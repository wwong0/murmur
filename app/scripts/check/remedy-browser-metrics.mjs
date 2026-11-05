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
  DRAIN_INTERVAL_MS,
  classifyField,
  finiteField,
} from '../remedy-browser-page.mjs';
import { checkEventStream, joinPolls, accountForProducedIds, recordAgreement, joinCallbacks } from './remedy-browser-events.mjs';
import { necessaryConditions, seamProofsOf } from './remedy-browser-conditions.mjs';
import { MAX_STOPPING_THRESHOLD_MS, SETTLED_FOR_MS } from '../../public/lib/drift-controller.mjs';

export {
  mergeBatches, checkEventStream, snapshotShape, joinPolls, accountForProducedIds,
  recordAgreement, joinCallbacks, SAMPLER_READS_BY_PATH, samplerProvenance,
} from './remedy-browser-events.mjs';
export { DRAIN_INTERVAL_MS, SETTLED_FOR_MS, MAX_STOPPING_THRESHOLD_MS };
export { NECESSARY_CONDITIONS, seamProofsOf } from './remedy-browser-conditions.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const push = (list, failure) => { if (!list.includes(failure)) list.push(failure); };

/** The existing headless callback-qualification predicates, carried unchanged
 *  from `verify-frames.mjs` rather than restated as new browser bars. */
export const MIN_CALLBACK_RATIO = 0.9;
export const MIN_ACCEPT_RATIO = 0.95;
/** The stage-B evidence bar, reported by stage A and never applied by it. */
export const PROPOSED_COVERAGE_RATIO = 0.95;

/**
 * The stopping-threshold ceiling, on every poll rather than on a helper.
 *
 * `dwellEligibility()` applies the ceiling to the polls a dwell walks over. A
 * poll outside any dwell run is never inspected by it, so a controller that
 * claimed a usable 999 ms threshold in a window that never settled passed
 * unexamined. This looks at all of them.
 *
 * THE CEILING IS A REFUSAL ONLY WHERE A FLOOR WAS ACCEPTED. For f > 0,
 * measurement plus allowance needing more room than the ceiling allows leaves
 * no threshold to accept. At f = 0 the shipped controller has no such branch,
 * and an accepted S above 20 ms is a poll that
 * cannot count toward a dwell — which `dwellEligibility()` already says —
 * rather than a broken contract. Counting it as one here would manufacture a
 * failure out of the approved design, so those polls are reported separately
 * and by name.
 *
 * WHICH FLOOR IS A FACT ABOUT THE ARM, NOT A FIELD IN THE SNAPSHOT. The
 * exception above is exactly what a research controller over the ceiling would
 * want a snapshot saying `MIN_COMMAND_DEVIATION: 0` to buy it, and reading the
 * operand out of the evidence being judged let it. The operand comes from the
 * arm predeclared before the run; each poll's own report is CHECKED against it
 * and is otherwise not consulted. A floor nobody declared, and a poll that
 * publishes none to confirm, are both undecidable rather than clean.
 */
