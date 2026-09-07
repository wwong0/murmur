// scripts/drift-figures.mjs
//
// The arithmetic and the verdicts the browser pass reports: samples and records
// in, numbers and English out. No CDP, no tab, no clock read — every function
// here is pure, so the pass's figures can be exercised without Chrome even
// though the pass that produces them cannot.
//
// It is separate from verify-browser.mjs because the driver is a sequence of
// windows, waits and assertions and nothing else: three hundred lines of
// statistics inside it left neither half readable, and put the arithmetic behind
// a five-minute browser run that cannot be asked to re-verify it.
//
// Exports are the figures and pure helpers used by verify-browser.mjs and its
// check suite; keeping them here makes the diagnosis arithmetic independently testable.
//
// TEST MACHINERY. Nothing in the product imports this.

import { median } from '../public/lib/frame-drift.mjs';
import { DECLINING_REASONS, quantile } from '../public/lib/drift-controller.mjs';
import { plant } from './check/drift-plant.mjs';

/**
 * DID THIS POLL ACT ON A VALID MEASUREMENT? Not "is its reason null": declining
 * inside the threshold now names which limit held it, and reading the absence of
 * a reason as the whole valid-input population would drop every quiet stretch
 * out of the figures the moment the controller started explaining itself.
 *
 * An allow-list, so an input hold, a resolution-budget refusal and any reason a
 * later branch invents are excluded without this file being edited again. 4d
 * evidence predates the declining reasons and carries `null` for the same
 * states, which is why the old value stays in the list rather than beside it.
 */
export function actedOnMeasurement(sample) {
  return sample?.reason === null || DECLINING_REASONS.includes(sample?.reason);
}

// Current snapshots carry all additive fields. An older 4d capture carries
// none and may use bandMs as S; a partial current snapshot is malformed.
const THRESHOLD_FIELDS = Object.freeze([
  'actuatorAllowanceMs',
  'requiredStoppingThresholdMs',
  'stoppingThresholdMs',
  'thresholdUsable',
  'measurementLimit',
]);

export function thresholdContractOf(sample) {
  const object = sample !== null && typeof sample === 'object' ? sample : {};
  const hasAnyCurrentField = THRESHOLD_FIELDS.some((field) => Object.hasOwn(object, field));
  if (!hasAnyCurrentField) {
    const stoppingThresholdMs = Number.isFinite(object.bandMs) ? object.bandMs : null;
    return { schema: 'legacy-4d', usable: stoppingThresholdMs !== null, stoppingThresholdMs };
  }
  const complete = THRESHOLD_FIELDS.every((field) => Object.hasOwn(object, field));
  const usable = complete && object.thresholdUsable === true && Number.isFinite(object.stoppingThresholdMs);
  return {
    schema: complete ? 'current' : 'malformed-new',
    usable,
    stoppingThresholdMs: usable ? object.stoppingThresholdMs : null,
  };
}

export function acceptedStoppingThresholdMs(sample) {
  const contract = thresholdContractOf(sample);
  return contract.usable ? contract.stoppingThresholdMs : null;
}

/** The converged span T6 anchors: below this many records the span reports nothing (count). */
export const MIN_CONVERGED_RECORDS = 120;
/** room.entry.js's controller poll interval; excursions report observed runs, not this conversion (ms). */
const EXCURSION_POLL_MS = 250;
/** Fraction at or above which finite, nonzero difference pairs are period-2-like. */
const PERIODICITY_LIKE = 0.8;
/** Fraction at or below which finite, nonzero difference pairs are not period-2-like. */
const PERIODICITY_NOT_LIKE = 0.6;
/** Dimensionless multiplier applied to the predicted half-vsync floor. */
const FLOOR_MULTIPLIER = 1.5;
/** The duty cycle the simulated plant asserts, which a browser run either clears or does not (fraction). */
const PLANT_ASSERTED_FLOOR = 0.8;
/** Fraction at or above which the whole-window rate trend is called effective. */
const RATE_EFFECTIVE = 0.5;
/** Fraction below which the whole-window rate trend cannot discriminate a held error. */
const RATE_INEFFECTIVE = 0.1;
/** One sweep step of 4a's standing-error sweep — the resolution its reference figures have. */
const STANDING_LAG_MATCH_MS = 20;
/** 3b's measured standing lag, as a band rather than a point (ms). */
const MEASURED_BAND_MIN_MS = 100;
const MEASURED_BAND_MAX_MS = 240;
/** 4a's largest movement of the median between two consecutive controller polls (ms). */
export const PLANT_MEDIAN_MOVEMENT_MS = 1.32;

