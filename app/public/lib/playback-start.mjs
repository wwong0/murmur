// public/lib/playback-start.mjs
//
// Pure scheduled-start reducer (D6). The entry supplies state, the shared
// instant and the returned actions; this module owns no timer, DOM or clock.

import { epochMsAt, mediaMsAt } from './playback-state.mjs';
import { edgeIndexAfter, heldAheadMs } from './held-ahead.mjs';

/** The advance's accepted range (executor-spec.md §2.5 C1 amendment). */
const ADVANCE_RANGE_MS = Object.freeze([0, 250]);

export const MISSING_CLOCK = 'clock-estimate';
export const MISSING_STATE = 'playback-state';
export const MISSING_HOST_LINK = 'host-link';
export const MISSING_HOST_TITLE = 'host-title';
export const WAITING_PAUSED = 'room-paused';
// T9 (design.md D6): a held room is a paused mapping everywhere the timeline
// reads it, but it is never reported as a paused room — checked before
// WAITING_PAUSED below.
export const WAITING_HELD = 'room-held';
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

export function createPlaybackStart({
  prepareLeadMs,
  presentationAdvanceMs = 0,
  reparkAfterMs = Infinity,
  maxReparks = 0,
  coverMarginMs = 0,
  projectionMs = prepareLeadMs,
  projectionMaxMs = projectionMs,
} = {}) {
  if (!Number.isFinite(prepareLeadMs) || prepareLeadMs < 0) {
    throw new TypeError('prepareLeadMs must be a finite non-negative number');
  }
  const [advanceLow, advanceHigh] = ADVANCE_RANGE_MS;
  // A value outside the range is a configuration fault, not something to clamp:
  // the upper bound keeps an advance below S's own preparation lead.
  if (!Number.isFinite(presentationAdvanceMs) || presentationAdvanceMs < advanceLow || presentationAdvanceMs > advanceHigh) {
    throw new TypeError(`presentationAdvanceMs must be a finite number in [${advanceLow}, ${advanceHigh}]`);
  }
  // Off by default: Infinity never re-parks, and the entry opts in (7b2 design.md D3).
  if (typeof reparkAfterMs !== 'number' || Number.isNaN(reparkAfterMs) || reparkAfterMs < 0) {
    throw new TypeError('reparkAfterMs must be a non-negative number or Infinity');
  }
  if (!Number.isInteger(maxReparks) || maxReparks < 0) {
    throw new TypeError('maxReparks must be a non-negative integer');
  }
  for (const [name, value] of [['coverMarginMs', coverMarginMs], ['projectionMs', projectionMs], ['projectionMaxMs', projectionMaxMs]]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  }
  if (projectionMs < prepareLeadMs) throw new TypeError('projectionMs must be at least prepareLeadMs');
  if (projectionMaxMs < projectionMs) throw new TypeError('projectionMaxMs must be at least projectionMs');

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
  let reparks = 0;
  let skips = 0;
  let lastLatenessMs = null;
  let lastPlayError = null;
  let linkOpen = true;
  let titleReady = true;
  let finished = null;
  let last = null;
  let pendingSkip = null;

  function covered(positionMs) {
    if (coverMarginMs === 0 || finished === null) return true;
    const marginCovered = Number.isFinite(positionMs) && Array.isArray(finished) && finished.length > 0
      && heldAheadMs({ positionMs, segments: finished }) >= coverMarginMs;
    const tailCovered = last !== null && Array.isArray(finished)
      && edgeIndexAfter({ positionMs, segments: finished }) === last.index + 1;
    return marginCovered || tailCovered;
  }

  function snapshot() {
    const playing = presented?.playing === true;
    let waiting = null;
    let reportedMissing = missing;
    if (playing) {
      reportedMissing = null;
    } else if (!linkOpen && reportedMissing === null) {
      reportedMissing = MISSING_HOST_LINK;
    } else if (!titleReady && reportedMissing === null) {
      reportedMissing = MISSING_HOST_TITLE;
    } else if (reportedMissing === null) {
      if (refused) waiting = WAITING_REFUSED;
      else if (lastState?.current?.playing) waiting = WAITING_PREPARING;
      else if (lastState?.current?.held === true) waiting = WAITING_HELD;
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
      reparks,
      skips,
      lastLatenessMs,
      lastPlayError,
      attemptId: attempt?.id ?? null,
      startAtSharedMs: attempt?.target.playing ? attempt.S : null,
      projectedAtSharedMs: attempt?.target.playing ? attempt.P : null,
      reprojections: attempt?.target.playing ? attempt.reprojections : 0,
    };
  }

  function result(actions, nextAtSharedMs) {
    return { ...snapshot(), actions, nextAtSharedMs };
  }

  function invalidateAttempt() {
    attempt = null;
  }

  function unload() {
    loaded = false;
    invalidateAttempt();
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

  /** What a playing attempt's actions report of its projection, and of the skip it follows. */
  const projectionReport = (from) => ({
    reprojections: from.reprojections,
    reprojectionOf: from.reprojectionOf,
    projectionMs: from.reportProjectionMs,
    coverElapsedMs: from.coverElapsedMs,
    ...(from.skipOf === undefined ? {} : { skipOf: from.skipOf, abandonedDriftMs: from.abandonedDriftMs }),
  });

  function newPlayingAttempt(state, target, nowSharedMs, lineage = null) {
    const id = nextAttemptId++;
    const S0 = Math.max(target.effectiveMs, nowSharedMs + prepareLeadMs);
    const chosen = covered(mediaMsAt(state, S0 + presentationAdvanceMs));
    let P = chosen ? S0 : Math.max(target.effectiveMs, nowSharedMs + (lineage?.nextProjectionMs ?? projectionMs));
    if (!chosen && last !== null && mediaMsAt(state, S0 + presentationAdvanceMs) < last.mediaEndMs
      && mediaMsAt(state, P + presentationAdvanceMs) >= last.mediaEndMs) {
      P = Math.max(S0, epochMsAt(state, P + presentationAdvanceMs) + last.mediaStartMs - presentationAdvanceMs);
    }
    const S = chosen ? S0 : null;
    const mapping = {
      positionMs: mediaMsAt(state, P + presentationAdvanceMs),
      scheduledPositionMs: mediaMsAt(state, P),
      advanceMs: presentationAdvanceMs,
      seamEpochMs: epochMsAt(state, P),
    };
    if (![mapping.positionMs, mapping.scheduledPositionMs, mapping.seamEpochMs].every(Number.isFinite)) {
      missing = MISSING_STATE;
      return result([], null);
    }
    const actions = [];
    attempt = {
      id,
      target,
      P,
      S,
      mapping,
      preparedAtSharedMs: nowSharedMs,
      readyAtSharedMs: null,
      playDispatched: false,
      parked: true,
      reparks: lineage?.reparks ?? 0,
      firstStartAtSharedMs: lineage?.firstStartAtSharedMs ?? S,
      reprojections: lineage?.reprojections ?? 0,
      reprojectionOf: lineage?.reprojectionOf ?? null,
      projectionMs: lineage?.nextProjectionMs ?? projectionMs,
      reportProjectionMs: lineage?.reportProjectionMs ?? (lineage?.nextProjectionMs ?? projectionMs),
      coverElapsedMs: lineage?.coverElapsedMs ?? null,
      skipOf: lineage?.skipOf,
      abandonedDriftMs: lineage?.abandonedDriftMs,
    };
    pauseAction(actions, id);
    setupPosition(actions, id, mapping);
    Object.assign(actions.at(-1), {
      ...projectionReport(attempt),
      ...(lineage?.reparkOf === undefined ? {} : {
        reparkOf: lineage.reparkOf,
        reparks: lineage.reparks,
        abandonedLatenessMs: lineage.abandonedLatenessMs,
        firstStartAtSharedMs: lineage.firstStartAtSharedMs,
      }),
    });
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

  function duePlaying(state, nowSharedMs) {
    if (!attempt || !attempt.target.playing) return result([], null);
    if (attempt.playDispatched) return result([], null);
    if (attempt.readyAtSharedMs !== null) {
      // Late beyond the bound: park again at the room's position for a fresh S
      // rather than play from the stale park. Strict, and capped (7b2 design.md D3).
      if (nowSharedMs - attempt.S > reparkAfterMs && attempt.reparks < maxReparks) {
        const lineage = {
          reparkOf: attempt.id,
          reparks: attempt.reparks + 1,
          abandonedLatenessMs: nowSharedMs - attempt.S,
          firstStartAtSharedMs: attempt.firstStartAtSharedMs,
          reprojections: attempt.reprojections,
          reprojectionOf: attempt.reprojectionOf,
          nextProjectionMs: attempt.projectionMs,
          reportProjectionMs: attempt.reportProjectionMs,
          coverElapsedMs: attempt.coverElapsedMs,
          skipOf: attempt.skipOf,
          abandonedDriftMs: attempt.abandonedDriftMs,
        };
        const replaced = newPlayingAttempt(state, attempt.target, nowSharedMs, lineage);
        if (replaced.actions.length > 0) {
          reparks += 1;
          return { ...replaced, reparks };
        }
        return replaced;
      }
      attempt.playDispatched = true;
      elementPlaying = true;
      lastLatenessMs = nowSharedMs - attempt.S;
      return result([{
        kind: 'play',
        attemptId: attempt.id,
        startAtSharedMs: attempt.S,
        latenessMs: lastLatenessMs,
        ...attempt.mapping,
        reparks: attempt.reparks,
        firstStartAtSharedMs: attempt.firstStartAtSharedMs,
        ...projectionReport(attempt),
      }], null);
    }
    return result([], null);
  }

  function poll({
    nowSharedMs,
    resolved: nextResolved = false,
    state = null,
    linkOpen: nextLinkOpen = true,
    titleReady: nextTitleReady = true,
    finished: nextFinished = null,
    last: nextLast = null,
  } = {}) {
    linkOpen = nextLinkOpen === true;
    titleReady = nextTitleReady === true;
    finished = nextFinished;
    last = nextLast;
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

    if (!loaded && !linkOpen) {
      missing = MISSING_HOST_LINK;
      invalidateAttempt();
      return result([], null);
    }
    if (!loaded && !titleReady) {
      missing = MISSING_HOST_TITLE;
      invalidateAttempt();
      return result([], null);
    }

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
    if (pendingSkip?.target && !sameTarget(pendingSkip.target, target)) pendingSkip = null;

    if (!target.playing) {
      pendingSkip = null;
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
    if (!attempt) {
      const lineage = pendingSkip;
      pendingSkip = null;
      return newPlayingAttempt(state, target, nowSharedMs, lineage);
    }
    if (!attempt.target.playing) {
      invalidateAttempt();
      return newPlayingAttempt(state, target, nowSharedMs);
    }
    if (attempt.S === null) {
      if (!covered(attempt.mapping.positionMs)) return result([], null);
      const remaining = attempt.P - nowSharedMs;
      if (remaining >= prepareLeadMs) {
        attempt.S = attempt.P;
        if (attempt.firstStartAtSharedMs === null) attempt.firstStartAtSharedMs = attempt.S;
        return result([], attempt.S);
      }
      const coverElapsedMs = nowSharedMs - attempt.preparedAtSharedMs;
      const nextProjectionMs = Math.min(projectionMaxMs, Math.max(projectionMs, 2 * coverElapsedMs));
      return newPlayingAttempt(state, target, nowSharedMs, {
        reparks: attempt.reparks,
        firstStartAtSharedMs: attempt.firstStartAtSharedMs,
        reprojections: attempt.reprojections + 1,
        reprojectionOf: attempt.id,
        nextProjectionMs,
        reportProjectionMs: attempt.projectionMs,
        coverElapsedMs,
      });
    }
    if (nowSharedMs < attempt.S) return result([], attempt.S);
    return duePlaying(state, nowSharedMs);
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

  function skip({ abandonedDriftMs = null } = {}) {
    if (presented?.playing !== true || !resolved) return false;
    pendingSkip = {
      target: attempt?.target ?? null,
      skipOf: attempt?.id ?? null,
      abandonedDriftMs: Number.isFinite(abandonedDriftMs) ? abandonedDriftMs : null,
    };
    presented = null;
    attempt = null;
    skips += 1;
    return true;
  }

  function click() {
    if (!resolved || !lastState?.current?.playing || !refused) return;
    retryRequested = true;
  }

  return { poll, ready, playResolved, playRejected, skip, click, unload, state: snapshot };
}