export function stoppingCeilingAudit(rows, { ceilingMs = MAX_STOPPING_THRESHOLD_MS, policy = null } = {}) {
  const violations = [];
  const aboveCeilingAtZeroFloor = [];
  const undecidable = [];
  const misdeclaredFloors = [];
  const declaredFloor = finiteField(policy ?? {}, 'minCommandDeviation');
  let snapshots = 0;
  let withPublishedFloor = 0;
  let inspected = 0;
  for (const row of rows) {
    if (!isObject(row.snapshot)) continue;
    snapshots += 1;
    const threshold = finiteField(row.snapshot, 'stoppingThresholdMs');
    const published = finiteField(row.snapshot.settings ?? {}, 'MIN_COMMAND_DEVIATION');
    const where = { pollId: row.pollId, stoppingThresholdMs: threshold, atMs: row.atMs };
    if (published !== null) {
      withPublishedFloor += 1;
      if (declaredFloor !== null && published !== declaredFloor) misdeclaredFloors.push({ ...where, published, declared: declaredFloor });
    }
    if (row.snapshot.thresholdUsable !== true) continue;
    inspected += 1;
    // A usable threshold that is not a number is a defect at any floor: nothing
    // downstream can compare an estimate against it.
    if (threshold === null) { violations.push(where); continue; }
    if (threshold <= ceilingMs) continue;
    if (declaredFloor === null) { undecidable.push({ ...where, why: 'no floor was predeclared for this arm' }); continue; }
    if (published === null) { undecidable.push({ ...where, why: 'the poll published no floor to confirm the declared one against' }); continue; }
    if (published !== declaredFloor) { violations.push({ ...where, published, declared: declaredFloor }); continue; }
    if (declaredFloor > 0) violations.push({ ...where, floor: declaredFloor });
    else aboveCeilingAtZeroFloor.push(where);
  }
  return {
    inspected, ceilingMs, declaredFloor, declaredFactory: policy?.factory ?? null,
    snapshots, withPublishedFloor, confirmed: withPublishedFloor - misdeclaredFloors.length,
    violations, aboveCeilingAtZeroFloor, undecidable, misdeclaredFloors,
  };
}

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
export function drainSlotCoverage({ drainTimesMs, startMs, endMs, slotMs = DRAIN_INTERVAL_MS, slots = null }) {
  const expected = Math.max(0, Math.ceil((endMs - startMs) / slotMs));
  const covered = new Set();
  // BINNING READ TIMES DERIVES A SECOND GRID. It is anchored at the window
  // start, while the schedule is anchored where the schedule was created, and
  // the two are offset by whatever phase separates them. A recorder serving
  // every slot on time then lands a few ms from a boundary, and ordinary jitter
  // puts two reads in one bin and none in the next -- a run that served 1921
  // distinct slots with a worst lateness of 17 ms measured 92%. Where the
  // recorder retained the index of the slot it was serving, that index is the
  // answer, and a drain later than the slot is wide is not counted for it.
  if (Array.isArray(slots)) {
    for (const slot of slots) {
      if (!Number.isInteger(slot?.slotIndex)) continue;
      if (!Number.isFinite(slot.atMs) || slot.atMs < startMs || slot.atMs >= endMs) continue;
      if (!Number.isFinite(slot.latenessMs) || slot.latenessMs >= slotMs) continue;
      covered.add(slot.slotIndex);
    }
    return {
      expectedSlots: expected,
      coveredSlots: covered.size,
      coverage: expected > 0 ? covered.size / expected : null,
      countedBy: 'retained-slot-index',
    };
  }
  for (const atMs of drainTimesMs ?? []) {
    if (!Number.isFinite(atMs) || atMs < startMs || atMs >= endMs) continue;
    covered.add(Math.floor((atMs - startMs) / slotMs));
  }
  return { expectedSlots: expected, coveredSlots: covered.size, coverage: expected > 0 ? covered.size / expected : null, countedBy: 'read-time' };
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
export function nativeWriteAgreement({ rows, events, rateBeforeWindow = 1 }) {
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
  //
  // `rateBeforeWindow` is what the retained writes BEFORE this window left the
  // element at, and it defaults to unity -- a stage-A window opens at the
  // client's own playback start, so nothing can have written to the element
  // yet. A window that opens later has to be told, or the writes it did not
  // contain are read as the browser moving on its own.
  let expected = writes.length > 0 ? null : 1;
  let lastWritten = rateBeforeWindow;
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
  // `{ slotIndex, atMs, latenessMs }` where the recorder retained which slot
  // each drain was serving. Null keeps stage A binning its read times.
  drainSlots = null,
  // Stage A's recorder is judged as if nothing may follow the frozen frontier;
  // see `accountForProducedIds`.
  readerTakesItsOwnSeam = false,
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
  // What this arm was DECLARED to run, taken from the manifest written before
  // the browser opened. The ceiling audit needs a floor no snapshot can revise.
  armPolicy = null,
  // Unity unless the caller retained writes from before the window; see
  // `nativeWriteAgreement`. Stage A does not pass it and does not change.
  rateBeforeWindow = 1,
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

  const frontier = producedThrough === null ? null : accountForProducedIds({ events, produced: producedThrough, readerTakesItsOwnSeam });
  if (frontier === null) push(failures, 'producer-frontier-not-declared');
  else if (!frontier.complete) push(failures, 'events-missing-against-the-producer-frontier');

  const coverage = frameCoverage({ callbacks: callbacks.rows, ratePoints, ...window, fixtureFps });
  const qualification = callbackQualification({ callbacks: callbacks.rows, ...window, fixtureFps });
  const continuity = playbackContinuity({ events, ...window });
  const writes = nativeWriteAgreement({ rows: capturePolls, events, rateBeforeWindow });
  const ceiling = stoppingCeilingAudit(capturePolls, { policy: armPolicy });
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
    // The build's own declaration of what it instruments, so an absent
    // observation can be told from one this build never made.
    observes: identity?.observes ?? null,
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
    drainCoverage: drainSlotCoverage({ drainTimesMs: drainReadTimesMs, slots: drainSlots, ...window }),
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
