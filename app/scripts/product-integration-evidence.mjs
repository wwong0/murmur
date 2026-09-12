// scripts/product-integration-evidence.mjs
//
// The product-integration audits (remedy-product-integration-spec.md 5.1-5.4),
// over one client's retained streams: whether the adopted treatment held, and
// whether the adopted refusal/dwell policy was followed. Pure over its inputs;
// `readClientEvidence` is the only disk reader, so manufactured streams and a
// real run take the same path.
//
// Rules that survive any edit:
//
//  - Missing evidence refuses. A gap in the event ids, a lost event or a poll
//    counter that skips is never filled in or read as "nothing happened".
//  - Dwell time is the kernel's own clock reading (`controllerNowMs`), compared
//    with no jitter allowance, never a 125 ms grid of repeated seam reads.
//  - The T8 allowlist and route signature below are the frozen preflight copy.
//    Editing either after a run is learning the exception from that run.

import fs from 'node:fs';
import path from 'node:path';

import { browserHoldRows, holdPolicyAudit, pitchAudit } from './check/remedy-browser-comparison-metrics.mjs';
import { dwellEligibility } from './check/remedy-browser-metrics.mjs';
import { INTEGRATION_SCHEMA } from './drift-capture.mjs';
import { D8_COMMAND_THRESHOLD, SETTLED_FOR_MS } from '../public/lib/drift-controller.mjs';
import { D8_TREATMENT, TREATMENT_FAULT_MODE } from '../public/lib/playback-treatment.mjs';

export const INTEGRATION_LABELS = Object.freeze({
  met: 'integration-met',
  metWithKnownT8: 'integration-met-with-known-T8',
  treatmentNotHeld: 'treatment-not-held',
  notMet: 'integration-not-met',
});

/** Failed in all four of `.tmp/browser-run-{1..4}.log`, each run diagnosed "V never went offline". */
export const T8_INHERITED_ALLOWLIST = Object.freeze([
  'T8 V lost exchanges advanced by at least 3 while offline',
  'T8 A3 observed V departure before the deadline',
  'T8 V freshJoins advanced by exactly 1',
  'T8 V timeline epoch moved later',
  'T8 V reopens advanced by exactly 1',
  'T8 V seams advanced by exactly 1',
  'T8 V new seam has a nonzero afterSeq',
  'T8 V new seam uses the post-event timeline epoch',
  'T8 V seam-drop counter advanced by exactly 1',
  "T8 V controller's last drop was a seam",
  'T8 V controller returned to the base rate within RATE_EPSILON',
  'T8 V newest record is after the new seam',
]);

/** Labels the evidence does not support excusing; listed so the preflight names them. */
export const T8_UNAPPROVED = Object.freeze([
  { label: 'T8 V clock half-width grew between the two readings', basis: 'failed in run 1 only of 4; intermittent, not inherited' },
  { label: 'T8 V controller did not re-settle during the 3s post-seam read', basis: 'passed in all 4 runs because V was correcting; D8 may leave V settled, so a failure here would be new' },
]);

/** The causal route signature every historical run showed. */
export const T8_ROUTE_SIGNATURE = Object.freeze({
  diagnosis: 'V never went offline',
  departureObserved: false,
  offline: Object.freeze({ probesIssued: true, lost: false, sampleCountUnchanged: true, callbacksAdvanced: true }),
  deltas: Object.freeze({ freshJoins: 0, reopens: 0, opens: 0, seams: 0, seamDrops: 0, epochRevisions: 0 }),
});

const unique = (values) => [...new Set(values)];

/** pitchAudit's own row shapes, from the product's startup record and fresh reads. */
export function pitchEvents({ startups, samples }) {
  const constructions = startups.map((startup) => ({
    kind: 'construction',
    factory: 'preservesPitch',
    requested: startup?.requested,
    readback: startup?.readback?.presence === 'value' ? startup.readback.value : null,
    propertySupported: startup?.supported,
    beforePlayback: startup?.beforePlayback,
  }));
  const reads = samples.map((sample) => {
    const current = sample?.pitch?.current;
    return { kind: 'seam-sample', atMs: sample?.atMs, media: current?.presence === 'value' ? { preservesPitch: current.value } : {} };
  });
  return [...constructions, ...reads];
}

