// scripts/check/d8-research-controller.mjs
//
// A RESEARCH COPY of `public/lib/drift-controller.mjs`, carrying the positive-floor stopping
// policy that the product controller refuses to construct. It is test machinery
// under scripts/: nothing under public/ imports it, no product setting changes,
// and the product's positive-floor construction refusal stands untouched.
//
// It is a copy in structure only. Every piece of arithmetic that the product
// exports — the quantile, the allowance, the threshold components, the shortest
// close and the declining reason — is IMPORTED from the product module rather
// than restated, so this file cannot drift into a second estimator with slightly
// different numbers. Only `median`, `spread` and `displayLocalOf` are copied,
// because the product does not export them.
//
// The five behavioural differences from the product controller, and nothing
// else (`remedy-comparison-spec.md`, "Test-only implementation and equivalence"):
//
//  1. Construction accepts a finite f in [0, MAX_RATE_DEVIATION]. The 20 ms
//     ceiling stays exactly as fixed; an override may not move it either way.
//  2. At positive f, a required S above that ceiling is a REFUSAL: exact unity,
//     no accepted threshold, no live close figure, dwell cleared at once, and
//     the historical first settling time preserved.
//  3. At positive f, the RATE_EPSILON write filter is bypassed for entering or
//     leaving unity and for a corrective sign change. Nearby same-direction
//     writes are still filtered.
//  4. Every applied non-unity command is checked against f and the authority.
//     This is a check, not a clamp: the geometry already guarantees it, because
//     just outside S the excess over U is at least L = f × T.
//  5. At f = 0 every one of the above is inert, so the f = 0 copy must produce
//     byte-identical applied streams and poll histories to the product.
//
// One further difference is SELECTED AT CONSTRUCTION and off by default
// (research only):
//
//  6. `refusalPolicy: 'split-outside-required-threshold'` splits the refusal in
//     2. A refused poll whose |estimate| is at or inside the REQUIRED S still
//     holds exact unity. One outside it keeps the unchanged command law —
//     measured from U, clamped at the authority, through the unchanged write
//     filter — under its own mode, with no accepted threshold, no close figure
//     and the dwell and latch cleared exactly as a hold clears them. It never
//     settles. This is a research relaxation of compulsory unity, not a proof
//     that the correction cannot overshoot: U is a spread, not a certified
//     bound on the rolling median's bias, and poll spacing is not guaranteed.
//     The default policy is the unity hold every earlier run used.
//
// TEST MACHINERY — under scripts/. No DOM, no timers, no clock read of its own.

import {
  MAX_RATE_DEVIATION,
  TIME_CONSTANT_MS,
  ESTIMATE_WINDOW_MS,
  STALE_AFTER_MS,
  MIN_RECORDS,
  SETTLED_FOR_MS,
  CLOSE_BUDGET_MS,
  RATE_EPSILON,
  MIN_COMMAND_DEVIATION,
  MAX_STOPPING_THRESHOLD_MS,
  quantile,
  actuatorAllowanceMs,
  thresholdComponents,
  shortestCloseMs,
  decliningReason,
} from '../../public/lib/drift-controller.mjs';
import { olaWindowSamples } from './mechanism-audio.mjs';

/** The declared positive-candidate model domain. NOT a claim about devices. */
export const D8_MODEL_SAMPLE_RATES = Object.freeze([44100, 48000, 96000]);
/** Explicit experimental headroom past the copy boundary, not a fitted constant. */
export const D8_THRESHOLD_HEADROOM = 0.000001;
export const D8_HOLD_MODE = 'resolution-budget-hold';
export const D8_HOLD_REASON = 'stopping-threshold-over-budget';
/** The refused poll that keeps correcting. Same reason as the hold: the
 *  threshold was refused either way; only what the rate does differs. */
export const D8_UNCERTIFIED_MODE = 'uncertified-correction';
export const D8_REFUSAL_POLICIES = Object.freeze({
  unityHold: 'unity-hold',
  split: 'split-outside-required-threshold',
});
export const D8_REFUSAL_MODES = Object.freeze([D8_HOLD_MODE, D8_UNCERTIFIED_MODE]);
/** The only slack allowed when checking an applied rate, and it is IEEE-754
 *  arithmetic slack near 1.0 — never a ppm acceptance allowance. */
