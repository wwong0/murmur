// scripts/check/d8-recoverable-holds.mjs
//
// The observations and the second acceptance rule that
// `remedy-recoverable-holds-amendment.md` adds to the frozen comparison, and
// nothing else. Every function here reads a finished case and returns numbers;
// the original evaluator in `describe-d8-comparison.mjs` is untouched and the
// controller is not edited at all.
//
// The distinctions this file exists to keep apart, each of which the amendment
// and its two review rounds argued over:
//
//  - A HOLD IS OBSERVED, NEVER RECONSTRUCTED. Clause 4 checks the mode, reason,
//    required S, usability, accepted S, close figure and both rates that the run
//    actually published. It never infers them from the branch that must have
//    produced them, because agreeing with the source is what the audit is for.
//  - THE JOIN IS THE EVIDENCE. The driver's history carries mode, reason,
//    accepted S and the two rates; the recorder's retained snapshot carries
//    required S, `thresholdUsable` and `fastestCloseMs`. Only the joined row can
//    answer clause 4, so a join that cannot be made one-to-one makes the case
//    UNEVALUABLE — which is an evidence failure, never an exemption.
//    The snapshot stream publishes no time of its own; identity is `polls`, and
//    only the history's timestamps are checked. There is no cross-stream
//    timestamp comparison to make and none is claimed.
//  - PRESENCE IS EVIDENCE; VALUES ARE JUDGEMENT. A poll missing a field an audit
//    reads cannot be evaluated at all, so it is an evidence failure and the
//    recorder stops on it. A poll carrying every field and carrying a wrong one
//    is a case that FAILS a clause. Keeping those apart is what V2 of
//    `remedy-recoverable-holds-verification.md` found missing: an absent
//    allowance used to make the clause-5 identity skip itself, and a null
//    accepted threshold facing a finite one used to bypass the agreement test,
//    so evidence incapable of establishing a clause read as evidence that had.
//  - THE SCHEDULE IS EXPECTED, NOT INFERRED. Phase and first poll id are the
//    approved grid's, supplied here as constants. Deriving them from the history
//    being checked would accept any self-consistent truncation of it (V2).
//  - AN EPISODE IS A MAXIMAL RUN OF SCHEDULED POLLS, with no minimum duration.
//    Its duration comes from the sampled-state convention: a poll's mode holds
//    from its timestamp to the next scheduled poll, capped at the horizon. So an
//    episode that reaches the horizon is RIGHT-CENSORED with an absent exit, and
//    one that begins at the final poll is one poll and zero observed duration.
//  - THE FRESH-DWELL AUDIT IS AN INSIDE-THRESHOLD RUN, not the controller's
//    private dwell state and not the plateau diagnostic's fixed 5000 ms
//    qualification interval. The two share an endpoint and nothing else, which
//    is why its fields are named `dwellRun*` and never reuse `qualification*`.
//  - PRE-SETTLE IS THE ONLY EXEMPTION. A hold at or after the case's own first
//    settled poll is a failure under both rules, and a nonsettler is rejected
//    whether or not its holds ended.
//
// TEST MACHINERY — under scripts/. Pure: no clock, no randomness, no I/O.

import { BUDGET_HOLD_MODE, PLATEAU_BREAKING_MODES, nearestRankP95 } from './d8-comparison-metrics.mjs';
import { POLL_INTERVAL_MS } from './mechanism-driver.mjs';
import { D8_HOLD_REASON, D8_UNCERTIFIED_MODE } from './d8-research-controller.mjs';

export { BUDGET_HOLD_MODE };
/** The legacy rule, as published before this amendment, under an explicit name. */
export const ORIGINAL_POLICY_ID = 'original-zero-refusal';
/** The amended rule. The only relaxation is the pre-settle budget-refusal clause. */
export const AMENDED_POLICY_ID = 'recoverable-pre-settle-v1';
export const COMPARISON_POLICY_IDS = Object.freeze([ORIGINAL_POLICY_ID, AMENDED_POLICY_ID]);
/** Float slack on the scheduled poll grid. Poll times are exact multiples of the
 *  interval in the model, so this absorbs `+` rounding and nothing else. */
const GRID_TOLERANCE_MS = 1e-6;
/** The approved grid's phase and first poll id, as CONSTANTS. The frozen
 *  experiment schedules its first poll at zero and numbers it one; a run whose
 *  retained history begins anywhere else is missing the polls before it, however
 *  neatly the rest of that history renumbers itself (V2). */
