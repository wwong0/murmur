// scripts/check/stopping-comparison-metrics.mjs
//
// The plateau and settling diagnostics `remedy-comparison-spec.md` freezes
// before execution, and nothing else. Every function here reads a finished poll
// history and returns numbers; none of them decides whether a run passed.
//
// The distinctions this file exists to keep apart, all of which the round-2
// review and the cross-review argued over and all of which collapse the moment
// one function tries to say "was it stuck":
//
//  - A PLATEAU IS A PROPERTY OF THE ESTIMATE, not of the command and not of the
//    input. It is a run of polls whose estimate is equal by `===`. A stable
//    median computed from hundreds of new records is a plateau and is NOT stale
//    input; whether the records were fresh is reported beside it as its own
//    number, so a reader can see both and neither is inferred from the other.
//  - COMMAND STRUCTURE IS SUBDIVIDED, NOT FILTERED. The round-1 hold statistic
//    tested the command at the end of a window, which cannot see a plateau that
//    changed command halfway or sat at unity. Here the plateau is cut into
//    maximal constant-command pieces and every piece is reported, so a plateau
//    with three commands in it reads as three subintervals rather than one.
//  - U AND S ARE REPORTED SEPARATELY AND BOTH RANGES ARE KEPT. A constant
//    estimate over a moving threshold is a different observation from a constant
//    estimate over a fixed one, and the second is what a stuck loop looks like.
//  - THE QUALIFICATION INTERVAL IS ARITHMETIC ON PUBLISHED POLL TIMES: the
//    5000 ms before the arm's own first settled poll. It is not an observation
//    of the controller's private dwell state and not the first unity write, and
//    it is never taken from another arm's trajectory.
//  - OVERLAP IS A DIAGNOSTIC. Nothing in this file vetoes a case for it.
//
// TEST MACHINERY — under scripts/. Pure: no clock, no randomness, no I/O.

import { POLL_INTERVAL_MS } from './mechanism-driver.mjs';

/** The floor for a plateau that counts toward the overlap diagnostic. Shorter
 *  runs are computed and available, but do not qualify. */
export const PLATEAU_MIN_MS = 5000;
/** Polls whose input never reached the estimator. They end a plateau. */
export const PLATEAU_BREAKING_MODES = Object.freeze(['waiting', 'stale']);
/** The candidate's refusal mode, as it appears in a published poll row. */
export const BUDGET_HOLD_MODE = 'resolution-budget-hold';
/** Float slack on a scheduled poll spacing, in ms. Poll times are exact
 *  multiples of the interval in the model, so this only absorbs `+` rounding. */
const GAP_TOLERANCE_MS = 1e-6;

const finiteValues = (values) => values.filter((value) => Number.isFinite(value));
const minOf = (values) => (values.length ? Math.min(...values) : null);
const maxOf = (values) => (values.length ? Math.max(...values) : null);

/**
 * Whether a poll can sit inside a plateau at all. A budget refusal is NOT
 * excluded: its input was valid and its estimate was measured, and the spec's
 * breaking events are a waiting/stale/input-refused poll, an estimate change or
 * a missing scheduled poll. Refusals inside a plateau are counted instead.
 */
export function isPlateauEligible(row) {
  if (!Number.isFinite(row.estimateMs)) return false;
  if (PLATEAU_BREAKING_MODES.includes(row.mode)) return false;
  return row.inputRefused !== true;
}

function freshRecordCoverage(records, fromMs, toMs) {
  if (!Array.isArray(records)) return null;
  const inside = records.filter((record) => record.atMs >= fromMs && record.atMs <= toMs);
  if (inside.length === 0) {
    return { count: 0, firstSeq: null, lastSeq: null, firstAtMs: null, lastAtMs: null, coverageMs: null, maxGapMs: null };
  }
  let maxGapMs = 0;
  for (let index = 1; index < inside.length; index += 1) maxGapMs = Math.max(maxGapMs, inside[index].atMs - inside[index - 1].atMs);
  return {
    count: inside.length,
    firstSeq: inside[0].seq ?? null,
    lastSeq: inside.at(-1).seq ?? null,
    firstAtMs: inside[0].atMs,
    lastAtMs: inside.at(-1).atMs,
    coverageMs: inside.at(-1).atMs - inside[0].atMs,
    maxGapMs,
  };
}

