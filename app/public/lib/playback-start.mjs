// public/lib/playback-start.mjs
//
// Pure scheduled-start reducer (D6). The entry supplies state, the shared
// instant and the returned actions; this module owns no timer, DOM or clock.

import { mediaMsAt } from './playback-state.mjs';

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

export function createPlaybackStart({ prepareLeadMs } = {}) {
  if (!Number.isFinite(prepareLeadMs) || prepareLeadMs < 0) {
    throw new TypeError('prepareLeadMs must be a finite non-negative number');
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

  function setupPosition(actions, id, positionMs) {
    if (!loaded) {
      actions.push({ kind: 'load', attemptId: id, positionMs });
      loaded = true;
      opens += 1;
    } else {
      actions.push({ kind: 'park', attemptId: id, positionMs });
    }
  }

  function newPlayingAttempt(state, target, nowSharedMs) {
    const id = nextAttemptId++;
    const S = Math.max(target.effectiveMs, nowSharedMs + prepareLeadMs);
    const positionMs = mediaMsAt(state, S);
    if (!Number.isFinite(positionMs)) {
      missing = MISSING_STATE;
      return result([], null);
    }
    const actions = [];
    attempt = {
      id,
      target,
      S,
      positionMs,
      readyAtSharedMs: null,
      playDispatched: false,
      parked: true,
    };
    pauseAction(actions, id);
    setupPosition(actions, id, positionMs);
    return result(actions, S);
  }

  function newPausedAttempt(target, nowSharedMs) {
    const id = nextAttemptId++;
    const actions = [];
    attempt = { id, target, parked: false, deferred: false };
    if (elementPlaying && nowSharedMs < target.effectiveMs) {
      attempt.deferred = true;
      return result(actions, target.effectiveMs);
    }
    pauseAction(actions, id);
    setupPosition(actions, id, target.positionMs);
    attempt.parked = true;
    presented = { playing: false, positionMs: target.positionMs };
    retryAfterError = false;
    return result(actions, null);
  }

  function duePlaying(nowSharedMs) {
    if (!attempt || !attempt.target.playing) return result([], null);
    if (attempt.playDispatched) return result([], null);
    if (attempt.readyAtSharedMs !== null && attempt.readyAtSharedMs <= attempt.S) {
      attempt.playDispatched = true;
      elementPlaying = true;
      lastLatenessMs = nowSharedMs - attempt.S;
      return result([{
        kind: 'play',
        attemptId: attempt.id,
        startAtSharedMs: attempt.S,
        latenessMs: lastLatenessMs,
        positionMs: attempt.positionMs,
      }], null);
    }
    retargets += 1;
    invalidateAttempt();
    return null;
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
        if (attempt.deferred && nowSharedMs >= target.effectiveMs) {
          attempt.deferred = false;
          const actions = [];
          pauseAction(actions, attempt.id);
          setupPosition(actions, attempt.id, target.positionMs);
          attempt.parked = true;
          presented = { playing: false, positionMs: target.positionMs };
          return result(actions, null);
        }
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
    const due = duePlaying(nowSharedMs);
    if (due) return due;
    return newPlayingAttempt(state, target, nowSharedMs);
  }

  function ready(attemptId, observedSharedMs) {
    if (!attempt || attempt.id !== attemptId || !attempt.target.playing || !attempt.parked) return;
    if (!Number.isFinite(observedSharedMs) || observedSharedMs > attempt.S) return;
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