export const APPROVED_POLL_PHASE_MS = 0;
export const APPROVED_FIRST_POLL_ID = 1;

/** The amended rule as data, so the manifest carries its exact text. */
export const AMENDED_ACCEPTANCE = Object.freeze({
  policy: AMENDED_POLICY_ID,
  relaxes: 'a budget refusal strictly before the case first settles, and only that',
  clauses: Object.freeze([
    'first settle inside the frozen horizon, with the observed first settled poll and the summary agreeing',
    'post-first-settle duty at least 0.8, zero corrective sign reversals, zero measured controller input loss, zero controller reset drops, zero record refusals',
    'every budget-hold poll strictly before that case own first settled poll',
    'at every budget hold: the named mode and reason, a finite required S above the ceiling, no usable threshold, no accepted S, no live close figure, and exact unity applied and requested',
    'at every poll with an accepted threshold: finite U and S, S equal to U + L, and S at or below the ceiling',
    'after any pre-settle hold, an uninterrupted inside-threshold run of at least SETTLED_FOR_MS ending at first settling and beginning after the last pre-settle hold',
  ]),
  notes: Object.freeze([
    'Duty is post-first-settle only. It bounds neither pre-settle unavailability nor the duration of observation after settling; a case first settling at the final scheduled poll has duty 1.0 from one poll and may pass.',
    'No hold-duration or hold-count bar is imposed. The case horizon is the only overall time budget, and recovery must still leave room for fresh dwell.',
    'Record refusals and reset drops are NOT exempted; the amended rule reuses their original zero bounds.',
    'Missing, duplicate, misjoined, off-schedule or field-incomplete poll evidence is an evidence failure. It STOPS the run in either judgement mode: it earns no exemption, no accepted verdict and no place in a candidate failure list, because it is a failure of the experiment and not of the candidate.',
    'Right-censored episodes belong to cases already rejected for nonsettling or post-settle recurrence. Censoring is descriptive.',
  ]),
});

/** Clause 4, as codes, so a violation is named rather than described. */
export const HOLD_SAFETY_VIOLATIONS = Object.freeze([
  'hold-reason-not-budget-refusal',
  'required-threshold-not-finite',
  'required-threshold-not-over-ceiling',
  'threshold-usable-during-hold',
  'accepted-threshold-during-hold',
  'close-figure-during-hold',
  'applied-rate-not-unity',
  'requested-rate-not-unity',
]);

const finiteOr = (value) => (Number.isFinite(value) ? value : null);
const minOf = (values) => (values.length ? Math.min(...values) : null);
const maxOf = (values) => (values.length ? Math.max(...values) : null);

/**
 * The fields the audits below read, per stream. Every one of them must be
 * PRESENT on every poll; an absent field is unevaluable evidence and not a
 * clause that quietly declines to run (V2).
 *
 * `spreadMs`, `windowRecords`, `trueDriftMs` and the rest of both streams are
 * deliberately absent from this list: nothing here reads them, so requiring them
 * would be this file asserting on a shape it does not depend on.
 */
const REQUIRED_HISTORY_FIELDS = Object.freeze([
  'polls', 'atMs', 'mode', 'reason', 'estimateMs', 'bandMs', 'stoppingThresholdMs', 'rate', 'requestedRate',
]);
const REQUIRED_POLLED_FIELDS = Object.freeze([
  'polls', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'thresholdUsable', 'fastestCloseMs', 'actuatorAllowanceMs',
]);

/** A published threshold is either a finite number or an explicit null. Anything
 *  else — absent, NaN, infinite, a string — is not an observation. */
const wellFormedThreshold = (value) => value === null || Number.isFinite(value);

/**
 * The two streams' accepted thresholds, compared over their WHOLE domain.
 *
 * The first version compared them only when both were finite, so the one pair
 * that matters most — a hold's null facing a finite number, in either direction
 * — was the pair it skipped, and the audit then read whichever stream it
 * happened to prefer (V2). Null is a value here, not an absence.
 */
function acceptedThresholdDisagreement(left, right) {
  if (left === undefined || right === undefined) return 'accepted-threshold-absent';
  if (!wellFormedThreshold(left) || !wellFormedThreshold(right)) return 'accepted-threshold-not-null-or-finite';
  return left === right ? null : 'accepted-threshold-disagreement';
}