// T4's diagnosis bars. They are exported so the browser pass can carry the
// exact regime it judged into its retained figures, while every fit still
// receives its bars explicitly and remains useful with constructed values.
export const RATE_STEADY_TOLERANCE = 2e-5;
export const STRETCH_EDGE_EXCLUSION_MS = 1500;
export const MIN_STRETCH_SPAN_MS = 5000;
export const MIN_STRETCH_RECORDS = 120;
export const MIN_RESIDUAL_SPAN_MS = 20000;
export const MIN_RESIDUAL_RECORDS = 480;
export const MAX_STRETCH_SLOPE_SE_PPM = 1000;
export const MAX_RESIDUAL_SLOPE_SE_PPM = 100;
export const SLOPE_SIGNIFICANCE_SIGMA = 3;
export const RESIDUAL_FLOOR_PPM = 50;
export const ENDPOINT_CROSSCHECK_MS = 48;

export const DEFAULT_BARS = Object.freeze({
  RATE_STEADY_TOLERANCE,
  STRETCH_EDGE_EXCLUSION_MS,
  MIN_STRETCH_SPAN_MS,
  MIN_STRETCH_RECORDS,
  MIN_RESIDUAL_SPAN_MS,
  MIN_RESIDUAL_RECORDS,
  MAX_STRETCH_SLOPE_SE_PPM,
  MAX_RESIDUAL_SLOPE_SE_PPM,
  SLOPE_SIGNIFICANCE_SIGMA,
  RESIDUAL_FLOOR_PPM,
  ENDPOINT_CROSSCHECK_MS,
});

// THE CANONICAL PAIR from frame-drift.mjs, never a local definition of the
// middle of an even set. The only thing added is the empty case: these figures
// are printed, and `null` is what the run prints for a quantity it does not have.
const middleOf = (sorted) => (sorted.length === 0 ? null : median(sorted));
const ascending = (left, right) => left - right;

/**
 * The refresh rate, from the raw `requestAnimationFrame` timestamps the page
 * collected. The statistics are taken HERE rather than in the page: an in-page
 * median is a fifth copy of the one above, and the stamps are the measurement.
 */
export function refreshFrom(stamps) {
  const deltas = [];
  for (let i = 1; i < (stamps?.length ?? 0); i++) deltas.push(stamps[i] - stamps[i - 1]);
  deltas.sort(ascending);
  const medianDelta = middleOf(deltas);
  const medianDeltaMs = Number.isFinite(medianDelta) && medianDelta > 0 ? medianDelta : null;
  return {
    frameCount: stamps?.length ?? 0,
    medianDeltaMs,
    refreshRateHz: Number.isFinite(medianDeltaMs) && medianDeltaMs > 0 ? 1000 / medianDeltaMs : null,
  };
}

/**
 * The span after the anchoring record, and nothing before it. Both figures are
 * withheld until the span is long enough to be one, so a short span reports
 * `null` rather than a median of eleven frames.
 */
export function convergedStats(seam, barSeq) {
  const records = (seam?.records ?? []).filter((record) => record.seq > barSeq);
  const drifts = records.map((record) => record.driftMs).sort(ascending);
  const enough = records.length >= MIN_CONVERGED_RECORDS && records.every((record) => Number.isFinite(record.driftMs));
  return {
    records,
    convergedCount: records.length,
    convergedMedianMs: enough ? middleOf(drifts) : null,
    convergedSpreadMs: enough ? quantile(drifts, 0.95) - quantile(drifts, 0.05) : null,
  };
}

/** How often consecutive differences change sign — a period-2 cadence alternates almost always. */
export function alternationStats(records) {
  let totalPairs = 0;
  let nonzeroPairs = 0;
  let zeroPairs = 0;
  let alternating = 0;
  for (let i = 1; i < records.length - 1; i++) {
    if (!Number.isFinite(records[i - 1].driftMs)
      || !Number.isFinite(records[i].driftMs)
      || !Number.isFinite(records[i + 1].driftMs)) continue;
    const previous = records[i].driftMs - records[i - 1].driftMs;
    const next = records[i + 1].driftMs - records[i].driftMs;
    if (!Number.isFinite(previous) || !Number.isFinite(next)) continue;
    totalPairs++;
    if (previous === 0 || next === 0) {
      zeroPairs++;
      continue;
    }
    nonzeroPairs++;
    if (Math.sign(previous) !== Math.sign(next)) alternating++;
  }
  return {
    totalPairs,
    nonzeroPairs,
    zeroPairs,
    fraction: nonzeroPairs === 0 ? null : alternating / nonzeroPairs,
  };
}

/** The ten most populated half-millisecond bins, so a cadence is visible as bins rather than inferred. */
function roundedHistogram(records) {
  const counts = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.driftMs)) continue;
    const rounded = Math.round(record.driftMs * 2) / 2;
    const key = rounded.toFixed(1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || Number(leftValue) - Number(rightValue))
    .slice(0, 10)
    .map(([value, count]) => `${value}ms:${count}`);
}

function finiteValues(samples, key) {
  return samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
}

