// scripts/start-timing.mjs
//
// The scheduled-start diagnostic's arithmetic and its in-page probes,
// split from the runner for the reason
// lead-measurement.mjs is: the figures and the page expressions are importable
// and checkable with no Chrome, and the runner is only the sequence of windows
// and waits.
//
// THE START RESIDUAL IS FROZEN. `startResidual` is imported and reused, never
// reimplemented, and nothing here touches its arithmetic or its population.

import { median as medianOfSorted, percentile } from '../public/lib/frame-drift.mjs';
import { startResidual } from './start-residual.mjs';

export { parseNdjson } from './lead-measurement.mjs';

export const PHASES = Object.freeze([0, 0.25, 0.5, 0.75]);
export const CONDITIONS = Object.freeze(['load', 'resume']);

/** The residual's population, and the joined frames one start must retain. */
export const RESIDUAL_POPULATION = 24;
export const FRAMES_PER_START = 72;
export const PLANNED_STARTS = 8;

/** §13 G0's bars, each written here and nowhere else. */
export const PARK_TOLERANCE_MS = 0.001;
export const IDENTITY_TOLERANCE_MS = 0.001;
/** How exactly a treated start must have applied the compiled advance (§13.1). */
export const ADVANCE_TOLERANCE_MS = 0.001;
export const SLOPE_TOLERANCE = 0.002;
/** §13 G1's band, G2's attribution bar and its floor. */
export const AGGREGATE_BAND_MS = Object.freeze([-60, -15]);
export const DISPATCH_SHARE = 0.5;
export const DISPATCH_FLOOR_MS = -5;
/** §13's advance clamp, and the bound U is itself held to. */
export const ADVANCE_CLAMP_MS = Object.freeze([0, 250]);
export const MAX_UNCERTAINTY_MS = 60;

/** The keys a figure below actually reads; a record naming one absent is refused. */
const REQUIRED_METADATA = Object.freeze(['mediaTime', 'presentedFrames', 'expectedDisplayTime']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const median = (values) => (values.length === 0 ? null : medianOfSorted([...values].sort((a, b) => a - b)));

/**
 * U — what one frame's reading cannot resolve, from the run's own evidence:
 * half a content interval (a continuous position lands on the nearest PTS),
 * half a refresh interval (a continuous instant lands on the next vsync), and
 * the shared clock's own published half-width.
 */
export function uncertaintyMs({ displayCadenceMs, frameIntervalMs, maxHalfWidthMs }) {
  if (![displayCadenceMs, frameIntervalMs, maxHalfWidthMs].every(finite)) return null;
  return displayCadenceMs / 2 + frameIntervalMs / 2 + maxHalfWidthMs;
}

/**
 * Um — how far two matched eight-start medians of THIS instrument drift apart
 * for reasons other than the advance, floored by the clock that timestamps
 * them. Frozen from the baseline before task 12 lands (§13.1 item 4).
 */
export function decisionToleranceMs({ medians, maxHalfWidthMs }) {
  if (!Array.isArray(medians) || medians.length === 0 || !medians.every(finite) || !finite(maxHalfWidthMs)) return null;
  return Math.max((Math.max(...medians) - Math.min(...medians)) / 2, maxHalfWidthMs);
}

/**
 * Accepted drift records to telemetry frames, on `presentedFrames` and nothing
 * else. A key missing on either side, a record with no frame, or one key over
 * two records makes the start unusable — never a fallback to a nearest
 * `mediaTime`, which is the whole reason frame-sampler.mjs stays unedited.
 */
export function joinFrames({ events, records }) {
  const byKey = new Map();
  const duplicates = [];
  const note = (key) => {
    if (!duplicates.includes(key)) duplicates.push(key);
  };
  for (const event of events ?? []) {
    if (event?.kind !== 'frame' || !finite(event.presentedFrames)) continue;
    if (byKey.has(event.presentedFrames)) note(event.presentedFrames);
    else byKey.set(event.presentedFrames, event);
  }
  const joined = [];
  const unjoined = [];
  const claimed = new Set();
  for (const record of records ?? []) {
    const key = record?.presentedFrames;
    if (!finite(key) || !byKey.has(key) || duplicates.includes(key)) {
      unjoined.push(record?.seq ?? null);
      continue;
    }
    if (claimed.has(key)) {
      note(key);
      unjoined.push(record.seq);
      continue;
    }
    claimed.add(key);
    joined.push({ record, frame: byKey.get(key) });
  }
  return { joined, unjoined, duplicates };
}

/** Ordinary least squares of `y` on `x`, or null where the abscissa never moves. */
function slopeOf(points) {
  if (points.length < 2) return null;
  const meanX = points.reduce((total, [x]) => total + x, 0) / points.length;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }
  return variance > 0 ? covariance / variance : null;
}

/** The display instant a frame carries, joined through ITS OWN offset. */
function displaySharedOf(frame) {
  if (!frame || ![frame.timeOriginMs, frame.expectedDisplayTimeMs, frame.clockOffsetMs].every(finite)) return null;
  return frame.timeOriginMs + frame.expectedDisplayTimeMs + frame.clockOffsetMs;
}