function sampleViolations(sample, { startupId, expectedF }) {
  const reasons = [];
  if (sample?.schema !== INTEGRATION_SCHEMA) reasons.push('schema-not-integration');
  const pitch = sample?.pitch ?? null;
  if (pitch === null) return [...reasons, 'pitch-absent'];
  if (startupId !== null && pitch.startupId !== startupId) reasons.push('startup-id-mismatch');
  if (pitch.treatment !== D8_TREATMENT) reasons.push('treatment-not-adopted');
  if (!Object.is(pitch.f, expectedF)) reasons.push('f-not-adopted');
  if (pitch.controllerActive !== true) reasons.push('controller-inactive');
  if (pitch.fault !== null) reasons.push('lifecycle-fault');
  if (sample.controller?.mode === TREATMENT_FAULT_MODE) reasons.push('controller-view-faulted');
  if (!Object.is(sample.controller?.settings?.MIN_COMMAND_DEVIATION, expectedF)) reasons.push('controller-f-not-adopted');
  return reasons;
}

function eventViolations(events) {
  const reasons = [];
  for (const event of events) {
    if (event?.kind === 'fault') reasons.push('fault-event');
    if (event?.kind === 'unity-restore') reasons.push('unity-restore-event');
    if (event?.kind === 'write') {
      const taken = event.allowed === true && event.error === null
        && event.readback?.presence === 'value' && event.readback.value === event.requested;
      if (!taken) reasons.push('write-unsuccessful');
    }
  }
  return reasons;
}

/**
 * Whether the adopted treatment held on every decision-bearing sample: one
 * established startup at exactly `expectedF`, fresh reads all false, and no
 * fault, restore or refused write anywhere in the event stream.
 */
export function treatmentAudit({ startups = [], events = [], samples = [], expectedF = D8_COMMAND_THRESHOLD } = {}) {
  const failures = [];
  const distinct = [...new Map(startups.map((startup) => [startup?.id, startup])).values()];
  const startupEvents = events.filter((event) => event?.kind === 'startup');
  if (distinct.length !== 1) failures.push(distinct.length === 0 ? 'startup-record-absent' : 'startup-record-not-unique');
  if (startupEvents.length !== 1) failures.push('startup-event-not-unique');
  const startup = distinct.length === 1 ? distinct[0] : null;
  if (startup !== null) {
    if (startup.outcome !== 'treatment-established') failures.push(`startup-not-established:${startup.reason}`);
    if (startup.attemptedWrites !== 1) failures.push('startup-write-count-not-one');
    const event = startupEvents[0];
    if (event && event.startup?.id !== startup.id) failures.push('startup-event-names-another-record');
    if (event && (event.treatment !== D8_TREATMENT || !Object.is(event.f, expectedF))) failures.push('startup-event-not-the-adopted-treatment');
  }
  const pitch = pitchAudit({ events: pitchEvents({ startups: distinct, samples }), declared: false });
  if (pitch.status !== 'met') failures.push(...pitch.failures.map((failure) => `pitch:${failure}`));
  if (samples.length === 0) failures.push('no-decision-bearing-samples');
  const bySample = samples.map((sample) => ({ atMs: sample?.atMs ?? null, source: sample?.source ?? null, reasons: sampleViolations(sample, { startupId: startup?.id ?? null, expectedF }) }))
    .filter((entry) => entry.reasons.length > 0);
  failures.push(...unique(bySample.flatMap((entry) => entry.reasons)).map((reason) => `sample:${reason}`));
  failures.push(...unique(eventViolations(events)).map((reason) => `event:${reason}`));
  return {
    status: failures.length === 0 ? 'met' : INTEGRATION_LABELS.treatmentNotHeld,
    requested: { treatment: D8_TREATMENT, f: expectedF, preservesPitch: false },
    observed: {
      startupId: startup?.id ?? null,
      outcome: startup?.outcome ?? null,
      reason: startup?.reason ?? null,
      treatments: unique(samples.map((sample) => sample?.pitch?.treatment ?? null)),
      f: unique(samples.map((sample) => sample?.pitch?.f ?? null)),
      preservesPitch: pitch.observed,
      samples: samples.length,
      violatingSamples: bySample.length,
      firstViolation: bySample[0] ?? null,
    },
    pitch: { status: pitch.status, failures: pitch.failures, readableSamples: pitch.readableSamples, unreadableSamples: pitch.unreadableSamples, set: pitch.set },
    failures: unique(failures),
  };
}

