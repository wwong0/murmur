// Raw browser-event validation, provenance and joins. No measurements or verdict policy.
import { SCHEMA_VERSION, EVENT_KINDS, classifyField, finiteField } from '../remedy-browser-page.mjs';

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
 * Did the run collect every id the page issued?
 *
 * The page numbers an event before anything about it can fail, so a produced id
 * with no event delivered is a real hole. A LOSSLESS DELAYED DRAIN IS NOT ONE:
 * every id is still there, just later than its slot. Contiguity says nothing
 * about the far end, which is why the producer's own count is required.
 */
export function accountForProducedIds({ events, produced, readerTakesItsOwnSeam = false }) {
  const seen = new Set(events.map((event) => event.eventId));
  const missing = [];
  for (let id = 1; id <= produced; id += 1) if (!seen.has(id)) missing.push(id);
  // The frontier is frozen BEFORE the tail drain, and every drain takes a seam
  // sample of its own, so a tail that needs a pass delivers one id past the
  // frontier it was draining toward. That is the reader's own footprint, not a
  // hole, and it is admitted only when the caller says its reader works that
  // way and only for events that really are seam samples -- anything else past
  // the frontier still fails, as does any id the frontier named and no drain
  // brought back.
  const beyond = events.filter((event) => event.eventId > produced);
  const beyondIsTheReadersOwnSeam = beyond.every((event) => event.kind === 'seam-sample');
  return {
    produced,
    delivered: seen.size,
    missing: missing.slice(0, 16),
    missingCount: missing.length,
    beyondFrontier: beyond.map((event) => event.eventId).slice(0, 16),
    beyondFrontierCount: beyond.length,
    complete: missing.length === 0 && (readerTakesItsOwnSeam
      ? beyondIsTheReadersOwnSeam
      : seen.size === produced),
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
  return {
    rows,
    complete: failures.length === 0,
    failures,
    samplerProvenance: samplerProvenance(rows),
  };
}

/**
 * The reads each derivation path actually reaches, in order (`frame-drift.mjs`).
 *
 * `now()` is handed in and is read on every path. `clock.read` is reached only
 * once the frame's own metadata is finite and not foreign; the timeline only
 * once the clock returned a finite offset. REQUIRING THREE READS OF EVERY
 * CALLBACK WOULD FAIL A LEGITIMATE EARLY REFUSAL for reads its path never made.
 */
export const SAMPLER_READS_BY_PATH = Object.freeze({
  accepted: ['now', 'clock.read', 'timeline.mediaMsAt'],
  mediaTimeNotFinite: ['now'],
  displayTimeNotFinite: ['now'],
  displayTimeForeign: ['now'],
  noClock: ['now', 'clock.read'],
  noEpoch: ['now', 'clock.read', 'timeline.mediaMsAt'],
});

/**
 * Whether the retained sampler reads are an observation of the derivation.
 *
 * PRESENCE OF THE ARRAY IS NOT THE OBSERVATION. `samplerReads: []` passes every
 * test that asks whether the reads were recorded and carries nothing, so each
 * array is checked against the path its own outcome took: the named inputs in
 * order, each with the arguments it was called with and the result it returned.
 */
export function samplerProvenance(rows) {
  const malformed = [];
  let withReads = 0;
  let validated = 0;
  for (const row of rows) {
    if (!Array.isArray(row.samplerReads)) continue;
    withReads += 1;
    const expected = SAMPLER_READS_BY_PATH[row.accepted ? 'accepted' : row.refusalReason] ?? null;
    if (expected === null) {
      malformed.push({ callbackId: row.callbackId, reason: `no read path is declared for ${row.refusalReason ?? 'this outcome'}` });
      continue;
    }
    const reason = readsDisagree(row.samplerReads, expected);
    if (reason === null) validated += 1;
    else malformed.push({ callbackId: row.callbackId, reason });
  }
  return {
    callbacks: rows.length,
    withReads,
    validated,
    malformed,
    complete: rows.length > 0 && validated === rows.length,
    inputs: [...new Set(rows.flatMap((row) => (Array.isArray(row.samplerReads) ? row.samplerReads : []).map((read) => read?.input)))],
  };
}

/** Why one callback's reads are not the derivation its outcome required, or
 *  null where they are. The first disagreement is the one reported. */
function readsDisagree(reads, expected) {
  if (reads.length === 0) return 'the reads array is empty';
  if (reads.length !== expected.length) return `${reads.length} read(s) recorded where this path takes ${expected.length}`;
  for (const [index, read] of reads.entries()) {
    if (!isObject(read)) return `read ${index} is not an observation`;
    if (read.input !== expected[index]) return `read ${index} is ${read.input ?? 'unnamed'} where this path reads ${expected[index]}`;
    if (!Array.isArray(read.args)) return `read ${index} (${expected[index]}) recorded no argument list`;
    if (!Object.hasOwn(read, 'result')) return `read ${index} (${expected[index]}) recorded no result`;
  }
  return null;
}

const refusalOf = (offer) => {
  const derived = classifyField(offer, 'derived');
  if (derived.presence !== 'value' || !isObject(derived.value) || derived.value.ok) return null;
  return derived.value.reason ?? 'unnamed-refusal';
};
