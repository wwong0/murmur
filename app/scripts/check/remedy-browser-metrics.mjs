// scripts/check/remedy-browser-metrics.mjs
//
// What the retained browser evidence means, as pure functions over manufactured
// or captured events. No browser, no filesystem, no clock of its own — the same
// split that lets `drift-figures.mjs` be checked without Chrome.
//
// The distinctions this file exists to hold (`remedy-browser-comparison-spec.md`
// sections 3 and 5):
//
//  - EVIDENCE FAILURE IS NOT CANDIDATE FAILURE. A wrong id, a missing field, a
//    conflicting duplicate or a clock-domain mismatch refuses the affected
//    figure. It never becomes a result about the controller, and it never
//    becomes a favourable missing value.
//  - BROWSER POLLS DO NOT LIE ON A GRID. The offline sweep validates an exact
//    0, 250, 500 ms schedule; nothing here may. A nonuniform but completely
//    observed sequence is complete evidence.
//  - THE DWELL PREDICATE IS ELAPSED TIME, not a tick count and not exactly
//    5000. It is measured on the controller's own retained `now()` values, and
//    the overshoot is reported rather than required to be zero.
//  - A DRAIN TIME IS NOT A POLL TIME. Coverage over drain slots and coverage
//    over frames are different populations with different denominators, and a
//    late but lossless drain is an empty slot, never a lost event.
//
// TEST MACHINERY — under scripts/.

import {
  SCHEMA_VERSION,
  EVENT_KINDS,
  DRAIN_INTERVAL_MS,
  classifyField,
  finiteField,
} from '../remedy-browser-page.mjs';
import { necessaryConditions, seamProofsOf } from './remedy-browser-conditions.mjs';
import { MAX_STOPPING_THRESHOLD_MS, SETTLED_FOR_MS } from '../../public/lib/drift-controller.mjs';

export { DRAIN_INTERVAL_MS, SETTLED_FOR_MS, MAX_STOPPING_THRESHOLD_MS };
export { NECESSARY_CONDITIONS, seamProofsOf } from './remedy-browser-conditions.mjs';

/** The existing headless callback-qualification predicates, carried unchanged
 *  from `verify-frames.mjs` rather than restated as new browser bars. */
export const MIN_CALLBACK_RATIO = 0.9;
export const MIN_ACCEPT_RATIO = 0.95;
/** The stage-B evidence bar, reported by stage A and never applied by it. */
export const PROPOSED_COVERAGE_RATIO = 0.95;

/** Every field a kind must CARRY. Presence is evidence; the value is judgement,
 *  so an absent field refuses the event and a wrong one fails a clause. */
const REQUIRED_FIELDS = Object.freeze({
  construction: ['factory'],
  poll: ['pollId', 'publishedPolls', 'enteredMs', 'exitedMs', 'rateBefore', 'rateAfter', 'snapshot'],
  'controller-input': ['pollId', 'input'],
  'rate-call': ['pollId', 'requestedRate', 'rateBefore', 'rateAfter'],
  'frame-callback': ['callbackId', 'callbackNow', 'metadata'],
  'sampler-input': ['callbackId', 'reads'],
  'drift-offer': ['callbackId', 'derived', 'accepted'],
  native: ['event', 'media'],
  'seam-sample': ['media'],
});

/** The rVFC fields a record cannot be interpreted without. Presence is not
 *  enough for these: a timestamp that arrived as NaN is a number-shaped refusal
 *  to say when the frame was shown, and a coverage figure must not read it. */
const REQUIRED_METADATA = Object.freeze(['mediaTime', 'expectedDisplayTime', 'presentationTime', 'presentedFrames']);

/** What each controller input must carry beyond its own name. `log.read` is the
 *  one that decides whether the controller saw every record, so its `missed` is
 *  required rather than defaulted — an absent count must never become zero. */
const REQUIRED_INPUT_FIELDS = Object.freeze({
  now: ['result'],
  'clock.read': ['result'],
  'log.read': ['count', 'missed', 'latestSeq'],
});

/** Every key the controller's own snapshot always carries. The product fills
 *  the ones it cannot compute with an explicit null, so an ABSENT key is a
 *  wrapper that lost it rather than a poll that had nothing to say. */