function describePlateau(rows, startIndex, records) {
  const first = rows[0];
  const last = rows.at(-1);
  const bands = finiteValues(rows.map((row) => row.bandMs));
  const stops = finiteValues(rows.map((row) => row.stoppingThresholdMs));
  const transitionsOn = (key) => rows
    .map((row, index) => (index > 0 && row[key] !== rows[index - 1][key] ? { atMs: row.atMs, from: rows[index - 1][key], to: row[key] } : null))
    .filter(Boolean);
  return {
    startIndex,
    endIndex: startIndex + rows.length - 1,
    startMs: first.atMs,
    endMs: last.atMs,
    // LAST POLL MINUS FIRST. Not extrapolated past the last poll: the plateau is
    // evidence about the instants that were observed and no interval after them.
    durationMs: last.atMs - first.atMs,
    polls: rows.length,
    estimateMs: first.estimateMs,
    bandMinMs: minOf(bands),
    bandMaxMs: maxOf(bands),
    bandChanged: bands.length > 0 && minOf(bands) !== maxOf(bands),
    stoppingMinMs: minOf(stops),
    stoppingMaxMs: maxOf(stops),
    stoppingChanged: stops.length > 0 && minOf(stops) !== maxOf(stops),
    // A poll inside the plateau that published no accepted S — a budget refusal
    // under this candidate, and impossible at f = 0.
    stoppingAbsentPolls: rows.length - stops.length,
    budgetRefusalPolls: rows.filter((row) => row.mode === BUDGET_HOLD_MODE).length,
    requestedTransitions: transitionsOn('requestedRate'),
    appliedTransitions: transitionsOn('rate'),
    windowRecordsMin: minOf(finiteValues(rows.map((row) => row.windowRecords))),
    windowRecordsMax: maxOf(finiteValues(rows.map((row) => row.windowRecords))),
    // The MEDIA CLOCK at the two ends, so a held estimate can be read against
    // where the media actually was while it was held.
    trueDriftStartMs: first.trueDriftMs ?? null,
    trueDriftEndMs: last.trueDriftMs ?? null,
    freshRecords: freshRecordCoverage(records, first.atMs, last.atMs),
  };
}

/**
 * Every maximal run of polls holding one finite estimate, equal by `===`.
 *
 * `records` is the in-memory raw record trace, used only to count fresh records
 * inside each plateau. It is optional and its absence reports `null` coverage —
 * never zero, which would read as "no records arrived".
 */
export function exactEstimatePlateaus(history, { pollIntervalMs = POLL_INTERVAL_MS, records = null } = {}) {
  const plateaus = [];
  let run = [];
  let runStart = 0;
  const flush = () => { if (run.length > 0) plateaus.push(describePlateau(run, runStart, records)); run = []; };
  for (const [index, row] of history.entries()) {
    if (!isPlateauEligible(row)) { flush(); continue; }
    const previous = run.at(-1);
    const continues = previous !== undefined
      // No fitted epsilon: `===` and nothing else, so two values that differ in
      // the last bit are two estimates and not one plateau.
      && row.estimateMs === previous.estimateMs
      && row.atMs - previous.atMs <= pollIntervalMs + GAP_TOLERANCE_MS
      && (!Number.isFinite(row.polls) || !Number.isFinite(previous.polls) || row.polls === previous.polls + 1);
    if (!continues) { flush(); runStart = index; }
    run.push(row);
  }
  flush();
  return plateaus;
}

export function retainedPlateaus(plateaus, minDurationMs = PLATEAU_MIN_MS) {
  return plateaus.filter((plateau) => plateau.durationMs >= minDurationMs);
}

/** The longest retained plateau; ties choose the earliest. `null` if none. */
export function longestPlateau(plateaus, minDurationMs = PLATEAU_MIN_MS) {
  let best = null;
  for (const plateau of retainedPlateaus(plateaus, minDurationMs)) {
    if (best === null || plateau.durationMs > best.durationMs) best = plateau;
  }
  return best;
}

/**
 * Cut a slice of history into maximal runs of one constant value of `key`.
 * INDEPENDENT of the plateau: it is applied to the plateau's own rows, so a
 * plateau that changed command three times reads as three subintervals rather
 * than as whatever its last poll happened to hold.
 */
export function commandSegments(rows, { key = 'requestedRate' } = {}) {
  const segments = [];
  for (const row of rows) {
    const current = segments.at(-1);
    if (current !== undefined && current.value === row[key]) {
      current.endMs = row.atMs;
      current.polls += 1;
      current.durationMs = current.endMs - current.startMs;
      continue;
    }
    segments.push({ value: row[key], startMs: row.atMs, endMs: row.atMs, durationMs: 0, polls: 1, unity: row[key] === 1 });
  }
  return segments;
}

/**
 * The plateau's command structure on both the applied and the requested rate.
 * `nonUnity` is the answer the round-1 hold statistic tried to give with a
 * single end-of-window test, and it is a LIST because a plateau may hold several
 * distinct non-unity commands and several unity gaps between them.
 */