/**
 * The driver's history and the recorder's retained snapshot stream, joined
 * one-to-one by `polls`.
 *
 * Length, per-index identity, strictly increasing poll ids, the presence of
 * every field an audit reads and a contiguous scheduled grid are all checked,
 * and each failure is named. `stoppingThresholdMs` is the duplicated field: both
 * streams publish it, so they are required to AGREE over its whole domain rather
 * than one silently overwriting the other.
 */
export function joinPollEvidence(history, polled, {
  pollIntervalMs = POLL_INTERVAL_MS, horizonMs = null, pollPhaseMs = APPROVED_POLL_PHASE_MS,
} = {}) {
  const failures = [];
  const rows = [];
  if (!Array.isArray(history) || !Array.isArray(polled)) {
    return { complete: false, failures: ['join-streams-absent'], rows, scheduleComplete: false, endsAtHorizon: false };
  }
  if (history.length !== polled.length) failures.push('join-length-mismatch');
  const paired = Math.min(history.length, polled.length);
  for (let index = 0; index < paired; index += 1) {
    const left = history[index];
    const right = polled[index];
    if (left.polls !== right.polls) { failures.push('join-identity-mismatch'); break; }
    if (index > 0 && !(left.polls === history[index - 1].polls + 1)) failures.push('join-poll-ids-not-consecutive');
    if (index > 0 && !(left.atMs > history[index - 1].atMs)) failures.push('join-poll-times-not-increasing');
    if (!Number.isFinite(left.atMs)) failures.push('join-poll-time-not-finite');
    if (REQUIRED_HISTORY_FIELDS.some((field) => left[field] === undefined)) failures.push('history-poll-fields-absent');
    if (REQUIRED_POLLED_FIELDS.some((field) => right[field] === undefined)) failures.push('retained-poll-fields-absent');
    // Usability is the field clause 4 turns on, and `!== false` would read an
    // absent or misspelt one as a usable threshold. It is required to be a
    // boolean before anything is concluded from it.
    if (typeof right.thresholdUsable !== 'boolean') failures.push('threshold-usability-not-boolean');
    const disagreement = acceptedThresholdDisagreement(left.stoppingThresholdMs, right.stoppingThresholdMs);
    if (disagreement !== null) failures.push(disagreement);
    rows.push({
      polls: left.polls,
      atMs: left.atMs,
      mode: left.mode,
      reason: left.reason,
      estimateMs: left.estimateMs,
      bandMs: left.bandMs,
      settlingMs: left.settlingMs,
      rate: left.rate,
      requestedRate: left.requestedRate,
      // From the history, and named for what it is: the threshold the controller
      // ACCEPTED, which every hold publishes as null.
      acceptedStoppingThresholdMs: left.stoppingThresholdMs,
      // From the retained snapshot, and the three fields the history never had.
      requiredStoppingThresholdMs: right.requiredStoppingThresholdMs,
      thresholdUsable: right.thresholdUsable,
      fastestCloseMs: right.fastestCloseMs,
      actuatorAllowanceMs: right.actuatorAllowanceMs,
    });
  }
  const grid = checkGrid(rows, { pollIntervalMs, horizonMs, pollPhaseMs });
  failures.push(...grid.failures);
  return {
    complete: failures.length === 0,
    failures: [...new Set(failures)],
    rows,
    scheduleComplete: grid.scheduleComplete,
    endsAtHorizon: grid.endsAtHorizon,
    polls: rows.length,
  };
}

/**
 * Whether every scheduled poll of the run is present, against a schedule the
 * CALLER supplies.
 *
 * The first version took the phase from `rows[0].atMs` and asked only that the
 * first poll id be 1. Deleting the first poll of both streams and renumbering
 * the rest from one therefore produced a history that agreed with itself and
 * declared its schedule complete, which is how a run could lose the poll that
 * held and never say so (V2). The expected phase and first id are constants of
 * the approved experiment, so they are compared against, not derived.
 */
function checkGrid(rows, { pollIntervalMs, horizonMs, pollPhaseMs }) {
  if (rows.length === 0) return { scheduleComplete: false, endsAtHorizon: false, failures: ['no-joined-polls'] };
  const failures = [];
  if (rows[0].polls !== APPROVED_FIRST_POLL_ID) failures.push('schedule-does-not-start-at-the-expected-poll-id');
  if (Math.abs(rows[0].atMs - pollPhaseMs) > GRID_TOLERANCE_MS) failures.push('schedule-does-not-start-at-the-expected-phase');
  let contiguous = true;
  for (const [index, row] of rows.entries()) {
    if (Math.abs(row.atMs - (pollPhaseMs + index * pollIntervalMs)) > GRID_TOLERANCE_MS) contiguous = false;
  }
  if (!contiguous) failures.push('missing-scheduled-polls');
  const lastMs = rows.at(-1).atMs;
  const endsAtHorizon = horizonMs !== null && lastMs <= horizonMs + GRID_TOLERANCE_MS && lastMs + pollIntervalMs > horizonMs + GRID_TOLERANCE_MS;
  if (horizonMs !== null && !endsAtHorizon) failures.push('schedule-does-not-reach-the-horizon');
  return { scheduleComplete: failures.length === 0, endsAtHorizon, failures };
}