/** One row per retained poll, carrying the writes that poll made; atMs is the kernel's own reading. */
export function pollRows(events) {
  const rows = [];
  let writes = [];
  for (const event of events) {
    if (event?.kind === 'write') writes.push(event);
    if (event?.kind !== 'poll') continue;
    rows.push({
      pollId: event.snapshot?.polls ?? null,
      atMs: Number.isFinite(event.controllerNowMs) ? event.controllerNowMs : null,
      controllerNowMs: event.controllerNowMs ?? null,
      pageAtMs: event.atMs ?? null,
      eventId: event.id ?? null,
      threw: event.threw ?? null,
      snapshot: event.snapshot ?? null,
      rateCalls: writes.map((write) => ({ requestedRate: write.requested })),
      file: 'treatment.ndjson',
    });
    writes = [];
  }
  return { rows, trailingWrites: writes.length };
}

function completenessFailures(events, stream, polls, trailingWrites) {
  const failures = [];
  if (events.length === 0) failures.push('no-events');
  if (!events.every((event, index) => event?.id === index + 1)) failures.push('event-ids-not-contiguous-from-1');
  if (stream === null || stream === undefined) failures.push('stream-counters-absent');
  else {
    if (stream.lost !== 0) failures.push('events-lost');
    if (stream.gaps !== 0) failures.push('drain-gaps');
    if (stream.pendingAtLastDrain !== 0) failures.push('events-left-undrained');
    if (stream.unavailable !== 0) failures.push('drain-unavailable');
  }
  if (polls.length === 0) failures.push('no-polls');
  if (polls.length > 0 && polls[0].pollId !== 1) failures.push('first-poll-not-retained');
  for (let index = 1; index < polls.length; index += 1) {
    if (polls[index].pollId !== polls[index - 1].pollId + 1) { failures.push('poll-missing'); break; }
  }
  if (polls.some((row) => row.atMs === null)) failures.push('poll-time-absent');
  if (polls.some((row, index) => index > 0 && row.atMs !== null && polls[index - 1].atMs !== null && row.atMs < polls[index - 1].atMs)) failures.push('poll-time-not-monotonic');
  if (polls.some((row) => row.threw !== null)) failures.push('poll-threw');
  if (trailingWrites > 0) failures.push('write-outside-a-poll');
  return failures;
}

/**
 * Every entry into `settled`, walked back over dwell-eligible polls. The kernel
 * requires SETTLED_FOR_MS from its own inside-threshold instant; an audit that
 * finds less on the kernel's own clock readings has not established that entry.
 */
export function settledEntryDwells(rows, { settledForMs = SETTLED_FOR_MS } = {}) {
  const entries = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].snapshot?.mode !== 'settled' || rows[index - 1]?.snapshot?.mode === 'settled') continue;
    let start = index;
    while (start > 0 && dwellEligibility(rows[start - 1].snapshot).eligible) start -= 1;
    const endpoint = dwellEligibility(rows[index].snapshot);
    const elapsedMs = rows[index].atMs - rows[start].atMs;
    entries.push({
      pollId: rows[index].pollId,
      atMs: rows[index].atMs,
      startPollId: rows[start].pollId,
      elapsedMs,
      requiredMs: settledForMs,
      endpointEligible: endpoint.eligible,
      ok: endpoint.eligible && elapsedMs >= settledForMs,
    });
  }
  return entries;
}