const REQUIRED_SNAPSHOT_FIELDS = Object.freeze([
  'rate', 'estimateMs', 'stoppingThresholdMs', 'thresholdUsable', 'mode', 'reason',
  'windowRecords', 'controlRecords', 'settings', 'polls', 'settlingMs', 'counters',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const push = (list, failure) => { if (!list.includes(failure)) list.push(failure); };

/**
 * Merge the batches Node wrote, in receipt order.
 *
 * A drain that was read twice before its acknowledgement delivers the same
 * events twice, and that is the durable-read contract working. Two events with
 * one id and DIFFERENT bodies is the opposite — nothing in a correct collector
 * produces it, so it refuses the stream rather than picking a winner.
 */
export function mergeBatches(batches) {
  const byId = new Map();
  const conflicts = [];
  const duplicates = [];
  for (const batch of batches ?? []) {
    for (const event of batch?.events ?? []) {
      const id = event?.eventId;
      if (!byId.has(id)) {
        byId.set(id, event);
        continue;
      }
      if (JSON.stringify(byId.get(id)) === JSON.stringify(event)) duplicates.push(id);
      else conflicts.push(id);
    }
  }
  return {
    events: [...byId.values()].sort((left, right) => left.eventId - right.eventId),
    identicalDuplicates: duplicates.length,
    conflictingDuplicates: conflicts,
  };
}

/**
 * The stream's own integrity, before anything it says is read as a measurement.
 * `expected` pins the arm and build the run believes it delivered, so a page
 * running the other bundle is caught here rather than in a figure.
 */
export function checkEventStream(events, { arm = null, buildId = null, conflictingDuplicates = [] } = {}) {
  const failures = [];
  if (!Array.isArray(events) || events.length === 0) return { complete: false, failures: ['no-events'], counts: {} };
  if (conflictingDuplicates.length > 0) push(failures, 'conflicting-duplicate-event');

  const counts = {};
  let previousId = null;
  const collectors = new Set();
  for (const event of events) {
    if (!isObject(event)) { push(failures, 'malformed-event'); continue; }
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    if (event.v !== SCHEMA_VERSION) push(failures, 'schema-version-mismatch');
    if (!EVENT_KINDS.includes(event.kind)) push(failures, 'unknown-event-kind');
    if (arm !== null && event.arm !== arm) push(failures, 'arm-disagreement');
    if (buildId !== null && event.buildId !== buildId) push(failures, 'build-disagreement');
    collectors.add(event.collectorId);
    if (!Number.isFinite(event.atMs)) push(failures, 'observation-time-not-finite');
    if (previousId === null) {
      if (event.eventId !== 1) push(failures, 'stream-does-not-start-at-the-first-event');
    } else if (event.eventId !== previousId + 1) {
      push(failures, 'missing-event-ids');
    }
    previousId = event.eventId;
    const required = REQUIRED_FIELDS[event.kind] ?? [];
    if (required.some((field) => classifyField(event, field).presence === 'absent')) push(failures, `${event.kind}-fields-absent`);
    if (event.kind === 'controller-input') {
      const forInput = REQUIRED_INPUT_FIELDS[event.input] ?? [];
      if (forInput.some((field) => classifyField(event, field).presence === 'absent')) push(failures, `controller-input-${event.input}-fields-absent`);
    }
    if (event.kind === 'frame-callback') {
      if (REQUIRED_METADATA.some((field) => classifyField(event.metadata, field).presence === 'absent')) push(failures, 'frame-metadata-fields-absent');
      // PRESENT IS NOT USABLE. A non-finite expectedDisplayTime passes every
      // presence test and then silently drops out of every interval and every
      // coverage denominator computed from it.
      else if (REQUIRED_METADATA.some((field) => finiteField(event.metadata, field) === null)) push(failures, 'frame-metadata-not-finite');
    }
  }
  if (collectors.size > 1) push(failures, 'more-than-one-collector');
  return { complete: failures.length === 0, failures, counts, collectors: [...collectors], events: events.length };
}

/**
 * One row per controller poll, with the inputs that poll actually used.
 *
 * `atMs` is the controller's OWN `now()` reading — the value the dwell
 * arithmetic inside the controller ran on — and not the wrapper's bracket or a
 * drain timestamp. A poll missing that reading has no time and refuses the
 * audit rather than borrowing the bracket's.
 */
/**
 * Is this snapshot the controller's, or an object shaped like one?
 *
 * An empty object satisfies every `isObject` test and then answers "no" to
 * every question asked of it — no mode, no threshold, no settling — which reads
 * downstream as a controller that ran quietly. The keys are required by name.
 */
export function snapshotShape(snapshot) {
  if (!isObject(snapshot)) return ['poll-snapshot-absent'];
  const problems = [];
  for (const field of REQUIRED_SNAPSHOT_FIELDS) {
    if (classifyField(snapshot, field).presence === 'absent') problems.push(`poll-snapshot-missing-${field}`);
  }
  if (typeof snapshot.mode !== 'string' || snapshot.mode === '') problems.push('poll-snapshot-mode-not-named');
  if (typeof snapshot.thresholdUsable !== 'boolean') problems.push('poll-snapshot-threshold-usability-not-stated');
  if (finiteField(snapshot, 'polls') === null) problems.push('poll-snapshot-poll-count-absent');
  // A poll that declares its threshold usable has to carry the two operands the
  // dwell and the ceiling are decided on; one that does not, does not.
  if (snapshot.thresholdUsable === true) {
    if (finiteField(snapshot, 'stoppingThresholdMs') === null) problems.push('poll-snapshot-usable-threshold-not-finite');
    if (finiteField(snapshot, 'estimateMs') === null) problems.push('poll-snapshot-usable-estimate-not-finite');
  }
  return problems;
}

export function joinPolls(events, { timeOriginMs = 0 } = {}) {
  const failures = [];
  const snapshotFailures = [];
  const inputs = new Map();
  const rateCalls = new Map();
  for (const event of events) {
    if (event.kind === 'controller-input') {
      const pollId = finiteField(event, 'pollId');
      if (!inputs.has(pollId)) inputs.set(pollId, []);
      inputs.get(pollId).push(event);
    }
    if (event.kind === 'rate-call') {
      const pollId = finiteField(event, 'pollId');
      if (!rateCalls.has(pollId)) rateCalls.set(pollId, []);
      rateCalls.get(pollId).push(event);
    }
  }

  const rows = [];
  let expected = 1;
  for (const event of events.filter((item) => item.kind === 'poll')) {
    const pollId = finiteField(event, 'pollId');
    const published = finiteField(event, 'publishedPolls');
    if (pollId !== expected) push(failures, 'missing-polls');
    expected = (pollId ?? expected) + 1;
    // ONE POLL AUTHORITY. The wrapper counts its own calls and the controller
    // counts every evaluation it made; a second timer or a second controller
    // moves them apart, and nothing else does.
    if (published !== pollId) push(failures, 'poll-authority-disagreement');

    const mine = inputs.get(pollId) ?? [];
    const nowInput = mine.find((item) => item.input === 'now');
    const clockInput = mine.find((item) => item.input === 'clock.read');
    const logInput = mine.find((item) => item.input === 'log.read');
    const snapshot = isObject(event.snapshot) ? event.snapshot : null;
    for (const problem of snapshotShape(event.snapshot)) push(snapshotFailures, problem);
    if (nowInput === undefined || clockInput === undefined) push(failures, 'controller-inputs-absent');
    const noClock = snapshot !== null && snapshot.mode === 'waiting' && snapshot.reason === 'no-clock';
    // The one poll that legitimately reads no log: with no offset the loop
    // returns before it reaches the cursor (`drift-controller.mjs`). That is a
    // STARTUP NULL and it is named; a log read that happened and did not say
    // what it missed is an absent observation and refuses the poll.
    if (!noClock && logInput === undefined) push(failures, 'controller-log-read-absent');
    const intakeMissed = logInput === undefined ? null : finiteField(logInput, 'missed');
    if (logInput !== undefined && intakeMissed === null) push(failures, 'controller-log-read-missed-absent');

    // THE CONTROLLER SPEAKS A DIFFERENT CLOCK. `room.entry.js` hands it
    // `performance.timeOrigin + performance.now()`, which is epoch-relative,
    // while every collector timestamp and the capture window are bare
    // page-monotonic milliseconds. Subtracting the page origin puts the poll on
    // the window's clock; it cannot disturb the dwell, which is a difference of
    // two of these readings and is unchanged by a constant. The reading the
    // controller actually used is retained beside it, because that is the value
    // the audit is defined over.
    const controllerNowMs = nowInput === undefined ? null : finiteField(nowInput, 'result');
    const atMs = controllerNowMs === null ? null : controllerNowMs - timeOriginMs;
    if (atMs === null) push(failures, 'controller-clock-reading-absent');
    rows.push({
      pollId,
      atMs,
      controllerNowMs,
      enteredMs: finiteField(event, 'enteredMs'),
      exitedMs: finiteField(event, 'exitedMs'),
      rateBefore: finiteField(event, 'rateBefore'),
      rateAfter: finiteField(event, 'rateAfter'),
      snapshot,
      threw: classifyField(event, 'threw').value ?? null,
      clockResult: clockInput === undefined ? null : clockInput.result ?? null,
      // `noClock` says the controller legitimately read no log at this poll;
      // anything else with no intake row is an observation that went missing,
      // and the two must not both arrive as a zero.
      intakeExempt: noClock && logInput === undefined,
      intake: logInput === undefined ? null : {
        missed: intakeMissed,
        count: finiteField(logInput, 'count'),
        firstSeq: finiteField(logInput, 'firstSeq'),
        lastSeq: finiteField(logInput, 'lastSeq'),
      },
      rateCalls: (rateCalls.get(pollId) ?? []).map((call) => ({
        requestedRate: finiteField(call, 'requestedRate'),
        rateBefore: finiteField(call, 'rateBefore'),
        rateAfter: finiteField(call, 'rateAfter'),
        atMs: finiteField(call, 'atMs'),
        threw: classifyField(call, 'threw').value ?? null,
      })),
    });
  }
  const orphans = [...rateCalls.keys()].filter((pollId) => !rows.some((row) => row.pollId === pollId));
  if (orphans.length > 0) push(failures, 'rate-call-outside-any-poll');
  return { rows, complete: failures.length === 0 && snapshotFailures.length === 0, failures, snapshotFailures };
}

/**
 * The stopping-threshold ceiling, on every poll rather than on a helper.
 *
 * `dwellEligibility()` applies the ceiling to the polls a dwell walks over. A
 * poll outside any dwell run is never inspected by it, so a controller that
 * claimed a usable 999 ms threshold in a window that never settled passed
 * unexamined. This looks at all of them.
 *
 * THE CEILING IS A REFUSAL ONLY WHERE A FLOOR WAS ACCEPTED. `executor-spec.md`
 * C1.3 states the hold for f > 0: measurement plus allowance needing more room
 * than the owner allowed leaves no threshold to accept. At f = 0 the shipped
 * controller has no such branch, and an accepted S above 20 ms is a poll that
 * cannot count toward a dwell — which `dwellEligibility()` already says —
 * rather than a broken contract. Counting it as one here would manufacture a
 * failure out of the approved design, so those polls are reported separately
 * and by name. A poll that publishes neither floor is undecidable, not clean.
 */
export function stoppingCeilingAudit(rows, { ceilingMs = MAX_STOPPING_THRESHOLD_MS } = {}) {
  const violations = [];
  const aboveCeilingAtZeroFloor = [];
  const undecidable = [];
  let inspected = 0;
  for (const row of rows) {
    if (!isObject(row.snapshot) || row.snapshot.thresholdUsable !== true) continue;
    inspected += 1;
    const threshold = finiteField(row.snapshot, 'stoppingThresholdMs');
    const where = { pollId: row.pollId, stoppingThresholdMs: threshold, atMs: row.atMs };
    // A usable threshold that is not a number is a defect at any floor: nothing
    // downstream can compare an estimate against it.
    if (threshold === null) { violations.push(where); continue; }
    if (threshold <= ceilingMs) continue;
    const floor = finiteField(row.snapshot.settings ?? {}, 'MIN_COMMAND_DEVIATION');
    if (floor === null) undecidable.push(where);
    else if (floor > 0) violations.push({ ...where, floor });
    else aboveCeilingAtZeroFloor.push(where);
  }
  return { inspected, ceilingMs, violations, aboveCeilingAtZeroFloor, undecidable };
}

/**
 * Did the run collect every id the page issued?
 *
 * The page numbers an event before anything about it can fail, so a produced id
 * with no event delivered is a real hole. A LOSSLESS DELAYED DRAIN IS NOT ONE:
 * every id is still there, just later than its slot. Contiguity says nothing
 * about the far end, which is why the producer's own count is required.
 */
export function accountForProducedIds({ events, produced }) {
  const seen = new Set(events.map((event) => event.eventId));
  const missing = [];
  for (let id = 1; id <= produced; id += 1) if (!seen.has(id)) missing.push(id);
  return {
    produced,
    delivered: seen.size,
    missing: missing.slice(0, 16),
    missingCount: missing.length,
    complete: missing.length === 0 && seen.size === produced,
  };
}

/**
 * The recorder's independent drain of the product log, against what the sampler
 * offered.
 *
 * These are two readers of one log with separate cursors, so agreement is real
 * cross-evidence: a record the recorder holds that no offer produced, or an
 * accepted offer the recorder never saw, is a hole in one of the two paths.
 */
export function recordAgreement({ records, callbacks }) {
  const differences = [];
  const recorded = new Set();
  for (const batch of records ?? []) {
    for (const item of batch?.records ?? []) {
      const seq = finiteField(item, 'seq');
      if (seq !== null) recorded.add(seq);
    }
  }
  const accepted = new Set(callbacks.filter((row) => row.accepted && Number.isFinite(row.seq)).map((row) => row.seq));
  const missingFromRecorder = [...accepted].filter((seq) => !recorded.has(seq));
  const unofferedRecords = [...recorded].filter((seq) => !accepted.has(seq));
  if (missingFromRecorder.length > 0) differences.push(`${missingFromRecorder.length} accepted offer(s) never reached the recorder`);
  if (unofferedRecords.length > 0) differences.push(`${unofferedRecords.length} recorded record(s) came from no observed offer`);
  return {
    records: recorded.size,
    acceptedOffers: accepted.size,
    missingFromRecorder: missingFromRecorder.slice(0, 8),
    unofferedRecords: unofferedRecords.slice(0, 8),
    agrees: differences.length === 0,
    differences,
  };
}

/** Callbacks and the derivations they produced, joined on the scoped callback
 *  id the sampler wrapper restores in a `finally`. */
export function joinCallbacks(events) {
  const failures = [];
  const offers = new Map();
  // The sampler's own reads for each callback, where the build that produced
  // this capture recorded them. A capture with none is a narrower provenance
  // claim, not a broken join, and the condition beside it says which.
  const samplerReads = new Map();
  for (const event of events.filter((item) => item.kind === 'sampler-input')) {
    const callbackId = finiteField(event, 'callbackId');
    if (samplerReads.has(callbackId)) push(failures, 'more-than-one-sampler-input-per-callback');
    samplerReads.set(callbackId, Array.isArray(event.reads) ? event.reads : null);
  }
  for (const event of events.filter((item) => item.kind === 'drift-offer')) {
    const callbackId = finiteField(event, 'callbackId');
    if (offers.has(callbackId)) push(failures, 'more-than-one-derivation-per-callback');
    offers.set(callbackId, event);
  }
  const rows = [];
  const seen = new Set();
  for (const event of events.filter((item) => item.kind === 'frame-callback')) {
    const callbackId = finiteField(event, 'callbackId');
    if (seen.has(callbackId)) push(failures, 'duplicate-callback-id');
    seen.add(callbackId);
    const offer = offers.get(callbackId);
    if (offer === undefined) push(failures, 'incomplete-callback-join');
    const accepted = offer === undefined ? null : classifyField(offer, 'accepted');
    rows.push({
      callbackId,
      atMs: finiteField(event, 'atMs'),
      // The three times a coverage figure must not confuse: when the callback
      // arrived, when the browser says the frame will be shown, and where the
      // media was. The drain time is not among them and never enters here.
      expectedDisplayTime: finiteField(event.metadata, 'expectedDisplayTime'),
      presentationTime: finiteField(event.metadata, 'presentationTime'),
      mediaTime: finiteField(event.metadata, 'mediaTime'),
      presentedFrames: finiteField(event.metadata, 'presentedFrames'),
      nativeRate: finiteField(event, 'nativeRate'),
      accepted: accepted !== null && accepted.presence === 'value' && isObject(accepted.value),
      refusalReason: offer === undefined ? null : refusalOf(offer),
      seq: accepted !== null && accepted.presence === 'value' && isObject(accepted.value) ? accepted.value.seq : null,
      samplerReads: samplerReads.get(callbackId) ?? null,
    });
  }
  for (const callbackId of offers.keys()) if (!seen.has(callbackId)) push(failures, 'derivation-outside-any-callback');
  for (const callbackId of samplerReads.keys()) if (!seen.has(callbackId)) push(failures, 'sampler-input-outside-any-callback');
  const withReads = rows.filter((row) => Array.isArray(row.samplerReads)).length;
  return {
    rows,
    complete: failures.length === 0,
    failures,
    samplerProvenance: {
      callbacks: rows.length,
      withReads,
      // Three reads produce one drift record: the sampler's own clock, the clock
      // estimate and the timeline position. Fewer means the derivation of that
      // record cannot be reconstructed from the retained events.
      complete: rows.length > 0 && withReads === rows.length,
      inputs: [...new Set(rows.flatMap((row) => (row.samplerReads ?? []).map((read) => read.input)))],
    },
  };
}

const refusalOf = (offer) => {
  const derived = classifyField(offer, 'derived');
  if (derived.presence !== 'value' || !isObject(derived.value) || derived.value.ok) return null;
  return derived.value.reason ?? 'unnamed-refusal';
};

/**
 * The rate the element was at, as a piecewise-constant timeline over observed
 * readings. Every reading is a real observation — a poll readback, a rate call
 * or a seam sample — and the span before the first one inside a window is
 * UNKNOWN, which refuses the rate-normalized figure rather than assuming unity.
 */
export function rateTimeline(events) {
  const points = [];
  for (const event of events) {
    const atMs = Number.isFinite(event.atMs) ? event.atMs : null;
    if (atMs === null) continue;
    if (event.kind === 'poll') {
      const after = finiteField(event, 'rateAfter');
      if (after !== null) points.push({ atMs, rate: after, source: 'poll-readback' });
    }
    if (event.kind === 'rate-call') {
      const after = finiteField(event, 'rateAfter');
      if (after !== null) points.push({ atMs, rate: after, source: 'rate-call-readback' });
    }
    if (event.kind === 'seam-sample' || event.kind === 'native') {
      const rate = finiteField(event.media, 'playbackRate');
      if (rate !== null) points.push({ atMs, rate, source: event.kind });
    }
  }
  points.sort((left, right) => left.atMs - right.atMs);
  return points;
}

/** The rate-weighted seconds of media a window nominally asked for, or `null`
 *  where any part of it has no observed rate. */
export function rateWeightedSeconds(points, startMs, endMs) {
  if (endMs <= startMs) return 0;
  const inside = points.filter((point) => point.atMs < endMs);
  const opening = inside.filter((point) => point.atMs <= startMs).at(-1);
  if (opening === undefined) return null;
  let cursor = startMs;
  let rate = opening.rate;
  let total = 0;
  for (const point of inside.filter((item) => item.atMs > startMs)) {
    total += (point.atMs - cursor) * rate;
    cursor = point.atMs;
    rate = point.rate;
  }
  total += (endMs - cursor) * rate;
  return total / 1000;
}

/**
 * Frame coverage over a half-open window, both ways.
 *
 * The named figure is rate-normalized: distinct accepted callbacks over
 * `fixtureFps * integral(rate dt)`. It is a capture check, NOT proof that the
 * browser physically advanced the media at the commanded rate — the same rate
 * readings appear on both sides of that question. The unadjusted denominator is
 * retained beside it. Neither is clamped to one.
 */
export function frameCoverage({ callbacks, ratePoints, startMs, endMs, fixtureFps }) {
  const failures = [];
  const inWindow = callbacks.filter((row) => row.atMs !== null && row.atMs >= startMs && row.atMs < endMs);
  const accepted = new Set(inWindow.filter((row) => row.accepted).map((row) => row.seq ?? `cb-${row.callbackId}`));
  const elapsedSec = (endMs - startMs) / 1000;
  if (!Number.isFinite(fixtureFps) || fixtureFps <= 0) push(failures, 'fixture-frame-rate-unknown');
  const weighted = rateWeightedSeconds(ratePoints, startMs, endMs);
  if (weighted === null) push(failures, 'unknown-rate-interval');
  const unadjustedExpected = fixtureFps * elapsedSec;
  const normalizedExpected = weighted === null ? null : fixtureFps * weighted;
  return {
    callbacks: inWindow.length,
    acceptedRecords: accepted.size,
    elapsedSec,
    unadjustedExpected,
    normalizedExpected,
    unadjustedCoverage: unadjustedExpected > 0 ? accepted.size / unadjustedExpected : null,
    rateNormalizedCoverage: normalizedExpected > 0 ? accepted.size / normalizedExpected : null,
    failures,
  };
}

/**
 * Drain-slot coverage. Slots are the fixed 125 ms slots intersecting the
 * half-open window from the observed start; a slot is covered when at least one
 * drain landed in it, and a second drain in the same slot covers nothing extra.
 * An uncovered slot is a drain that was late, which loses no event.
 */
export function drainSlotCoverage({ drainTimesMs, startMs, endMs, slotMs = DRAIN_INTERVAL_MS }) {
  const expected = Math.max(0, Math.ceil((endMs - startMs) / slotMs));
  const covered = new Set();
  for (const atMs of drainTimesMs ?? []) {
    if (!Number.isFinite(atMs) || atMs < startMs || atMs >= endMs) continue;
    covered.add(Math.floor((atMs - startMs) / slotMs));
  }
  return { expectedSlots: expected, coveredSlots: covered.size, coverage: expected > 0 ? covered.size / expected : null };
}

/**
 * The inherited callback qualification, over the fixed playing interval and not
 * a favourable subwindow. Three predicates, reported apart: a state that fires
 * at a fraction of the frame rate and one that fires and refuses every frame
 * both pass a bare callback count.
 */
export function callbackQualification({ callbacks, startMs, endMs, fixtureFps }) {
  const inWindow = callbacks.filter((row) => row.atMs !== null && row.atMs >= startMs && row.atMs < endMs);
  const elapsedSec = (endMs - startMs) / 1000;
  const acceptedCount = inWindow.filter((row) => row.accepted).length;
  const refusals = {};
  for (const row of inWindow) if (row.refusalReason !== null) refusals[row.refusalReason] = (refusals[row.refusalReason] ?? 0) + 1;
  const callbacksPerSec = elapsedSec > 0 ? inWindow.length / elapsedSec : null;
  const requiredPerSec = MIN_CALLBACK_RATIO * fixtureFps;
  const acceptRatio = inWindow.length > 0 ? acceptedCount / inWindow.length : 0;
  const rateOk = callbacksPerSec !== null && callbacksPerSec >= requiredPerSec;
  const acceptOk = acceptRatio >= MIN_ACCEPT_RATIO;
  const refusalsOk = Object.keys(refusals).length === 0;
  return {
    callbacks: inWindow.length,
    accepted: acceptedCount,
    elapsedSec,
    callbacksPerSec,
    requiredPerSec,
    acceptRatio,
    refusals,
    qualified: rateOk && acceptOk && refusalsOk,
    predicates: { callbackRate: rateOk, acceptRatio: acceptOk, noRefusals: refusalsOk },
  };
}

/** Interval statistics for a series of instants. Descriptive: a passive
 *  cadence measurement, never a claim about a hardware refresh rate. */
export function intervals(timesMs) {
  const sorted = [...(timesMs ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  if (gaps.length === 0) return { count: 0, medianMs: null, minMs: null, maxMs: null, p95Ms: null };
  const ordered = [...gaps].sort((a, b) => a - b);
  const middle = ordered.length >> 1;
  return {
    count: gaps.length,
    medianMs: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    minMs: ordered[0],
    maxMs: ordered[ordered.length - 1],
    p95Ms: ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(0.95 * ordered.length) - 1))],
  };
}

/** A poll that may be counted toward a dwell: usable threshold inside the fixed
 *  ceiling, a finite estimate, and the estimate inside that threshold. */
export function dwellEligibility(snapshot) {
  if (!isObject(snapshot)) return { eligible: false, reason: 'no-snapshot' };
  if (snapshot.mode === 'waiting' || snapshot.mode === 'stale') return { eligible: false, reason: 'waiting-or-stale' };
  if (snapshot.thresholdUsable !== true) return { eligible: false, reason: 'threshold-refused' };
  const threshold = snapshot.stoppingThresholdMs;
  const estimate = snapshot.estimateMs;
  if (!Number.isFinite(threshold) || !Number.isFinite(estimate)) return { eligible: false, reason: 'operands-absent' };
  if (threshold > MAX_STOPPING_THRESHOLD_MS) return { eligible: false, reason: 'threshold-over-ceiling' };
  if (Math.abs(estimate) > threshold) return { eligible: false, reason: 'outside-threshold' };
  return { eligible: true, reason: null };
}

/**
 * The fresh-dwell audit, on elapsed time.
 *
 * Ending at the first observed settling, walk back over uninterrupted eligible
 * polls and compare end minus start against SETTLED_FOR_MS with no jitter
 * allowance. THE OVERSHOOT IS REPORTED, not required to be zero: browser polls
 * arrive when they arrive, and the offline run's exact 5000 is a property of a
 * 250 ms grid rather than a margin (`remedy-recoverable-holds-report.md`).
 *
 * No observed settling is `not-observed` — not zero, and not an instrument
 * failure. Missing poll evidence anywhere in the walked interval is `refused`.
 */
export function freshDwellAudit({ rows, settledForMs = SETTLED_FOR_MS, evidenceComplete = true }) {
  if (!evidenceComplete) return { status: 'refused', reason: 'poll-evidence-incomplete' };
  // AN EMPTY POPULATION IS NOT AN OBSERVATION. `not-observed` says the
  // controller ran and did not settle; with no polls at all there is nothing to
  // have observed, and reporting the two the same way is the favourable missing
  // value section 3 forbids.
  if (rows.length === 0) return { status: 'refused', reason: 'no-polls-in-the-audited-interval' };
  const settledIndex = rows.findIndex((row) => isObject(row.snapshot) && row.snapshot.mode === 'settled');
  if (settledIndex === -1) return { status: 'not-observed', reason: 'no-observed-first-settling' };

  const end = rows[settledIndex];
  if (end.atMs === null) return { status: 'refused', reason: 'settled-poll-has-no-clock-reading' };
  // THE ENDPOINT IS PART OF THE CLAIM. Walking back from a settling whose own
  // poll is not eligible audits the run leading up to a moment that did not
  // qualify — an unusable threshold, an absent estimate or an estimate outside
  // the band at the settling poll itself is a disagreement, not a start.
  const endpoint = dwellEligibility(end.snapshot);
  if (!endpoint.eligible) {
    return {
      status: 'disagrees',
      reason: `the settling poll is not itself eligible (${endpoint.reason})`,
      endPollId: end.pollId,
      endAtMs: end.atMs,
      endControllerNowMs: end.controllerNowMs ?? null,
      requiredMs: settledForMs,
    };
  }
  let start = end;
  let interruptedBy = null;
  for (let index = settledIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.atMs === null) return { status: 'refused', reason: 'poll-in-the-run-has-no-clock-reading' };
    const verdict = dwellEligibility(row.snapshot);
    if (!verdict.eligible) { interruptedBy = verdict.reason; break; }
    start = row;
  }

  const elapsedMs = end.atMs - start.atMs;
  const claimedSettlingMs = Number.isFinite(end.snapshot.settlingMs) ? end.snapshot.settlingMs : null;
  const meets = elapsedMs >= settledForMs;
  return {
    // The controller's own test is `atMs - insideBandAt >= SETTLED_FOR_MS`. An
    // audit that walks the retained polls and finds less than that has not
    // found a tolerance to widen — it has failed to establish the recovery the
    // controller claimed.
    status: meets ? 'agrees' : 'disagrees',
    startPollId: start.pollId,
    endPollId: end.pollId,
    startAtMs: start.atMs,
    endAtMs: end.atMs,
    // The retained readings themselves, in the controller's own domain, so the
    // published audit quotes the values the controller ran on rather than only
    // the ones this file put on the window's clock.
    startControllerNowMs: start.controllerNowMs ?? null,
    endControllerNowMs: end.controllerNowMs ?? null,
    elapsedMs,
    requiredMs: settledForMs,
    overshootMs: elapsedMs - settledForMs,
    polls: end.pollId - start.pollId + 1,
    interruptedBy,
    claimedSettlingMs,
  };
}

