// public/lib/playback-start.mjs
//
// Pure scheduled-start reducer (D6). The entry supplies state, the shared
// instant and the returned actions; this module owns no timer, DOM or clock.

import { epochMsAt, mediaMsAt } from './playback-state.mjs';

/** The advance's accepted range (executor-spec.md §2.5 C1 amendment). */
const ADVANCE_RANGE_MS = Object.freeze([0, 250]);

export const MISSING_CLOCK = 'clock-estimate';
export const MISSING_STATE = 'playback-state';
export const WAITING_PAUSED = 'room-paused';
export const WAITING_PREPARING = 'preparing';
export const WAITING_REFUSED = 'play-refused';

const sameTarget = (a, b) => a && b && a.playing === b.playing
  && (a.playing ? a.epochMs === b.epochMs : a.positionMs === b.positionMs);

function targetFor(state) {
  const current = state?.current;
  if (!current || typeof current.playing !== 'boolean'
    || !Number.isFinite(current.atSharedMs) || !Number.isFinite(current.mediaMs)) return null;
  if (current.playing) {
    return {
      playing: true,
      effectiveMs: current.atSharedMs,
      epochMs: current.atSharedMs - current.mediaMs,
    };
  }
  return { playing: false, effectiveMs: current.atSharedMs, positionMs: current.mediaMs };
}

