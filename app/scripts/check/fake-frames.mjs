// scripts/check/fake-frames.mjs
//
// Manufactured `requestVideoFrameCallback` metadata, and the callback binding
// that delivers it. The whole drift path — sampler included — runs off this with
// no browser and no elapsed time (design.md D7).
//
// It builds FORWARDS from the quantities a player actually has: where the room
// says the frame should be, and where the frame's media timestamp actually is.
// The derivation next door works BACKWARDS from four numbers to a drift. Two
// directions through the same arithmetic, compared against a configuration
// rather than against each other — the reason this file can check that one at
// all (fake-probe.mjs does the same job for the clock).
//
// TEST MACHINERY — under scripts/, so it cannot reach the browser bundle.
// IT DRAWS NO RANDOMNESS. Every frame is arithmetic on the spec, so the run is
// reproducible with no seed to carry, report or keep stable — unlike
// fake-probe.mjs, where loss and an irregular path are the subject.

/** Epoch-based, so `expectedDisplayTime` values look like a real page's. */
export const DEFAULT_TIME_ORIGIN_MS = 1_756_000_000_000;

/**
 * rVFC fires shortly BEFORE the frame is displayed, which is why the D3 guard
 * has to admit a display instant in the near future. Exported so a check that
 * builds its own frame builds it against the same lead this file uses.
 */
export const DEFAULT_CALLBACK_LEAD_MS = 8;

/**
 * A run of frames on a regular display grid.
 *
 * The media clock is a small state machine — advance by `rate` frame intervals,
 * or freeze for a stall or a repeat — and the drift each frame carries falls out
 * of it rather than being written down: `truthDriftMs` is computed from the
 * numbers actually built, so every regime reports its own truth.
 *
 * @param {{timeOriginMs?: number, offsetMs?: number, fps?: number, count?: number,
 *   rate?: number, stallAt?: number|null, stallFrames?: number,
 *   repeatAt?: Record<number, boolean>, callbackLeadMs?: number,
 *   nonFiniteAt?: Record<number, string>,
 *   foreignTimebaseAt?: Record<number, boolean>}} [spec]
 */
export function createFakeFrames(spec = {}) {
  const {
    timeOriginMs = DEFAULT_TIME_ORIGIN_MS,
    offsetMs = 0,
    fps = 30,
    count = 30,
    rate = 1,
    stallAt = null,
    stallFrames = 0,
    repeatAt = {},
    callbackLeadMs = DEFAULT_CALLBACK_LEAD_MS,
    nonFiniteAt = {},
    foreignTimebaseAt = {},
  } = spec;

  // The room's epoch, in the shared timebase. A minute into the page's life, so
  // `expectedDisplayTime` is the few-second number a real callback carries
  // rather than an epoch timestamp.
  const epochMs = timeOriginMs + offsetMs + 60_000;
  const intervalMs = 1000 / fps;

  const frames = [];
  let mediaMs = 0;
  let presentedFrames = 0;

  for (let i = 0; i < count; i++) {
    const stalled = stallAt !== null && i >= stallAt && i < stallAt + stallFrames;
    const repeated = repeatAt[i] === true;
    if (i > 0 && !stalled && !repeated) mediaMs += intervalMs * rate;
    if (!repeated) presentedFrames += 1;

    const displaySharedMs = epochMs + i * intervalMs;
    const scheduledMediaMs = displaySharedMs - epochMs;
    const displayLocalMs = displaySharedMs - offsetMs;

    let expectedDisplayTime = displayLocalMs - timeOriginMs;
    // The domain error the D3 guard exists for: a user agent handing back an
    // absolute instant where the specification says a `performance.now()` one.
    // Every field still looks like a number, and the drift is out by 55 years.
    if (foreignTimebaseAt[i] === true) expectedDisplayTime = displayLocalMs;

    let mediaTime = mediaMs / 1000;
    if (nonFiniteAt[i] === 'mediaTime') mediaTime = NaN;
    if (nonFiniteAt[i] === 'expectedDisplayTime') expectedDisplayTime = Infinity;

    frames.push({
      metadata: {
        presentationTime: expectedDisplayTime - 4,
        expectedDisplayTime,
        width: 1280,
        height: 720,
        mediaTime,
        presentedFrames,
        processingDuration: 0.004,
      },
      nowLocalMs: displayLocalMs - callbackLeadMs,
      displayLocalMs,
      displaySharedMs,
      scheduledMediaMs,
      truthDriftMs: mediaTime * 1000 - scheduledMediaMs,
    });
  }

  return {
    timeOriginMs,
    epochMs,
    intervalMs,
    frames,
    /** The regime, for the failure messages — a run nothing names has nothing to reproduce. */
    describe() {
      return `fake-frames(fps=${fps}, count=${count}, rate=${rate}, offset=${offsetMs}ms)`;
    },
  };
}