/**
 * Clause 4 on ONE observed hold poll. Every test reads a published field.
 *
 * `settlingMs` is deliberately not tested: it is the historical first settling
 * duration, which a hold preserves on purpose, and reading it as a live settled
 * indicator is the confusion the amendment names.
 */
export function holdSafetyViolations(row, { maxStoppingThresholdMs }) {
  const violations = [];
  if (row.reason !== D8_HOLD_REASON) violations.push('hold-reason-not-budget-refusal');
  if (!Number.isFinite(row.requiredStoppingThresholdMs)) violations.push('required-threshold-not-finite');
  else if (!(row.requiredStoppingThresholdMs > maxStoppingThresholdMs)) violations.push('required-threshold-not-over-ceiling');
  if (row.thresholdUsable !== false) violations.push('threshold-usable-during-hold');
  if (row.acceptedStoppingThresholdMs !== null) violations.push('accepted-threshold-during-hold');
  if (row.fastestCloseMs !== null) violations.push('close-figure-during-hold');
  if (row.rate !== 1) violations.push('applied-rate-not-unity');
  if (row.requestedRate !== 1) violations.push('requested-rate-not-unity');
  return violations;
}

/** Violations that say the row cannot be judged, as opposed to judged wrong. */
export const UNCERTIFIED_EVIDENCE_GAPS = Object.freeze(['command-settings-absent', 'estimate-or-band-not-finite']);

/**
 * The refusal split's poll (`remedy-pitch-preserving-amendment.md`). Everything
 * a refusal withholds must still be withheld, and the rate must be what the
 * UNCHANGED law and the UNCHANGED write filter leave standing.
 *
 * The filter is audited, not removed. The law's newly computed rate either
 * reached the element exactly, or the filter kept the previous non-unity rate
 * because the change was within RATE_EPSILON, on the same side of unity and in
 * the same direction — the only case in which the controller skips a write.
 * Demanding exact equality to every computed rate would reject legitimate
 * evidence, and accepting any nearby rate would stop auditing the law.
 *
 * This checks the command law was followed. It is not a claim that the command
 * could not overshoot: U is a spread, not a certified bound on the median.
 */
export function uncertifiedCorrectionViolations(row, { maxStoppingThresholdMs }) {
  const violations = [];
  if (row.reason !== D8_HOLD_REASON) violations.push('uncertified-reason-not-budget-refusal');
  if (!Number.isFinite(row.requiredStoppingThresholdMs)) violations.push('required-threshold-not-finite');
  else if (!(row.requiredStoppingThresholdMs > maxStoppingThresholdMs)) violations.push('required-threshold-not-over-ceiling');
  if (row.thresholdUsable !== false) violations.push('threshold-usable-during-refusal');
  if (row.acceptedStoppingThresholdMs !== null) violations.push('accepted-threshold-during-refusal');
  if (row.fastestCloseMs !== null) violations.push('close-figure-during-refusal');
  if (row.requestedRate !== row.rate) violations.push('requested-rate-not-the-applied-rate');
  const settings = row.settings ?? null;
  const timeConstantMs = settings?.TIME_CONSTANT_MS;
  const authority = settings?.MAX_RATE_DEVIATION;
  const epsilon = settings?.RATE_EPSILON;
  if (![timeConstantMs, authority, epsilon].every(Number.isFinite)) return [...violations, 'command-settings-absent'];
  if (!Number.isFinite(row.estimateMs) || !Number.isFinite(row.bandMs)) return [...violations, 'estimate-or-band-not-finite'];
  if (Number.isFinite(row.requiredStoppingThresholdMs) && !(Math.abs(row.estimateMs) > row.requiredStoppingThresholdMs)) {
    violations.push('estimate-not-outside-required-threshold');
  }
  const excess = Math.sign(row.estimateMs) * Math.max(0, Math.abs(row.estimateMs) - row.bandMs);
  const commanded = 1 + Math.max(-authority, Math.min(authority, -excess / timeConstantMs));
  const written = row.rate === commanded;
  const filtered = Number.isFinite(row.rate) && row.rate !== 1 && commanded !== 1
    && Math.sign(row.rate - 1) === Math.sign(commanded - 1)
    && Math.abs(row.rate - commanded) <= epsilon;
  if (!written && !filtered) violations.push('applied-rate-not-the-law-or-its-filtered-predecessor');
  return violations;
}