export const COMMAND_TOLERANCE = 8 * Number.EPSILON;

/**
 * f — the smallest command deviation that leaves the modelled copy branch at
 * every rate in the domain, plus the declared headroom. The copy region's upper
 * open endpoint is N/(N−1), so the smallest deviation strictly outside it is
 * 1/(N−1), and the SMALLEST window in the domain sets the largest of those.
 * Computed from the formula every time it is needed; the printed ppm figure is
 * a rendering of this number and is never the input to anything.
 */
export function commandThresholdFor(sampleRates = D8_MODEL_SAMPLE_RATES, headroom = D8_THRESHOLD_HEADROOM) {
  if (!Array.isArray(sampleRates) || sampleRates.length === 0) throw new RangeError('d8-research-controller: the sample-rate domain must be a non-empty list');
  const bounds = sampleRates.map((sampleRate) => 1 / (olaWindowSamples(sampleRate) - 1));
  return Math.max(...bounds) + headroom;
}

const BASE_RATE = 1;
const DEFAULT_SETTINGS = Object.freeze({
  MAX_RATE_DEVIATION,
  TIME_CONSTANT_MS,
  ESTIMATE_WINDOW_MS,
  STALE_AFTER_MS,
  MIN_RECORDS,
  SETTLED_FOR_MS,
  CLOSE_BUDGET_MS,
  RATE_EPSILON,
  MIN_COMMAND_DEVIATION,
  MAX_STOPPING_THRESHOLD_MS,
});