function perPollMovement(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample?.polls)) continue;
    const polls = sample.polls;
    const group = groups.get(polls) ?? { polls, estimates: [] };
    if (Number.isFinite(sample.estimateMs)) group.estimates.push(sample.estimateMs);
    groups.set(polls, group);
  }
  const ordered = [...groups.values()].sort((left, right) => left.polls - right.polls);
  let maxPerPollMovementMs = null;
  let perPollPairsUsed = 0;
  let perPollPairsSkippedForGap = 0;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const gap = current.polls - previous.polls;
    if (gap !== 1) {
      if (gap > 1) perPollPairsSkippedForGap++;
      continue;
    }
    const previousEstimate = previous.estimates.at(-1);
    const currentEstimate = current.estimates.at(-1);
    if (!Number.isFinite(previousEstimate) || !Number.isFinite(currentEstimate)) continue;
    perPollPairsUsed++;
    const movementMs = Math.abs(currentEstimate - previousEstimate);
    if (maxPerPollMovementMs === null || movementMs > maxPerPollMovementMs) {
      maxPerPollMovementMs = movementMs;
    }
  }
  return {
    maxPerPollMovementMs,
    perPollEvaluations: ordered.length,
    perPollPairsUsed,
    perPollPairsSkippedForGap,
  };
}

/**
 * The least-squares trend of the estimate against wall-clock, in ms per second.
 *
 * A WHOLE-WINDOW TREND, not a closure rate against the command that produced it.
 * The regression spans every acting sample, so it covers a transient and a
 * plateau together, and the command varies across both because the controller is
 * proportional. Report it, do not conclude from a low one: see
 * `rateEffectivenessVerdict` for which direction it can be read in.
 */
function closureRate(samples) {
  const usable = samples.filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.estimateMs));
  if (usable.length < 2) return null;
  const meanAtMs = usable.reduce((sum, sample) => sum + sample.atMs, 0) / usable.length;
  const meanEstimateMs = usable.reduce((sum, sample) => sum + sample.estimateMs, 0) / usable.length;
  const denominator = usable.reduce((sum, sample) => sum + (sample.atMs - meanAtMs) ** 2, 0);
  if (denominator <= 0) return null;
  const numerator = usable.reduce((sum, sample) => sum + (sample.atMs - meanAtMs) * (sample.estimateMs - meanEstimateMs), 0);
  return (numerator / denominator) * 1000;
}

/** Each unbroken run of non-`settled` samples, with the range of the two record counts across it. */
function excursionsOf(samples, pollEveryMs) {
  const excursions = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const range = (key) => {
      const values = current.samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
    };
    const pollValues = current.samples.map((sample) => sample.polls);
    const observedPolls = pollValues.every((polls) => Number.isFinite(polls))
      ? new Set(pollValues).size
      : null;
    excursions.push({
      samples: current.samples.length,
      lengthMs: current.samples.length * pollEveryMs,
      controllerPolls: observedPolls,
      controllerPollsLabel: observedPolls === null ? 'unavailable' : `${observedPolls} distinct polls`,
      modes: [...current.modes],
      reasons: [...current.reasons],
      windowRecords: range('windowRecords'),
      controlRecords: range('controlRecords'),
    });
    current = null;
  };
  for (const sample of samples) {
    if (sample.mode === 'settled') {
      finish();
      continue;
    }
    if (!current) current = { samples: [], modes: new Set(), reasons: new Set() };
    current.samples.push(sample);
    current.modes.add(sample.mode ?? null);
    current.reasons.add(sample.reason ?? null);
  }
  finish();
  return excursions;
}

/**
 * Everything the observation window says about one client. `samples` are the
 * controller readings at `pollEveryMs`; `convergedRecords` are T6's span, which
 * is a different population and only the cadence figures read it.
 *
 * The steady-state figures come from the samples after the first `settled` one
 * where there is one, and from the acting samples where there is not —
 * `population` says which, and every verdict below repeats it, because a floor
 * measured while the controller is still acting is not evidence of a held floor.
 */