/**
 * Clause 5 over every poll that ACCEPTED a threshold. S must be exactly U + L —
 * the same IEEE-754 sum the controller computed from the same two published
 * doubles, so this is an identity and needs no tolerance — and must sit at or
 * below the fixed ceiling, with no slack above it.
 *
 * A NON-FINITE OPERAND IS A FAILURE, NOT A SKIP (V2). Testing the identity only
 * when U and L are both finite lets a poll that accepted a threshold and
 * published no allowance pass the clause without it ever being applied.
 */
export function thresholdCeilingViolations(rows, { maxStoppingThresholdMs }) {
  const violations = [];
  for (const row of rows) {
    if (row.acceptedStoppingThresholdMs === null) continue;
    const failures = [];
    if (!Number.isFinite(row.bandMs)) failures.push('band-not-finite');
    if (!Number.isFinite(row.actuatorAllowanceMs)) failures.push('allowance-not-finite');
    if (!Number.isFinite(row.acceptedStoppingThresholdMs)) failures.push('accepted-threshold-not-finite');
    else if (Number.isFinite(row.bandMs) && Number.isFinite(row.actuatorAllowanceMs)
      && row.acceptedStoppingThresholdMs !== row.bandMs + row.actuatorAllowanceMs) failures.push('accepted-threshold-not-band-plus-allowance');
    if (!(row.acceptedStoppingThresholdMs <= maxStoppingThresholdMs)) failures.push('accepted-threshold-over-ceiling');
    if (failures.length > 0) violations.push({ polls: row.polls, atMs: row.atMs, failures });
  }
  return violations;
}

/**
 * Whether a poll may sit inside a fresh-dwell run: measured, usable input, an
 * accepted threshold inside the ceiling, and an estimate inside it. A refused
 * poll of any kind fails the usability test, so `waiting`, `stale` and the
 * budget hold are named for legibility rather than to carry the exclusion.
 */
function dwellEligible(row, { maxStoppingThresholdMs }) {
  if (PLATEAU_BREAKING_MODES.includes(row.mode)) return false;
  if (row.mode === BUDGET_HOLD_MODE) return false;
  if (row.mode === D8_UNCERTIFIED_MODE) return false;
  if (!Number.isFinite(row.estimateMs)) return false;
  if (!Number.isFinite(row.acceptedStoppingThresholdMs)) return false;
  if (row.thresholdUsable !== true) return false;
  if (!(row.acceptedStoppingThresholdMs <= maxStoppingThresholdMs)) return false;
  return Math.abs(row.estimateMs) <= row.acceptedStoppingThresholdMs;
}

/**
 * Clause 6. The final uninterrupted eligible run of scheduled polls ending at
 * first settling.
 *
 * Walked BACKWARDS from the first settled poll and stopped at the first
 * ineligible poll, so no time before an interruption is credited. The `status`
 * distinguishes the three absences the amendment insists on keeping apart: a
 * case with no hold needs no audit, a case with no first settling or incomplete
 * evidence cannot have one, and a case that has one either passes or fails.
 */
