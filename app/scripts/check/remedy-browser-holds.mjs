// Browser poll adaptation and audit of the frozen recoverable-hold policy.
import { MAX_STOPPING_THRESHOLD_MS, SETTLED_FOR_MS } from '../../public/lib/drift-controller.mjs';
import { acceptedStoppingThresholdMs } from '../drift-figures.mjs';
import {
  BUDGET_HOLD_MODE,
  UNCERTIFIED_EVIDENCE_GAPS,
  freshDwellAudit,
  holdEpisodes,
  holdSafetyViolations,
  summariseHolds,
  thresholdCeilingViolations,
  uncertifiedCorrectionViolations,
} from './d8-recoverable-holds.mjs';
import { D8_REFUSAL_MODES, D8_UNCERTIFIED_MODE } from './d8-research-controller.mjs';

const HOLD_MODE = BUDGET_HOLD_MODE;
/** `hold-after-first-settling` keeps its published name and now counts BOTH
 *  refusal modes; the split's own poll has a clause of its own. */
export const HOLD_CLAUSE_NAMES = Object.freeze([
  'hold-safety-unity-and-no-accepted-threshold',
  'hold-fresh-dwell-5000ms',
  'hold-after-first-settling',
  'uncertified-correction-follows-the-law-and-certifies-nothing',
]);

const has = (object, field) => object !== null && typeof object === 'object' && Object.hasOwn(object, field);
const finite = (value) => Number.isFinite(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Set(values)];

function rowSnapshot(row) {
  return object(row?.controller) ? row.controller : (object(row?.snapshot) ? row.snapshot : null);
}

function clause(name, status, observed, detail = null, row = null) {
  const result = { name, status, observed };
  if (detail !== null) result.detail = detail;
  if (row !== null) {
    result.atMs = finite(row.atMs) ? row.atMs : null;
    const snapshotPolls = rowSnapshot(row)?.polls;
    result.pollId = finite(row.pollId) ? row.pollId : finite(snapshotPolls) ? snapshotPolls : null;
    result.file = row.file ?? 'seam-events.ndjson';
  }
  return result;
}

/**
 * The browser polls as audit rows, with the rate STANDING at each poll.
 *
 * The standing rate is seeded at unity and carried forward, which is what
 * clause 4 reads. The offline driver holds `requestedRate` as one variable
 * seeded at unity, updates it only when the controller commands a new rate, and
 * publishes it on every history row (`mechanism-driver.mjs`) — so an offline
 * hold poll reports the rate the last write left, not nothing. The real browser
 * controller also writes only when the rate changes, so most polls carry no call
 * at all: the first candidate trial retained 1007 polls against 438 `rate-call`
 * events. Reading a poll that wrote nothing as an absent field refuses the hold
 * audit on precisely the polls it exists to judge, and it refuses them for a
 * reason the evidence contradicts — the stream states positively that no write
 * occurred.
 *
 * A RETAINED CALL WITHOUT A FINITE `requestedRate` IS STILL AN EVIDENCE GAP, and
 * so is a poll standing on one. The absence carried through here is the absence
 * of a write; it is not the absence of a field on a write that happened, and the
 * two must not become each other. Carrying forward also keeps the clause sharp:
 * a hold that follows a non-unity write without returning the element to unity
 * still stands on 1.01 and still fails.
 */
export function browserHoldRows(capturePolls) {
  const incomplete = [];
  const rows = [];
  const polls = Array.isArray(capturePolls) ? capturePolls : [];
  let requestedRate = 1;
  let requestComplete = true;
  for (const poll of polls) {
    const calls = Array.isArray(poll?.rateCalls) ? poll.rateCalls : [];
    if (calls.length > 0) {
      const call = calls.at(-1);
      requestComplete = has(call, 'requestedRate') && finite(call.requestedRate);
      requestedRate = requestComplete ? call.requestedRate : undefined;
    }
    const snapshot = rowSnapshot(poll);
    const required = ['pollId', 'atMs'];
    for (const field of required) if (!has(poll, field)) incomplete.push({ pollId: poll?.pollId, field });
    const snapshotFields = ['mode', 'reason', 'estimateMs', 'bandMs', 'stoppingThresholdMs', 'requiredStoppingThresholdMs', 'thresholdUsable', 'fastestCloseMs', 'actuatorAllowanceMs', 'rate'];
    for (const field of snapshotFields) if (!has(snapshot, field)) incomplete.push({ pollId: poll?.pollId, field: `snapshot.${field}` });
    if (!requestComplete) incomplete.push({ pollId: poll?.pollId, field: 'rateCalls.requestedRate' });
    rows.push({
      polls: poll?.pollId,
      atMs: poll?.atMs,
      controllerNowMs: poll?.controllerNowMs,
      mode: snapshot?.mode,
      reason: snapshot?.reason,
      estimateMs: snapshot?.estimateMs,
      bandMs: snapshot?.bandMs,
      stoppingThresholdMs: snapshot?.stoppingThresholdMs,
      acceptedStoppingThresholdMs: acceptedStoppingThresholdMs(snapshot),
      requiredStoppingThresholdMs: snapshot?.requiredStoppingThresholdMs,
      thresholdUsable: snapshot?.thresholdUsable,
      fastestCloseMs: snapshot?.fastestCloseMs,
      actuatorAllowanceMs: snapshot?.actuatorAllowanceMs,
      rate: snapshot?.rate,
      // Read only by the refusal split's clause, which refuses a row without
      // them rather than assume the product's numbers.
      settings: snapshot?.settings ?? null,
      requestedRate,
      incomplete: !requestComplete || snapshot === null || snapshotFields.some((field) => !has(snapshot, field)),
      incompleteFields: [],
      pollId: poll?.pollId,
      file: poll?.file ?? 'poll-events.ndjson',
    });
  }
  for (const item of incomplete) {
    const row = rows.find((candidate) => candidate.pollId === item.pollId);
    if (row && !row.incompleteFields.includes(item.field)) row.incompleteFields.push(item.field);
  }
  return rows;
}

