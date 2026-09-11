// Pure comparison measurements and classifications.
// CONSTRAINTS.md -> Verification: absent observations refuse; they never pass.

import {
  MAX_STOPPING_THRESHOLD_MS,
  RATE_EPSILON,
  SETTLED_FOR_MS,
} from '../../public/lib/drift-controller.mjs';
import { DEFAULT_CAPACITY } from '../../public/lib/frame-drift.mjs';
import {
  MIN_CONVERGED_RECORDS,
  acceptedStoppingThresholdMs,
  convergedStats,
  observationStats,
} from '../drift-figures.mjs';
import {
  DRAIN_INTERVAL_MS,
  PROPOSED_COVERAGE_RATIO,
  observedPlaybackStart,
  joinPolls,
} from './remedy-browser-metrics.mjs';
import {
  BUDGET_HOLD_MODE,
  freshDwellAudit,
  holdEpisodes,
  holdSafetyViolations,
  summariseHolds,
  thresholdCeilingViolations,
} from './d8-recoverable-holds.mjs';

const LEGACY_T5_DEADLINE_MS = 120000;
const LEGACY_T5_SETTLING_BUDGET_MS = 75000;
const LEGACY_T5_SEAM_POLL_MS = 250;
const LEGACY_T6_SPAN_MS = 10000;
const LEGACY_T6_CLIENT_ROOM_MS = 40;
const LEGACY_T6_PAIR_MS = 50;
const LEGACY_T7_OBSERVATION_MS = 60000;
const LEGACY_T7_POLL_MS = 125;

export const COMPARISON_CRITERIA = Object.freeze({
  captureMs: 240000,
  startupMs: 45000,
  viewerGapMs: 10000,
  t5DeadlineMs: LEGACY_T5_DEADLINE_MS,
  t5SettlingBudgetMs: LEGACY_T5_SETTLING_BUDGET_MS,
  t5SeamPollMs: LEGACY_T5_SEAM_POLL_MS,
  rateEpsilon: RATE_EPSILON,
  t6SpanMs: LEGACY_T6_SPAN_MS,
  t6MinRecords: MIN_CONVERGED_RECORDS,
  t6ClientRoomMs: LEGACY_T6_CLIENT_ROOM_MS,
  t6PairMs: LEGACY_T6_PAIR_MS,
  t7ObservationMs: LEGACY_T7_OBSERVATION_MS,
  t7PollMs: LEGACY_T7_POLL_MS,
  coverageRatio: PROPOSED_COVERAGE_RATIO,
  freshDwellMs: SETTLED_FOR_MS,
  ceilingMs: MAX_STOPPING_THRESHOLD_MS,
});

export const COMPARISON_ORDER = Object.freeze(['B', 'C', 'C', 'B']);
const LEGACY_SEAM_LABEL = 'derived-250ms-sub-grid-of-the-125ms-drain-seam-stream';
const T5_WARNING = 'mode and rate can drop on a believed excursion while settlingMs and correctionsApplied latch; read all five T5 clauses together';
const T6_NOTE = 'comparison of two medians, not instantaneous pairwise error, and not change 6\'s group bar';
const T7_NOTE = 'no approved error budget exists; model agreement is inconclusive';
const HOLD_MODE = BUDGET_HOLD_MODE;

const has = (object, field) => object !== null && typeof object === 'object' && Object.hasOwn(object, field);
const finite = (value) => Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Set(values)];

function medianGap(times) {
  const sorted = times.filter(finite).sort((left, right) => left - right);
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  if (gaps.length === 0) return null;
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

function slotFor(atMs, originMs) {
  if (!finite(atMs) || !finite(originMs)) return null;
  return Math.round((atMs - originMs) / DRAIN_INTERVAL_MS);
}

function expectedEvenSlots(originMs, startMs, endMs) {
  if (!finite(originMs) || !finite(startMs) || !finite(endMs) || endMs < startMs) return [];
  const first = Math.ceil((startMs - originMs) / DRAIN_INTERVAL_MS);
  const last = Math.floor((endMs - originMs) / DRAIN_INTERVAL_MS);
  const slots = [];
  for (let slot = first; slot <= last; slot += 1) {
    if (slot % 2 === 0) slots.push(slot);
  }
  return slots;
}

export function legacySeamStream(events, { originMs } = {}) {
  const rows = [];
  const slots = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind !== 'seam-sample') continue;
    const slotIndex = slotFor(event.atMs, originMs);
    if (slotIndex === null || slotIndex % 2 !== 0 || slots.has(slotIndex)) continue;
    slots.set(slotIndex, event);
  }
  for (const [slotIndex, event] of [...slots.entries()].sort((left, right) => left[1].atMs - right[1].atMs)) {
    rows.push({ ...event, slotIndex, source: LEGACY_SEAM_LABEL });
  }
  const expected = rows.length > 0
    ? expectedEvenSlots(originMs, originMs, originMs + rows.at(-1).slotIndex * DRAIN_INTERVAL_MS)
    : [];
  const present = new Set(rows.map((row) => row.slotIndex));
  const missingSlots = expected.filter((slot) => !present.has(slot));
  return {
    rows,
    stream: rows,
    label: LEGACY_SEAM_LABEL,
    originMs: finite(originMs) ? originMs : null,
    sampledEveryMs: medianGap(rows.map((row) => row.atMs)),
    expectedSlots: expected.length,
    missingSlots,
    missingSlotCount: missingSlots.length,
  };
}