// Copied verbatim from the product controller: unexported there, identical here.
function median(sorted) {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spread(sorted) {
  return quantile(sorted, 0.95) - quantile(sorted, 0.05);
}

function displayLocalOf(record) {
  return record.displaySharedMs - record.clock.offsetMs;
}

/**
 * The product contract with ONE clause replaced. Where the product refuses any
 * positive floor because none was calibrated, this copy requires a floor the
 * actuator could actually issue: finite, not negative, and not past the rate
 * authority, since a threshold above the authority names a command the loop can
 * never write.
 */
function validateSettings(settings) {
  const floor = settings.MIN_COMMAND_DEVIATION;
  const refuse = (message) => { throw new RangeError(`d8-research-controller: ${message}`); };
  const finite = ['MIN_COMMAND_DEVIATION', 'TIME_CONSTANT_MS', 'MAX_RATE_DEVIATION', 'RATE_EPSILON'];
  for (const name of finite) if (!Number.isFinite(settings[name])) refuse(`${name} must be a finite number, got ${settings[name]}`);
  if (floor < 0) refuse(`MIN_COMMAND_DEVIATION must not be negative, got ${floor}`);
  if (settings.TIME_CONSTANT_MS <= 0) refuse(`TIME_CONSTANT_MS must be positive, got ${settings.TIME_CONSTANT_MS}`);
  if (settings.MAX_RATE_DEVIATION < 0 || settings.MAX_RATE_DEVIATION >= 1) refuse(`MAX_RATE_DEVIATION must be in [0, 1), got ${settings.MAX_RATE_DEVIATION}`);
  if (floor > settings.MAX_RATE_DEVIATION) refuse(`MIN_COMMAND_DEVIATION ${floor} exceeds the rate authority ${settings.MAX_RATE_DEVIATION}`);
  if (settings.RATE_EPSILON < 0) refuse(`RATE_EPSILON must not be negative, got ${settings.RATE_EPSILON}`);
  if (settings.MAX_STOPPING_THRESHOLD_MS !== MAX_STOPPING_THRESHOLD_MS) refuse(`MAX_STOPPING_THRESHOLD_MS is fixed at ${MAX_STOPPING_THRESHOLD_MS}, got ${settings.MAX_STOPPING_THRESHOLD_MS}`);
}

export function createD8ResearchController({ log, clock, apply, settings: overrides = {}, now, refusalPolicy = D8_REFUSAL_POLICIES.unityHold }) {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
  validateSettings(settings);
  if (!Object.values(D8_REFUSAL_POLICIES).includes(refusalPolicy)) {
    throw new RangeError(`d8-research-controller: refusalPolicy must be one of ${Object.values(D8_REFUSAL_POLICIES).join(', ')}, got ${refusalPolicy}`);
  }
  const splitRefusal = refusalPolicy === D8_REFUSAL_POLICIES.split;
  const allowanceMs = actuatorAllowanceMs(settings.MIN_COMMAND_DEVIATION, settings.TIME_CONSTANT_MS);
  const floorRate = settings.MIN_COMMAND_DEVIATION;
  const positiveFloor = floorRate > 0;
  let cursor = 0;
  let records = [];
  let lastReanchors = null;
  let lastSeenAt = null;
  let dropCutoffSeq = 0;
  let recordsSinceDrop = 0;
  let staleHold = false;
  let pendingSeams = [];
  let restatements = 0;
  let lastOffsetMs = null;
  let firstCorrectionAt = null;
  let insideBandAt = null;
  let settledLatched = false;
  let excursionAt = null;
  let estimateMs = null;
  let bandMs = null;
  let spreadMs = null;
  let halfWidthMs = null;
  let measurementLimit = null;
  let requiredStoppingThresholdMs = null;
  let stoppingThresholdMs = null;
  let thresholdUsable = false;
  let windowRecords = 0;
  let controlRecords = 0;
  let fastestCloseMs = null;
  let mode = 'waiting';
  let reason = 'no-clock';
  let lastDrop = null;
  let rate = BASE_RATE;
  let correctionsApplied = 0;
  let polls = 0;
  let settlingMs = null;
  let budgetRefusals = 0;
  const seams = [];
  const drops = { seam: 0, reanchor: 0, stale: 0 };

  function unlatch() {
    insideBandAt = null;
    settledLatched = false;
    excursionAt = null;
  }

  function drop(dropReason, atMs, cutoffSeq) {
    drops[dropReason] += 1;
    dropCutoffSeq = Math.max(dropCutoffSeq, cutoffSeq);
    recordsSinceDrop = 0;
    staleHold = dropReason === 'stale';
    unlatch();
    lastDrop = { reason: dropReason, atMs };
  }

  function hold(atMs, nextMode, nextReason) {
    applyRate(BASE_RATE, atMs);
    unlatch();
    stoppingThresholdMs = null;
    thresholdUsable = false;
    fastestCloseMs = null;
    mode = nextMode;
    reason = nextReason;
  }

  /**
   * Which writes the RATE_EPSILON filter may not swallow once f is positive.
   * With RATE_EPSILON larger than f, +f to −f is a 2f step the product filter
   * would drop, leaving the element commanded the wrong way; and the return to
   * exact unity that a stop or a refusal asks for would never reach the player
   * at all. Both are transitions, so both are named here rather than handled by
   * shrinking the filter, which would also let same-direction noise through.
   */
  function transitionRequiresWrite(nextRate) {
    if (!positiveFloor || nextRate === rate) return false;
    if ((nextRate === BASE_RATE) !== (rate === BASE_RATE)) return true;
    return Math.sign(nextRate - BASE_RATE) !== Math.sign(rate - BASE_RATE);
  }

  /**
   * A CHECK, NOT A CLAMP. Just outside S the error exceeds U by at least
   * L = f × T, so `excess / T` is at least f without any minimum-rate write:
   * this asserts that geometry held rather than manufacturing it, and a failure
   * is a defect in the branch above, not a value to be rounded into range.
   */
  function assertCommandInRange(nextRate) {
    const deviation = Math.abs(nextRate - BASE_RATE);
    if (deviation === 0) return;
    if (deviation < floorRate - COMMAND_TOLERANCE) throw new RangeError(`d8-research-controller: applied deviation ${deviation} is below the command threshold ${floorRate}`);
    if (deviation > settings.MAX_RATE_DEVIATION + COMMAND_TOLERANCE) throw new RangeError(`d8-research-controller: applied deviation ${deviation} exceeds the rate authority ${settings.MAX_RATE_DEVIATION}`);
  }

  /** The one command law, shared by the accepted branch and the split so the
   *  two cannot drift apart: the excess over U, never over S, clamped at the
   *  authority. */
  function correctionFor(estimate, band) {
    const excess = Math.sign(estimate) * Math.max(0, Math.abs(estimate) - band);
    return Math.max(-settings.MAX_RATE_DEVIATION, Math.min(settings.MAX_RATE_DEVIATION, -excess / settings.TIME_CONSTANT_MS));
  }

  function applyRate(nextRate, atMs) {
    if (Math.abs(nextRate - rate) <= settings.RATE_EPSILON && !transitionRequiresWrite(nextRate)) return;
    assertCommandInRange(nextRate);
    apply(nextRate);
    rate = nextRate;
    correctionsApplied += 1;
    if (nextRate !== BASE_RATE && firstCorrectionAt === null) firstCorrectionAt = atMs;
  }

  function snapshot() {
    return {
      rate,
      estimateMs,
      bandMs,
      spreadMs,
      halfWidthMs,
      measurementLimit,
      actuatorAllowanceMs: allowanceMs,
      requiredStoppingThresholdMs,
      stoppingThresholdMs,
      thresholdUsable,
      windowRecords,
      controlRecords,
      mode,
      reason,
      settings,
      correctionsApplied,
      polls,
      settlingMs,
      fastestCloseMs,
      counters: { drops: { ...drops }, restatements, budgetRefusals },
      lastDrop: lastDrop ? { ...lastDrop } : null,
    };
  }

  function poll() {
    polls += 1;
    const atMs = now();
    const estimate = clock.read();
    const offsetMs = estimate.offsetMs;

    const reanchors = estimate.counters?.reanchors;
    if (lastReanchors === null) lastReanchors = reanchors ?? 0;
    else if (Number.isFinite(reanchors)) {
      for (let i = lastReanchors; i < reanchors; i++) drop('reanchor', atMs, log.latestSeq);
      lastReanchors = reanchors;
    }
    for (const seam of pendingSeams) drop('seam', atMs, seam.afterSeq);
    pendingSeams = [];

    if (offsetMs === null) {
      estimateMs = null;
      bandMs = null;
      spreadMs = null;
      halfWidthMs = null;
      measurementLimit = null;
      requiredStoppingThresholdMs = null;
      windowRecords = 0;
      controlRecords = 0;
      hold(atMs, 'waiting', 'no-clock');
      return snapshot();
    }

    const beforeReadSeq = cursor;
    const read = log.read({ afterSeq: cursor });
    cursor = read.latestSeq;
    const incoming = read.records;
    for (const record of incoming) {
      records.push(record);
      if (record.seq > dropCutoffSeq) recordsSinceDrop += 1;
    }
    if (incoming.length > 0) {
      lastSeenAt = displayLocalOf(incoming.at(-1));
      staleHold = false;
    } else if (lastSeenAt === null) {
      lastSeenAt = atMs;
    }

    if (atMs - lastSeenAt >= settings.STALE_AFTER_MS && !staleHold) {
      drop('stale', atMs, cursor);
    }

    halfWidthMs = Number.isFinite(estimate.halfWidthMs) ? estimate.halfWidthMs : null;
    const windowStart = atMs - settings.ESTIMATE_WINDOW_MS;
    const rolling = records.filter((record) => displayLocalOf(record) > windowStart);
    windowRecords = rolling.length;
    const controlWindow = rolling.filter((record) => record.seq > dropCutoffSeq);
    controlRecords = controlWindow.length;

    const offsetChanged = lastOffsetMs !== offsetMs;
    for (const record of controlWindow) {
      if (record.clock.offsetMs === offsetMs) continue;
      if (offsetChanged || record.seq > beforeReadSeq) restatements += 1;
    }
    lastOffsetMs = offsetMs;

    if (controlWindow.length > 0) {
      const values = controlWindow
        .map((record) => record.driftMs + record.clock.offsetMs - offsetMs)
        .sort((a, b) => a - b);
      estimateMs = median(values);
      spreadMs = spread(values);
    } else {
      estimateMs = null;
      spreadMs = null;
    }
    ({ bandMs, measurementLimit, requiredStoppingThresholdMs } = thresholdComponents({ halfWidthMs, spreadMs, allowanceMs }));

    if (staleHold) {
      hold(atMs, 'stale', 'no-records');
    } else if (recordsSinceDrop < settings.MIN_RECORDS || estimateMs === null) {
      hold(atMs, 'waiting', 'too-few-records');
    } else if (positiveFloor && requiredStoppingThresholdMs > settings.MAX_STOPPING_THRESHOLD_MS) {
      // THE INPUT WAS VALID AND THE ANSWER IS STILL A REFUSAL. Measurement plus
      // allowance needs more room than the largest stopping threshold allowed,
      // so there is no threshold to accept and nothing to declare settled inside.
      // `hold` publishes exact unity, drops the accepted S and the close figure,
      // and clears the dwell in the same step — a latch surviving this would let
      // the next poll inherit a dwell served under a threshold that was refused.
      // `requiredStoppingThresholdMs` stays published, because what the poll
      // needed is the whole finding; `settlingMs` stays because it is history.
      budgetRefusals += 1;
      if (splitRefusal && Math.abs(estimateMs) > requiredStoppingThresholdMs) {
        // THE SPLIT (difference 6). Outside the required S no stopping
        // question is open, so the unchanged law keeps running. Everything a
        // refusal withholds is still withheld: no accepted S, no close figure,
        // and the latch cleared, so no poll of this mode can settle or carry a
        // dwell into the next one.
        applyRate(BASE_RATE + correctionFor(estimateMs, bandMs), atMs);
        unlatch();
        stoppingThresholdMs = null;
        thresholdUsable = false;
        fastestCloseMs = null;
        mode = D8_UNCERTIFIED_MODE;
        reason = D8_HOLD_REASON;
      } else {
        hold(atMs, D8_HOLD_MODE, D8_HOLD_REASON);
      }
    } else {
      stoppingThresholdMs = requiredStoppingThresholdMs;
      thresholdUsable = true;
      fastestCloseMs = shortestCloseMs(estimateMs, stoppingThresholdMs, settings.MAX_RATE_DEVIATION);
      const correction = correctionFor(estimateMs, bandMs);
      const inside = Math.abs(estimateMs) <= stoppingThresholdMs;
      if (inside) excursionAt = null;
      else if (settledLatched && excursionAt === null) excursionAt = atMs;
      const believed = !inside && (!settledLatched || atMs - excursionAt >= settings.ESTIMATE_WINDOW_MS);
      applyRate(believed ? BASE_RATE + correction : BASE_RATE, atMs);
      if (believed) {
        insideBandAt = null;
        settledLatched = false;
        mode = fastestCloseMs === null || fastestCloseMs > settings.CLOSE_BUDGET_MS ? 'beyond-rate-authority' : 'correcting';
        reason = null;
      } else {
        if (insideBandAt === null) insideBandAt = atMs;
        if (firstCorrectionAt !== null && atMs - insideBandAt >= settings.SETTLED_FOR_MS) {
          settledLatched = true;
          if (settlingMs === null) settlingMs = atMs - firstCorrectionAt;
        }
        mode = settledLatched ? 'settled' : 'declining';
        reason = settledLatched ? null : decliningReason(estimateMs, bandMs);
      }
    }

    records = rolling;
    return snapshot();
  }

  function markSeam({ afterSeq, epochMs, positionMs }) {
    const seam = { afterSeq, epochMs, positionMs };
    seams.push(seam);
    pendingSeams.push(seam);
  }

  return {
    poll,
    state: snapshot,
    markSeam,
    // Beside the snapshot, not in it: the f = 0 equivalence compares snapshots
    // with the product field by field, and the product has no such policy.
    refusalPolicy,
    get seams() {
      return seams.map((seam) => ({ ...seam }));
    },
  };
}
