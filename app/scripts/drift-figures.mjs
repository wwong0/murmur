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
// Exports are what verify-browser.mjs calls. Everything else is internal on
// purpose — a figure with no caller is a figure nobody is reading.
//
// TEST MACHINERY. Nothing in the product imports this.

import { median, percentile } from '../public/lib/frame-drift.mjs';
import { plant } from './check/drift-plant.mjs';

/** The converged span T6 anchors: below this many records the span reports nothing. */
export const MIN_CONVERGED_RECORDS = 120;
/** room.entry.js's controller poll — the unit an excursion is measured in. */
const EXCURSION_POLL_MS = 250;
const PERIODICITY_LIKE = 0.8;
const PERIODICITY_NOT_LIKE = 0.6;
const FLOOR_MULTIPLIER = 1.5;
/** The duty cycle the simulated plant asserts, which a browser run either clears or does not. */
const PLANT_ASSERTED_FLOOR = 0.8;
const RATE_EFFECTIVE = 0.5;
const RATE_INEFFECTIVE = 0.1;
/** One sweep step of 4a's standing-error sweep — the resolution its reference figures have. */
const STANDING_LAG_MATCH_MS = 20;
/** 3b's measured standing lag, as a band rather than a point. */
const MEASURED_BAND_MIN_MS = 100;
const MEASURED_BAND_MAX_MS = 240;
/** 4a's largest movement of the median between two consecutive controller polls. */
export const PLANT_MEDIAN_MOVEMENT_MS = 1.32;

// THE CANONICAL PAIR from frame-drift.mjs, never a local definition of the
// middle of an even set. The only thing added is the empty case: these figures
// are printed, and `null` is what the run prints for a quantity it does not have.
const middleOf = (sorted) => (sorted.length === 0 ? null : median(sorted));
const rankOf = (sorted, fraction) => (sorted.length === 0 ? null : percentile(sorted, fraction));

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
  const medianDeltaMs = middleOf(deltas);
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
  const records = (seam.records ?? []).filter((record) => record.seq > barSeq);
  const drifts = records.map((record) => record.driftMs).sort(ascending);
  const enough = records.length >= MIN_CONVERGED_RECORDS && records.every((record) => Number.isFinite(record.driftMs));
  return {
    records,
    convergedCount: records.length,
    convergedMedianMs: enough ? middleOf(drifts) : null,
    convergedSpreadMs: enough ? rankOf(drifts, 0.95) - rankOf(drifts, 0.05) : null,
  };
}

