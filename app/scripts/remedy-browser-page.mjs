// scripts/remedy-browser-page.mjs
//
// The research collector that runs INSIDE the page, and the three factory
// wrappers the research build redirects the entry point's imports to.
//
// Rules that survive any edit:
//
//  1. IT DOES NOT CONTROL PLAYBACK. Every wrapper forwards the original
//     arguments to the original factory and returns what it returned. A rate is
//     written by the product's `apply` and by nothing here.
//  2. A VALUE THAT WAS NOT THERE MUST NOT ARRIVE AS A VALUE. JSON drops
//     `undefined` keys and turns NaN and Infinity into null, so a missing
//     field, an explicit `undefined`, a null and a non-finite number would all
//     reach Node as the same thing. The codec below tags the last two, and a
//     missing key stays missing — that is the whole difference between evidence
//     that is absent and evidence that says nothing.
//  3. SNAPSHOTS ARE COPIES. The controller returns live-ish objects and the
//     entry holds them; a retained reference would let a later poll rewrite an
//     earlier observation.
//  4. OVERFLOW LATCHES, IT NEVER EVICTS. A sampled or wrapped event sequence is
//     a sequence with a hole nobody can see; a fatal flag beside the data the
//     collector did hold is an observation about the instrument.
//
// TEST MACHINERY — under scripts/. Nothing in the product imports it. It has no
// top-level side effect, so `npm run check` can import it in Node and drive the
// same code the browser runs.

export const SCHEMA_VERSION = 1;

/** The two tags rule 2 exists for, plus the one for a value JSON cannot carry
 *  at all. Read on the Node side by `remedy-browser-metrics.mjs`. */
export const TAG_UNDEFINED = '$undefined';
export const TAG_NON_FINITE = '$nonFinite';
export const TAG_UNSERIALIZABLE = '$unserializable';

export const EVENT_KINDS = Object.freeze([
  'construction',
  'poll',
  'controller-input',
  'rate-call',
  'frame-callback',
  'sampler-input',
  'drift-offer',
  'native',
  'seam-sample',
]);

/** Observation buffers, not product settings: the collector's own capacities
 *  and the per-response drain limits. Frozen here so the manifest, the page and
 *  the evaluator quote one number each. */
export const MAX_QUEUED_EVENTS = 16384;
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export const DRAIN_MAX_EVENTS = 512;
export const DRAIN_MAX_BYTES = 256 * 1024;
export const DRAIN_INTERVAL_MS = 125;

/** The native media events observed from sampler construction onward. */
export const NATIVE_EVENTS = Object.freeze([
  'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'pause',
  'ended', 'error', 'emptied', 'loadstart', 'ratechange', 'volumechange',
]);

const MAX_ENCODE_DEPTH = 8;

export const isTagged = (value, tag) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, tag);

/**
 * One value, encoded so its absence, its emptiness and its unrepresentability
 * stay three different answers. Depth is bounded because a wrapper handed a
 * cyclic object must produce a marked event rather than hang the page.
 */
export function encodeValue(value, depth = 0) {
  if (value === undefined) return { [TAG_UNDEFINED]: true };
  if (typeof value === 'number') return Number.isFinite(value) ? value : { [TAG_NON_FINITE]: String(value) };
  if (typeof value === 'function') return { [TAG_UNSERIALIZABLE]: 'function' };
  if (typeof value === 'symbol' || typeof value === 'bigint') return { [TAG_UNSERIALIZABLE]: typeof value };
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_ENCODE_DEPTH) return { [TAG_UNSERIALIZABLE]: 'depth' };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) out[key] = encodeValue(value[key], depth + 1);
  return out;
}

/**
 * How a field arrived, as five distinguishable answers. `absent` is the one no
 * encoding can express, so it is read off the container rather than the value.
 */
export function classifyField(container, key) {
  if (container === null || typeof container !== 'object' || !Object.hasOwn(container, key)) return { presence: 'absent' };
  const raw = container[key];
  if (isTagged(raw, TAG_UNDEFINED)) return { presence: 'undefined' };
  if (isTagged(raw, TAG_NON_FINITE)) return { presence: 'non-finite', value: Number(raw[TAG_NON_FINITE]) };
  if (isTagged(raw, TAG_UNSERIALIZABLE)) return { presence: 'unserializable', value: raw[TAG_UNSERIALIZABLE] };
  if (raw === null) return { presence: 'null', value: null };
  return { presence: 'value', value: raw };
}