/**
 * The injected `requestVideoFrameCallback` binding (D7). Delivery is
 * synchronous and driven by the check, so a run of frames costs no wall-clock
 * time and the log can be read mid-run — which is the only way to see a
 * transient (`CONSTRAINTS.md` → *Verification*).
 *
 * `now` is the reading the sampler takes INSIDE the callback, and it walks with
 * the frame being delivered. It is deliberately not derived from the metadata:
 * the guard it feeds exists to catch metadata from a foreign clock domain, and
 * a reading taken from that same metadata would agree with it.
 */
export function createFrameBinding(fake) {
  let armed = null;
  let handles = 0;
  let index = 0;
  let current = null;

  function requestFrame(callback) {
    armed = { handle: ++handles, callback };
    return armed.handle;
  }

  function cancelFrame(handle) {
    if (armed && armed.handle === handle) armed = null;
  }

  function fire(entry) {
    const frame = fake.frames[index];
    if (!frame) throw new Error(`${fake.describe()}: asked for frame ${index}, only ${fake.frames.length} were manufactured`);
    index += 1;
    current = frame;
    try {
      entry.callback(frame.metadata.expectedDisplayTime, frame.metadata);
    } finally {
      current = null;
    }
    return frame;
  }

  return {
    requestFrame,
    cancelFrame,
    /**
     * The instant the sampler reads in the callback; injected as its `now`. It
     * exists ONLY while a frame is in flight: a reading taken outside one would
     * be a plausible number belonging to no frame, and the drift built on it
     * would look like a measurement.
     */
    now: () => {
      if (!current) throw new Error('fake-frames: `now` was read with no frame in flight');
      return current.nowLocalMs;
    },
    /** Deliver the next `count` frames to whatever the sampler has armed. */
    deliver(count = 1) {
      const delivered = [];
      for (let n = 0; n < count; n++) {
        if (!armed) throw new Error('fake-frames: nothing is armed — the sampler is stopped or did not re-arm');
        const entry = armed;
        armed = null;
        delivered.push(fire(entry));
      }
      return delivered;
    },
    /** The callback armed right now, kept so it can be fired after a restart. */
    hold() {
      if (!armed) throw new Error('fake-frames: nothing is armed to hold');
      return armed;
    },
    /**
     * Fire a callback the sampler has already cancelled — a user agent
     * dispatching one that was in flight when `stop()` ran. `entry` comes from
     * `hold()`, taken before the stop; nothing but the sampler's own guard
     * stands between it and a record.
     */
    deliverStale(entry) {
      return fire(entry);
    },
  };
}

/**
 * A clock estimate in `clock-sync.read()`'s shape, under the check's control.
 *
 * `present: false` is the no-estimate state — `offsetMs: null`, exactly as the
 * filter reports it before its first accepted sample, never a zero.
 *
 * `reads` records the instant each read was taken at, which is how a check
 * proves the estimate was read at the FRAME's display instant rather than at
 * wall-clock now (D5).
 */
export function createFakeClock(config = {}) {
  const state = {
    present: true,
    offsetMs: 0,
    delayTermMs: 3,
    ageTermMs: 1,
    sampleCount: 8,
    ...config,
  };
  const reads = [];
  return {
    state,
    reads,
    read(atMs) {
      reads.push(atMs);
      if (!state.present) {
        return { offsetMs: null, halfWidthMs: null, delayTermMs: null, ageTermMs: null, sampleCount: 0, atMs };
      }
      return {
        offsetMs: state.offsetMs,
        halfWidthMs: state.delayTermMs + state.ageTermMs,
        delayTermMs: state.delayTermMs,
        ageTermMs: state.ageTermMs,
        sampleCount: state.sampleCount,
        atMs,
      };
    },
  };
}