const rollUpHoldClauses = (clauses) => (clauses.some((item) => item.status === 'refused') ? 'refused'
  : clauses.some((item) => item.status === 'failed') ? 'failed'
    : clauses.some((item) => item.status === 'unavailable') ? 'unavailable' : 'met');

function holdClause(name, status, observed, detail = null, row = null) {
  return clause(name, status, observed, detail, row === null ? null : { ...row, pollId: row.polls, file: row.file });
}

export function holdPolicyAudit({ rows, arm = null, horizonMs, evidenceComplete = true } = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const isBaseline = arm === 'B';
  if (isBaseline) {
    const clauses = HOLD_CLAUSE_NAMES
      .map((name) => ({ name, status: 'not-applicable', observed: null }));
    return { status: 'not-applicable', criteria: 'not-applicable', arm, clauses, episodes: [], summary: summariseHolds([]), postFirstSettleHold: false, dutyNumerator: null, dutyDenominator: null, dutyCycle: null, followUpMs: null };
  }
  const incomplete = inputRows.flatMap((row) => row.incompleteFields ?? []);
  if (!evidenceComplete || incomplete.length > 0) {
    const reason = !evidenceComplete ? 'hold-poll-evidence-incomplete' : `missing-required-field:${unique(incomplete).join(',')}`;
    const clauses = HOLD_CLAUSE_NAMES
      .map((name) => ({ name, status: 'refused', observed: null, detail: reason }));
    return { status: 'refused', criteria: 'refused', arm, clauses, refusal: reason, incompleteFields: unique(incomplete), episodes: [], summary: summariseHolds([]), postFirstSettleHold: null, dutyNumerator: null, dutyDenominator: null, dutyCycle: null, followUpMs: null };
  }
  const last = inputRows.at(-1);
  const inferredHorizon = finite(horizonMs) ? horizonMs : (finite(last?.atMs) ? last.atMs : null);
  if (!finite(inferredHorizon)) return holdPolicyAudit({ rows: inputRows.map((row) => ({ ...row, incompleteFields: ['horizonMs'] })), arm, evidenceComplete: false });
  const episodes = holdEpisodes(inputRows, { horizonMs: inferredHorizon, maxStoppingThresholdMs: MAX_STOPPING_THRESHOLD_MS });
  const safetyFailures = inputRows.filter((row) => row.mode === HOLD_MODE)
    .map((row) => ({ polls: row.polls, atMs: row.atMs, violations: holdSafetyViolations(row, { maxStoppingThresholdMs: MAX_STOPPING_THRESHOLD_MS }), file: row.file }));
  const ceilingFailures = thresholdCeilingViolations(inputRows, { maxStoppingThresholdMs: MAX_STOPPING_THRESHOLD_MS });
  // EXACT UNITY IS THE HOLD'S RULE ALONE; EVERY OTHER REFUSAL RULE IS BOTH
  // MODES'. The split's poll is a refused threshold that keeps correcting, so
  // it is judged by its own clause for what the rate does, and counted with
  // the hold for what a refusal forbids: it interrupts a fresh dwell, and one
  // at or after first settling is a failure exactly as a hold there is.
  const uncertifiedFailures = inputRows.filter((row) => row.mode === D8_UNCERTIFIED_MODE)
    .map((row) => ({ polls: row.polls, atMs: row.atMs, violations: uncertifiedCorrectionViolations(row, { maxStoppingThresholdMs: MAX_STOPPING_THRESHOLD_MS }), file: row.file }));
  const isRefusal = (row) => D8_REFUSAL_MODES.includes(row.mode);
  const firstSettledIndex = inputRows.findIndex((row) => row.mode === 'settled');
  const firstSettledAtMs = firstSettledIndex < 0 ? null : inputRows[firstSettledIndex].atMs;
  const preRefusals = inputRows.filter((row) => isRefusal(row) && (firstSettledAtMs === null || row.atMs < firstSettledAtMs));
  const lastPreSettleHoldAtMs = preRefusals.length > 0 ? preRefusals.at(-1).atMs : null;
  const dwell = freshDwellAudit(inputRows, {
    firstSettledIndex,
    lastPreSettleHoldAtMs,
    settledForMs: SETTLED_FOR_MS,
    maxStoppingThresholdMs: MAX_STOPPING_THRESHOLD_MS,
    evidenceComplete: true,
  });
  const postFirstSettleHold = firstSettledAtMs !== null && inputRows.some((row) => isRefusal(row) && row.atMs >= firstSettledAtMs);
  const followUpMs = firstSettledAtMs === null ? null : inferredHorizon - firstSettledAtMs;
  const dutyRows = firstSettledIndex < 0 ? [] : inputRows.slice(firstSettledIndex);
  const dutyNumerator = dutyRows.length > 0 ? dutyRows.filter((row) => row.mode === 'settled').length : null;
  const dutyDenominator = dutyRows.length > 0 ? dutyRows.length : null;
  const dutyCycle = dutyNumerator === null ? null : dutyNumerator / dutyDenominator;
  const observation = {
    holdPollCount: inputRows.filter((row) => row.mode === HOLD_MODE).length,
    uncertifiedPollCount: uncertifiedFailures.length,
    episodes,
    episodeCount: episodes.length,
    neverSettledInHorizon: firstSettledIndex < 0,
    postSettleRecurrence: postFirstSettleHold,
    postSettleObservedMs: followUpMs,
    postSettlePolls: dutyRows.length,
    preSettleBudgetHoldFraction: null,
    freshDwellAudit: dwell,
    holdSafetyFailures: safetyFailures.flatMap((item) => item.violations),
    thresholdCeilingFailures: ceilingFailures,
    evidence: { complete: true },
  };
  const summary = summariseHolds([observation]);
  summary.dutyNumerator = dutyNumerator;
  summary.dutyDenominator = dutyDenominator;
  summary.dutyCycle = dutyCycle;
  summary.followUpMs = followUpMs;
  const clauses = [
    holdClause(
      'hold-safety-unity-and-no-accepted-threshold',
      safetyFailures.some((item) => item.violations.length > 0) || ceilingFailures.length > 0 ? 'failed' : 'met',
      { safetyFailures, thresholdCeilingFailures: ceilingFailures },
      null,
      safetyFailures.length > 0 ? safetyFailures[0] : null,
    ),
    // THE OFFLINE AUDIT REPORTS ONE `unavailable` FOR TWO DIFFERENT THINGS: a
    // run that never settled, and evidence too incomplete to say. The D8 study
    // never exercised the first, because its candidate always settled. Both
    // facts are known separately here -- incomplete evidence returned above, and
    // `firstSettledIndex` is computed from the same rows -- so the never-settled
    // case is named for what it is. It is an observation, not an absence: there
    // is no settling claim for a fresh dwell to back, and T5 already fails the
    // run for not settling. Its own clause must not also call that a refusal.
    holdClause(
      'hold-fresh-dwell-5000ms',
      preRefusals.length === 0 ? 'not-applicable'
        : firstSettledIndex < 0 ? 'unavailable'
          : dwell.status === 'passed' ? 'met' : dwell.status === 'failed' ? 'failed' : 'refused',
      dwell,
      null,
      firstSettledIndex >= 0 ? inputRows[firstSettledIndex] : null,
    ),
    holdClause(
      'hold-after-first-settling',
      postFirstSettleHold ? 'failed' : 'met',
      { postFirstSettleHold, firstSettledAtMs },
      null,
      postFirstSettleHold ? inputRows.find((row) => isRefusal(row) && row.atMs >= firstSettledAtMs) : null,
    ),
    // A row the clause cannot judge refuses; one it judges wrong fails.
    holdClause(
      'uncertified-correction-follows-the-law-and-certifies-nothing',
      uncertifiedFailures.some((item) => item.violations.some((violation) => UNCERTIFIED_EVIDENCE_GAPS.includes(violation))) ? 'refused'
        : uncertifiedFailures.some((item) => item.violations.length > 0) ? 'failed' : 'met',
      { uncertifiedPolls: uncertifiedFailures.length, uncertifiedFailures: uncertifiedFailures.filter((item) => item.violations.length > 0) },
      null,
      uncertifiedFailures.find((item) => item.violations.length > 0) ?? null,
    ),
  ];
  return {
    // A summary that reported `met` while one clause was unavailable would be
    // claiming the clause ran. Only the clause statuses decide the client
    // (`classifyClient`); this is the line a reader sees, so it says so too.
    status: rollUpHoldClauses(clauses),
    criteria: rollUpHoldClauses(clauses),
    arm,
    firstSettledAtMs,
    lastPreSettleHoldAtMs,
    postFirstSettleHold,
    episodes,
    safetyFailures,
    uncertifiedFailures,
    thresholdCeilingFailures: ceilingFailures,
    freshDwellAudit: dwell,
    dutyNumerator,
    dutyDenominator,
    dutyCycle,
    followUpMs,
    summary,
    clauses,
  };
}