/** A finite number the caller may use, or `null` — every other presence is a
 *  refusal to answer, and no caller may read one as a quantity. */
export function finiteField(container, key) {
  const field = classifyField(container, key);
  return field.presence === 'value' && Number.isFinite(field.value) ? field.value : null;
}

const defaultNow = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * The collector. One per page, shared by the three wrappers, holding the event
 * queue, the recorder's own log cursor and the media element the wrappers found.
 *
 * `now` is PAGE-MONOTONIC milliseconds — bare `performance.now()`, the domain
 * rVFC metadata already speaks. `timeOriginMs` is published once so Node can
 * convert into the epoch-relative domain the controller uses, and no drain
 * timestamp is ever used as a poll or callback time.
 */
export function createCollector({
  arm,
  buildId,
  collectorId,
  now = defaultNow,
  timeOriginMs = typeof performance === 'undefined' ? 0 : performance.timeOrigin,
  maxEvents = MAX_QUEUED_EVENTS,
  maxBytes = MAX_QUEUED_BYTES,
  drainMaxEvents = DRAIN_MAX_EVENTS,
  drainMaxBytes = DRAIN_MAX_BYTES,
  // A build that records a different set of kinds declares that set instead.
  // The default is unchanged, so the two remedy-browser arms publish exactly
  // what they always have.
  observes = EVENT_KINDS,
} = {}) {
  const queue = [];
  let queuedBytes = 0;
  let produced = 0;
  let lost = 0;
  let fatal = null;
  let reads = 0;
  let acks = 0;
  let acknowledgedThrough = 0;
  let nextCallbackId = 0;
  let constructions = 0;
  let video = null;
  let log = null;
  let recorderCursor = 0;
  const recorderIntake = { reads: 0, records: 0, missed: 0, readsWithMissed: 0, maxMissedInOneRead: 0 };
  const scope = { callbackId: null, pollId: null };

  const latch = (reason, detail) => {
    if (fatal === null) fatal = { reason, detail: detail ?? null, atMs: now(), afterEventId: produced };
  };

  /**
   * One event. The id is assigned before anything can fail, so a refused event
   * still consumes its number and a gap in the delivered stream is a gap the
   * evaluator can name rather than a renumbering that hides it.
   */
  function record(kind, fields) {
    produced += 1;
    // THE ENCODE IS INSIDE THE GUARD, not only the serialisation. A snapshot
    // property that throws when it is read — an accessor on an object a wrapper
    // was handed — would otherwise escape this function and take the poll down
    // with it, which is the one thing an observer must never do. A cycle is a
    // different case and is handled by the depth bound in `encodeValue`: it is
    // marked in place rather than latched, because a bounded copy of a cyclic
    // object is still evidence.
    let event;
    let text;
    try {
      event = {
        v: SCHEMA_VERSION,
        arm,
        buildId,
        collectorId,
        eventId: produced,
        kind,
        atMs: now(),
        ...encodeValue(fields ?? {}),
      };
      text = JSON.stringify(event);
    } catch (error) {
      lost += 1;
      latch('unserializable-event', `${kind}: ${error?.message ?? error}`);
      return null;
    }
    if (text === undefined) {
      lost += 1;
      latch('unserializable-event', kind);
      return null;
    }
    if (queue.length + 1 > maxEvents || queuedBytes + text.length > maxBytes) {
      lost += 1;
      latch('queue-overflow', kind);
      return null;
    }
    queue.push({ event, bytes: text.length });
    queuedBytes += text.length;
    return event;
  }

  /**
   * A non-destructive batch. Nothing leaves the queue until Node says it has
   * durably written what it was given, so two reads before an acknowledgement
   * return the same events — a delayed drain loses nothing, and a drain that
   * failed mid-flight repeats rather than skips.
   */
  function read({ afterEventId = acknowledgedThrough } = {}) {
    reads += 1;
    const events = [];
    let bytes = 0;
    let truncated = false;
    for (const entry of queue) {
      if (entry.event.eventId <= afterEventId) continue;
      if (events.length === 0 && entry.bytes > drainMaxBytes) {
        latch('event-too-large', `eventId ${entry.event.eventId} is ${entry.bytes} bytes`);
        break;
      }
      if (events.length >= drainMaxEvents || bytes + entry.bytes > drainMaxBytes) {
        truncated = true;
        break;
      }
      events.push(entry.event);
      bytes += entry.bytes;
    }
    return {
      events,
      bytes,
      truncated,
      readAtMs: now(),
      finalEventId: events.length > 0 ? events[events.length - 1].eventId : afterEventId,
      state: state(),
    };
  }

  /** Node has the batch on disk. Only now may the queue forget it. */
  function acknowledge({ throughEventId } = {}) {
    acks += 1;
    if (!Number.isFinite(throughEventId) || throughEventId <= acknowledgedThrough) {
      return { acknowledgedThrough, ackAtMs: now() };
    }
    acknowledgedThrough = throughEventId;
    while (queue.length > 0 && queue[0].event.eventId <= acknowledgedThrough) {
      queuedBytes -= queue[0].bytes;
      queue.shift();
    }
    return { acknowledgedThrough, ackAtMs: now() };
  }

  function state() {
    return {
      produced,
      queued: queue.length,
      queuedBytes,
      lost,
      reads,
      acks,
      acknowledgedThrough,
      constructions,
      fatal,
      capacities: { maxEvents, maxBytes, drainMaxEvents, drainMaxBytes },
    };
  }

  /** The native media state, read at whatever instant the caller asks. Every
   *  field is tagged, so a property the element does not expose is absent
   *  rather than null. */
  function mediaState() {
    if (video === null) return null;
    return encodeValue({
      paused: video.paused,
      seeking: video.seeking,
      ended: video.ended,
      readyState: video.readyState,
      networkState: video.networkState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      defaultPlaybackRate: video.defaultPlaybackRate,
      preservesPitch: video.preservesPitch,
      muted: video.muted,
      volume: video.volume,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      quality: typeof video.getVideoPlaybackQuality === 'function' ? qualityOf(video) : undefined,
    });
  }

  function qualityOf(element) {
    const quality = element.getVideoPlaybackQuality();
    return { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames };
  }

  /** The rate the element is actually at, for a readback beside a write. */
  const nativeRate = () => (video === null ? null : video.playbackRate);

  /**
   * The media element, found by the sampler wrapper because that is the one
   * factory the entry hands it to. Listeners are passive: they record and
   * return, and none of them touches the element.
   */
  function attachMedia(element) {
    if (video !== null || !element || typeof element.addEventListener !== 'function') return;
    video = element;
    for (const name of NATIVE_EVENTS) {
      element.addEventListener(name, () => {
        record('native', { event: name, media: mediaState() });
      });
    }
  }

  /** The product log, kept so the recorder can drain it on a cursor of its own
   *  — the controller's intake and this one are different readers and must not
   *  share a count. */
  function attachLog(instance) {
    if (log === null) log = instance;
  }

  function drainRecords() {
    if (log === null) return null;
    const result = log.read({ afterSeq: recorderCursor });
    recorderCursor = result.latestSeq;
    const missed = Number.isFinite(result.missed) ? result.missed : 0;
    recorderIntake.reads += 1;
    recorderIntake.records += result.records.length;
    recorderIntake.missed += missed;
    if (missed > 0) {
      recorderIntake.readsWithMissed += 1;
      recorderIntake.maxMissedInOneRead = Math.max(recorderIntake.maxMissedInOneRead, missed);
    }
    return {
      records: result.records.map((item) => encodeValue(item)),
      missed,
      counters: encodeValue(result.counters),
      capacity: result.capacity,
      latestSeq: result.latestSeq,
      readAtMs: now(),
      intake: { ...recorderIntake },
    };
  }

  return {
    // `observes` is this build's DECLARED instrumentation, published by the page
    // rather than inferred from what happened to arrive. A build that says it
    // records the sampler's reads and delivers none is broken; a build that
    // never claimed to is narrower evidence. Nothing downstream can tell those
    // apart from an empty stream alone.
    info: () => ({ schemaVersion: SCHEMA_VERSION, arm, buildId, collectorId, timeOriginMs, observes, capacities: state().capacities }),
    record,
    read,
    acknowledge,
    state,
    scope,
    mediaState,
    nativeRate,
    attachMedia,
    attachLog,
    drainRecords,
    now,
    nextCallbackId: () => (nextCallbackId += 1),
    countConstruction: () => (constructions += 1),
  };
}