/**
 * The adopted unity-hold policy over the retained polls: refusals at exact
 * unity with nothing qualified, a fresh >=5000 ms dwell before every settled
 * entry, no refusal after first settling, and no split mode at all.
 */
export function refusalDwellAudit({ events = [], stream = null, expectedF = D8_COMMAND_THRESHOLD } = {}) {
  const { rows: polls, trailingWrites } = pollRows(events);
  const incomplete = completenessFailures(events, stream, polls, trailingWrites);
  const base = { polls: polls.length, firstPollId: polls[0]?.pollId ?? null, lastPollId: polls.at(-1)?.pollId ?? null, startAtMs: polls[0]?.atMs ?? null, endAtMs: polls.at(-1)?.atMs ?? null };
  if (incomplete.length > 0) return { status: 'refused', ...base, failures: incomplete, holds: null, settledEntries: [] };
  const failures = [];
  if (polls.some((row) => !Object.is(row.snapshot?.settings?.MIN_COMMAND_DEVIATION, expectedF))) failures.push('poll-f-not-adopted');
  const holds = holdPolicyAudit({ rows: browserHoldRows(polls), arm: 'C', horizonMs: base.endAtMs });
  for (const clause of holds.clauses) {
    const allowed = clause.name === 'hold-fresh-dwell-5000ms' ? ['met', 'not-applicable'] : ['met'];
    if (!allowed.includes(clause.status)) failures.push(`${clause.name}:${clause.status}`);
  }
  if ((holds.uncertifiedFailures?.length ?? 0) > 0 || polls.some((row) => row.snapshot?.mode === 'uncertified-correction')) failures.push('split-mode-observed');
  const settledEntries = settledEntryDwells(polls);
  if (settledEntries.length === 0) failures.push('never-settled');
  if (settledEntries.some((entry) => !entry.ok)) failures.push('settled-entry-without-fresh-dwell');
  return {
    status: failures.length === 0 ? 'met' : 'not-met',
    ...base,
    failures,
    holds: { status: holds.status, clauses: holds.clauses.map(({ name, status }) => ({ name, status })), firstSettledAtMs: holds.firstSettledAtMs ?? null, postFirstSettleHold: holds.postFirstSettleHold ?? null },
    settledEntries,
  };
}

/** `missing` names retained files that were absent; each refuses both audits. */
export function auditClient({ label, startups, events, stream, samples, missing = [], expectedF = D8_COMMAND_THRESHOLD }) {
  const treatment = treatmentAudit({ startups, events, samples, expectedF });
  const refusalDwell = refusalDwellAudit({ events, stream, expectedF });
  if (missing.length === 0) return { label, treatment, refusalDwell };
  const absent = missing.map((name) => `file-absent:${name}`);
  return {
    label,
    treatment: { ...treatment, status: INTEGRATION_LABELS.treatmentNotHeld, failures: [...treatment.failures, ...absent] },
    refusalDwell: { ...refusalDwell, status: 'refused', failures: [...refusalDwell.failures, ...absent] },
  };
}

function readNdjsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/** One client's retained evidence from a verifier run directory. */
export function readClientEvidence(dir, label) {
  const treatment = readNdjsonIfPresent(path.join(dir, `${label}.treatment.ndjson`));
  const captures = readNdjsonIfPresent(path.join(dir, `${label}.captures.ndjson`));
  const settle = readNdjsonIfPresent(path.join(dir, `${label}.settle.ndjson`));
  const missing = [['treatment', treatment], ['captures', captures], ['settle', settle]].filter(([, value]) => value === null).map(([name]) => name);
  const samples = [
    ...(settle ?? []).map((read) => ({ ...read, source: 'settle' })),
    ...(captures ?? []).map((capture) => ({ ...capture, source: 'capture' })),
  ].sort((left, right) => left.atMs - right.atMs);
  return {
    missing,
    startups: (treatment ?? []).filter((line) => line.kind === 'startup').map((line) => line.startup),
    events: (treatment ?? []).filter((line) => line.kind === 'event').map((line) => line.event),
    samples,
  };
}