function rowSnapshot(row) {
  return object(row?.controller) ? row.controller : (object(row?.snapshot) ? row.snapshot : null);
}

function seamRowsOf(seamRows) {
  if (Array.isArray(seamRows)) return seamRows;
  if (Array.isArray(seamRows?.rows)) return seamRows.rows;
  if (Array.isArray(seamRows?.stream)) return seamRows.stream;
  return [];
}

function legacyPlayback(row) {
  return row?.playback?.playing === true;
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

function refusedT5(reason, seam, extra = {}) {
  const names = [
    't5-settled-at-end-of-wait',
    't5-recorded-a-correction',
    't5-applied-a-rate-write',
    't5-settled-within-budget',
    't5-holds-the-base-rate',
  ];
  return {
    status: 'refused',
    criteria: 'refused',
    refusal: reason,
    clauses: names.map((name) => clause(name, 'refused', null, reason)),
    warning: T5_WARNING,
    seamCoverage: seam,
    ...extra,
  };
}

function missingInsideWait(seam, startMs, endMs) {
  const originMs = seam?.originMs;
  const expected = expectedEvenSlots(originMs, startMs, endMs);
  const present = new Set(seamRowsOf(seam).map((row) => row.slotIndex));
  const missing = expected.filter((slot) => !present.has(slot));
  return {
    expectedSlots: expected.length,
    observedSlots: expected.filter((slot) => present.has(slot)).length,
    missingSlots: missing,
    missingSlotCount: missing.length,
    missingRatio: expected.length > 0 ? missing.length / expected.length : null,
  };
}

export function t5Observations({ seamRows, legacyPlaybackStartMs, observedStartMs } = {}) {
  const seam = Array.isArray(seamRows) ? { rows: seamRows, stream: seamRows, originMs: null } : seamRows;
  const rows = seamRowsOf(seam).slice().sort((left, right) => left.atMs - right.atMs);
  const firstPlayback = rows.find(legacyPlayback);
  const firstPlaybackAtMs = firstPlayback === undefined ? null : firstPlayback.atMs;
  const start = finite(legacyPlaybackStartMs) ? legacyPlaybackStartMs : null;
  if (!finite(start)) return refusedT5('legacy-playback-start-missing', seam, { firstPlaybackAtMs, legacyPlaybackStartMs: null, t5WaitEndMs: null });

  const settled = rows.find((row) => {
    const snapshot = rowSnapshot(row);
    return snapshot?.mode === 'settled' && snapshot?.settlingMs !== null;
  });
  const firstSettledAtMs = settled === undefined ? null : settled.atMs;
  const firstSettlingMs = settled ? rowSnapshot(settled).settlingMs : null;
  let lastNoCorrectionAtMs = null;
  let lastNoSettlingAtMs = null;
  for (const row of rows) {
    const snapshot = rowSnapshot(row);
    if (snapshot?.correctionsApplied === 0) lastNoCorrectionAtMs = row.atMs;
    if (has(snapshot, 'settlingMs') && snapshot.settlingMs === null) lastNoSettlingAtMs = row.atMs;
  }
  const deadlineMs = start + COMPARISON_CRITERIA.t5DeadlineMs;
  const t5WaitEndMs = Math.min(firstSettledAtMs === null ? deadlineMs : firstSettledAtMs, deadlineMs);
  const finalRow = rows.filter((row) => finite(row.atMs) && row.atMs <= t5WaitEndMs).at(-1);
  const endOfWait = finalRow === undefined ? null : finalRow;
  const coverage = missingInsideWait(seam, start, t5WaitEndMs);
  // THE DEADLINE MUST NOT START LATE. The two origins are retained separately
  // and disagree by construction: the legacy seam observation is taken on the
  // 250 ms seam and the recorder's observed start is bracketed to 125 ms, so
  // the recorder's is at or after the seam's whenever capture begins before
  // playback does. Running the deadline from the legacy origin is what the
  // brief requires, and it is the earlier of the two -- so what has to be
  // refused is an origin EARLIER than the one the deadline used, which would
  // mean the wait had been started at a later observation. A later origin is
  // the ordinary case and is reported, not refused.
  const origins = [observedStartMs].filter(finite);
  const earliestOriginMs = Math.min(start, ...origins);
  const deadlineStartedLate = earliestOriginMs < start;
  const common = {
    firstPlaybackAtMs,
    legacyPlaybackStartMs: start,
    observedStartMs: finite(observedStartMs) ? observedStartMs : null,
    earliestOriginMs,
    originSpreadMs: earliestOriginMs === null ? null : Math.max(start, ...origins) - earliestOriginMs,
    firstSettledAtMs,
    firstSettlingMs,
    lastNoCorrectionAtMs,
    lastNoSettlingAtMs,
    t5WaitEndMs,
    endOfWait,
    seamCoverage: coverage,
    warning: T5_WARNING,
  };
  if (deadlineStartedLate) return refusedT5('t5-deadline-origin-would-move-end', seam, common);
  if (coverage.expectedSlots > 0 && coverage.missingRatio > (1 - COMPARISON_CRITERIA.coverageRatio)) {
    return refusedT5('legacy-seam-gap-over-5-percent', seam, common);
  }
  if (endOfWait === null) return refusedT5('t5-end-of-wait-row-missing', seam, common);
  const snapshot = rowSnapshot(endOfWait);
  const absent = (field) => !has(snapshot, field);
  const nonFinite = (field) => !finite(snapshot?.[field]);
  const clauses = [
    absent('mode') ? clause('t5-settled-at-end-of-wait', 'refused', null, 'mode is absent', endOfWait)
      : clause('t5-settled-at-end-of-wait', snapshot.mode === 'settled' ? 'met' : 'failed', snapshot.mode, null, endOfWait),
    absent('settlingMs') || nonFinite('settlingMs') && snapshot.settlingMs !== null
      ? clause('t5-recorded-a-correction', 'refused', null, 'settlingMs is absent or non-finite', endOfWait)
      : clause('t5-recorded-a-correction', snapshot.settlingMs !== null ? 'met' : 'failed', snapshot.settlingMs, null, endOfWait),
    absent('correctionsApplied') || nonFinite('correctionsApplied')
      ? clause('t5-applied-a-rate-write', 'refused', null, 'correctionsApplied is absent or non-finite', endOfWait)
      : clause('t5-applied-a-rate-write', snapshot.correctionsApplied > 0 ? 'met' : 'failed', snapshot.correctionsApplied, null, endOfWait),
    absent('settlingMs') || (nonFinite('settlingMs') && snapshot.settlingMs !== null)
      ? clause('t5-settled-within-budget', 'refused', null, 'settlingMs is absent or non-finite', endOfWait)
      : clause('t5-settled-within-budget', finite(snapshot.settlingMs) && snapshot.settlingMs <= COMPARISON_CRITERIA.t5SettlingBudgetMs ? 'met' : 'failed', snapshot.settlingMs, null, endOfWait),
    absent('rate') || nonFinite('rate')
      ? clause('t5-holds-the-base-rate', 'refused', null, 'rate is absent or non-finite', endOfWait)
      : clause('t5-holds-the-base-rate', Math.abs(snapshot.rate - 1) <= COMPARISON_CRITERIA.rateEpsilon ? 'met' : 'failed', snapshot.rate, null, endOfWait),
  ];
  const overallStatus = clauses.some((item) => item.status === 'refused') ? 'refused' : clauses.some((item) => item.status === 'failed') ? 'failed' : 'met';
  return {
    ...common,
    status: overallStatus,
    criteria: overallStatus,
    refusal: null,
    clauses,
    legacySeamPollMs: COMPARISON_CRITERIA.t5SeamPollMs,
  };
}

function recordEntries(records) {
  const entries = [];
  for (const item of Array.isArray(records) ? records : []) {
    if (object(item) && Array.isArray(item.records)) {
      for (const record of item.records) entries.push({ record, parent: item });
    } else entries.push({ record: item, parent: null });
  }
  return entries;
}

function recordAt(entry) {
  const record = entry.record;
  const parent = entry.parent;
  const keys = ['arrivalAtMs', 'retainedArrivalMs', 'retainedAtMs', 'atMs', 'readAtMs', 'nodeReceivedAtMs', 'nodeReceivedAt', 'nodeWrittenAtMs'];
  for (const key of keys) if (finite(record?.[key])) return record[key];
  for (const key of keys) if (finite(parent?.[key])) return parent[key];
  return null;
}

function recordsWithArrival(records) {
  return recordEntries(records).map((entry) => ({ ...entry, atMs: recordAt(entry) }));
}

export function anchorSeqAt(records, t5WaitEndMs) {
  if (!finite(t5WaitEndMs)) return null;
  const candidates = recordsWithArrival(records)
    .filter((entry) => finite(entry.atMs) && entry.atMs <= t5WaitEndMs && integer(entry.record?.seq) && entry.record.seq > 0)
    .map((entry) => entry.record.seq);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

export function endSeqAt(records, endMs) {
  if (!finite(endMs)) return null;
  const candidates = recordsWithArrival(records)
    .filter((entry) => finite(entry.atMs) && entry.atMs <= endMs && integer(entry.record?.seq) && entry.record.seq > 0)
    .map((entry) => entry.record.seq);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function timeBounds(selected) {
  const times = selected.map((entry) => entry.atMs).filter(finite);
  return { firstRecordAtMs: times.length > 0 ? Math.min(...times) : null, lastRecordAtMs: times.length > 0 ? Math.max(...times) : null };
}

export function t6Span({ records, anchorSeq, endSeq, t5WaitEndMs } = {}) {
  const entries = recordsWithArrival(records);
  const computedAnchor = anchorSeqAt(records, t5WaitEndMs);
  const suppliedAnchor = anchorSeq !== undefined;
  const suppliedEnd = endSeq !== undefined;
  const actualAnchor = suppliedAnchor ? anchorSeq : computedAnchor;
  const computedEnd = endSeqAt(records, finite(t5WaitEndMs) ? t5WaitEndMs + COMPARISON_CRITERIA.t6SpanMs : NaN);
  const actualEnd = suppliedEnd ? endSeq : computedEnd;
  const anchorMatchesWait = !finite(t5WaitEndMs) || !suppliedAnchor || actualAnchor === computedAnchor;
  const endMatchesWait = !finite(t5WaitEndMs) || !suppliedEnd || actualEnd === computedEnd;
  const anchorValid = anchorMatchesWait && integer(actualAnchor) && actualAnchor > 0;
  const endValid = endMatchesWait && integer(actualEnd) && actualEnd >= actualAnchor;
  const selected = anchorValid && endValid
    ? entries.filter((entry) => integer(entry.record?.seq) && entry.record.seq > actualAnchor && entry.record.seq <= actualEnd)
    : [];
  const stats = convergedStats({ records: selected.map((entry) => entry.record) }, anchorValid ? actualAnchor : 0);
  const bounds = timeBounds(selected);
  const countClause = !anchorValid || !endValid
    ? clause('t6-at-least-120-finite-records', 'refused', null, !anchorValid ? 't6-anchor-not-a-real-record' : 't6-end-not-a-real-record')
    : stats.convergedCount < COMPARISON_CRITERIA.t6MinRecords
      ? clause('t6-at-least-120-finite-records', 'refused', { convergedCount: stats.convergedCount, required: COMPARISON_CRITERIA.t6MinRecords }, 'the anchored span has fewer than 120 records')
      : !stats.records.every((record) => finite(record.driftMs))
        ? clause('t6-at-least-120-finite-records', 'refused', { convergedCount: stats.convergedCount }, 'the anchored span contains a non-finite drift')
        : clause('t6-at-least-120-finite-records', 'met', { convergedCount: stats.convergedCount, required: COMPARISON_CRITERIA.t6MinRecords });
  const medianClause = !anchorValid || !endValid || stats.convergedMedianMs === null
    ? clause('t6-client-within-40ms-of-the-room', 'refused', stats.convergedMedianMs, 'converged median is unavailable')
    : clause('t6-client-within-40ms-of-the-room', Math.abs(stats.convergedMedianMs) <= COMPARISON_CRITERIA.t6ClientRoomMs ? 'met' : 'failed', stats.convergedMedianMs);
  const overallStatus = [countClause, medianClause].some((item) => item.status === 'refused') ? 'refused'
      : [countClause, medianClause].some((item) => item.status === 'failed') ? 'failed' : 'met';
  return {
    status: overallStatus,
    criteria: overallStatus,
    refusal: !anchorValid ? 't6-anchor-not-a-real-record' : !endValid ? 't6-end-not-a-real-record' : null,
    clauses: [countClause, medianClause],
    convergedMedianMs: stats.convergedMedianMs,
    convergedSpreadMs: stats.convergedSpreadMs,
    convergedCount: stats.convergedCount,
    anchorSeq: actualAnchor,
    endSeq: actualEnd,
    ...bounds,
    t6EndMs: finite(t5WaitEndMs) ? t5WaitEndMs + COMPARISON_CRITERIA.t6SpanMs : null,
  };
}

export function t6Pair({ left, right } = {}) {
  const leftMedian = left?.convergedMedianMs;
  const rightMedian = right?.convergedMedianMs;
  const observed = { leftMedianMs: leftMedian, rightMedianMs: rightMedian };
  if (!finite(leftMedian) || !finite(rightMedian)) {
    return { status: 'refused', clauses: [clause('t6-pair-medians-within-50ms', 'refused', observed, 'one or both medians are unavailable')], ...observed, note: T6_NOTE };
  }
  const differenceMs = Math.abs(leftMedian - rightMedian);
  return {
    status: differenceMs <= COMPARISON_CRITERIA.t6PairMs ? 'met' : 'failed',
    clauses: [clause('t6-pair-medians-within-50ms', differenceMs <= COMPARISON_CRITERIA.t6PairMs ? 'met' : 'failed', { ...observed, differenceMs })],
    ...observed,
    differenceMs,
    note: T6_NOTE,
  };
}

function captureBoundsOf(input) {
  const capture = input?.captureWindow;
  return { startMs: capture?.startMs, endMs: capture?.endMs };
}

export function t7Observation({ samples, convergedRecords, t6, t6EndMs, captureWindow } = {}) {
  const endInput = t6EndMs;
  const end = finite(endInput) ? endInput : null;
  const observationEndMs = end === null ? null : end + COMPARISON_CRITERIA.t7ObservationMs;
  const rows = Array.isArray(samples) ? samples : [];
  const inWindow = end === null ? [] : rows.filter((sample) => finite(sample?.atMs) && sample.atMs >= end && sample.atMs < observationEndMs);
  const stats = observationStats(inWindow, Array.isArray(convergedRecords) ? convergedRecords : [], COMPARISON_CRITERIA.t7PollMs);
  const expectedSamples = Math.ceil(COMPARISON_CRITERIA.t7ObservationMs / COMPARISON_CRITERIA.t7PollMs);
  const observedSamples = inWindow.length;
  const bounds = captureBoundsOf({ captureWindow });
  const whollyInside = finite(end) && finite(observationEndMs) && finite(bounds.startMs) && finite(bounds.endMs)
    && end >= bounds.startMs && observationEndMs <= bounds.endMs;
  const shortfall = expectedSamples > 0 ? (expectedSamples - observedSamples) / expectedSamples : null;
  const qualifiedT6 = (t6 === undefined || t6?.status === 'met') && Array.isArray(convergedRecords)
    && convergedRecords.length >= COMPARISON_CRITERIA.t6MinRecords
    && convergedRecords.every((record) => finite(record?.driftMs));
  const reasons = [];
  if (end === null) reasons.push('t6-end-not-supplied');
  if (!whollyInside) reasons.push('observation-window-outside-capture');
  if (!(shortfall !== null && shortfall < (1 - COMPARISON_CRITERIA.coverageRatio))) reasons.push('observation-sample-shortfall-over-5-percent');
  if (!qualifiedT6) reasons.push('converged-records-are-not-qualified-t6-population');
  return {
    stats,
    samples: inWindow,
    t6EndMs: end,
    endMs: observationEndMs,
    expectedSamples,
    observedSamples,
    sampleShortfall: shortfall,
    eligibility: reasons.length === 0 ? 'eligible' : 'not-eligible',
    eligibilityReason: reasons.length === 0 ? null : reasons,
    modelAgreement: 'inconclusive',
    note: T7_NOTE,
  };
}

function requestedRateFor(row) {
  if (!Array.isArray(row?.rateCalls) || row.rateCalls.length === 0) return { value: undefined, complete: false };
  const calls = row.rateCalls;
  const call = calls.at(-1);
  return { value: has(call, 'requestedRate') ? call.requestedRate : undefined, complete: has(call, 'requestedRate') && finite(call.requestedRate) };
}

export function browserHoldRows(capturePolls) {
  const incomplete = [];
  const rows = [];
  for (const poll of Array.isArray(capturePolls) ? capturePolls : []) {
    const snapshot = rowSnapshot(poll);
    const requested = requestedRateFor(poll);
    const required = ['pollId', 'atMs'];
    for (const field of required) if (!has(poll, field)) incomplete.push({ pollId: poll?.pollId, field });
    const snapshotFields = ['mode', 'reason', 'estimateMs', 'bandMs', 'stoppingThresholdMs', 'requiredStoppingThresholdMs', 'thresholdUsable', 'fastestCloseMs', 'actuatorAllowanceMs', 'rate'];
    for (const field of snapshotFields) if (!has(snapshot, field)) incomplete.push({ pollId: poll?.pollId, field: `snapshot.${field}` });
    if (!requested.complete) incomplete.push({ pollId: poll?.pollId, field: 'rateCalls.requestedRate' });
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
      requestedRate: requested.value,
      incomplete: !requested.complete || snapshot === null || snapshotFields.some((field) => !has(snapshot, field)),
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

function holdClause(name, status, observed, detail = null, row = null) {
  return clause(name, status, observed, detail, row === null ? null : { ...row, pollId: row.polls, file: row.file });
}

export function holdPolicyAudit({ rows, arm = null, horizonMs, evidenceComplete = true } = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const isBaseline = arm === 'B';
  if (isBaseline) {
    const clauses = ['hold-safety-unity-and-no-accepted-threshold', 'hold-fresh-dwell-5000ms', 'hold-after-first-settling']
      .map((name) => ({ name, status: 'not-applicable', observed: null }));
    return { status: 'not-applicable', criteria: 'not-applicable', arm, clauses, episodes: [], summary: summariseHolds([]), postFirstSettleHold: false, dutyNumerator: null, dutyDenominator: null, dutyCycle: null, followUpMs: null };
  }
  const incomplete = inputRows.flatMap((row) => row.incompleteFields ?? []);
  if (!evidenceComplete || incomplete.length > 0) {
    const reason = !evidenceComplete ? 'hold-poll-evidence-incomplete' : `missing-required-field:${unique(incomplete).join(',')}`;
    const clauses = ['hold-safety-unity-and-no-accepted-threshold', 'hold-fresh-dwell-5000ms', 'hold-after-first-settling']
      .map((name) => ({ name, status: 'refused', observed: null, detail: reason }));
    return { status: 'refused', criteria: 'refused', arm, clauses, refusal: reason, incompleteFields: unique(incomplete), episodes: [], summary: summariseHolds([]), postFirstSettleHold: null, dutyNumerator: null, dutyDenominator: null, dutyCycle: null, followUpMs: null };
  }
  const last = inputRows.at(-1);
  const inferredHorizon = finite(horizonMs) ? horizonMs : (finite(last?.atMs) ? last.atMs : null);
  if (!finite(inferredHorizon)) return holdPolicyAudit({ rows: inputRows.map((row) => ({ ...row, incompleteFields: ['horizonMs'] })), arm, evidenceComplete: false });
  const episodes = holdEpisodes(inputRows, { horizonMs: inferredHorizon, maxStoppingThresholdMs: COMPARISON_CRITERIA.ceilingMs });
  const safetyFailures = inputRows.filter((row) => row.mode === HOLD_MODE)
    .map((row) => ({ polls: row.polls, atMs: row.atMs, violations: holdSafetyViolations(row, { maxStoppingThresholdMs: COMPARISON_CRITERIA.ceilingMs }), file: row.file }));
  const ceilingFailures = thresholdCeilingViolations(inputRows, { maxStoppingThresholdMs: COMPARISON_CRITERIA.ceilingMs });
  const firstSettledIndex = inputRows.findIndex((row) => row.mode === 'settled');
  const firstSettledAtMs = firstSettledIndex < 0 ? null : inputRows[firstSettledIndex].atMs;
  const preHolds = firstSettledAtMs === null ? inputRows.filter((row) => row.mode === HOLD_MODE) : inputRows.filter((row) => row.mode === HOLD_MODE && row.atMs < firstSettledAtMs);
  const lastPreSettleHoldAtMs = preHolds.length > 0 ? preHolds.at(-1).atMs : null;
  const dwell = freshDwellAudit(inputRows, {
    firstSettledIndex,
    lastPreSettleHoldAtMs,
    settledForMs: COMPARISON_CRITERIA.freshDwellMs,
    maxStoppingThresholdMs: COMPARISON_CRITERIA.ceilingMs,
    evidenceComplete: true,
  });
  const postFirstSettleHold = firstSettledAtMs !== null && inputRows.some((row) => row.mode === HOLD_MODE && row.atMs >= firstSettledAtMs);
  const followUpMs = firstSettledAtMs === null ? null : inferredHorizon - firstSettledAtMs;
  const dutyRows = firstSettledIndex < 0 ? [] : inputRows.slice(firstSettledIndex);
  const dutyNumerator = dutyRows.length > 0 ? dutyRows.filter((row) => row.mode === 'settled').length : null;
  const dutyDenominator = dutyRows.length > 0 ? dutyRows.length : null;
  const dutyCycle = dutyNumerator === null ? null : dutyNumerator / dutyDenominator;
  const observation = {
    holdPollCount: inputRows.filter((row) => row.mode === HOLD_MODE).length,
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
    holdClause(
      'hold-fresh-dwell-5000ms',
      preHolds.length === 0 ? 'not-applicable' : dwell.status === 'passed' ? 'met' : dwell.status === 'failed' ? 'failed' : 'refused',
      dwell,
      null,
      firstSettledIndex >= 0 ? inputRows[firstSettledIndex] : null,
    ),
    holdClause(
      'hold-after-first-settling',
      postFirstSettleHold ? 'failed' : 'met',
      { postFirstSettleHold, firstSettledAtMs },
      null,
      postFirstSettleHold ? inputRows.find((row) => row.mode === HOLD_MODE && row.atMs >= firstSettledAtMs) : null,
    ),
  ];
  return {
    status: clauses.some((item) => item.status === 'refused') ? 'refused' : clauses.some((item) => item.status === 'failed') ? 'failed' : 'met',
    criteria: clauses.some((item) => item.status === 'refused') ? 'refused' : clauses.some((item) => item.status === 'failed') ? 'failed' : 'met',
    arm,
    firstSettledAtMs,
    lastPreSettleHoldAtMs,
    postFirstSettleHold,
    episodes,
    safetyFailures,
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

function numericAt(value) {
  return finite(value) ? value : null;
}

/**
 * One reading out of an `analyseArm()` block, BY ITS ONE REAL NAME.
 *
 * The first version of this file searched a list of candidate names for each
 * reading and, finding none, supplied a zero where the collector looked healthy.
 * Two of those names — a research-queue overflow counter and an eviction
 * counter — do not exist anywhere in the collector, so both clauses were
 * structurally incapable of failing and the zero was the favourable missing
 * value section 3 of the comparison spec refuses. A reading is taken from the
 * exact field that produces it or it is a provenance gap.
 */
function reading(source, name) {
  return has(source, name) ? { found: true, value: source[name], name } : { found: false, value: null, name };
}

/**
 * Accepted drift sequence numbers past the product ring's retained capacity.
 *
 * DESCRIPTIVE, AND NEVER A FAILURE. The product log keeps `DEFAULT_CAPACITY`
 * records and forgets older ones; a reader that already drained them has lost
 * nothing, and the brief says so explicitly. `null` where the capture carries no
 * accepted offer to count.
 */
function acceptedSequenceGrowth(analysis) {
  const agreement = analysis?.evidence?.recordAgreement;
  const accepted = finite(agreement?.acceptedOffers) ? agreement.acceptedOffers : null;
  if (accepted === null) return null;
  return {
    acceptedOffers: accepted,
    retainedCapacity: DEFAULT_CAPACITY,
    beyondCapacity: Math.max(0, accepted - DEFAULT_CAPACITY),
    note: 'normal turnover of the product ring for a reader that already drained those records; not loss and not a refusal',
  };
}

/**
 * The evidence bar of the decision brief, over one `analyseArm()` result.
 *
 * The necessary-condition enumeration is REUSED rather than recomputed, so the
 * value that qualifies a client here is the one the published record shows. The
 * four counters below are the brief's own list, each read from the single field
 * that carries it: the collector's `lost` is the whole of the research queue's
 * loss, overflow and eviction accounting — the queue drops on capacity, counts
 * it there and latches `fatal.reason`, and there is no second counter to find.
 */
export function evidenceGate({ analysis } = {}) {
  const evidence = analysis?.evidence;
  const gaps = [];
  if (!object(evidence)) gaps.push('evidence-block-absent');
  const qualified = evidence?.qualified === true;

  const frameRatio = reading(analysis?.coverage, 'rateNormalizedCoverage');
  const unadjusted = reading(analysis?.coverage, 'unadjustedExpected');
  const drainRatio = reading(analysis?.drainCoverage, 'coverage');
  const controllerMissed = reading(evidence, 'controllerMissedRecords');
  const recorderMissed = reading(evidence, 'recorderMissedRecords');
  const frontier = reading(evidence, 'producerFrontier');
  const collector = reading(evidence, 'collector');
  const collectorLost = collector.found && object(collector.value) ? reading(collector.value, 'lost') : { found: false, value: null, name: 'collector.lost' };
  const collectorFatal = collector.found && object(collector.value) ? reading(collector.value, 'fatal') : { found: false, value: null, name: 'collector.fatal' };

  if (!frameRatio.found || !finite(frameRatio.value)) gaps.push('frame-coverage-ratio-absent');
  if (!unadjusted.found || !finite(unadjusted.value)) gaps.push('unadjusted-frame-denominator-absent');
  if (!drainRatio.found || !finite(drainRatio.value)) gaps.push('drain-coverage-ratio-absent');
  if (!controllerMissed.found || !finite(controllerMissed.value)) gaps.push('controller-log-missed-absent');
  if (!recorderMissed.found || !finite(recorderMissed.value)) gaps.push('recorder-log-missed-absent');
  if (!frontier.found || !object(frontier.value) || !finite(frontier.value.missingCount)) gaps.push('lost-event-frontier-absent');
  if (!collectorLost.found || !finite(collectorLost.value)) gaps.push('research-queue-loss-counter-absent');
  // `null` IS the healthy reading here and an absent key is not. A collector
  // that never published the field cannot say it did not latch.
  if (!collectorFatal.found) gaps.push('research-queue-fatal-latch-absent');

  const failures = [];
  if (!qualified) failures.push('necessary-conditions-not-qualified');
  if (finite(frameRatio.value) && frameRatio.value < COMPARISON_CRITERIA.coverageRatio) failures.push('frame-coverage-below-95-percent');
  if (finite(drainRatio.value) && drainRatio.value < COMPARISON_CRITERIA.coverageRatio) failures.push('drain-coverage-below-95-percent');
  if (finite(controllerMissed.value) && controllerMissed.value !== 0) failures.push('controller-log-missed-records');
  if (finite(recorderMissed.value) && recorderMissed.value !== 0) failures.push('recorder-log-missed-records');
  if (finite(frontier.value?.missingCount) && frontier.value.missingCount !== 0) failures.push('lost-event-ids');
  if (finite(collectorLost.value) && collectorLost.value !== 0) failures.push('research-queue-lost-events');
  if (collectorFatal.found && collectorFatal.value !== null) failures.push(`research-queue-${collectorFatal.value?.reason ?? 'fatal'}`);

  const allZero = failures.length === 0 && gaps.length === 0;
  return {
    status: allZero ? 'qualified' : 'refused',
    qualified: allZero,
    failures,
    provenanceGaps: unique(gaps),
    coverage: { ratio: numericAt(frameRatio.value), unadjustedDenominator: numericAt(unadjusted.value) },
    drainCoverage: { ratio: numericAt(drainRatio.value) },
    acceptedSequenceGrowthBeyondRetainedCapacity: acceptedSequenceGrowth(analysis),
    necessaryConditions: evidence?.conditions ?? [],
  };
}

function statusOf(value) {
  return value?.status ?? value?.criteria ?? 'refused';
}

function criterionClauses(value) {
  return Array.isArray(value?.clauses) ? value.clauses : [];
}

function firstFailed(value) {
  const found = criterionClauses(value).find((item) => item.status === 'failed');
  return found === undefined ? null : found;
}

function clientEvidenceResult(evidence) {
  if (evidence?.status === 'qualified' || evidence?.status === 'refused') return evidence;
  if (object(evidence?.evidence) && object(evidence?.coverage)) return evidenceGate({ analysis: evidence });
  return evidenceGate({ analysis: { evidence } });
}

function violationFrom(failing, source, fallbackFile) {
  if (failing === null) return null;
  return {
    clause: failing.name,
    status: failing.status,
    observed: failing.observed,
    atMs: numericAt(failing.atMs ?? source?.endOfWait?.atMs ?? source?.firstRecordAtMs),
    pollId: numericAt(failing.pollId ?? source?.endOfWait?.pollId),
    file: failing.file ?? fallbackFile,
    detail: failing.detail === undefined ? null : failing.detail,
  };
}

export function classifyClient({ arm, evidence, t5, t6, holds, captureComplete, captured, fullWindow, files = {}, observedStartMs = null, controllerEvents = [], events = [], timeOriginMs = 0 } = {}) {
  const gate = clientEvidenceResult(evidence);
  const qualified = gate?.status === 'qualified' || gate?.qualified === true;
  const full = captureComplete === true || captured === true || fullWindow === true;
  const values = [t5, t6, holds];
  const refusals = values.flatMap((value) => criterionClauses(value).filter((item) => item.status === 'refused').map((item) => item.name));
  const failures = values.flatMap((value) => criterionClauses(value).filter((item) => item.status === 'failed').map((item) => item.name));
  const criteria = !qualified || !full || refusals.length > 0 ? 'refused' : failures.length > 0 ? 'failed' : 'met';
  const observed = finite(observedStartMs) ? { found: true, atMs: observedStartMs } : observedPlaybackStart(events);
  const joined = Array.isArray(controllerEvents) && controllerEvents.length > 0 ? controllerEvents : joinPolls(events, { timeOriginMs }).rows;
  const sources = [
    { value: t5, file: files.t5 ?? 'seam-events.ndjson', order: 0 },
    { value: t6, file: files.t6 ?? 'records.ndjson', order: 1 },
    { value: holds, file: files.holds ?? 'poll-events.ndjson', order: 2 },
  ];
  const earliestViolation = failures.length === 0 ? null : sources
    .map((item) => ({ ...item, failure: firstFailed(item.value) }))
    .filter((item) => item.failure !== null)
    .map((item) => violationFrom(item.failure, item.value, item.file))[0] || null;
  return {
    arm,
    qualified,
    captured: full,
    criteria,
    evidence: gate,
    t5,
    t6,
    holds,
    failures,
    refusals,
    earliestViolation,
    observedStartMs: observed.found ? observed.atMs : null,
    observedStart: observed,
    legacyPlaybackStartMs: t5?.legacyPlaybackStartMs === undefined ? null : t5.legacyPlaybackStartMs,
    controllerEvents: joined,
  };
}

export function classifyPair({ left, right, pair } = {}) {
  const pairResult = pair ?? t6Pair({ left: left?.t6, right: right?.t6 });
  const qualified = left?.qualified === true && right?.qualified === true;
  const clientFailed = left?.criteria === 'failed' || right?.criteria === 'failed';
  const clientRefused = left?.criteria === 'refused' || right?.criteria === 'refused';
  const clientMet = left?.criteria === 'met' && right?.criteria === 'met';
  const pairStatus = statusOf(pairResult);
  const criteria = !qualified || pairStatus === 'refused' || clientRefused ? 'refused'
    : pairStatus === 'failed' || clientFailed ? 'failed' : clientMet && pairStatus === 'met' ? 'met' : 'refused';
  return {
    left: left?.arm === undefined ? null : left.arm,
    right: right?.arm === undefined ? null : right.arm,
    qualified,
    criteria,
    pair: pairResult,
    note: T6_NOTE,
  };
}

export function classifyTrial({ arm, clients, pair } = {}) {
  const members = Array.isArray(clients) ? clients : [];
  const pairResult = pair ?? classifyPair({ left: members[0], right: members[1] });
  const complete = members.length === 2 && members.every((client) => client?.captured === true && client?.qualified === true);
  const refusal = members.some((client) => client?.criteria === 'refused') || pairResult.criteria === 'refused';
  const failed = members.some((client) => client?.criteria === 'failed') || pairResult.criteria === 'failed';
  return {
    arm,
    status: complete ? 'complete' : 'incomplete',
    complete,
    criteria: !complete || refusal ? 'refused' : failed ? 'failed' : 'met',
    clients: members,
    pair: pairResult,
  };
}

export function classifyBatch({ trials, order = COMPARISON_ORDER } = {}) {
  const members = Array.isArray(trials) ? trials : [];
  const completedOrder = members.map((trial) => trial?.arm);
  const validOrder = members.length === COMPARISON_ORDER.length && JSON.stringify(order) === JSON.stringify(COMPARISON_ORDER) && JSON.stringify(completedOrder) === JSON.stringify(COMPARISON_ORDER);
  if (!validOrder) {
    return { label: 'batch-incomplete', status: 'refused', reason: members.length !== 4 ? 'trial-count-not-four' : 'completed-order-not-B-C-C-B', trials: members, order: completedOrder };
  }
  const complete = members.every((trial) => trial?.status === 'complete' && trial?.complete === true);
  if (!complete) return { label: 'batch-incomplete', status: 'refused', reason: 'trial-incomplete', trials: members, order: completedOrder };
  const candidate = members.filter((trial) => trial.arm === 'C');
  const candidateClients = candidate.flatMap((trial) => trial.clients ?? []);
  const candidateFailed = candidateClients.some((client) => client?.qualified === true && client.criteria === 'failed')
    || candidate.some((trial) => trial.pair?.qualified === true && trial.pair.criteria === 'failed');
  const candidateRefused = candidateClients.some((client) => client?.qualified !== true || client.criteria === 'refused')
    || candidate.some((trial) => trial.pair?.qualified !== true || trial.pair.criteria === 'refused');
  if (candidateRefused) return { label: 'batch-incomplete', status: 'refused', reason: 'candidate-evidence-refused', trials: members, order: completedOrder };
  if (candidateFailed) return { label: 'candidate-failed', status: 'failed', trials: members, order: completedOrder };
  return {
    label: 'research-criteria-met',
    status: 'met',
    trials: members,
    order: completedOrder,
    bothArmsPass: members.every((trial) => trial.clients.every((client) => client.criteria === 'met') && trial.pair.criteria === 'met'),
  };
}

export function projectRetainedBytes({ eventSizes, clients, captureSeconds, ratesPerSecond, fixedOverheadBytes, allowance } = {}) {
  const sizeMap = object(eventSizes) ? eventSizes : {};
  const rateMap = object(ratesPerSecond) ? ratesPerSecond : {};
  const clientCount = Array.isArray(clients) ? clients.length : clients;
  const invalid = [];
  if (!integer(clientCount) || clientCount < 0) invalid.push('clients');
  if (!finite(captureSeconds) || captureSeconds < 0) invalid.push('captureSeconds');
  if (!finite(fixedOverheadBytes) || fixedOverheadBytes < 0) invalid.push('fixedOverheadBytes');
  if (!finite(allowance) || allowance < 0) invalid.push('allowance');
  const eventKinds = unique([...Object.keys(sizeMap), ...Object.keys(rateMap)]);
  const byKind = {};
  let eventBytes = 0;
  for (const kind of eventKinds) {
    const size = sizeMap[kind];
    const rate = rateMap[kind];
    if (!finite(size) || size < 0) invalid.push(`eventSizes.${kind}`);
    if (!finite(rate) || rate < 0) invalid.push(`ratesPerSecond.${kind}`);
    if (finite(size) && finite(rate) && integer(clientCount) && finite(captureSeconds)) {
      const bytes = size * rate * captureSeconds * clientCount;
      byKind[kind] = { sizeBytes: size, ratePerSecond: rate, bytes };
      eventBytes += bytes;
    }
  }
  const projectedBytes = invalid.length === 0 ? fixedOverheadBytes + eventBytes : null;
  return {
    projectedBytes,
    budget: allowance,
    fits: projectedBytes !== null && projectedBytes <= allowance,
    inputs: { eventSizes: sizeMap, clients: clientCount, captureSeconds, ratesPerSecond: rateMap, fixedOverheadBytes, allowance },
    byKind,
    invalidInputs: unique(invalid),
  };
}