export function observationStats(samples, convergedRecords, pollEveryMs) {
  const firstSettledIndex = samples.findIndex((sample) => sample.mode === 'settled'
    && acceptedStoppingThresholdMs(sample) !== null);
  const afterSettled = firstSettledIndex < 0 ? [] : samples.slice(firstSettledIndex);
  const settled = afterSettled.filter((sample) => sample.mode === 'settled'
    && acceptedStoppingThresholdMs(sample) !== null);
  const acting = samples.filter((sample) => actedOnMeasurement(sample)
    && acceptedStoppingThresholdMs(sample) !== null);
  const population = settled.length > 0 ? settled : acting;
  const populationName = settled.length > 0 ? 'settled' : 'acting';
  const spreadValues = finiteValues(population, 'spreadMs').sort(ascending);
  const bandValues = finiteValues(population, 'bandMs').sort(ascending);
  const stoppingThresholdValues = population.map(acceptedStoppingThresholdMs).filter(Number.isFinite).sort(ascending);
  const allowanceValues = finiteValues(population, 'actuatorAllowanceMs').sort(ascending);
  const thresholdSchemas = [...new Set(population.map((sample) => thresholdContractOf(sample).schema))];
  const thresholdUsableCount = population.filter((sample) => acceptedStoppingThresholdMs(sample) !== null).length;
  const estimateValues = finiteValues(population, 'estimateMs');
  const actingRateMedian = middleOf(finiteValues(acting, 'rate').sort(ascending));
  const observedClosureRateMsPerSec = closureRate(acting);
  const commandedClosureRateMsPerSec = Number.isFinite(actingRateMedian) ? (actingRateMedian - 1) * 1000 : null;
  const pollStates = new Map();
  for (const sample of afterSettled) {
    if (!Number.isFinite(sample.polls)) continue;
    const current = pollStates.get(sample.polls) ?? { settled: false };
    current.settled ||= sample.mode === 'settled';
    pollStates.set(sample.polls, current);
  }
  const allDutySamplesHavePolls = afterSettled.every((sample) => Number.isFinite(sample.polls));
  const dutyPolls = allDutySamplesHavePolls ? [...pollStates.values()] : [];
  const settledPolls = allDutySamplesHavePolls ? dutyPolls.filter((poll) => poll.settled).length : null;
  const dutyCycle = firstSettledIndex < 0 || !allDutySamplesHavePolls || dutyPolls.length === 0
    ? null
    : settledPolls / dutyPolls.length;
  return {
    firstSettledIndex,
    settledSamples: afterSettled.length,
    settledCount: settled.length,
    dutyCycle,
    dutyPopulation: 'distinct controller polls from 125ms observation samples',
    dutyPopulationPolls: allDutySamplesHavePolls ? dutyPolls.length : null,
    settledPolls,
    population: populationName,
    populationSamples: population.length,
    thresholdPopulation: populationName,
    thresholdPopulationSamples: population.length,
    thresholdSchemas,
    thresholdUsableCount,
    thresholdUsableFraction: population.length ? thresholdUsableCount / population.length : null,
    stoppingThresholdMedianMs: middleOf(stoppingThresholdValues),
    stoppingThresholdMaxMs: stoppingThresholdValues.length ? Math.max(...stoppingThresholdValues) : null,
    actuatorAllowanceMedianMs: middleOf(allowanceValues),
    actuatorAllowanceMaxMs: allowanceValues.length ? Math.max(...allowanceValues) : null,
    spreadMedianMs: middleOf(spreadValues),
    bandMedianMs: middleOf(bandValues),
    spreadMaxMs: spreadValues.length ? Math.max(...spreadValues) : null,
    // THE RANGE ACROSS THE WHOLE OBSERVATION, distinct from the adjacent-poll
    // maximum below and never compared to the plant's per-poll step.
    estimateRangeMs: estimateValues.length ? Math.max(...estimateValues) - Math.min(...estimateValues) : null,
    ...perPollMovement(population),
    actingCount: acting.length,
    actingFraction: samples.length ? acting.length / samples.length : null,
    actingRateMedian,
    observedClosureRateMsPerSec,
    commandedClosureRateMsPerSec,
    effectivenessFraction: Number.isFinite(observedClosureRateMsPerSec)
      && Number.isFinite(commandedClosureRateMsPerSec)
      && commandedClosureRateMsPerSec !== 0
      ? observedClosureRateMsPerSec / commandedClosureRateMsPerSec
      : null,
    alternation: alternationStats(convergedRecords),
    histogram: roundedHistogram(convergedRecords),
    excursions: excursionsOf(firstSettledIndex < 0 ? acting : afterSettled, pollEveryMs),
  };
}

const bar = (bars, name, fallback) => Number.isFinite(bars?.[name]) ? bars[name] : fallback;

function dropsSignature(sample) {
  return JSON.stringify(sample?.counters?.drops ?? sample?.drops ?? null);
}

function localDisplayMs(record) {
  return record?.displaySharedMs - record?.clock?.offsetMs;
}

function allWithin(values, centre, tolerance) {
  return values.every((value) => Math.abs(value - centre) <= tolerance);
}

/** Maximal stable command runs, grouped so two reads of one published poll do not break a run. */
export function steadyCommandStretches(samples, bars = DEFAULT_BARS) {
  const tolerance = bar(bars, 'RATE_STEADY_TOLERANCE', RATE_STEADY_TOLERANCE);
  const evaluations = [];
  for (const sample of samples ?? []) {
    const previous = evaluations.at(-1);
    if (previous && previous.polls === sample?.polls && Number.isFinite(sample?.polls)) {
      previous.samples.push(sample);
      continue;
    }
    evaluations.push({ polls: sample?.polls, samples: [sample] });
  }

  const usable = (evaluation) => Number.isFinite(evaluation.polls)
    && evaluation.samples.every((sample) => actedOnMeasurement(sample)
      && acceptedStoppingThresholdMs(sample) !== null
      && Number.isFinite(sample.rate)
      && Number.isFinite(sample.atMs));
  const rateValues = (run) => run.flatMap((evaluation) => evaluation.samples.map((sample) => sample.rate));
  const stretches = [];
  let current = [];
  const finish = () => {
    if (current.length === 0) return;
    const rates = rateValues(current).sort(ascending);
    const observations = current.flatMap((evaluation) => evaluation.samples);
    const signatures = current.flatMap((evaluation) => evaluation.samples.map(dropsSignature));
    stretches.push({
      firstAtMs: Math.min(...observations.map((sample) => sample.atMs)),
      lastAtMs: Math.max(...observations.map((sample) => sample.atMs)),
      medianRate: middleOf(rates),
      firstPolls: current[0].polls,
      lastPolls: current.at(-1).polls,
      sampleCount: current.length,
      observationCount: observations.length,
      samples: observations,
      commandSource: 'last-applied-rate',
      thresholdSchemas: [...new Set(observations.map((sample) => thresholdContractOf(sample).schema))],
      dropSignatures: signatures,
      dropsChanged: new Set(signatures).size > 1,
    });
    current = [];
  };

  for (const evaluation of evaluations) {
    if (!usable(evaluation)) {
      finish();
      continue;
    }
    const contiguous = current.length === 0 || evaluation.polls === current.at(-1).polls + 1;
    const proposed = rateValues([...current, evaluation]).sort(ascending);
    const proposedMedian = middleOf(proposed);
    if (!contiguous || !allWithin(proposed, proposedMedian, tolerance)) finish();
    current.push(evaluation);
  }
  finish();
  return stretches;
}