/**
 * Did every write reach the element, and did the element move only when it was
 * written to?
 *
 * The readback is taken immediately after the original `apply` returned. A
 * `ratechange` event is asynchronous and one event does not mean one new write,
 * so it is correlated with the retained writes rather than counted against them.
 */
export function nativeWriteAgreement({ rows, events }) {
  const failures = [];
  const writes = [];
  for (const row of rows) {
    for (const call of row.rateCalls) {
      writes.push({ pollId: row.pollId, ...call });
      if (call.threw !== null) push(failures, 'rate-write-threw');
      else if (call.rateAfter === null || call.rateAfter !== call.requestedRate) push(failures, 'rate-readback-mismatch');
    }
  }
  // An unexplained change is the element at a rate no retained write asked for,
  // seen at the top of a poll that has not yet written anything.
  let expected = writes.length > 0 ? null : 1;
  let lastWritten = 1;
  for (const row of rows) {
    expected = lastWritten;
    if (row.rateBefore !== null && row.rateBefore !== expected) push(failures, 'unexplained-native-rate-change');
    for (const call of row.rateCalls) if (call.requestedRate !== null) lastWritten = call.requestedRate;
  }
  const rateChangeEvents = events.filter((event) => event.kind === 'native' && event.event === 'ratechange');
  const nonUnity = writes.filter((write) => write.requestedRate !== null && write.requestedRate !== 1);
  return {
    writes: writes.length,
    nonUnityWrites: nonUnity.length,
    firstNonUnityWrite: nonUnity.length > 0 ? nonUnity[0] : null,
    rateChangeEvents: rateChangeEvents.length,
    // Established only by an actual non-unity write whose readback agreed.
    nativeWriteProof: nonUnity.length === 0
      ? 'unavailable'
      : (nonUnity.every((write) => write.rateAfter === write.requestedRate) ? 'established' : 'failed'),
    failures,
  };
}