/**
 * The log wrapper. It observes what the sampler OFFERED and what the log made
 * of it, and hands the collector the log so the recorder can drain it
 * independently. `add` is the only method wrapped; everything else is the
 * original, reached through the original object.
 */
export function wrapDriftLog({ collector, createDriftLog }) {
  return function createObservedDriftLog(config = {}) {
    const log = createDriftLog(config);
    collector.attachLog(log);
    collector.countConstruction();
    collector.record('construction', { factory: 'createDriftLog', config, capacity: log.read({ afterSeq: 0 }).capacity });
    return {
      ...log,
      add(derived) {
        const accepted = log.add(derived);
        collector.record('drift-offer', {
          callbackId: collector.scope.callbackId,
          derived,
          accepted,
          latestSeq: log.latestSeq,
          counters: log.counters,
        });
        return accepted;
      },
      read: (query) => log.read(query),
      summary: () => log.summary(),
      get latestSeq() { return log.latestSeq; },
      get counters() { return log.counters; },
    };
  };
}

/**
 * The sampler wrapper. It wraps the callback binding — the supplied one where
 * the caller supplied it, the element's own otherwise — so a frame's arrival,
 * its metadata and the derivation it triggers share one scoped callback id.
 *
 * `_callbackNow` is RECORDED AND NEVER FED BACK. The product deliberately does
 * not use it (`frame-sampler.mjs`), and substituting it here would replace the
 * client's own clock reading with one from the metadata's domain.
 */