export function freshDwellAudit(rows, { firstSettledIndex, lastPreSettleHoldAtMs, settledForMs, maxStoppingThresholdMs, evidenceComplete = true }) {
  const empty = { dwellRunStartMs: null, dwellRunEndMs: null, dwellRunDurationMs: null, dwellRunPolls: 0, failures: [] };
  if (lastPreSettleHoldAtMs === null) return { ...empty, status: 'not-applicable' };
  if (firstSettledIndex < 0 || !evidenceComplete) return { ...empty, status: 'unavailable' };
  let start = firstSettledIndex;
  while (start > 0 && dwellEligible(rows[start - 1], { maxStoppingThresholdMs })) start -= 1;
  const audit = {
    dwellRunStartMs: rows[start].atMs,
    dwellRunEndMs: rows[firstSettledIndex].atMs,
    dwellRunDurationMs: rows[firstSettledIndex].atMs - rows[start].atMs,
    dwellRunPolls: firstSettledIndex - start + 1,
    failures: [],
  };
  if (!dwellEligible(rows[firstSettledIndex], { maxStoppingThresholdMs })) audit.failures.push('settling-poll-not-inside-threshold');
  // ENTAILED BY THE WALK ABOVE, and kept anyway. A hold poll is ineligible, so a
  // run ending at first settling cannot reach back past one — which means this
  // clause cannot fail while the walk is correct, and removing it changes no
  // observation. It is the guard on the WALK: break the backwards search and
  // this is what says so. The report records it as entailed rather than as an
  // independently falsifiable audit, because claiming otherwise would be a
  // discrimination the fixtures cannot demonstrate.
  if (!(audit.dwellRunStartMs > lastPreSettleHoldAtMs)) audit.failures.push('dwell-run-does-not-clear-the-last-hold');
  if (!(audit.dwellRunDurationMs >= settledForMs)) audit.failures.push('dwell-run-shorter-than-settled-for');
  return { ...audit, status: audit.failures.length === 0 ? 'passed' : 'failed' };
}

/**
 * The budget-hold episodes of one case, with the sampled-state duration
 * convention attached.
 *
 * A poll's mode holds from its timestamp to the next scheduled poll, capped at
 * the horizon. So an episode that ends at a later non-budget poll lasted
 * `exit − start`; one still holding at the horizon lasted `horizon − start`, has
 * no exit and is right-censored; and one that begins at the final poll is a
 * single poll of zero observed duration rather than a poll that never happened.
 */
export function holdEpisodes(rows, { horizonMs, maxStoppingThresholdMs }) {
  const episodes = [];
  let current = null;
  const closeAt = (exitIndex) => {
    const exit = exitIndex === null ? null : rows[exitIndex];
    current.exitAtMs = exit === null ? null : exit.atMs;
    current.exitMode = exit === null ? null : exit.mode;
    current.censored = exit === null;
    current.observedDurationMs = (exit === null ? horizonMs : exit.atMs) - current.startAtMs;
    // Exiting into `waiting` is an exit, not a recovery: the threshold is no more
    // usable there than it was during the hold, so the first later USABLE poll is
    // reported separately and may be null.
    const usable = rows.slice(exitIndex ?? rows.length).find((row) => row.thresholdUsable === true && Number.isFinite(row.acceptedStoppingThresholdMs)) ?? null;
    current.firstUsableThresholdAtMs = usable === null ? null : usable.atMs;
    current.firstUsableThresholdPollId = usable === null ? null : usable.polls;
    episodes.push(current);
    current = null;
  };
  for (const [index, row] of rows.entries()) {
    const isHold = row.mode === BUDGET_HOLD_MODE;
    if (isHold && current === null) {
      current = {
        startAtMs: row.atMs, startPollId: row.polls, lastHoldAtMs: row.atMs, lastHoldPollId: row.polls,
        holdPolls: 0, requiredStoppingMinMs: null, requiredStoppingMaxMs: null, safetyViolations: [],
      };
    }
    if (isHold) {
      current.holdPolls += 1;
      current.lastHoldAtMs = row.atMs;
      current.lastHoldPollId = row.polls;
      const required = finiteOr(row.requiredStoppingThresholdMs);
      if (required !== null) {
        current.requiredStoppingMinMs = current.requiredStoppingMinMs === null ? required : Math.min(current.requiredStoppingMinMs, required);
        current.requiredStoppingMaxMs = current.requiredStoppingMaxMs === null ? required : Math.max(current.requiredStoppingMaxMs, required);
      }
      const violations = holdSafetyViolations(row, { maxStoppingThresholdMs });
      if (violations.length > 0) current.safetyViolations.push({ polls: row.polls, atMs: row.atMs, violations });
      continue;
    }
    if (current !== null) closeAt(index);
  }
  if (current !== null) closeAt(null);
  return episodes;
}

/** The longest episode, ties broken by the earliest start, as the amendment fixes. */
function longestEpisode(episodes) {
  let best = null;
  for (const episode of episodes) {
    if (best === null || episode.observedDurationMs > best.observedDurationMs) best = episode;
  }
  return best;
}

/**
 * Everything the amended rule and the report read about one case and arm, in one
 * place, so no section of the recorder can compute a hold one way and its
 * duration another.
 *
 * Duration totals are NULL when the scheduled evidence is incomplete: a gap is
 * not bridged and unknown time is not replaced with zero.
 */