/** Everything that refuses continuous playback after the capture origin, and
 *  the same observations before it, which are startup data and stay labelled. */
export const CONTINUITY_REFUSING_EVENTS = Object.freeze([
  'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'ended', 'error', 'emptied', 'loadstart',
]);

export function playbackContinuity({ events, startMs, endMs }) {
  const failures = [];
  const startup = [];
  const inside = [];
  for (const event of events.filter((item) => item.kind === 'native')) {
    if (!CONTINUITY_REFUSING_EVENTS.includes(event.event)) continue;
    if (event.atMs < startMs) startup.push({ event: event.event, atMs: event.atMs });
    else if (event.atMs < endMs) { inside.push({ event: event.event, atMs: event.atMs }); push(failures, `playback-${event.event}`); }
  }
  let reopens = null;
  let epochMs = null;
  for (const event of events.filter((item) => item.kind === 'seam-sample' && item.atMs >= startMs && item.atMs < endMs)) {
    const seenReopens = finiteField(event.playback ?? {}, 'reopens');
    if (seenReopens !== null) {
      if (reopens !== null && seenReopens !== reopens) push(failures, 'playback-reopened');
      reopens = seenReopens;
    }
    const seenEpoch = finiteField(event.timeline ?? {}, 'epochMs');
    if (seenEpoch !== null) {
      if (epochMs !== null && seenEpoch !== epochMs) push(failures, 'timeline-epoch-changed');
      epochMs = seenEpoch;
    }
  }
  return { continuous: failures.length === 0, failures, startupEvents: startup, inWindowEvents: inside, reopens, epochMs };
}

