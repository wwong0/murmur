// public/lib/start-telemetry.mjs
//
// Deliberate measurement instrumentation for the scheduled start: a bounded
// ring of timing events, and a second rVFC observer that records raw frame
// metadata beside the product sampler instead of editing it.
//
// OPT-IN AND INERT. `enabled: false` is one early return in `record`, so every
// call site is unconditional and the product keeps one code path either way.
// Nothing here decides anything — no assertion, no
// self-check, and no product branch may read what it holds.
//
// Under public/lib/: no DOM, no page access, and NO CLOCK READ — every shared
// instant and both clock terms arrive in `context`, from the page that has them.

export const TELEMETRY_CAPACITY = 4096;

export const EVENT_KINDS = Object.freeze(['poll', 'action', 'element-event', 'play-settled', 'frame', 'rate-write']);

/**
 * The client's timebase, the SAME CONSTRUCTION frame-sampler and clock-sync use
 * — a stamp joined to a shared instant through an offset measured against a
 * different one is not a measurement.
 */
const defaultNow = () => performance.timeOrigin + performance.now();

// Every event's own fields, in the order they are written, with the type that
// says how an absence is reported: a number that is not finite, a boolean that
// is not a boolean and a missing array become null AND name themselves in
// `absentFields`. A string is nullable on purpose — `waiting`, `missing`,
// `errorName` and `threw` each have "nothing to report" as a value.
const HEADER_FIELDS = Object.freeze({
  atLocalMs: 'number',
  atSharedMs: 'number',
  clockOffsetMs: 'number',
  clockHalfWidthMs: 'number',
  attemptId: 'number',
  lineage: 'string',
  version: 'number',
});

const KIND_FIELDS = Object.freeze({
  poll: {
    nowSharedMs: 'number', resolved: 'boolean', waiting: 'string', missing: 'string', actions: 'array',
    nextAtSharedMs: 'number', opens: 'number', begun: 'number', retargets: 'number',
  },
  action: {
    action: 'string', positionMs: 'number', scheduledPositionMs: 'number', advanceMs: 'number',
    seamEpochMs: 'number', startAtSharedMs: 'number', latenessMs: 'number', elementPausedBefore: 'boolean',
    elementCurrentTimeMs: 'number', dispatchedAtLocalMs: 'number', returnedAtLocalMs: 'number', threw: 'string',
    reparkOf: 'number', reparks: 'number', abandonedLatenessMs: 'number', firstStartAtSharedMs: 'number',
    reprojections: 'number', reprojectionOf: 'number', projectionMs: 'number', coverElapsedMs: 'number',
    skipOf: 'number', abandonedDriftMs: 'number',
  },
  'element-event': {
    type: 'string', readyState: 'number', paused: 'boolean', elementCurrentTimeMs: 'number',
    prerequisiteSeen: 'boolean', offeredReadiness: 'boolean', observedSharedMs: 'number',
  },
  'play-settled': { outcome: 'string', errorName: 'string', settledAtLocalMs: 'number', settledSharedMs: 'number' },
  frame: {
    paused: 'boolean', callbackNowMs: 'number', localNowMs: 'number', timeOriginMs: 'number', mediaTimeMs: 'number', placementMs: 'number',
    presentedFrames: 'number', presentationTimeMs: 'number', expectedDisplayTimeMs: 'number',
    processingDurationMs: 'number', commandedRate: 'number', width: 'number', height: 'number',
  },
  'rate-write': { commandedRate: 'number', readbackRate: 'number', appliedOk: 'boolean' },
});

// A frame field names the rVFC METADATA KEY it came from, not its own name:
// `processingDuration` is optional in the specification, and a reducer refusing
// a record has to name the key it went looking for.
const METADATA_KEYS = Object.freeze({
  mediaTimeMs: 'mediaTime',
  presentationTimeMs: 'presentationTime',
  expectedDisplayTimeMs: 'expectedDisplayTime',
  processingDurationMs: 'processingDuration',
});

function coerce(value, type) {
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return typeof value === 'boolean' ? value : null;
  if (type === 'array') return Array.isArray(value) ? Object.freeze([...value]) : null;
  return typeof value === 'string' ? value : null;
}

/**
 * @param {{capacity?: number, enabled?: boolean, now?: () => number}} [config]
 */