export function caseHoldObservations({
  history, polled, summary, horizonMs, settledForMs, maxStoppingThresholdMs,
  pollIntervalMs = POLL_INTERVAL_MS, pollPhaseMs = APPROVED_POLL_PHASE_MS,
}) {
  const evidence = joinPollEvidence(history, polled, { pollIntervalMs, horizonMs, pollPhaseMs });
  const rows = evidence.rows;
  const firstSettledIndex = rows.findIndex((row) => row.mode === 'settled');
  const firstSettledAtMs = firstSettledIndex < 0 ? null : rows[firstSettledIndex].atMs;
  const episodes = holdEpisodes(rows, { horizonMs, maxStoppingThresholdMs });
  const holdRows = rows.filter((row) => row.mode === BUDGET_HOLD_MODE);
  const preSettle = firstSettledAtMs === null ? [] : holdRows.filter((row) => row.atMs < firstSettledAtMs);
  const postSettle = firstSettledAtMs === null ? [] : holdRows.filter((row) => row.atMs >= firstSettledAtMs);
  const lastPreSettleHoldAtMs = firstSettledAtMs === null
    ? (holdRows.length > 0 ? holdRows.at(-1).atMs : null)
    : (preSettle.length > 0 ? preSettle.at(-1).atMs : null);
  const durationsValid = evidence.scheduleComplete;
  const finalPollIsBudgetHold = rows.length > 0 && rows.at(-1).mode === BUDGET_HOLD_MODE;
  // The sampled-state interval of each hold poll, clipped to the pre-settle
  // window. Every other form of waiting is NOT budget-hold time.
  const preSettleBudgetHoldMs = !durationsValid || firstSettledAtMs === null ? null : holdRows.reduce((total, row) => {
    const end = Math.min(row.atMs + pollIntervalMs, horizonMs, firstSettledAtMs);
    return total + Math.max(0, end - Math.min(row.atMs, firstSettledAtMs));
  }, 0);
  const longest = longestEpisode(episodes);
  const audit = freshDwellAudit(rows, {
    firstSettledIndex, lastPreSettleHoldAtMs, settledForMs, maxStoppingThresholdMs,
    evidenceComplete: evidence.complete,
  });
  const ceilingViolations = thresholdCeilingViolations(rows, { maxStoppingThresholdMs });
  const safetyFailures = episodes.flatMap((episode) => episode.safetyViolations);
  return {
    evidence: {
      complete: evidence.complete,
      failures: evidence.failures,
      polls: rows.length,
      scheduleComplete: evidence.scheduleComplete,
      endsAtHorizon: evidence.endsAtHorizon,
    },
    horizonMs,
    firstSettledAtMs,
    // Clause 1's agreement check: the observed first settled poll against the
    // summary's own figure, which is computed from the same history by a
    // different function and must not be assumed to match.
    summaryFirstSettledAtMs: summary?.settledWithinRunMs ?? null,
    firstSettledAgrees: (summary?.settledWithinRunMs ?? null) === firstSettledAtMs,
    settlingMs: summary?.settlingMs ?? null,
    neverSettledInHorizon: firstSettledIndex < 0,
    postSettlePolls: firstSettledIndex < 0 ? 0 : rows.length - firstSettledIndex,
    postSettleObservedMs: firstSettledAtMs === null ? null : horizonMs - firstSettledAtMs,
    holdPollCount: holdRows.length,
    episodeCount: episodes.length,
    // Null partitions for a nonsettler: it has no first settling to be before.
    holdPollsBeforeFirstSettle: firstSettledAtMs === null ? null : preSettle.length,
    holdPollsAtOrAfterFirstSettle: firstSettledAtMs === null ? null : postSettle.length,
    postSettleRecurrence: firstSettledAtMs !== null && postSettle.length > 0,
    totalObservedHoldMs: durationsValid ? episodes.reduce((total, episode) => total + episode.observedDurationMs, 0) : null,
    longestEpisodeMs: durationsValid && longest !== null ? longest.observedDurationMs : null,
    longestEpisodeCensored: longest === null ? null : longest.censored,
    longestEpisodeStartAtMs: longest === null ? null : longest.startAtMs,
    censoredEpisodes: episodes.filter((episode) => episode.censored).length,
    finalPollIsBudgetHold,
    durationsValid,
    lastPreSettleHoldAtMs,
    firstUsableAfterLastHoldAtMs: episodes.length === 0 ? null : episodes.at(-1).firstUsableThresholdAtMs,
    preSettleBudgetHoldMs,
    preSettleBudgetHoldFraction: preSettleBudgetHoldMs === null || !(firstSettledAtMs > 0) ? null : preSettleBudgetHoldMs / firstSettledAtMs,
    freshDwellAudit: audit,
    holdSafetyFailures: safetyFailures,
    thresholdCeilingFailures: ceilingViolations,
    episodes,
  };
}