export function createPlaybackStart({ prepareLeadMs, presentationAdvanceMs = 0 } = {}) {
  if (!Number.isFinite(prepareLeadMs) || prepareLeadMs < 0) {
    throw new TypeError('prepareLeadMs must be a finite non-negative number');
  }
  const [advanceLow, advanceHigh] = ADVANCE_RANGE_MS;
  // A value outside the range is a configuration fault, not something to clamp:
  // the upper bound keeps an advance below S's own preparation lead.
  if (!Number.isFinite(presentationAdvanceMs) || presentationAdvanceMs < advanceLow || presentationAdvanceMs > advanceHigh) {
    throw new TypeError(`presentationAdvanceMs must be a finite number in [${advanceLow}, ${advanceHigh}]`);
  }

  let nextAttemptId = 1;
  let attempt = null;
  let loaded = false;
  let elementPlaying = false;
  let presented = null;
  let resolved = false;
  let lastState = null;
  let missing = MISSING_CLOCK;
  let refused = false;
  let retryAfterError = false;
  let retryRequested = false;
  let opens = 0;
  let begun = 0;
  let retargets = 0;
  let lastLatenessMs = null;
  let lastPlayError = null;

  function snapshot() {
    const playing = presented?.playing === true;
    let waiting = null;
    let reportedMissing = missing;
    if (playing) {
      reportedMissing = null;
    } else if (reportedMissing === null) {
      if (refused) waiting = WAITING_REFUSED;
      else if (lastState?.current?.playing) waiting = WAITING_PREPARING;
      else if (lastState) waiting = WAITING_PAUSED;
    }
    return {
      playing,
      resolved,
      missing: reportedMissing,
      waiting,
      opens,
      begun,
      retargets,
      lastLatenessMs,
      lastPlayError,
      attemptId: attempt?.id ?? null,
      startAtSharedMs: attempt?.target.playing ? attempt.S : null,
    };
  }

  function result(actions, nextAtSharedMs) {
    return { ...snapshot(), actions, nextAtSharedMs };
  }

  function invalidateAttempt() {
    attempt = null;
  }

  function pauseAction(actions, id) {
    if (!elementPlaying) return;
    actions.push({ kind: 'pause', attemptId: id });
    elementPlaying = false;
  }

  /**
   * `positionMs` is the PHYSICAL park — what the entry writes. `mapping` is what
   * the room is showing at S, carried explicitly so the entry publishes the room
   * mapping on the seam rather than deriving it from the park (§12).
   */
  function setupPosition(actions, id, mapping) {
    if (!loaded) {
      actions.push({ kind: 'load', attemptId: id, ...mapping });
      loaded = true;
      opens += 1;
    } else {
      actions.push({ kind: 'park', attemptId: id, ...mapping });
    }
  }

  function newPlayingAttempt(state, target, nowSharedMs) {
    const id = nextAttemptId++;
    const S = Math.max(target.effectiveMs, nowSharedMs + prepareLeadMs);
    // Both through the mapping's own arithmetic, never by adding the advance to
    // a position: the timeline decides what media instant S + advance is (C1-6).
    const mapping = {
      positionMs: mediaMsAt(state, S + presentationAdvanceMs),
      scheduledPositionMs: mediaMsAt(state, S),
      advanceMs: presentationAdvanceMs,
      seamEpochMs: epochMsAt(state, S),
    };
    if (![mapping.positionMs, mapping.scheduledPositionMs, mapping.seamEpochMs].every(Number.isFinite)) {
      missing = MISSING_STATE;
      return result([], null);
    }
    const actions = [];
    attempt = {
      id,
      target,
      S,
      mapping,
      readyAtSharedMs: null,
      playDispatched: false,
      parked: true,
    };
    pauseAction(actions, id);
    setupPosition(actions, id, mapping);
    return result(actions, S);
  }

  /** A paused target parks at the state's position exactly: no advance, ever (D6). */
  const pausedMapping = (target) => ({
    positionMs: target.positionMs,
    scheduledPositionMs: target.positionMs,
    advanceMs: 0,
    seamEpochMs: target.effectiveMs - target.positionMs,
  });

  /**
   * The only place a paused target parks — reached either as the attempt is
   * created or when a deferred one comes due, which must write the same actions.
   */
  function parkPaused(target) {
    const actions = [];
    attempt.deferred = false;
    pauseAction(actions, attempt.id);
    setupPosition(actions, attempt.id, pausedMapping(target));
    attempt.parked = true;
    presented = { playing: false, positionMs: target.positionMs };
    retryAfterError = false;
    return result(actions, null);
  }

  function newPausedAttempt(target, nowSharedMs) {
    attempt = { id: nextAttemptId++, target, parked: false, deferred: false };
    if (elementPlaying && nowSharedMs < target.effectiveMs) {
      attempt.deferred = true;
      return result([], target.effectiveMs);
    }
    return parkPaused(target);
  }

  function duePlaying(nowSharedMs) {
    if (!attempt || !attempt.target.playing) return result([], null);
    if (attempt.playDispatched) return result([], null);
    if (attempt.readyAtSharedMs !== null) {
      attempt.playDispatched = true;
      elementPlaying = true;
      lastLatenessMs = nowSharedMs - attempt.S;
      return result([{
        kind: 'play',
        attemptId: attempt.id,
        startAtSharedMs: attempt.S,
        latenessMs: lastLatenessMs,
        ...attempt.mapping,
      }], null);
    }
    return result([], null);
  }

  function poll({ nowSharedMs, resolved: nextResolved = false, state = null } = {}) {
    resolved = nextResolved === true && state !== null;
    lastState = state;

    if (!Number.isFinite(nowSharedMs)) {
      missing = MISSING_CLOCK;
      invalidateAttempt();
      return result([], null);
    }
    if (!resolved || !state) {
      missing = MISSING_STATE;
      invalidateAttempt();
      return result([], null);
    }
    const target = targetFor(state);
    if (!target) {
      missing = MISSING_STATE;
      invalidateAttempt();
      return result([], null);
    }
    missing = null;

    if (retryRequested) {
      retryRequested = false;
      refused = false;
      invalidateAttempt();
    }
    // A refusal blocks only play(); a paused target still parks (D6).
    if (refused && target.playing) return result([], null);
    if (!target.playing) refused = false;

    if (presented && sameTarget(presented, target) && !retryAfterError) {
      return result([], null);
    }
    if (attempt && !sameTarget(attempt.target, target)) invalidateAttempt();
    if (presented && !sameTarget(presented, target)) presented = null;

    if (!target.playing) {
      if (retryAfterError) retryAfterError = false;
      if (attempt && sameTarget(attempt.target, target)) {
        if (attempt.deferred && nowSharedMs >= target.effectiveMs) return parkPaused(target);
        return result([], attempt.deferred ? target.effectiveMs : null);
      }
      return newPausedAttempt(target, nowSharedMs);
    }

    if (retryAfterError) {
      retryAfterError = false;
      retargets += 1;
      invalidateAttempt();
    }
    if (!attempt) return newPlayingAttempt(state, target, nowSharedMs);
    if (!attempt.target.playing) {
      invalidateAttempt();
      return newPlayingAttempt(state, target, nowSharedMs);
    }
    if (nowSharedMs < attempt.S) return result([], attempt.S);
    return duePlaying(nowSharedMs);
  }

  function ready(attemptId, observedSharedMs) {
    if (!attempt || attempt.id !== attemptId || !attempt.target.playing || !attempt.parked) return;
    if (!Number.isFinite(observedSharedMs)) return;
    if (attempt.readyAtSharedMs === null) attempt.readyAtSharedMs = observedSharedMs;
  }

  function playResolved(attemptId) {
    if (!attempt || attempt.id !== attemptId || !attempt.playDispatched) return;
    presented = { playing: true, epochMs: attempt.target.epochMs };
    begun += 1;
    elementPlaying = true;
    lastPlayError = null;
  }

  function playRejected(attemptId, { name } = {}) {
    if (!attempt || attempt.id !== attemptId || !attempt.playDispatched) return;
    elementPlaying = false;
    presented = null;
    attempt = null;
    if (name === 'NotAllowedError') {
      refused = true;
      retryAfterError = false;
      lastPlayError = null;
    } else {
      refused = false;
      retryAfterError = true;
      lastPlayError = name ?? 'UnknownError';
    }
  }

  function click() {
    if (!resolved || !lastState?.current?.playing || !refused) return;
    retryRequested = true;
  }

  return { poll, ready, playResolved, playRejected, click, state: snapshot };
}