/** Least-squares slope and its fitted standard error, both in native units. */
export function slopeOf(points) {
  const usable = (points ?? []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  const n = usable.length;
  if (n < 3) return null;
  const meanX = usable.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = usable.reduce((sum, point) => sum + point.y, 0) / n;
  const spanX = Math.max(...usable.map((point) => point.x)) - Math.min(...usable.map((point) => point.x));
  const denominator = usable.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (!(denominator > 0)) return null;
  const numerator = usable.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residualSum = usable.reduce((sum, point) => sum + (point.y - (slope * point.x + intercept)) ** 2, 0);
  return {
    slope,
    standardError: Math.sqrt(Math.max(0, residualSum) / (n - 2) / denominator),
    n,
    spanX,
    intercept,
  };
}

/** Media position against the local display instant; the clock offset cancels in x. */
export function mediaAgainstLocal(records) {
  return (records ?? []).map((record) => ({ x: localDisplayMs(record), y: record?.mediaMs }));
}

/** Drift restated to one offset before fitting against the local display instant. */
export function driftAgainstLocal(records, offsetRefMs) {
  return (records ?? []).map((record) => ({
    x: localDisplayMs(record),
    y: record?.driftMs + record?.clock?.offsetMs - offsetRefMs,
  }));
}

function slopeReport(fit) {
  if (!fit) return null;
  return {
    ...fit,
    slopePpm: fit.slope * 1e6,
    standardErrorPpm: fit.standardError * 1e6,
  };
}

export function endpointCrosscheck(points, fit) {
  const usable = (points ?? []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .sort((left, right) => left.x - right.x);
  if (!fit || usable.length < 2) return null;
  const first = usable[0];
  const last = usable.at(-1);
  const actualDeltaMs = last.y - first.y;
  const predictedDeltaMs = fit.slope * (last.x - first.x);
  return {
    errorMs: Math.abs(actualDeltaMs - predictedDeltaMs),
    actualDeltaMs,
    predictedDeltaMs,
  };
}

/** Fit both record views inside each verified, edge-trimmed command run. */
export function stretchSlopes({ stretches = [], records = [], bars = DEFAULT_BARS } = {}) {
  const edgeExclusionMs = bar(bars, 'STRETCH_EDGE_EXCLUSION_MS', STRETCH_EDGE_EXCLUSION_MS);
  const minimumSpanMs = bar(bars, 'MIN_STRETCH_SPAN_MS', MIN_STRETCH_SPAN_MS);
  const minimumRecords = bar(bars, 'MIN_STRETCH_RECORDS', MIN_STRETCH_RECORDS);
  const endpointBarMs = bar(bars, 'ENDPOINT_CROSSCHECK_MS', ENDPOINT_CROSSCHECK_MS);
  return (stretches ?? []).map((stretch) => {
    const firstAtMs = stretch?.firstAtMs;
    const lastAtMs = stretch?.lastAtMs;
    const trimmedStartMs = Number.isFinite(firstAtMs) ? firstAtMs + edgeExclusionMs : null;
    const trimmedEndMs = Number.isFinite(lastAtMs) ? lastAtMs - edgeExclusionMs : null;
    const reasons = [];
    if (!Number.isFinite(trimmedStartMs) || !Number.isFinite(trimmedEndMs)) reasons.push('missing-stretch-boundaries');
    if (Number.isFinite(trimmedStartMs) && trimmedEndMs <= trimmedStartMs) reasons.push('stretch-shorter-than-edge-exclusion');

    const inside = (record) => {
      const local = localDisplayMs(record);
      if (Number.isFinite(local)) return local >= trimmedStartMs && local <= trimmedEndMs;
      return Number.isFinite(record?.displaySharedMs)
        && record.displaySharedMs >= trimmedStartMs && record.displaySharedMs <= trimmedEndMs;
    };
    const selected = Number.isFinite(trimmedStartMs) && Number.isFinite(trimmedEndMs)
      ? (records ?? []).filter(inside)
      : [];
    const usable = selected.filter((record) => Number.isFinite(record?.mediaMs)
      && Number.isFinite(record?.displaySharedMs)
      && Number.isFinite(record?.clock?.offsetMs));
    const excludedNonFiniteRecords = selected.length - usable.length;
    const mediaPoints = mediaAgainstLocal(usable);
    const localValues = mediaPoints.map((point) => point.x).filter(Number.isFinite);
    const trimmedSpanMs = localValues.length ? Math.max(...localValues) - Math.min(...localValues) : 0;
    const epochValues = [...new Set(usable.map((record) => record.epochMs).filter(Number.isFinite))];
    const offsets = usable.map((record) => record.clock.offsetMs);
    const distinctOffsetCount = new Set(offsets).size;
    const offsetMovementMs = offsets.length ? Math.max(...offsets) - Math.min(...offsets) : null;
    if (trimmedSpanMs < minimumSpanMs) reasons.push('trimmed-span-below-bar');
    if (usable.length < minimumRecords) reasons.push('record-count-below-bar');
    if (epochValues.length > 1) reasons.push('epoch-revision');
    const sampleDropSignatures = (stretch?.samples ?? []).map(dropsSignature);
    const dropSignatures = [...(stretch?.dropSignatures ?? []), ...sampleDropSignatures];
    if (stretch?.dropsChanged || new Set(dropSignatures).size > 1) reasons.push('control-drop');

    const mediaFit = slopeOf(mediaPoints);
    const offsetRefMs = offsets.length ? offsets[0] : NaN;
    const driftPoints = driftAgainstLocal(usable, offsetRefMs);
    const driftFit = slopeOf(driftPoints);
    if (!mediaFit || !driftFit) reasons.push('slope-unavailable');
    const mediaEndpoint = endpointCrosscheck(mediaPoints, mediaFit);
    const driftEndpoint = endpointCrosscheck(driftPoints, driftFit);
    const refused = reasons.length > 0;
    const media = slopeReport(mediaFit);
    const drift = slopeReport(driftFit);
    return {
      ...stretch,
      firstAtMs,
      lastAtMs,
      trimmedStartMs,
      trimmedEndMs,
      trimmedSpanMs,
      records: usable,
      recordCount: usable.length,
      excludedNonFiniteRecords,
      epochValues,
      distinctOffsetCount,
      offsetMovementMs,
      media,
      drift,
      endpointCrosscheck: {
        mediaMs: mediaEndpoint?.errorMs ?? null,
        driftMs: driftEndpoint?.errorMs ?? null,
        barMs: endpointBarMs,
        mediaWithinBar: mediaEndpoint === null ? null : mediaEndpoint.errorMs <= endpointBarMs,
        driftWithinBar: driftEndpoint === null ? null : driftEndpoint.errorMs <= endpointBarMs,
      },
      refused,
      reason: reasons[0] ?? null,
      reasons,
    };
  });
}

/** Compare the first two qualifying command stretches without treating one as its own control. */
export function compareStretchSlopes(results = []) {
  const qualifying = results.filter((result) => !result.refused && Number.isFinite(result.media?.slope));
  if (qualifying.length < 2) {
    return { available: false, reason: 'fewer-than-two-qualifying-stretches', differencePpm: null };
  }
  const [first, second] = qualifying;
  const standardError = Math.sqrt((first.media.standardError ?? 0) ** 2 + (second.media.standardError ?? 0) ** 2);
  return {
    available: true,
    reason: null,
    first,
    second,
    difference: second.media.slope - first.media.slope,
    differencePpm: (second.media.slope - first.media.slope) * 1e6,
    standardError,
    standardErrorPpm: standardError * 1e6,
    commandDifferencePpm: (second.medianRate - first.medianRate) * 1e6,
  };
}

/** Residual rate relative to a commanded rate, with the fitted error propagated to ppm. */
export function residualPpm(slope, commandedRate) {
  const slopeValue = Number.isFinite(slope) ? slope : slope?.slope;
  const standardError = Number.isFinite(slope?.standardError) ? slope.standardError : null;
  if (!Number.isFinite(slopeValue) || !Number.isFinite(commandedRate) || commandedRate === 0) return null;
  const value = (slopeValue / commandedRate - 1) * 1e6;
  const error = standardError === null ? null : Math.abs(standardError / commandedRate) * 1e6;
  return {
    residualPpm: value,
    standardErrorPpm: error,
  };
}

/**
 * The standing lag this window opened with, against the figure 4a's sweep
 * produced for it. Read from the first eight records — the controller's own
 * minimum — so it describes the client before any correction was applied.
 */
export function standingLag(firstRecords, referenceLagMs) {
  const drifts = (firstRecords ?? []).slice(0, 8).map((record) => record.driftMs);
  const firstEightMs = drifts.length < 8 || drifts.some((driftMs) => !Number.isFinite(driftMs))
    ? null
    : middleOf(drifts.sort(ascending));
  const lagMatches = Number.isFinite(firstEightMs) && Math.abs(firstEightMs - referenceLagMs) <= STANDING_LAG_MATCH_MS;
  const inMeasuredBand = Number.isFinite(firstEightMs)
    && Math.abs(firstEightMs) >= MEASURED_BAND_MIN_MS
    && Math.abs(firstEightMs) <= MEASURED_BAND_MAX_MS;
  const verdict = !Number.isFinite(firstEightMs)
    ? 'unavailable (the first eight records population was not finite)'
    : `${lagMatches ? 'reproduces' : 'does not reproduce'} within one ${STANDING_LAG_MATCH_MS}ms sweep step, ${inMeasuredBand ? 'inside' : 'outside'} the 3b ${MEASURED_BAND_MIN_MS}-${MEASURED_BAND_MAX_MS}ms band`;
  return {
    firstEightMs,
    referenceLagMs,
    lagMatches,
    inMeasuredBand,
    population: 'first eight records the window ever produced',
    units: 'ms',
    // The prose names both thresholds, so it is built beside them.
    verdict,
  };
}

/**
 * The worst duty cycle the simulated plant produces across the sweep — the bar a
 * browser run is compared against, recomputed rather than carried as a constant
 * so it cannot go stale against the controller it is drawn from.
 */
export function plantSweepMinimum() {
  let minimum = null;
  for (const refreshHz of [60, 180]) {
    for (let standingError = -320; standingError <= -80; standingError += 20) {
      const simulation = plant({ refreshHz, standingError, pollEvery: 6 });
      for (let i = 0; i < 6 * 960; i++) simulation.deliver();
      const firstSettled = simulation.history.findIndex((state) => state.mode === 'settled');
      const afterSettled = firstSettled < 0 ? [] : simulation.history.slice(firstSettled);
      const dutyCycle = afterSettled.length
        ? afterSettled.filter((state) => state.mode === 'settled').length / afterSettled.length
        : 0;
      if (minimum === null || dutyCycle < minimum.dutyCycle) {
        minimum = {
          dutyCycle,
          refreshHz,
          standingError,
          population: 'simulated controller polls over 240 simulated seconds',
        };
      }
    }
  }
  return minimum;
}

function cadenceOf(alternation) {
  const population = {
    nonzeroPairs: alternation.nonzeroPairs,
    totalPairs: alternation.totalPairs,
    zeroPairs: alternation.zeroPairs,
  };
  const populationText = `${population.nonzeroPairs} nonzero pairs over ${population.totalPairs} total pairs (${population.zeroPairs} zero pairs)`;
  if (alternation.fraction === null) {
    return { ...population, period2Like: false, text: `not enough nonzero differences (${populationText})` };
  }
  if (alternation.fraction >= PERIODICITY_LIKE) {
    return { ...population, period2Like: true, text: `period-2-like (${populationText})` };
  }
  if (alternation.fraction <= PERIODICITY_NOT_LIKE) {
    return { ...population, period2Like: false, text: `not period-2-like (${populationText})` };
  }
  return {
    ...population,
    period2Like: false,
    text: `inconclusive (between ${PERIODICITY_NOT_LIKE} and ${PERIODICITY_LIKE}; ${populationText})`,
  };
}

function floorVerdictOf(floorHeld, population, cadence) {
  if (!cadence.period2Like) {
    return `inapplicable: half-vsync prediction assumes period-2-like cadence; ${cadence.text}`;
  }
  if (floorHeld === null) return `${population} population has no finite spread`;
  if (population === 'settled') {
    return floorHeld ? `held at <=${FLOOR_MULTIPLIER}x predicted` : `not held above ${FLOOR_MULTIPLIER}x predicted`;
  }
  return floorHeld
    ? `within <=${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`
    : `above ${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`;
}

/** The sum of two published controller bands is a predicted worst-case separation (ms). */
export function predictedParkingDistanceMs(firstBandMs, secondBandMs) {
  return Number.isFinite(firstBandMs) && Number.isFinite(secondBandMs)
    ? firstBandMs + secondBandMs
    : null;
}

// THE THIRD TERM is live only when two published controller polls supplied a
// like-for-like movement; a whole-window range is not the plant's per-poll step.
function modelVerdictOf(cadence, floorHeld, population, movementComparable, movementReason) {
  if (cadence.period2Like && floorHeld === true && movementComparable) {
    return population === 'settled' ? 'agree' : 'agree on acting figures; no settled hold was observed';
  }
  const floorText = floorHeld === true ? 'within prediction' : floorHeld === false ? 'above prediction' : 'unavailable';
  const hold = population === 'settled' ? '' : '; no settled hold was observed';
  const movementText = movementComparable
    ? 'max-per-poll movement term available'
    : `max-per-poll movement term withheld (${movementReason})`;
  return `inconclusive: cadence ${cadence.text}, floor ${floorText}, ${movementText}${hold}`;
}

function excursionVerdictOf(stats) {
  if (stats.populationSamples === 0) return 'unavailable (no acting samples)';
  const exceeded = stats.excursions.some((excursion) => excursion.lengthMs > EXCURSION_POLL_MS);
  if (stats.firstSettledIndex < 0) {
    return exceeded
      ? 'yes, an acting excursion exceeded one controller poll; no settled hold was observed'
      : 'no, no acting excursion exceeded one controller poll; no settled hold was observed';
  }
  return exceeded ? 'yes, an excursion exceeded one controller poll' : 'no, none exceeded one controller poll';
}

function dutyVerdictOf(stats) {
  if (stats.firstSettledIndex < 0) return `unavailable (no settled sample; browser population is ${stats.dutyPopulation})`;
  if (!Number.isFinite(stats.dutyCycle)) return `unavailable (${stats.dutyPopulation} is incomplete)`;
  const percent = (stats.dutyCycle * 100).toFixed(1);
  return `${percent}% settled over ${stats.settledPolls}/${stats.dutyPopulationPolls} ${stats.dutyPopulation}`;
}

function recommendationOf(stats, plantMinimum) {
  if (stats.firstSettledIndex < 0) return `no settled hold observed; keep the simulated ${PLANT_ASSERTED_FLOOR} floor pending hardware hold evidence`;
  if (!Number.isFinite(stats.dutyCycle)) return 'no recommendation from this window';
  if (stats.dutyCycle < PLANT_ASSERTED_FLOOR) return `keep the simulated ${PLANT_ASSERTED_FLOOR} floor; browser duty is below it`;
  if (!Number.isFinite(plantMinimum?.dutyCycle)) return 'no recommendation from this window';
  if (stats.dutyCycle < plantMinimum.dutyCycle) return `keep the simulated ${PLANT_ASSERTED_FLOOR} floor; browser clears it but not the plant minimum`;
  return 'browser clears the plant minimum; any floor change belongs to a follow-up';
}

// ONE-SIDED, AND THE VERDICT SAYS SO. A high ratio does prove the actuator moves
// the clock. A LOW ONE PROVES NOTHING, because a converged proportional loop reads
// low here whatever its actuator is doing — on a plateau the trend is ~0 while the
// command stays nonzero, a residual error being what produces it. Separating a
// dead actuator from a held steady-state error needs the slope over a stretch
// where the command is STEADY, filed under change 5 (4c design.md D2).
function rateEffectivenessOf(fraction) {
  if (!Number.isFinite(fraction)) return 'unavailable (insufficient acting samples or zero commanded closure rate)';
  if (fraction >= RATE_EFFECTIVE) return `effective (>=${RATE_EFFECTIVE}; the whole-window trend tracks the command, so the rate does move the media clock)`;
  if (fraction < RATE_INEFFECTIVE) return `low (<${RATE_INEFFECTIVE}); this ratio cannot say whether the actuator is dead or the loop is holding a steady-state error — read the steady-command stretches, not this number`;
  return `low (${RATE_INEFFECTIVE}-${RATE_EFFECTIVE}); same caveat as below ${RATE_INEFFECTIVE} — this ratio does not discriminate`;
}

/**
 * What one window's figures amount to, in the words the run prints. Every
 * verdict is derived from `stats` and the panel's refresh rate and nothing else,
 * so the pass can be read without re-deriving any of them.
 */
export function windowVerdicts({ stats, refresh, plantMinimum }) {
  const predictedFloorMs = Number.isFinite(refresh.refreshRateHz) && refresh.refreshRateHz > 0
    ? 1000 / (2 * refresh.refreshRateHz)
    : null;
  const cadence = cadenceOf(stats.alternation);
  const cadenceVerdict = cadence.text;
  const floorHeld = Number.isFinite(stats.spreadMedianMs) && Number.isFinite(predictedFloorMs)
    && cadence.period2Like
    ? stats.spreadMedianMs <= predictedFloorMs * FLOOR_MULTIPLIER
    : null;
  const floorApplicable = cadence.period2Like;
  const movementComparable = Number.isFinite(stats.maxPerPollMovementMs);
  const movementReason = stats.perPollPairsSkippedForGap > 0 && stats.perPollPairsUsed === 0
    ? 'all observed pairs had a poll gap'
    : stats.perPollPairsUsed === 0
      ? 'no consecutive published poll pair was observed'
      : 'no finite movement was observed';
  return {
    movementComparable,
    maxPerPollMovementMs: stats.maxPerPollMovementMs,
    movementReason,
    predictedFloorMs,
    floorHeld,
    floorApplicable,
    cadenceVerdict,
    cadencePeriod2Like: cadence.period2Like,
    modelVerdict: modelVerdictOf(cadence, floorHeld, stats.population, movementComparable, movementReason),
    floorVerdict: floorVerdictOf(floorHeld, stats.population, cadence),
    excursionVerdict: excursionVerdictOf(stats),
    dutyVerdict: dutyVerdictOf(stats),
    recommendation: recommendationOf(stats, plantMinimum),
    rateEffectivenessVerdict: rateEffectivenessOf(stats.effectivenessFraction),
  };
}