export function wrapFrameSampler({ collector, createFrameSampler, preservesPitch = null }) {
  return function createObservedFrameSampler(config) {
    const { video, requestFrame, clock, timeline, now } = config;
    collector.attachMedia(video);
    // THE ONE PLACE AN ARM MAY TOUCH THE ELEMENT. `null` leaves the flag where
    // the browser default put it, which is what the product does; a boolean is
    // written once, here, and never again. The sampler is constructed before
    // the entry opens playback, so a flag set here stands from the first frame
    // — and because nothing writes it a second time, whether it HELD is a
    // question the retained media samples answer rather than an assumption.
    if (typeof preservesPitch === 'boolean') {
      video.preservesPitch = preservesPitch;
      collector.record('construction', {
        factory: 'preservesPitch',
        requested: preservesPitch,
        readback: video.preservesPitch,
        propertySupported: 'preservesPitch' in video,
        beforePlayback: video.paused !== false,
      });
    }
    const base = requestFrame ?? ((callback) => video.requestVideoFrameCallback(callback));

    // THE SAMPLER'S OWN INPUT POPULATION. The controller's `now` and `clock`
    // reads are observed elsewhere and are a different population entirely:
    // these are the readings each drift record was actually derived from, taken
    // inside the callback that produced it. They are buffered and flushed as one
    // event per callback, so the provenance costs one event rather than three.
    let reads = null;
    const noteRead = (input, value, args) => { if (reads !== null) reads.push({ input, args, result: value }); };
    // The entry supplies no `now` to the sampler, so observing only a supplied
    // one would observe nothing. The substitute is the sampler's own default
    // expression unchanged — `performance.timeOrigin + performance.now()`, the
    // domain `frame-sampler.mjs` requires the offset be measured against — and
    // the construction event records which of the two was wrapped.
    const suppliedNow = now !== undefined;
    const underlyingNow = now ?? (() => performance.timeOrigin + performance.now());
    const observedNow = () => { const value = underlyingNow(); noteRead('now', value, []); return value; };
    const observedClock = clock === undefined ? undefined : {
      ...clock,
      read(...args) { const result = clock.read(...args); noteRead('clock.read', result, args); return result; },
    };
    const observedTimeline = timeline === undefined ? undefined : {
      ...timeline,
      mediaMsAt(...args) { const result = timeline.mediaMsAt(...args); noteRead('timeline.mediaMsAt', result, args); return result; },
      get epochMs() { return timeline.epochMs; },
      get counters() { return timeline.counters; },
    };

    const observedRequestFrame = (callback) =>
      base((callbackNow, metadata) => {
        const callbackId = collector.nextCallbackId();
        collector.record('frame-callback', {
          callbackId,
          callbackNow,
          metadata: metadataOf(metadata),
          nativeRate: collector.nativeRate(),
        });
        const outer = collector.scope.callbackId;
        const outerReads = reads;
        collector.scope.callbackId = callbackId;
        reads = [];
        try {
          return callback(callbackNow, metadata);
        } finally {
          collector.record('sampler-input', { callbackId, reads });
          collector.scope.callbackId = outer;
          reads = outerReads;
        }
      });
    const sampler = createFrameSampler({
      ...config,
      requestFrame: observedRequestFrame,
      ...(observedClock === undefined ? {} : { clock: observedClock }),
      ...(observedTimeline === undefined ? {} : { timeline: observedTimeline }),
      now: observedNow,
    });
    collector.countConstruction();
    collector.record('construction', {
      factory: 'createFrameSampler',
      suppliedRequestFrame: requestFrame !== undefined,
      suppliedNow,
      observedInputs: ['now', 'clock.read', 'timeline.mediaMsAt'],
      media: collector.mediaState(),
    });
    return sampler;
  };
}