export function createStartTelemetry(config = {}) {
  const { capacity = TELEMETRY_CAPACITY, enabled = false, now = defaultNow } = config;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new TypeError(`createStartTelemetry: capacity must be a positive integer, got ${capacity}`);
  }

  const events = [];
  let nextSeq = 1;
  let dropped = 0;

  /**
   * One frozen event, or null with the instrument off. `context` carries the
   * identity and the clock as the page read them at this call; every one of its
   * values may be null, and a null is named rather than defaulted.
   */
  function record(kind, fields, context) {
    if (!enabled) return null;
    const shape = KIND_FIELDS[kind];
    if (!shape) throw new RangeError(`start-telemetry: unknown event kind ${JSON.stringify(kind)}`);
    const absentFields = [];
    const supplied = {
      atLocalMs: now(),
      atSharedMs: context?.nowSharedMs,
      clockOffsetMs: context?.clockOffsetMs,
      clockHalfWidthMs: context?.clockHalfWidthMs,
      attemptId: context?.attemptId,
      lineage: context?.lineage,
      version: context?.version,
    };
    const header = {};
    for (const [name, type] of Object.entries(HEADER_FIELDS)) {
      header[name] = coerce(supplied[name], type);
      if (type !== 'string' && header[name] === null) absentFields.push(name);
    }
    const own = {};
    for (const [name, type] of Object.entries(shape)) {
      own[name] = coerce(fields?.[name], type);
      if (type !== 'string' && own[name] === null) absentFields.push(METADATA_KEYS[name] ?? name);
    }
    const event = Object.freeze({ seq: nextSeq++, kind, ...header, absentFields: Object.freeze(absentFields), ...own });
    events.push(event);
    if (events.length > capacity) {
      events.shift();
      dropped += 1;
    }
    return event;
  }

  /**
   * Everything after `afterSeq`, `missed` for what fell out of the ring before
   * this read could see it, and `dropped` for the total evicted — the split
   * `createDriftLog.read` already publishes. Off, the reading is the same shape
   * with `enabled: false` and `capacity: 0`, which is how a consumer tells the
   * instrument being off from it being on and silent.
   */
  function read(afterSeq = 0) {
    if (!enabled) return { enabled: false, events: [], missed: 0, dropped: 0, latestSeq: 0, capacity: 0 };
    const oldestSeq = events.length > 0 ? events[0].seq : nextSeq;
    return {
      enabled: true,
      events: events.slice(Math.max(0, afterSeq + 1 - oldestSeq)),
      missed: Math.max(0, oldestSeq - afterSeq - 1),
      dropped,
      latestSeq: nextSeq - 1,
      capacity,
    };
  }

  return {
    record,
    read,
    get enabled() {
      return enabled;
    },
    get dropped() {
      return dropped;
    },
  };
}

const toMs = (seconds) => (Number.isFinite(seconds) ? seconds * 1000 : seconds);

/**
 * frame-sampler.mjs's lifecycle with the derivation replaced by one `record`.
 * It holds no log, no timeline and no clock: it sees the same frames the
 * product sampler sees, independently, and the two streams are joined offline
 * on `presentedFrames` — which is why `frame-sampler.mjs` is not edited and
 * the product sampler's records cannot move.
 *
 * @param {{video?: object, telemetry: object, context?: () => object|null, now?: () => number,
 *   timeOriginMs?: number, placement?: () => number|null, paused?: () => boolean, commandedRate?: () => number,
 *   requestFrame?: (cb: Function) => any, cancelFrame?: (handle: any) => void}} config
 */
export function createFrameObserver(config) {
  const {
    video,
    telemetry,
    context = () => null,
    now = defaultNow,
    timeOriginMs = performance.timeOrigin,
    placement = () => 0,
    paused = () => video.paused,
    commandedRate = () => video.playbackRate,
    requestFrame = (callback) => video.requestVideoFrameCallback(callback),
    cancelFrame = (handle) => video.cancelVideoFrameCallback(handle),
  } = config;

  let running = false;
  // Bumped on stop, so a callback already dispatched when stop() ran cannot
  // record or re-arm after a later start has made `running` true again.
  let generation = 0;
  let handle = null;
  let callbacks = 0;

  function arm(mine) {
    handle = requestFrame((callbackNow, metadata) => onFrame(mine, callbackNow, metadata));
  }

  function onFrame(mine, callbackNow, metadata) {
    if (!running || mine !== generation) return;
    callbacks += 1;
    // At callback entry, before the re-arm: the rate is the COMMANDED one, which
    // under §11.4's shim is not what the element is playing at, and no figure is
    // derived from it.
    const wasPaused = paused();
    const rate = commandedRate();
    const placementMs = placement();
    arm(mine);
    telemetry.record('frame', {
      paused: wasPaused,
      callbackNowMs: callbackNow,
      localNowMs: now(),
      timeOriginMs,
      // The seconds-to-milliseconds conversion happens once, here, so every
      // consumer downstream reads one unit.
      mediaTimeMs: Number.isFinite(placementMs) ? toMs(metadata?.mediaTime) - placementMs : null,
      placementMs,
      presentedFrames: metadata?.presentedFrames,
      presentationTimeMs: metadata?.presentationTime,
      expectedDisplayTimeMs: metadata?.expectedDisplayTime,
      processingDurationMs: toMs(metadata?.processingDuration),
      commandedRate: rate,
      width: metadata?.width,
      height: metadata?.height,
    }, context());
  }

  function start() {
    if (running) return;
    running = true;
    arm(generation);
  }

  function stop() {
    if (!running) return;
    running = false;
    generation += 1;
    if (handle !== null) cancelFrame(handle);
    handle = null;
  }

  return {
    start,
    stop,
    get running() {
      return running;
    },
    get callbacks() {
      return callbacks;
    },
  };
}
