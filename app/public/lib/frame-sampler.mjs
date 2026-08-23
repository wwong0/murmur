// public/lib/frame-sampler.mjs
//
// The driver: it arms `requestVideoFrameCallback`, reads the clock at each
// displayed frame, and hands the derivation to the log. Everything with a
// lifecycle lives here so frame-drift.mjs next door can stay a pure function of
// its inputs — the same split as clock-filter and clock-sync (design.md D7).
//
// IT HOLDS NO TIMER. rVFC is the only thing that schedules it, and the callback
// binding is an argument, which is what lets a manufactured source drive this
// whole path with no browser and no elapsed time. If this file grows a
// `setTimeout`, the suite covering it stops being free.
//
// Under public/lib/: no DOM, no page access — the video element arrives as an
// argument, the way player.mjs takes its own.

import { deriveDriftRecord } from './frame-drift.mjs';

/**
 * The client's timebase. Same construction as clock-sync's and room-client's,
 * AND THEY MUST STAY THE SAME: the offset is measured against that one, and
 * applying it to a different one is a drift figure measured against two clocks.
 */
function defaultNow() {
  return performance.timeOrigin + performance.now();
}

/**
 * @param {{video?: object, timeline: object, clock: {read: Function}, log: {add: Function},
 *   requestFrame?: (cb: Function) => any, cancelFrame?: (handle: any) => void,
 *   now?: () => number, timeOriginMs?: number}} config
 */
export function createFrameSampler(config) {
  const {
    video,
    timeline,
    clock,
    log,
    requestFrame = (callback) => video.requestVideoFrameCallback(callback),
    cancelFrame = (handle) => video.cancelVideoFrameCallback(handle),
    now = defaultNow,
    timeOriginMs = performance.timeOrigin,
  } = config;

  let running = false;
  // Bumped on stop, so a callback already dispatched when stop() ran cannot
  // record or re-arm after the caller has said stop.
  let generation = 0;
  let handle = null;
  let callbacks = 0;

  function arm(mine) {
    handle = requestFrame((_callbackNow, metadata) => onFrame(mine, metadata));
  }

  /**
   * `_callbackNow` IS DELIBERATELY UNREAD: it comes from the same source as the
   * metadata, so it would agree with it about a foreign clock domain — which is
   * the one thing frame-drift.mjs's guard exists to catch. `now()` below is this
   * client's own reading.
   */
  function onFrame(mine, metadata) {
    // Cancellation is best-effort; THIS is what stops a stale callback
    // recording — including one from before a stop/start, where `running` is
    // true again and only the generation tells them apart.
    if (!running || mine !== generation) return;
    callbacks += 1;
    // Re-arm BEFORE deriving: a throw in the derivation must not be able to
    // silently stop the instrument for the life of the page.
    arm(mine);
    log.add(
      deriveDriftRecord({
        metadata,
        timeOriginMs,
        localNowMs: now(),
        clock,
        timeline,
      })
    );
  }

  function start() {
    if (running) return;
    running = true;
    arm(generation);
  }

  /**
   * STOP CLEARS THE SCHEDULING STATE, ALL OF IT — the trap clock-sync.mjs
   * records: a driver that leaves a handle or a flag behind reports itself
   * running while nothing ever arms a callback again.
   */
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
    /** Frames the binding delivered, recorded or refused. */
    get callbacks() {
      return callbacks;
    },
  };
}