/** Every field rVFC is specified to carry, each read explicitly so one the
 *  browser omits arrives absent rather than as a silently missing key. */
function metadataOf(metadata) {
  if (metadata === null || typeof metadata !== 'object') return metadata;
  const out = {};
  for (const key of [
    'presentationTime', 'expectedDisplayTime', 'width', 'height', 'mediaTime',
    'presentedFrames', 'processingDuration', 'captureTime', 'receiveTime', 'rtpTimestamp',
  ]) {
    if (Object.hasOwn(metadata, key)) out[key] = metadata[key];
  }
  return out;
}

/**
 * The controller wrapper. It brackets the poll, and wraps the four things the
 * entry supplies — `now`, `clock.read`, `log.read` and `apply` — recording the
 * values the ORIGINAL operation used rather than a later reading of the same
 * quantity. `settings` is the arm's, and the only one either arm changes is
 * `MIN_COMMAND_DEVIATION`.
 */
export function wrapDriftController({ collector, createController, settings = null, options = null }) {
  return function createObservedDriftController(config) {
    const { log, clock, apply, now } = config;
    let pollId = 0;

    const observedNow = () => {
      const value = now();
      collector.record('controller-input', { pollId, input: 'now', result: value });
      return value;
    };

    const observedClock = {
      ...clock,
      read(...args) {
        const result = clock.read(...args);
        collector.record('controller-input', { pollId, input: 'clock.read', args, result });
        return result;
      },
    };

    const observedLog = {
      ...log,
      read(query) {
        const result = log.read(query);
        const records = result.records ?? [];
        collector.record('controller-input', {
          pollId,
          input: 'log.read',
          args: [query],
          firstSeq: records.length > 0 ? records[0].seq : null,
          lastSeq: records.length > 0 ? records[records.length - 1].seq : null,
          count: records.length,
          missed: result.missed,
          latestSeq: result.latestSeq,
          counters: result.counters,
        });
        return result;
      },
      get latestSeq() { return log.latestSeq; },
      get counters() { return log.counters; },
    };

    const observedApply = (rate) => {
      const before = collector.nativeRate();
      let thrown;
      let returned;
      try {
        returned = apply(rate);
      } catch (error) {
        thrown = error;
      }
      collector.record('rate-call', {
        pollId,
        callbackId: collector.scope.callbackId,
        requestedRate: rate,
        rateBefore: before,
        rateAfter: collector.nativeRate(),
        returned: thrown === undefined ? returned : undefined,
        threw: thrown === undefined ? null : String(thrown?.message ?? thrown),
      });
      if (thrown !== undefined) throw thrown;
      return returned;
    };

    const controller = createController({
      ...config,
      log: observedLog,
      clock: observedClock,
      apply: observedApply,
      now: observedNow,
      ...(settings === null ? {} : { settings }),
      ...(options === null ? {} : options),
    });
    collector.countConstruction();
    // The refusal policy is recorded only by a controller that has one, so the
    // baseline's construction record keeps exactly the shape it always had.
    collector.record('construction', {
      factory: 'createDriftController',
      settings: controller.state().settings,
      ...(controller.refusalPolicy === undefined ? {} : { refusalPolicy: controller.refusalPolicy }),
      media: collector.mediaState(),
    });

    return {
      ...controller,
      poll() {
        pollId += 1;
        const mine = pollId;
        const enteredMs = collector.now();
        const rateBefore = collector.nativeRate();
        let snapshot;
        let thrown;
        try {
          snapshot = controller.poll();
        } catch (error) {
          thrown = error;
        }
        collector.record('poll', {
          pollId: mine,
          publishedPolls: snapshot ? snapshot.polls : undefined,
          enteredMs,
          exitedMs: collector.now(),
          rateBefore,
          rateAfter: collector.nativeRate(),
          snapshot,
          threw: thrown === undefined ? null : String(thrown?.message ?? thrown),
        });
        if (thrown !== undefined) throw thrown;
        return snapshot;
      },
      state: () => controller.state(),
      markSeam: (seam) => controller.markSeam(seam),
      get seams() { return controller.seams; },
    };
  };
}