/** What a replay and the verifier's own record must agree on. */
export function integrationSummary(clients) {
  return clients.map((client) => ({
    label: client.label,
    treatment: { status: client.treatment.status, failures: client.treatment.failures },
    refusalDwell: { status: client.refusalDwell.status, failures: client.refusalDwell.failures, polls: client.refusalDwell.polls },
  }));
}

/** Re-derives both clients' audits from disk and compares them with the manifest's. */
export function replayIntegration(runDir, { labels = ['A', 'B'], expectedF = D8_COMMAND_THRESHOLD } = {}) {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { agreement: false, reason: 'manifest-absent', clients: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const clients = labels.map((label) => auditClient({
    label,
    ...readClientEvidence(runDir, label),
    stream: manifest.windows?.find((window) => window.label === label)?.counts?.treatment ?? null,
    expectedF,
  }));
  const recorded = manifest.integration?.summary ?? null;
  const schemaOk = manifest.integrationSchema === INTEGRATION_SCHEMA;
  const agreement = schemaOk && recorded !== null && JSON.stringify(integrationSummary(clients)) === JSON.stringify(recorded);
  return { agreement, reason: agreement ? null : !schemaOk ? 'integration-schema-absent' : recorded === null ? 'recorded-audit-absent' : 'replay-disagrees', clients, manifest };
}

export function routeSignatureMatches(route, signature = T8_ROUTE_SIGNATURE) {
  if (route === null || typeof route !== 'object') return false;
  if (route.diagnosis !== signature.diagnosis || route.departureObserved !== signature.departureObserved) return false;
  const offlineOk = Object.entries(signature.offline).every(([key, value]) => route.offlineSignature?.[key] === value);
  const deltasOk = Object.entries(signature.deltas).every(([key, value]) => route.deltas?.[key] === value);
  return offlineOk && deltasOk;
}

/**
 * The attempt's label. Treatment first: a client whose treatment did not hold
 * makes the attempt `treatment-not-held` whatever else passed. Then every other
 * condition; a T8 failure is excused only if it is on the frozen list, the
 * owner accepted that list, and the route showed the same causal signature.
 */
export function classifyIntegration({ clients = [], failures = [], exitCode = null, completed = false, route = null, replayAgreement = false, resources = null, t8Accepted = false } = {}) {
  const knownT8 = failures.filter((label) => T8_INHERITED_ALLOWLIST.includes(label));
  const unexpected = failures.filter((label) => !T8_INHERITED_ALLOWLIST.includes(label));
  const disappeared = T8_INHERITED_ALLOWLIST.filter((label) => !failures.includes(label));
  const common = { knownT8, unexpected, disappeared, exitCode };
  if (clients.length !== 2 || clients.some((client) => client.treatment?.status !== 'met')) {
    return { label: INTEGRATION_LABELS.treatmentNotHeld, reasons: ['treatment-not-held-in-both-clients'], ...common };
  }
  const reasons = [];
  if (!completed) reasons.push('verifier-did-not-complete');
  if (clients.some((client) => client.refusalDwell?.status !== 'met')) reasons.push('refusal-dwell-not-met');
  if (unexpected.length > 0) reasons.push('unexcused-failures');
  if (knownT8.length > 0 && !t8Accepted) reasons.push('t8-exceptions-not-accepted');
  if (knownT8.length > 0 && !routeSignatureMatches(route)) reasons.push('t8-route-signature-changed');
  if ((failures.length === 0) !== (exitCode === 0)) reasons.push('exit-status-disagrees-with-failures');
  if (replayAgreement !== true) reasons.push('disk-replay-disagrees');
  if (resources?.ok !== true) reasons.push('resource-bound-not-met');
  const label = reasons.length > 0 ? INTEGRATION_LABELS.notMet : knownT8.length > 0 ? INTEGRATION_LABELS.metWithKnownT8 : INTEGRATION_LABELS.met;
  return { label, reasons, ...common, note: 'never ALL PASS; an exception-free command does not declare change 5 fixed' };
}