/**
 * One arm's whole evidence block, from its raw events.
 *
 * The live path and the offline replay both call THIS function, on the objects
 * held in memory and on the lines read back off disk. Structural equality of
 * the two results is what makes the retained bytes the record: a distinction
 * lost in serialisation shows up as a disagreement instead of agreeing with
 * itself on both sides.
 *
 * Evidence qualification and candidate behaviour are kept apart throughout. A
 * refusal below names an instrument, never a controller.
 */
export function analyseArm({
  arm,
  buildId,
  events,
  drainReadTimesMs = [],
  window,
  fixtureFps,
  conflictingDuplicates = [],
  collectorState = null,
  recorderMissed = null,
  timeOriginMs = 0,
  schedulingCadence = null,
  // The three inputs V2 required be supplied rather than defaulted: what the
  // page said it had produced, how far Node acknowledged, and the recorder's
  // own independent drain of the product log.
  producedThrough = null,
  acknowledgedThrough = null,
  records = null,
  identity = null,
}) {
  const stream = checkEventStream(events, { arm, buildId, conflictingDuplicates });
  const polls = joinPolls(events, { timeOriginMs });
  const callbacks = joinCallbacks(events);
  const inWindow = (row) => row.atMs !== null && row.atMs >= window.startMs && row.atMs < window.endMs;
  const capturePolls = polls.rows.filter(inWindow);
  const ratePoints = rateTimeline(events);

  const failures = [...stream.failures, ...polls.failures, ...polls.snapshotFailures, ...callbacks.failures];
  // A window with poll EVENTS but no poll inside it is not an idle controller:
  // it is the two clocks having been read as one. Nothing downstream can tell
  // an empty population from a quiet one, so the emptiness is the finding.
  if (capturePolls.length === 0 && polls.rows.length > 0) push(failures, 'no-polls-inside-the-capture-window');
  // NULL, NOT ZERO, WHERE A POLL DID NOT SAY. One unmeasured intake makes the
  // arm's loss unmeasured; summing it as zero is the favourable missing value.
  const unmeasuredIntake = capturePolls.some((row) => row.intake === null ? !row.intakeExempt : row.intake.missed === null);
  const controllerMissed = unmeasuredIntake ? null : capturePolls.reduce((total, row) => total + (row.intake?.missed ?? 0), 0);
  if (controllerMissed === null) push(failures, 'controller-intake-unmeasured');
  else if (controllerMissed > 0) push(failures, 'controller-intake-loss');
  if (recorderMissed === null) push(failures, 'recorder-intake-unmeasured');
  else if (recorderMissed > 0) push(failures, 'recorder-intake-loss');
  if (collectorState === null) push(failures, 'collector-state-absent');
  if (collectorState?.fatal) push(failures, `collector-${collectorState.fatal.reason}`);
  if (collectorState !== null && collectorState.lost > 0) push(failures, 'collector-events-lost');

  const frontier = producedThrough === null ? null : accountForProducedIds({ events, produced: producedThrough });
  if (frontier === null) push(failures, 'producer-frontier-not-declared');
  else if (!frontier.complete) push(failures, 'events-missing-against-the-producer-frontier');

  const coverage = frameCoverage({ callbacks: callbacks.rows, ratePoints, ...window, fixtureFps });
  const qualification = callbackQualification({ callbacks: callbacks.rows, ...window, fixtureFps });
  const continuity = playbackContinuity({ events, ...window });
  const writes = nativeWriteAgreement({ rows: capturePolls, events });
  const ceiling = stoppingCeilingAudit(capturePolls);
  const agreement = records === null ? null : recordAgreement({ records, callbacks: callbacks.rows });
  const constructions = events.filter((event) => event.kind === 'construction');
  const factories = {};
  for (const event of constructions) factories[event.factory] = (factories[event.factory] ?? 0) + 1;
  // One controller, one sampler and one log. A second construction is the
  // duplicate-authority failure, and it is counted rather than inferred.
  for (const factory of ['createDriftController', 'createFrameSampler', 'createDriftLog']) {
    if ((factories[factory] ?? 0) !== 1) push(failures, `construction-count-${factory}`);
  }
  const dwell = freshDwellAudit({ rows: capturePolls, evidenceComplete: stream.complete && polls.complete });
  const analysedThroughEventId = Math.max(0, ...events.filter((event) => Number.isFinite(event?.atMs) && event.atMs < window.endMs).map((event) => event.eventId ?? 0));
  const conditions = necessaryConditions({
    arm, buildId, stream, polls, callbacks, coverage, qualification, continuity, writes, dwell,
    ceiling, frontier, recordAgreement: agreement, identity, factories, collectorState,
    controllerMissed, recorderMissed, capturePollCount: capturePolls.length,
    acknowledgedThrough, analysedThroughEventId,
  });

  return {
    arm,
    buildId,
    window,
    // Published, because every poll time below was put on the window's clock
    // with it and a replay cannot recover it from the events alone.
    timeOriginMs,
    evidence: {
      // DECIDED BY THE ENUMERATION AND BY NOTHING ELSE. The flat failure list
      // below stays as the reader's index of what went wrong; it is no longer
      // a second, shorter definition of what qualifying means.
      qualified: conditions.qualified,
      failures: [...failures, ...coverage.failures, ...writes.failures],
      conditions: conditions.conditions,
      failedConditions: conditions.failed,
      refusedConditions: conditions.refused,
      unavailableConditions: conditions.unavailable,
      events: stream.events,
      counts: stream.counts,
      controllerMissedRecords: controllerMissed,
      recorderMissedRecords: recorderMissed,
      collector: collectorState,
      producerFrontier: frontier,
      acknowledgedThrough,
      analysedThroughEventId,
      recordAgreement: agreement,
      identity,
    },
    seamProofs: seamProofsOf(conditions),
    factories,
    polls: { count: capturePolls.length, complete: polls.complete, gaps: intervals(capturePolls.map((row) => row.atMs)) },
    callbacks: { count: callbacks.rows.filter(inWindow).length, complete: callbacks.complete, arrivals: intervals(callbacks.rows.filter(inWindow).map((row) => row.atMs)) },
    // The spacing of the browser's own expectedDisplayTime values. rVFC fires
    // once per PRESENTED FRAME, so at 24 fps content this is about 24 per
    // second whatever the compositor is doing — it is a media cadence and NOT
    // a refresh rate. The compositor's own cadence is the passive rAF series
    // beside it, and where that is absent it is absent rather than inferred.
    frameCallbackDisplayIntervals: intervals(callbacks.rows.filter(inWindow).map((row) => row.expectedDisplayTime)),
    schedulingCadence: schedulingCadence === null
      ? { measured: false, note: 'no passive requestAnimationFrame series was taken; display cadence is unmeasured, not 60 Hz' }
      : { measured: true, note: 'passive requestAnimationFrame series — browser scheduling cadence, not hardware refresh certainty', ...schedulingCadence },
    coverage,
    drainCoverage: drainSlotCoverage({ drainTimesMs: drainReadTimesMs, ...window }),
    qualification,
    continuity,
    writes,
    stoppingCeiling: ceiling,
    dwell,
    settledInStartup: polls.rows.some((row) => !inWindow(row) && isObject(row.snapshot) && row.snapshot.mode === 'settled'),
  };
}