/** How often consecutive differences change sign — a period-2 cadence alternates almost always. */
function alternationStats(records) {
  let pairs = 0;
  let alternating = 0;
  for (let i = 1; i < records.length - 1; i++) {
    const previous = records[i].driftMs - records[i - 1].driftMs;
    const next = records[i + 1].driftMs - records[i].driftMs;
    if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === 0 || next === 0) continue;
    pairs++;
    if (Math.sign(previous) !== Math.sign(next)) alternating++;
  }
  return { pairs, fraction: pairs === 0 ? null : alternating / pairs };
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
    excursions.push({
      samples: current.samples.length,
      lengthMs: current.samples.length * pollEveryMs,
      controllerPolls: (current.samples.length * pollEveryMs) / EXCURSION_POLL_MS,
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
  const firstSettledIndex = samples.findIndex((sample) => sample.mode === 'settled');
  const afterSettled = firstSettledIndex < 0 ? [] : samples.slice(firstSettledIndex);
  const settled = afterSettled.filter((sample) => sample.mode === 'settled');
  const acting = samples.filter((sample) => sample.reason === null);
  const population = settled.length > 0 ? settled : acting;
  const spreadValues = finiteValues(population, 'spreadMs').sort(ascending);
  const estimateValues = finiteValues(population, 'estimateMs');
  const actingRateMedian = middleOf(finiteValues(acting, 'rate').sort(ascending));
  const observedClosureRateMsPerSec = closureRate(acting);
  const commandedClosureRateMsPerSec = Number.isFinite(actingRateMedian) ? (actingRateMedian - 1) * 1000 : null;
  return {
    firstSettledIndex,
    settledSamples: afterSettled.length,
    settledCount: settled.length,
    dutyCycle: afterSettled.length ? settled.length / afterSettled.length : 0,
    population: settled.length > 0 ? 'settled' : 'acting',
    populationSamples: population.length,
    spreadMedianMs: middleOf(spreadValues),
    spreadMaxMs: spreadValues.length ? Math.max(...spreadValues) : null,
    // THE RANGE ACROSS THE WHOLE OBSERVATION, which is why the model check below
    // withholds it rather than comparing it to the plant's per-poll step.
    medianMovementMs: estimateValues.length ? Math.max(...estimateValues) - Math.min(...estimateValues) : null,
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

/**
 * The standing lag this window opened with, against the figure 4a's sweep
 * produced for it. Read from the first eight records — the controller's own
 * minimum — so it describes the client before any correction was applied.
 */
export function standingLag(firstRecords, referenceLagMs) {
  const drifts = (firstRecords ?? []).map((record) => record.driftMs);
  const firstEightMs = drifts.length < 8 || drifts.some((driftMs) => !Number.isFinite(driftMs))
    ? null
    : middleOf(drifts.sort(ascending));
  const lagMatches = Number.isFinite(firstEightMs) && Math.abs(firstEightMs - referenceLagMs) <= STANDING_LAG_MATCH_MS;
  const inMeasuredBand = Number.isFinite(firstEightMs)
    && Math.abs(firstEightMs) >= MEASURED_BAND_MIN_MS
    && Math.abs(firstEightMs) <= MEASURED_BAND_MAX_MS;
  return {
    firstEightMs,
    referenceLagMs,
    lagMatches,
    inMeasuredBand,
    // The prose names both thresholds, so it is built beside them.
    verdict: `${lagMatches ? 'reproduces' : 'does not reproduce'} within one ${STANDING_LAG_MATCH_MS}ms sweep step, ${inMeasuredBand ? 'inside' : 'outside'} the 3b ${MEASURED_BAND_MIN_MS}-${MEASURED_BAND_MAX_MS}ms band`,
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
      if (minimum === null || dutyCycle < minimum.dutyCycle) minimum = { dutyCycle, refreshHz, standingError };
    }
  }
  return minimum;
}

function cadenceOf(alternation) {
  if (alternation.fraction === null) return 'not enough nonzero differences';
  if (alternation.fraction >= PERIODICITY_LIKE) return 'period-2-like';
  if (alternation.fraction <= PERIODICITY_NOT_LIKE) return 'not period-2-like';
  return `inconclusive (between ${PERIODICITY_NOT_LIKE} and ${PERIODICITY_LIKE})`;
}

function floorVerdictOf(floorHeld, population) {
  if (floorHeld === null) return `${population} population has no finite spread`;
  if (population === 'settled') {
    return floorHeld ? `held at <=${FLOOR_MULTIPLIER}x predicted` : `not held above ${FLOOR_MULTIPLIER}x predicted`;
  }
  return floorHeld
    ? `within <=${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`
    : `above ${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`;
}

// THE THIRD TERM OF THE MODEL CHECK. `movementComparable` at its call site is
// false, so the `agree` arm is unreachable — DO NOT DELETE IT AS DEAD CODE. It is
// the shape the check returns to when the term is repaired, and a review session
// has already removed it once. The term is withheld rather than dropped because
// `medianMovementMs` (a whole-window range) and PLANT_MEDIAN_MOVEMENT_MS (4a's
// per-poll step) are not the same quantity, and an incomparable term cannot
// support `agree` either: 4c design.md D2, repair filed under change 5.
function modelVerdictOf(cadenceVerdict, floorHeld, population, movementComparable) {
  if (cadenceVerdict === 'period-2-like' && floorHeld === true && movementComparable) {
    return population === 'settled' ? 'agree' : 'agree on acting figures; no settled hold was observed';
  }
  const floorText = floorHeld === true ? 'within prediction' : floorHeld === false ? 'above prediction' : 'unavailable';
  const hold = population === 'settled' ? '' : '; no settled hold was observed';
  return `inconclusive: cadence ${cadenceVerdict}, floor ${floorText}, median-movement term withheld (a whole-window range is not the plant's per-poll step)${hold}`;
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
  if (!Number.isFinite(stats.dutyCycle)) return 'unavailable';
  const percent = (stats.dutyCycle * 100).toFixed(1);
  return stats.firstSettledIndex < 0
    ? `${percent}% settled (0 settled samples; acting population used for steady-state figures)`
    : `${percent}% settled after first settled sample (${stats.settledCount}/${stats.settledSamples} samples)`;
}

function recommendationOf(stats, plantMinimum) {
  if (stats.firstSettledIndex < 0) return `no settled hold observed; keep the simulated ${PLANT_ASSERTED_FLOOR} floor pending hardware hold evidence`;
  if (!Number.isFinite(stats.dutyCycle)) return 'no recommendation from this window';
  if (stats.dutyCycle < PLANT_ASSERTED_FLOOR) return `keep the simulated ${PLANT_ASSERTED_FLOOR} floor; browser duty is below it`;
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
  const floorHeld = Number.isFinite(stats.spreadMedianMs) && Number.isFinite(predictedFloorMs)
    ? stats.spreadMedianMs <= predictedFloorMs * FLOOR_MULTIPLIER
    : null;
  const cadenceVerdict = cadenceOf(stats.alternation);
  // WITHHELD, NOT FAILED, and false is a decision rather than a placeholder: see
  // `modelVerdictOf`. It is returned as well as used so the run carries the reason
  // its model check cannot conclude, not only the conclusion.
  const movementComparable = false;
  return {
    movementComparable,
    predictedFloorMs,
    floorHeld,
    // Two clients can each sit anywhere in their own scatter, so the distance
    // between them is the spread doubled.
    parkingDistanceMs: Number.isFinite(stats.spreadMedianMs) ? stats.spreadMedianMs * 2 : null,
    cadenceVerdict,
    modelVerdict: modelVerdictOf(cadenceVerdict, floorHeld, stats.population, movementComparable),
    floorVerdict: floorVerdictOf(floorHeld, stats.population),
    excursionVerdict: excursionVerdictOf(stats),
    dutyVerdict: dutyVerdictOf(stats),
    recommendation: recommendationOf(stats, plantMinimum),
    rateEffectivenessVerdict: rateEffectivenessOf(stats.effectivenessFraction),
  };
}