/** `value mod modulus` in [0, modulus), for a scheduled park below the lattice anchor. */
function positiveMod(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Where one start's evidence window opens, and which attempt it is about.
 *
 * A start armed into a page that is ALREADY RUNNING must exclude everything
 * before its own action, or `reduceStart` reads the previous start's park: the
 * window opens at the sequence that page had last published, and the start is
 * the one that appears after it.
 *
 * A FRESH DOCUMENT has nothing before it to exclude, and by the time the runner
 * can read it, it may already have parked, or already have begun playing — on a
 * `load` start the park is hls.js's `startPosition` on the paused load, which
 * runs the moment the state is adopted. Its window therefore opens at sequence
 * zero and its start is its FIRST attempt, whatever was recorded before the
 * first read. The 2026-09-17 baseline refused two `load` starts for
 * `no-park-action` for exactly that reason.
 */
export function captureBoundary({ freshDocument = false, latestSeq = 0, startCount = 0, dropped = 0 } = {}) {
  if (freshDocument) return Object.freeze({ mode: 'document', cursor: 0, pick: 'first', startsRequired: 1, droppedBaseline: 0 });
  return Object.freeze({ mode: 'before-action', cursor: latestSeq, pick: 'last', startsRequired: startCount + 1, droppedBaseline: dropped });
}

/** Whether the start this boundary opened has both appeared and filled. */
export function startSatisfied(boundary, { startCount = 0, recordCount = 0, framesPerStart = FRAMES_PER_START } = {}) {
  return startCount >= boundary.startsRequired && recordCount >= framesPerStart;
}

/**
 * One start's figures, all in milliseconds and all signed. `phase` is the phase
 * that was REQUESTED and is only a grouping label; `achievedPhase` is measured
 * off the observed lattice, and the park-on-target gate is what entitles the
 * label to stand for the phase the start actually ran at.
 */
export function reduceStart(input) {
  const {
    label, condition, phase, requestedTargetMs, events = [], records = [], start,
    nextAfterSeq = Infinity, frameIntervalMs, latticeOffsetMs,
    telemetry = {}, nativeRateReadback = null,
    // The treated run supplies the advance it compiled in. A start that did not
    // apply it — an old bundle, a paused target, a zero — is unusable, never a
    // treated observation (§13.1). The baseline supplies nothing and is unaffected.
    expectedAdvanceMs = null,
    // 72 and 24 in the capture. The qualification runs a reduced window, which
    // is why both are arguments and neither is read from a constant below.
    framesPerStart = FRAMES_PER_START, residualPopulation = RESIDUAL_POPULATION,
  } = input;
  const unusable = [];
  const refuse = (reason) => {
    if (!unusable.includes(reason)) unusable.push(reason);
  };

  const frames = events.filter((event) => event?.kind === 'frame');
  const actions = events.filter((event) => event?.kind === 'action');
  const play = actions.find((event) => event.action === 'play') ?? null;
  const park = actions.find((event) => event.action === 'load' || event.action === 'park') ?? null;
  const settled = events.find((event) => event?.kind === 'play-settled') ?? null;
  if (!play) refuse('no-play-action');
  if (!park) refuse('no-park-action');

  const requestedParkMs = park?.positionMs ?? null;
  const scheduledParkMs = park?.scheduledPositionMs ?? null;
  const advanceMs = park?.advanceMs ?? null;
  const S = play?.startAtSharedMs ?? null;
  const latenessMs = play?.latenessMs ?? null;
  const dispatchMs = play && finite(play.dispatchedAtLocalMs) && finite(play.clockOffsetMs) && finite(S)
    ? play.dispatchedAtLocalMs + play.clockOffsetMs - S : null;
  const callDurationMs = play && finite(play.returnedAtLocalMs) && finite(play.dispatchedAtLocalMs)
    ? play.returnedAtLocalMs - play.dispatchedAtLocalMs : null;
  const settleMs = settled && finite(settled.settledAtLocalMs) && finite(play?.returnedAtLocalMs)
    ? settled.settledAtLocalMs - play.returnedAtLocalMs : null;

  // The frame the park itself presented, and the first one presented playing.
  // `presentedFrames` orders them; the dispatch separates them.
  const beforeDispatch = play ? frames.filter((frame) => frame.seq < play.seq) : [];
  const pausedFrame = [...beforeDispatch].reverse().find((frame) => frame.paused === true) ?? null;
  const pausedFramePtsMs = pausedFrame?.mediaTimeMs ?? null;
  const firstPlayingFrame = pausedFrame
    ? frames.find((frame) => frame.paused === false && finite(frame.presentedFrames) && frame.presentedFrames > pausedFrame.presentedFrames) ?? null
    : null;
  if (!pausedFrame) refuse('no-paused-frame');
  if (!firstPlayingFrame) refuse('no-playing-frame');

  const snapErrorMs = firstPlayingFrame && finite(requestedParkMs) ? firstPlayingFrame.mediaTimeMs - requestedParkMs : null;
  const pausedSnapErrorMs = finite(pausedFramePtsMs) && finite(requestedParkMs) ? pausedFramePtsMs - requestedParkMs : null;
  const mediaAdvanceMs = firstPlayingFrame && finite(pausedFramePtsMs) ? firstPlayingFrame.mediaTimeMs - pausedFramePtsMs : null;
  const firstDisplaySharedMs = displaySharedOf(firstPlayingFrame);
  const displayMinusSMs = finite(firstDisplaySharedMs) && finite(S) ? firstDisplaySharedMs - S : null;
  const achievedPhase = finite(scheduledParkMs) && finite(latticeOffsetMs) && finite(frameIntervalMs) && frameIntervalMs > 0
    ? positiveMod(scheduledParkMs - latticeOffsetMs, frameIntervalMs) / frameIntervalMs : null;

  const ordered = records
    .filter((record) => record && Number.isSafeInteger(record.seq) && record.seq > (start?.afterSeq ?? -1))
    .sort((a, b) => a.seq - b.seq);
  const population = ordered.slice(0, framesPerStart);
  const residual = startResidual({ records, start, nextAfterSeq, frameIntervalMs, population: residualPopulation });
  const driftOf = (from, to) => median(population.slice(from, to).map((record) => record.driftMs).filter(finite));
  const earlyMs = driftOf(0, 6);
  const lateMs = driftOf(18, 24);
  const tailMs = driftOf(48, 72);

  const first = population[0] ?? null;
  const identityResidualMs = first && finite(scheduledParkMs) && finite(S)
    ? first.driftMs - ((first.mediaMs - scheduledParkMs) - (first.displaySharedMs - S)) : null;

  const join = joinFrames({ events, records: population });
  const slope = slopeOf(join.joined.slice(0, framesPerStart).map(({ record }) => [record.displaySharedMs, record.mediaMs]));
  const maxHalfWidthMs = join.joined.length > 0
    ? Math.max(...join.joined.map(({ record }) => record.clock?.halfWidthMs ?? Number.NaN)) : null;
  const lastFrameSeq = join.joined.at(framesPerStart - 1)?.frame.seq ?? join.joined.at(-1)?.frame.seq ?? Infinity;
  const commandedRates = events
    .filter((event) => event?.kind === 'rate-write' && event.seq > (play?.seq ?? -1) && event.seq <= lastFrameSeq)
    .map((event) => event.commandedRate);

  // Retargets across the attempt, and the readiness the attempt offered.
  const polls = events.filter((event) => event?.kind === 'poll' && finite(event.retargets));
  const retargetsMoved = polls.length > 0 && polls.some((event) => event.retargets !== polls[0].retargets);
  const readiness = events.find((event) => event?.kind === 'element-event' && event.offeredReadiness === true) ?? null;

  // G0, in one place. Each clause names itself so an unusable start says which.
  if (residual.count !== residualPopulation) refuse('residual-count');
  if (!['met', 'missed'].includes(residual.status)) refuse(`residual-status:${residual.status}`);
  if (population.length < framesPerStart) refuse(`records-under-${framesPerStart}`);
  if (join.unjoined.length > 0) refuse('join-unjoined');
  if (join.duplicates.length > 0) refuse('join-duplicates');
  if (telemetry.missed !== 0) refuse('telemetry-missed');
  if (telemetry.droppedDelta !== 0) refuse('telemetry-dropped');
  for (const used of [pausedFrame, firstPlayingFrame, ...join.joined.map(({ frame }) => frame)]) {
    for (const key of REQUIRED_METADATA) if (used?.absentFields?.includes(key)) refuse(`absent:${key}`);
  }
  for (const event of [play, park, firstPlayingFrame]) {
    if (event?.absentFields?.includes('clockOffsetMs')) refuse('absent:clockOffsetMs');
  }
  if (retargetsMoved) refuse('retargets-moved');
  if (!readiness || !finite(readiness.observedSharedMs) || !finite(S) || readiness.observedSharedMs > S) refuse('readiness-after-S');
  if (!finite(scheduledParkMs) || !finite(requestedTargetMs) || Math.abs(scheduledParkMs - requestedTargetMs) > PARK_TOLERANCE_MS) refuse('park-off-target');
  if (!finite(identityResidualMs) || Math.abs(identityResidualMs) > IDENTITY_TOLERANCE_MS) refuse('identity-residual');
  if (!finite(slope) || Math.abs(slope - 1) > SLOPE_TOLERANCE) refuse('slope-off-unity');
  if (nativeRateReadback !== 1) refuse('native-rate-not-unity');
  if (finite(expectedAdvanceMs)) {
    for (const event of [park, play]) {
      if (!event || !finite(event.advanceMs) || Math.abs(event.advanceMs - expectedAdvanceMs) > ADVANCE_TOLERANCE_MS) refuse('advance-not-applied');
    }
    // The park it actually wrote must be the room position plus that advance,
    // or the entry moved a figure the reducer did not (§12).
    if (!finite(requestedParkMs) || !finite(scheduledParkMs)
      || Math.abs((requestedParkMs - scheduledParkMs) - expectedAdvanceMs) > ADVANCE_TOLERANCE_MS) refuse('park-not-advanced');
  }

  return {
    label,
    condition,
    phase,
    requestedTargetMs: requestedTargetMs ?? null,
    requestedParkMs,
    scheduledParkMs,
    advanceMs,
    S,
    latenessMs,
    dispatchMs,
    callDurationMs,
    settleMs,
    pausedFramePtsMs,
    firstPlayingFrame,
    snapErrorMs,
    pausedSnapErrorMs,
    mediaAdvanceMs,
    achievedPhase,
    displayMinusSMs,
    identityResidualMs,
    residual,
    earlyMs,
    lateMs,
    tailMs,
    slope,
    maxHalfWidthMs,
    commandedRates,
    nativeRateReadback,
    joinedCount: join.joined.length,
    unjoined: join.unjoined,
    duplicates: join.duplicates,
    unusable,
  };
}

const gate = (name, held, inputs, bar) => ({ name, held, inputs, bar });

/**
 * §13's rule, in its fixed order, stopping at the first failure. No bar is
 * chosen here: every one comes from the constants above, which were written
 * before the capture ran.
 */
export function reduceCapture(input) {
  const {
    starts = [], frameIntervalMs, displayCadenceMs, plannedStarts = PLANNED_STARTS,
    condition = 'baseline',
  } = input;
  const usable = starts.filter((start) => start.unusable.length === 0);
  const medians = usable.map((start) => start.residual.medianMs);
  const maxHalfWidthMs = usable.length > 0 && usable.every((start) => finite(start.maxHalfWidthMs))
    ? Math.max(...usable.map((start) => start.maxHalfWidthMs)) : null;
  const U = uncertaintyMs({ displayCadenceMs, frameIntervalMs, maxHalfWidthMs });
  const Um = decisionToleranceMs({ medians, maxHalfWidthMs });
  const gates = [];
  const result = (verdict, reason) => ({
    verdict,
    reason,
    condition,
    plannedStarts,
    usableCount: usable.length,
    medians,
    aggregate: medians.length > 0 ? median(medians) : null,
    advanceMs: null,
    U,
    Um,
    uncertainty: { displayCadenceMs, frameIntervalMs, maxHalfWidthMs },
    gates,
    starts,
  });

  const g0 = gate('G0', usable.length === plannedStarts && starts.length === plannedStarts,
    { planned: plannedStarts, retained: starts.length, usable: usable.length, unusable: starts.filter((s) => s.unusable.length).map((s) => ({ label: s.label, reasons: s.unusable })) },
    'every planned start usable');
  gates.push(g0);
  if (!g0.held) return result('INCONCLUSIVE', 'S-DIAG-EVIDENCE');

  // The tolerance is itself bounded: above 60 ms the instrument is not the
  // localhost regime this was sized for (verification.md → bound the tolerance).
  const uGate = gate('U', finite(U) && U > 0 && U <= MAX_UNCERTAINTY_MS, { U, displayCadenceMs, frameIntervalMs, maxHalfWidthMs }, `0 < U <= ${MAX_UNCERTAINTY_MS}`);
  gates.push(uGate);
  if (!uGate.held) return result('INCONCLUSIVE', 'S-CADENCE');

  const aggregate = median(medians);
  const [low, high] = AGGREGATE_BAND_MS;
  const g1 = gate('G1', aggregate >= low && aggregate <= high, { aggregate, medians }, `${low} <= aggregate <= ${high}`);
  gates.push(g1);
  if (!g1.held) return { ...result('INCONCLUSIVE', 'S-DIAG-REGIME'), aggregate };

  const dispatchMedian = median(usable.map((start) => start.dispatchMs).filter(finite));
  const share = finite(dispatchMedian) ? dispatchMedian / Math.abs(aggregate) : null;
  const g2 = gate('G2', finite(share) && share <= DISPATCH_SHARE && dispatchMedian >= DISPATCH_FLOOR_MS,
    { dispatchMedian, aggregate, share }, `dispatch/|aggregate| <= ${DISPATCH_SHARE} with dispatch >= ${DISPATCH_FLOOR_MS}`);
  gates.push(g2);
  if (!g2.held) return { ...result('DISPATCH', 'S-DISPATCH'), aggregate };

  const bar = frameIntervalMs / 2;
  const spread = (values) => (values.length > 0 ? Math.max(...values) - Math.min(...values) : null);
  const byCondition = Object.fromEntries(CONDITIONS.map((name) => [name, usable.filter((start) => start.condition === name).map((start) => start.residual.medianMs)]));
  const conditionMedians = CONDITIONS.map((name) => median(byCondition[name])).filter(finite);
  const overall = spread(medians);
  const conditionGap = conditionMedians.length === CONDITIONS.length ? Math.abs(conditionMedians[0] - conditionMedians[1]) : null;
  const phaseSpreads = Object.fromEntries(CONDITIONS.map((name) => [name, spread(byCondition[name])]));
  const g3 = gate('G3',
    finite(overall) && overall <= bar && finite(conditionGap) && conditionGap <= bar
      && CONDITIONS.every((name) => finite(phaseSpreads[name]) && phaseSpreads[name] <= bar),
    { overall, conditionGap, phaseSpreads, byCondition }, `each spread <= frameIntervalMs / 2 = ${bar}`);
  gates.push(g3);
  if (!g3.held) return { ...result('SPREAD', 'S-ADVANCE-SPREAD'), aggregate };

  const stationarity = usable.map((start) => ({
    label: start.label,
    tailGapMs: finite(start.tailMs) && finite(start.residual.medianMs) ? Math.abs(start.tailMs - start.residual.medianMs) : null,
    earlyLateGapMs: finite(start.earlyMs) && finite(start.lateMs) ? Math.abs(start.earlyMs - start.lateMs) : null,
  }));
  const g4 = gate('G4', stationarity.every((row) => finite(row.tailGapMs) && row.tailGapMs <= U && finite(row.earlyLateGapMs) && row.earlyLateGapMs <= U),
    { U, perStart: stationarity }, 'every |tail − median| <= U and |early − late| <= U');
  gates.push(g4);
  if (!g4.held) return { ...result('NONSTATIONARY', 'S-ADVANCE-UNRESOLVED'), aggregate };

  const [clampLow, clampHigh] = ADVANCE_CLAMP_MS;
  const advanceMs = Math.min(clampHigh, Math.max(clampLow, Math.round(-aggregate * 10) / 10));
  return { ...result('ADVANCE', null), aggregate, advanceMs };
}

/**
 * §13.1 condition 4, as one function, so the negative control below and the
 * treated verdict run the SAME arithmetic rather than two copies of it: did the
 * advance move the population by the amount it was supposed to?
 */
export function mechanismCheck({ treatedMedians = [], baselineAggregate, advanceMs, Um }) {
  const observed = treatedMedians.length > 0 && treatedMedians.every(finite) ? median(treatedMedians) : null;
  const expected = finite(baselineAggregate) && finite(advanceMs) ? baselineAggregate + advanceMs : null;
  const deltaMs = finite(observed) && finite(expected) ? Math.abs(observed - expected) : null;
  return { held: finite(deltaMs) && finite(Um) && deltaMs <= Um, observed, expected, deltaMs, Um: finite(Um) ? Um : null };
}

/**
 * §13.1's negative control (task 13.3), run in `npm run check` before any
 * treated start: the same check fed the BASELINE medians must say no, and fed
 * the same medians shifted by the advance must say yes. A control that cannot
 * fail stops the treated run and is reported inconclusive, never as a pass.
 */
export function mechanismControl({ baselineMedians = [], baselineAggregate, advanceMs, Um }) {
  const negative = mechanismCheck({ treatedMedians: baselineMedians, baselineAggregate, advanceMs, Um });
  const positive = mechanismCheck({ treatedMedians: baselineMedians.map((value) => value + advanceMs), baselineAggregate, advanceMs, Um });
  const power = finite(advanceMs) && finite(Um) && advanceMs >= 2 * Um;
  return {
    held: negative.held === false && positive.held === true && power,
    negative, positive, power,
    powerInputs: { advanceMs, Um, required: finite(Um) ? 2 * Um : null, marginMs: finite(advanceMs) && finite(Um) ? advanceMs - 2 * Um : null },
  };
}

/**
 * §13.1's treated condition, in the order O2 option 1′ fixed, stopping at the
 * first failure. Every bar comes from the frozen baseline or from the constants
 * above; nothing is chosen from treated data.
 *
 * `baseline` is read from the baseline run's `summary.json` — `aggregate`,
 * `medians`, `Um` and the advance that was compiled in — and never recomputed
 * here (§13.1 item 4).
 */
export function reduceTreated(input) {
  const {
    starts = [], leads = [], frameIntervalMs, displayCadenceMs,
    plannedStarts = PLANNED_STARTS, baseline = {},
  } = input;
  const { aggregate: baselineAggregate, medians: baselineMedians = [], Um, advanceMs } = baseline;
  const usable = starts.filter((start) => start.unusable.length === 0);
  const medians = usable.map((start) => start.residual.medianMs);
  const maxHalfWidthMs = usable.length > 0 && usable.every((start) => finite(start.maxHalfWidthMs))
    ? Math.max(...usable.map((start) => start.maxHalfWidthMs)) : null;
  const U = uncertaintyMs({ displayCadenceMs, frameIntervalMs, maxHalfWidthMs });
  const spreadOf = (values) => (values.length > 0 && values.every(finite) ? Math.max(...values) - Math.min(...values) : null);
  const baselineSpread = spreadOf(baselineMedians);
  const aggregate = medians.length > 0 ? median(medians) : null;
  const gates = [];
  const result = (verdict, reason) => ({
    verdict, reason, condition: 'treated', plannedStarts,
    usableCount: usable.length, medians, aggregate, advanceMs: finite(advanceMs) ? advanceMs : null,
    U, Um: finite(Um) ? Um : null,
    baseline: { aggregate: finite(baselineAggregate) ? baselineAggregate : null, medians: baselineMedians, spread: baselineSpread },
    uncertainty: { displayCadenceMs, frameIntervalMs, maxHalfWidthMs },
    gates, starts, leads,
  });

  // The control first: an instrument that cannot say no does not get to say yes.
  const control = mechanismControl({ baselineMedians, baselineAggregate, advanceMs, Um });
  gates.push(gate('T-CONTROL', control.held, control, 'the negative control goes red, its positive twin green, and advanceMs >= 2 * Um'));
  if (!control.held) return result('INCONCLUSIVE', 'S-ADVANCE-UNRESOLVED');

  const g0 = gate('T-G0', usable.length === plannedStarts && starts.length === plannedStarts,
    { planned: plannedStarts, retained: starts.length, usable: usable.length, unusable: starts.filter((s) => s.unusable.length).map((s) => ({ label: s.label, reasons: s.unusable })) },
    'every planned treated start usable, with the advance applied');
  gates.push(g0);
  if (!g0.held) return result('INCONCLUSIVE', 'S-DIAG-EVIDENCE');

  const uGate = gate('T-U', finite(U) && U > 0 && U <= MAX_UNCERTAINTY_MS, { U, displayCadenceMs, frameIntervalMs, maxHalfWidthMs }, `0 < U <= ${MAX_UNCERTAINTY_MS}`);
  gates.push(uGate);
  if (!uGate.held) return result('INCONCLUSIVE', 'S-CADENCE');

  // 1 — every treated start meets the residual's unchanged bar.
  const missed = usable.filter((start) => start.residual.status !== 'met').map((start) => ({ label: start.label, status: start.residual.status, medianMs: start.residual.medianMs }));
  const c1 = gate('T1', missed.length === 0, { missed, statuses: usable.map((start) => start.residual.status) }, 'every treated start residual.status === met');
  gates.push(c1);
  if (!c1.held) return result('FAILED', 'S-RESIDUAL');

  // 2a — the replacement for the original condition 2.
  const worstMs = medians.length > 0 ? Math.max(...medians.map(Math.abs)) : null;
  const c2a = gate('T2a', finite(worstMs) && finite(frameIntervalMs) && worstMs <= frameIntervalMs, { worstMs, bar: frameIntervalMs }, 'max |treated median| <= frameIntervalMs');
  gates.push(c2a);
  if (!c2a.held) return result('FAILED', 'S-ADVANCE-SPREAD');

  // 2b — a translation cannot widen the spread; this is what says so.
  const treatedSpread = spreadOf(medians);
  const spreadBar = finite(baselineSpread) && finite(Um) ? baselineSpread + Um : null;
  const c2b = gate('T2b', finite(treatedSpread) && finite(spreadBar) && treatedSpread <= spreadBar, { treatedSpread, baselineSpread, Um, bar: spreadBar }, 'spread(treated) <= spread(baseline) + Um');
  gates.push(c2b);
  if (!c2b.held) return result('FAILED', 'S-ADVANCE-SPREAD');

  // Improvement — so that "no change at all" fails on the figure the repair is
  // about, and not only on the mechanism check.
  const improvementBar = finite(baselineAggregate) && finite(Um) ? Math.abs(baselineAggregate) - 2 * Um : null;
  const improvement = gate('T-IMPROVE', finite(aggregate) && finite(improvementBar) && Math.abs(aggregate) <= improvementBar,
    { aggregate, baselineAggregate, Um, bar: improvementBar }, '|aggregate treated| <= |aggregate baseline| - 2 * Um');
  gates.push(improvement);
  if (!improvement.held) return result('FAILED', 'S-ADVANCE-SPREAD');

  // The per-start lead bar: an over-advance puts a start ahead of the room.
  const maxMedian = medians.length > 0 ? Math.max(...medians) : null;
  const leadBar = finite(frameIntervalMs) ? frameIntervalMs / 2 : null;
  const perStartLead = gate('T-LEAD-BAR', finite(maxMedian) && finite(leadBar) && maxMedian <= leadBar, { maxMedian, bar: leadBar, medians }, 'max(treated medians) <= + frameIntervalMs / 2');
  gates.push(perStartLead);
  if (!perStartLead.held) return result('FAILED', 'S-LEAD');

  // 3 — the later-frame lead test, on records the controller is already acting on.
  const tailMedian = median(usable.map((start) => start.tailMs).filter(finite));
  const notHeld = leads.filter((lead) => lead.status !== 'held').map((lead) => ({ label: lead.label, status: lead.status, medianMs: lead.medianMs }));
  const c3 = gate('T3', leads.length === usable.length && notHeld.length === 0 && finite(tailMedian) && finite(U) && tailMedian <= U,
    { leads, notHeld, tailMedian, U }, 'every startLead held, and median(tailMs) <= +U');
  gates.push(c3);
  if (!c3.held) return result('FAILED', 'S-LEAD');

  // 4 — the mechanism, against the frozen Um and never against U.
  const mechanism = mechanismCheck({ treatedMedians: medians, baselineAggregate, advanceMs, Um });
  const c4 = gate('T4', mechanism.held, mechanism, '|median(treated) - (aggregate + advanceMs)| <= Um');
  gates.push(c4);
  if (!c4.held) return result('INCONCLUSIVE', 'S-ADVANCE-UNRESOLVED');

  return result('REPAIRED', null);
}

/**
 * The observed PTS lattice: where the content's frame timestamps actually sit
 * inside one frame interval. The frame origin is observed, never guessed.
 *
 * MEASURED ON THE CIRCLE, not on [0, frameIntervalMs). Chrome reports
 * `mediaTime` quantised to microseconds, so a frame whose true PTS is exactly on
 * a lattice point arrives a hair BELOW it and its remainder wraps to nearly a
 * full interval. Taken linearly, a lattice that is tight to a thousandth of a
 * millisecond reads as a dispersion of one whole interval — which is what this
 * run's first attempt reported. The centre is the
 * circular mean; the dispersion is measured against it after unwrapping.
 */
export function reduceLattice({ mediaTimeMs, frameIntervalMs, minimumFrames = 48 }) {
  const values = (mediaTimeMs ?? []).filter(finite);
  const empty = { latticeOffsetMs: null, frameCount: values.length, dispersionMs: null, usable: false };
  if (!finite(frameIntervalMs) || frameIntervalMs <= 0 || values.length === 0) return empty;

  const offsets = values.map((value) => positiveMod(value, frameIntervalMs));
  const turn = (2 * Math.PI) / frameIntervalMs;
  const sine = offsets.reduce((total, offset) => total + Math.sin(offset * turn), 0) / offsets.length;
  const cosine = offsets.reduce((total, offset) => total + Math.cos(offset * turn), 0) / offsets.length;
  // Every frame on opposite sides of the interval leaves no centre to speak of.
  if (Math.hypot(sine, cosine) < 1e-6) return { ...empty, dispersionMs: frameIntervalMs };
  const centreMs = positiveMod(Math.atan2(sine, cosine) / turn, frameIntervalMs);

  // Each offset as a signed distance from the centre, in (−interval/2, interval/2].
  const half = frameIntervalMs / 2;
  const residuals = offsets.map((offset) => positiveMod(offset - centreMs + half, frameIntervalMs) - half).sort((a, b) => a - b);
  const dispersionMs = percentile(residuals, 0.95) - percentile(residuals, 0.05);
  return {
    latticeOffsetMs: positiveMod(centreMs + medianOfSorted(residuals), frameIntervalMs),
    frameCount: values.length,
    dispersionMs,
    centreMs,
    usable: values.length >= minimumFrames && finite(dispersionMs) && dispersionMs <= frameIntervalMs / 4,
  };
}

// ---------------------------------------------------------------------------
// In-page expressions. Each returns a string for CDP `Runtime.evaluate`.
// ---------------------------------------------------------------------------

/** The raw-socket host page: a document on the right origin with no player. */
export function probeHostExpression({ origin }) {
  return `(() => ({ origin: location.origin, matches: location.origin === ${JSON.stringify(origin)}, hasVideo: document.querySelector('video') !== null }))()`;
}

/** The shared instant a raw socket can honestly name: the SERVER's own stamp. */
const sharedFromEnvelope = `(env) => (env && env.ts && Number.isFinite(env.ts.recv) ? env.ts.recv : null)`;

/** Join `room` as a viewer over a raw socket and keep the room's sequence. */
const rawSocket = (room, tabId) => `
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    const state = { joined: false, clientId: null, lastSeq: 0, sent: null, error: null, done: false };
    const sharedOf = ${sharedFromEnvelope};
    ws.addEventListener('open', () => ws.send(JSON.stringify({ v: 1, type: 'join', to: 'server', payload: { room: ${JSON.stringify(room)}, tabId: ${JSON.stringify(tabId)}, role: 'viewer' } })));
    ws.addEventListener('error', () => { state.error = state.error ?? 'probe socket error'; });
    ws.addEventListener('close', () => { state.error = state.error ?? 'probe socket closed'; });`;

/**
 * The answering member for the `load` condition. It has no clock of its own, so
 * the mapping's instant is built from the REQUEST's server stamp plus the lead
 * — never from a renderer instant joined to another page's offset.
 */
export function probeStateExpression({ room, lineage, mapping, tabId = 'H-state' }) {
  const { playing = true, mediaMs, leadMs } = mapping;
  return `(() => {${rawSocket(room, tabId)}
    ws.addEventListener('message', (event) => {
      let env;
      try { env = JSON.parse(event.data); } catch { return; }
      if (Number.isInteger(env.seq)) state.lastSeq = Math.max(state.lastSeq, env.seq);
      if (env.type === 'error') { state.error = 'server refused: ' + env.payload?.code + ' ' + env.payload?.reason; return; }
      if (env.type === 'joined') { state.joined = true; state.clientId = env.payload?.clientId ?? null; return; }
      if (env.type !== 'playback-state-request') return;
      const recv = sharedOf(env);
      if (recv === null) { state.error = 'request carried no server stamp'; return; }
      const answer = {
        state: {
          lineage: ${JSON.stringify(lineage)},
          version: 1,
          current: { playing: ${playing}, atSharedMs: recv + ${leadMs}, mediaMs: ${mediaMs} },
          previous: null,
          controlMode: 'open',
        },
        throughSeq: state.lastSeq,
      };
      try {
        ws.send(JSON.stringify({ v: 1, type: 'playback-state-answer', to: env.from, replyTo: env.id, payload: answer }));
        state.sent = { atSharedMs: answer.state.current.atSharedMs, mediaMs: ${mediaMs}, throughSeq: state.lastSeq, to: env.from };
        state.done = true;
      } catch (error) { state.error = String(error?.message ?? error); }
    });
    window.__startProbe = state;
    return { installed: true };
  })()`;
}

/**
 * The `resume` condition. The socket echoes the server once to learn a fresh
 * shared instant, then issues one seek at that instant plus the lead — inside
 * MAX_FUTURE_MS and far enough ahead that the client's S is the operation's own
 * instant, so the park lands on the requested position by construction.
 */
export function probeSeekExpression({ room, positionMs, basis, leadMs, tabId = 'H-seek' }) {
  return `(() => new Promise((resolve) => {${rawSocket(room, tabId)}
    const fail = (why) => { state.error = state.error ?? why; resolve({ ...state }); };
    const deadline = setTimeout(() => fail('seek probe deadline'), 15000);
    ws.addEventListener('message', (event) => {
      let env;
      try { env = JSON.parse(event.data); } catch { return; }
      if (Number.isInteger(env.seq)) state.lastSeq = Math.max(state.lastSeq, env.seq);
      if (env.type === 'error') { clearTimeout(deadline); fail('server refused: ' + env.payload?.code + ' ' + env.payload?.reason); return; }
      if (env.type === 'joined') {
        state.joined = true;
        state.clientId = env.payload?.clientId ?? null;
        ws.send(JSON.stringify({ v: 1, type: 'echo', to: 'server', id: 'seek-clock', payload: null }));
        return;
      }
      if (env.type !== 'echo-reply' || env.replyTo !== 'seek-clock' || state.sent) return;
      const recv = sharedOf(env);
      if (recv === null) { clearTimeout(deadline); fail('echo carried no server stamp'); return; }
      const atSharedMs = recv + ${leadMs};
      try {
        ws.send(JSON.stringify({ v: 1, type: 'playback-operation', to: 'room', payload: { kind: 'seek', basis: ${JSON.stringify(basis)}, atSharedMs, positionMs: ${positionMs} } }));
        state.sent = { atSharedMs, positionMs: ${positionMs} };
      } catch (error) { clearTimeout(deadline); fail(String(error?.message ?? error)); return; }
      clearTimeout(deadline);
      state.done = true;
      resolve({ ...state });
    });
  }))()`;
}

/**
 * Cheap enough to poll: the counts, the identity, and the one start this window
 * is about — `first` for a fresh document, `last` for a start armed into a
 * running page (`captureBoundary`). The record count is read against THAT
 * start's `afterSeq`, so no other start's records can satisfy the wait.
 */
export function progressExpression(cursor = 0, pick = 'last') {
  if (pick !== 'first' && pick !== 'last') throw new RangeError(`progressExpression: pick must be first or last, got ${JSON.stringify(pick)}`);
  return `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  const playback = app.playback();
  const starts = playback.starts;
  const chosen = starts.length === 0 ? null : (${pick === 'first'} ? starts[0] : starts[starts.length - 1]);
  const drift = chosen ? app.drift(chosen.afterSeq) : null;
  const reading = app.startTiming(${cursor});
  return {
    present: true, playing: playback.playing, opens: playback.opens, begun: playback.begun,
    retargets: playback.retargets, startCount: starts.length, chosen,
    recordCount: drift ? drift.records.length : 0, driftMissed: drift ? drift.missed : null,
    enabled: reading.enabled, latestSeq: reading.latestSeq, missed: reading.missed, dropped: reading.dropped,
    identity: app.timeline()?.identity ?? null,
    clockOffsetMs: app.clock()?.offsetMs ?? null,
    currentTimeMs: null,
  };
})()`;
}

/** Both streams for one start, each from its own cursor. */
export function drainExpression(cursor, afterSeq) {
  return `(() => {
  const app = window.__app;
  const reading = app.startTiming(${cursor});
  const drift = app.drift(${afterSeq});
  return {
    events: reading.events, missed: reading.missed, dropped: reading.dropped, latestSeq: reading.latestSeq,
    records: drift.records, recordsMissed: drift.missed, counters: drift.counters,
  };
})()`;
}

/** The measured window's telemetry frames, for the lattice and for retention. */
export function latticeExpression(afterSeq = 0) {
  return `(() => {
    const reading = window.__app?.startTiming?.(${afterSeq});
    if (!reading || reading.enabled !== true) return { enabled: false, mediaTimeMs: [], latestSeq: 0 };
    return {
      enabled: true,
      latestSeq: reading.latestSeq,
      missed: reading.missed,
      dropped: reading.dropped,
      mediaTimeMs: reading.events.filter((event) => event.kind === 'frame' && event.paused === false).map((event) => event.mediaTimeMs),
    };
  })()`;
}

/**
 * The rate pin. The own accessor on the prototype stores and returns the
 * COMMANDED rate and never reaches the native setter, so the element plays at
 * exactly 1.0 whatever the controller asks for — and the native readback stays
 * reachable, which is what makes the lever falsifiable instead of believed.
 */
export function rateShimScript() {
  return `(() => {
    const proto = HTMLMediaElement.prototype;
    const native = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
    if (!native || typeof native.get !== 'function' || typeof native.set !== 'function') {
      window.__rateShim = { installed: false, reason: 'no native playbackRate accessor' };
      return;
    }
    const writes = [];
    let commanded = 1;
    Object.defineProperty(proto, 'playbackRate', {
      configurable: true,
      enumerable: native.enumerable,
      get() { return commanded; },
      set(value) {
        writes.push({ value, atLocalMs: performance.timeOrigin + performance.now() });
        commanded = value;
      },
    });
    const element = () => document.querySelector('video');
    window.__rateShim = {
      installed: true,
      writes: () => writes.slice(),
      commanded: () => commanded,
      nativeReadback: () => (element() ? native.get.call(element()) : null),
      nativeWrite: (value) => { if (element()) native.set.call(element(), value); },
    };
  })();`;
}

/** The shim's own reading, for the qualification and for every start's G0 check. */
export function rateShimStateExpression() {
  return `(() => {
    const shim = window.__rateShim;
    if (!shim || shim.installed !== true) return { installed: false, nativeReadback: null, writes: [], reason: shim?.reason ?? 'shim not installed' };
    return { installed: true, nativeReadback: shim.nativeReadback(), commanded: shim.commanded(), writes: shim.writes() };
  })()`;
}