/**
 * What one 125 ms drain reads, recorded as an event of its own so a drain-time
 * observation can never be mistaken for a poll or a callback. The product's
 * existing `window.__app` seam supplies the clock, timeline and controller
 * snapshots; nothing here recomputes them.
 */
/**
 * A passive requestAnimationFrame series.
 *
 * BROWSER SCHEDULING CADENCE, NOT A REFRESH RATE. rAF is driven by the
 * compositor, so its spacing is the best available evidence about how often
 * this page is being composited — and it is still the browser's scheduling,
 * not a hardware certainty. It reads a clock and nothing else: no rate is
 * written, no frame is inserted, and it runs after the fixed capture window has
 * closed so it cannot perturb the interval being measured.
 */
export function sampleSchedulingCadence({ count = 120, raf = null, now = defaultNow } = {}) {
  const request = raf ?? (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : null);
  if (request === null) return Promise.resolve({ available: false, stamps: [] });
  return new Promise((resolve) => {
    const stamps = [];
    const step = (stamp) => {
      stamps.push(stamp);
      if (stamps.length >= count) resolve({ available: true, stamps, takenAtMs: now() });
      else request(step);
    };
    request(step);
  });
}

export function publishHarness({ collector, appSeam }) {
  const seam = () => {
    const app = appSeam();
    const sample = app === null || app === undefined
      ? { app: null }
      : {
        playback: app.playback(),
        timeline: app.timeline(),
        clock: app.clock(),
        controller: app.controller(),
        buildId: app.buildId,
      };
    collector.record('seam-sample', { ...sample, media: collector.mediaState() });
    return sample;
  };
  return {
    info: collector.info,
    state: collector.state,
    seam,
    /** The producer's own count, read WITHOUT producing an event. Every drain
     *  emits a seam sample, so a frontier taken by draining can never be
     *  reached; this one is a number the recorder can drain up to. */
    frontier: () => collector.state().produced,
    /** One round trip: the drain-time seam, then the recorder's own records,
     *  then the event batch — in that order, so the seam this drain took is in
     *  the batch this drain returns. */
    drain: (afterEventId) => {
      seam();
      const records = collector.drainRecords();
      return { ...collector.read({ afterEventId }), records };
    },
    ack: (throughEventId) => collector.acknowledge({ throughEventId }),
    cadence: (count) => sampleSchedulingCadence({ count }),
  };
}