export function subdivideByCommand(plateau, history) {
  const rows = history.slice(plateau.startIndex, plateau.endIndex + 1);
  const requested = commandSegments(rows, { key: 'requestedRate' });
  const applied = commandSegments(rows, { key: 'rate' });
  const nonUnity = (segments) => segments.filter((segment) => !segment.unity);
  return {
    requested,
    applied,
    requestedNonUnity: nonUnity(requested),
    appliedNonUnity: nonUnity(applied),
    longestConstantNonUnityMs: maxOf(nonUnity(requested).map((segment) => segment.durationMs)) ?? null,
    constantThroughout: requested.length === 1,
  };
}

/**
 * Where the arm's first settled poll sits relative to its OWN plateaus.
 *
 * The qualification interval is `[first settled poll − SETTLED_FOR_MS, first
 * settled poll]` on published poll timestamps. Both interval tests are on closed
 * intervals, so a plateau that ends exactly at the interval's start overlaps it
 * by 0 ms and is reported as an overlap with `overlapMs: 0` rather than being
 * silently dropped or silently counted as a containment.
 *
 * The two null cases stay distinct: a case that never settled reports
 * `settled: false` and null classifications, because there is no interval to
 * classify; a case that settled with no qualifying plateau reports `false` for
 * both tests and `noPlateau: true`, because the question was asked and answered.
 */
export function classifySettlingQualification(history, plateaus, { settledForMs, minDurationMs = PLATEAU_MIN_MS } = {}) {
  if (!Number.isFinite(settledForMs)) throw new TypeError('stopping-comparison-metrics: settledForMs must be supplied from the controller settings, not defaulted here');
  const retained = retainedPlateaus(plateaus, minDurationMs);
  const firstSettled = history.find((row) => row.mode === 'settled') ?? null;
  const base = { settledForMs, minDurationMs, plateauCount: retained.length, noPlateau: retained.length === 0 };
  if (firstSettled === null) {
    return {
      ...base,
      settled: false,
      firstSettledAtMs: null,
      qualificationStartMs: null,
      qualificationEndMs: null,
      overlapsPlateau: null,
      containedInPlateau: null,
      overlapMs: null,
      overlappingPlateauIndexes: null,
      containingPlateauIndex: null,
    };
  }
  const endMs = firstSettled.atMs;
  const startMs = endMs - settledForMs;
  const overlapping = [];
  let containing = null;
  let overlapMs = 0;
  for (const [index, plateau] of retained.entries()) {
    if (plateau.startMs <= endMs && plateau.endMs >= startMs) {
      overlapping.push(index);
      overlapMs = Math.max(overlapMs, Math.min(plateau.endMs, endMs) - Math.max(plateau.startMs, startMs));
    }
    if (containing === null && plateau.startMs <= startMs && plateau.endMs >= endMs) containing = index;
  }
  return {
    ...base,
    settled: true,
    firstSettledAtMs: endMs,
    qualificationStartMs: startMs,
    qualificationEndMs: endMs,
    overlapsPlateau: overlapping.length > 0,
    containedInPlateau: containing !== null,
    overlapMs: overlapping.length > 0 ? overlapMs : null,
    overlappingPlateauIndexes: overlapping,
    containingPlateauIndex: containing,
  };
}

/**
 * Whether a poll MEASURED anything: it published a finite estimate and a finite
 * measurement band. A holding poll can still do this — a record shortage and a
 * budget refusal both keep the last estimate visible — so this is the
 * measurement population and NOT the population either stopping predicate is
 * entitled to be evaluated on.
 */
export function hasFiniteMeasurement(row) {
  return Number.isFinite(row.estimateMs) && Number.isFinite(row.bandMs);
}

/**
 * Whether the controller ACCEPTED a stopping threshold at this poll, which is
 * the only population on which "inside S" is a question with an answer. Every
 * hold — waiting, stale, input-refused, budget-refused — publishes a null S and
 * a false `thresholdUsable` in the same step, so the two tests agree; both are
 * applied because the driver's history row carries S and the recorder's
 * retained poll fields carry `thresholdUsable`, and a joined row must not be
 * classified differently from an unjoined one.
 */
export function hasAcceptedThreshold(row) {
  return hasFiniteMeasurement(row) && Number.isFinite(row.stoppingThresholdMs) && row.thresholdUsable !== false;
}