/**
 * The first 125 ms seam sample showing the page open and the element actually
 * playing. IT IS A SAMPLING BOUND, NOT AN INSTANT: the preceding sample is
 * retained beside it, and the pair is how much is known about when playback
 * physically began.
 */
export function observedPlaybackStart(events) {
  const samples = events.filter((event) => event.kind === 'seam-sample').sort((a, b) => a.atMs - b.atMs);
  for (const [index, sample] of samples.entries()) {
    const playing = classifyField(sample.playback ?? {}, 'playing').value === true;
    const paused = classifyField(sample.media ?? {}, 'paused').value;
    const readyState = finiteField(sample.media ?? {}, 'readyState');
    const epochMs = finiteField(sample.timeline ?? {}, 'epochMs');
    if (playing && paused === false && readyState !== null && readyState >= 2 && epochMs !== null) {
      return {
        found: true,
        atMs: sample.atMs,
        eventId: sample.eventId,
        precedingSampleAtMs: index > 0 ? samples[index - 1].atMs : null,
        uncertaintyMs: index > 0 ? sample.atMs - samples[index - 1].atMs : null,
        epochMs,
      };
    }
  }
  return { found: false, atMs: null, eventId: null, precedingSampleAtMs: null, uncertaintyMs: null, epochMs: null };
}