/**
 * The amended judged-failure list for one case.
 *
 * It is the original rule with ONE clause replaced: `unhandled-budget-refusal`
 * gives way to the four audits plus the evidence requirement. Every other bound
 * — horizon, duty, reversals, measured input loss, reset drops and record
 * refusals — is reused at its original value, and none of them is relaxed.
 */
export function amendedFailures(originalFailures, holds) {
  const failures = originalFailures.filter((failure) => failure !== 'unhandled-budget-refusal');
  // A BACKSTOP, and no longer the primary answer. The recorder now stops a run
  // the moment a case's evidence will not join, so this clause cannot appear in
  // a published verdict (V1). It stays because this function is pure and callable
  // on any observation, and a caller that skipped the gate must not read silence
  // here as a pass.
  if (!holds.evidence.complete) failures.push('hold-evidence-unevaluable');
  if (!holds.firstSettledAgrees) failures.push('settling-definition-disagreement');
  if (holds.postSettleRecurrence) failures.push('post-settle-budget-refusal');
  if (holds.holdSafetyFailures.length > 0) failures.push('hold-safety-failure');
  if (holds.thresholdCeilingFailures.length > 0) failures.push('threshold-ceiling-failure');
  if (holds.freshDwellAudit.status === 'failed' || holds.freshDwellAudit.status === 'unavailable') failures.push('fresh-dwell-audit-failed');
  return failures;
}

/**
 * One population's holds, summarised. Every denominator is stated, and observed
 * censored durations are counted apart from completed ones — a censored episode
 * is a lower bound on a duration nobody observed the end of.
 */
export function summariseHolds(observations) {
  const withHolds = observations.filter((row) => row.holdPollCount > 0);
  const completed = observations.flatMap((row) => row.episodes.filter((episode) => !episode.censored).map((episode) => episode.observedDurationMs));
  const censored = observations.flatMap((row) => row.episodes.filter((episode) => episode.censored).map((episode) => episode.observedDurationMs));
  const fractions = observations.map((row) => row.preSettleBudgetHoldFraction).filter(Number.isFinite);
  const audits = {};
  for (const row of observations) audits[row.freshDwellAudit.status] = (audits[row.freshDwellAudit.status] ?? 0) + 1;
  return {
    cases: observations.length,
    casesWithHolds: withHolds.length,
    casesWithoutHolds: observations.length - withHolds.length,
    nonSettlers: observations.filter((row) => row.neverSettledInHorizon).length,
    postSettleRecurrence: observations.filter((row) => row.postSettleRecurrence).length,
    evidenceIncomplete: observations.filter((row) => !row.evidence.complete).length,
    holdPolls: observations.reduce((total, row) => total + row.holdPollCount, 0),
    episodes: observations.reduce((total, row) => total + row.episodeCount, 0),
    completedEpisodes: {
      denominator: completed.length,
      minMs: minOf(completed), maxMs: maxOf(completed), p95Ms: nearestRankP95(completed),
    },
    censoredEpisodes: {
      denominator: censored.length,
      note: 'observed durations of episodes still holding at the horizon; each is a lower bound',
      minMs: minOf(censored), maxMs: maxOf(censored),
    },
    preSettleHoldFraction: {
      denominator: fractions.length,
      max: maxOf(fractions), p95: nearestRankP95(fractions),
    },
    postSettleObservedMs: {
      denominator: observations.filter((row) => Number.isFinite(row.postSettleObservedMs)).length,
      minMs: minOf(observations.map((row) => row.postSettleObservedMs).filter(Number.isFinite)),
    },
    postSettlePollsMin: minOf(observations.filter((row) => !row.neverSettledInHorizon).map((row) => row.postSettlePolls)),
    freshDwellAudits: audits,
    holdSafetyFailures: observations.reduce((total, row) => total + row.holdSafetyFailures.length, 0),
    thresholdCeilingFailures: observations.reduce((total, row) => total + row.thresholdCeilingFailures.length, 0),
  };
}