/**
 * The candidate's stopping predicate and the original one, ON THE SAME POLLS.
 *
 * The population is stated three ways because the first version stated it once
 * and stated it wrongly. `polls` is every published poll. `finiteMeasurementPolls`
 * is those that measured. `actingPolls` is those that also accepted a stopping
 * threshold, and it is the denominator BOTH predicates are counted over: a
 * budget refusal has a measured estimate and no accepted S, so counting it as
 * an acting poll inflated the denominator and, at 60 Hz, moved the inside-U
 * count as well by admitting refused polls to it. Comparing two predicates over
 * differently eligible rows is not a comparison.
 *
 * The two predicates are still never merged: S = U + L accepts errors U alone
 * would not, and that difference is the experiment. On any arm with a
 * non-negative allowance `insideStopping === insideBand + onlyInsideStopping`,
 * which the manufactured checks assert as an identity rather than as a total.
 */
export function predicateCounts(history) {
  let polls = 0;
  let finiteMeasurementPolls = 0;
  let actingPolls = 0;
  let budgetHoldPolls = 0;
  let measuringHoldPolls = 0;
  let insideBand = 0;
  let insideStopping = 0;
  let onlyInsideStopping = 0;
  for (const row of history) {
    polls += 1;
    if (!hasFiniteMeasurement(row)) continue;
    finiteMeasurementPolls += 1;
    if (!hasAcceptedThreshold(row)) {
      // A poll that measured and then held. Counted, and counted APART: it is
      // evidence about the run and it is not evidence about a stopping test the
      // controller never applied.
      if (row.mode === BUDGET_HOLD_MODE) budgetHoldPolls += 1;
      else measuringHoldPolls += 1;
      continue;
    }
    actingPolls += 1;
    const band = Math.abs(row.estimateMs) <= row.bandMs;
    const stopping = Math.abs(row.estimateMs) <= row.stoppingThresholdMs;
    if (band) insideBand += 1;
    if (stopping) insideStopping += 1;
    if (stopping && !band) onlyInsideStopping += 1;
  }
  return {
    polls,
    finiteMeasurementPolls,
    actingPolls,
    budgetHoldPolls,
    measuringHoldPolls,
    unmeasuredPolls: polls - finiteMeasurementPolls,
    insideBand,
    insideStopping,
    onlyInsideStopping,
  };
}

/** Nearest rank: the `ceil(0.95n)`-th smallest, one-based. Null for n = 0. */
export function nearestRankP95(values) {
  const sorted = finiteValues(values).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/**
 * First settled poll time and elapsed settling duration, summarised APART.
 *
 * A nonsettler stays null and is never assigned the horizon. The maximum over
 * settled cases is a conditional figure and says so: when any case in the
 * population did not settle, the all-case maximum is CENSORED, because the
 * unsettled cases have durations at least as long as the horizon and reporting
 * the finite maximum as if it were the population's would understate it.
 */
export function settlingSummary(rows) {
  const settled = rows.filter((row) => Number.isFinite(row.settlingMs) && !row.neverSettledInHorizon);
  const durations = settled.map((row) => row.settlingMs);
  const firstSettledTimes = settled.map((row) => row.firstSettledAtMs).filter(Number.isFinite);
  const nonSettlerCount = rows.length - settled.length;
  return {
    cases: rows.length,
    settledCases: settled.length,
    nonSettlerCount,
    denominator: settled.length,
    maxSettlingMs: maxOf(durations),
    p95SettlingMs: nearestRankP95(durations),
    minSettlingMs: minOf(durations),
    maxFirstSettledAtMs: maxOf(firstSettledTimes),
    p95FirstSettledAtMs: nearestRankP95(firstSettledTimes),
    allCaseMaximum: {
      censored: nonSettlerCount > 0,
      observedMaxAmongSettledMs: maxOf(durations),
      censoredCount: nonSettlerCount,
    },
  };
}

/**
 * Everything the report reads for one arm of one case, in one place, so a
 * section of the recorder cannot compute the plateau one way and the overlap
 * classification another.
 */
export function caseDiagnostics(history, { settledForMs, records = null, pollIntervalMs = POLL_INTERVAL_MS, minDurationMs = PLATEAU_MIN_MS } = {}) {
  const plateaus = exactEstimatePlateaus(history, { pollIntervalMs, records });
  const retained = retainedPlateaus(plateaus, minDurationMs);
  const longest = longestPlateau(plateaus, minDurationMs);
  return {
    plateauCount: plateaus.length,
    retainedPlateauCount: retained.length,
    retainedPlateaus: retained.map((plateau) => ({ ...plateau, commands: subdivideByCommand(plateau, history) })),
    longestPlateau: longest === null ? null : { ...longest, commands: subdivideByCommand(longest, history) },
    qualification: classifySettlingQualification(history, plateaus, { settledForMs, minDurationMs }),
    predicates: predicateCounts(history),
  };
}
