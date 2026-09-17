// scripts/check/suites/start-timing.mjs
//
// The scheduled-start diagnostic's arithmetic, over constructed cases whose
// expected values are computed by hand in the fixture below rather than by a
// second copy of the code under test. Pure — no server, no browser.
//
// One pair per gate, differing in the single figure that gate reads, and the
// keys that differ between each pair are asserted rather than assumed (R6).

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { createStartTelemetry } from '../../../public/lib/start-telemetry.mjs';
import {
  CONDITIONS, PHASES, ADVANCE_CLAMP_MS, AGGREGATE_BAND_MS, MAX_UNCERTAINTY_MS,
  uncertaintyMs, decisionToleranceMs, joinFrames, reduceStart, reduceCapture, reduceLattice,
  captureBoundary, startSatisfied, progressExpression,
  probeHostExpression, probeStateExpression, probeSeekExpression, latticeExpression,
  rateShimScript, rateShimStateExpression,
} from '../../start-timing.mjs';

const FRAME_INTERVAL_MS = 40;
const DISPLAY_CADENCE_MS = 16;
const HALF_WIDTH_MS = 4;
// U = 16/2 + 40/2 + 4.
const U = 32;

const S_MS = 1_000_000;
const PARK_MS = 60_000;
const OFFSET_MS = 500;
const EPOCH_MS = 940_000;
const CLOCK = Object.freeze({ offsetMs: OFFSET_MS, halfWidthMs: HALF_WIDTH_MS, delayTermMs: 3, ageTermMs: 1, sampleCount: 8 });
const HEAD = Object.freeze({
  atLocalMs: 999_000, atSharedMs: 999_500, clockOffsetMs: OFFSET_MS, clockHalfWidthMs: HALF_WIDTH_MS,
  attemptId: 7, lineage: 'L', version: 1, absentFields: Object.freeze([]),
});

/**
 * One start, worked through in shared milliseconds:
 *   S = 1_000_000, dispatch at local 999_505 with offset 500 → dispatchMs = 5
 *   returns at 999_507 → callDurationMs = 2; settles at 999_515 → settleMs = 8
 *   paused frame PTS 59_980 → pausedSnapErrorMs = −20
 *   first playing frame PTS 60_010 → snapErrorMs = 10, mediaAdvanceMs = 30
 *   its display instant 1_000_050 → displayMinusSMs = 50
 *   epoch 940_000 → scheduledMedia 60_050, so every driftMs = −40
 *   and driftMs − ((60_010 − 60_000) − 50) = 0, the identity residual.
 */
function buildStart(edit = {}) {
  const {
    telemetry = { missed: 0, droppedDelta: 0 }, nativeRateReadback = 1, retargetsSecond = 0,
    readinessSharedMs = S_MS - 100, requestedTargetMs = PARK_MS, frameCount = 72,
    dropRecordKey = false, duplicateFrameKey = false, absentKey = null, slopeFactor = 1,
    keep = false,
    // The treated run's two extra inputs: what the page applied, and what the
    // reducer was told to require. The baseline leaves both at their defaults.
    advanceMs = 0, expectedAdvanceMs = null,
  } = edit;

  let seq = 0;
  const events = [];
  const push = (kind, fields) => events.push(Object.freeze({ seq: (seq += 1), kind, ...HEAD, ...fields }));

  push('poll', { resolved: true, retargets: 0, opens: 1, begun: 0 });
  push('element-event', { type: 'canplay', readyState: 4, paused: true, offeredReadiness: true, observedSharedMs: readinessSharedMs });
  push('frame', { paused: true, presentedFrames: 1000, mediaTimeMs: 59_980, expectedDisplayTimeMs: 999_400, timeOriginMs: 0 });
  push('action', { action: 'load', positionMs: PARK_MS + advanceMs, scheduledPositionMs: PARK_MS, advanceMs });
  push('action', {
    action: 'play', positionMs: PARK_MS + advanceMs, scheduledPositionMs: PARK_MS, advanceMs, startAtSharedMs: S_MS,
    latenessMs: 0, dispatchedAtLocalMs: 999_505, returnedAtLocalMs: 999_507, elementPausedBefore: true, threw: null,
  });
  push('play-settled', { outcome: 'resolved', errorName: null, settledAtLocalMs: 999_515, settledSharedMs: 1_000_015 });
  push('rate-write', { commandedRate: 1, readbackRate: 1, appliedOk: null });

  const records = [];
  for (let k = 0; k < frameCount; k += 1) {
    const presentedFrames = 1001 + k;
    const mediaMs = 60_010 + FRAME_INTERVAL_MS * k * slopeFactor;
    const displaySharedMs = 1_000_050 + FRAME_INTERVAL_MS * k;
    push('frame', {
      paused: false, commandedRate: 1, timeOriginMs: 0, mediaTimeMs: mediaMs,
      presentedFrames: duplicateFrameKey && k === 1 ? 1001 : presentedFrames,
      expectedDisplayTimeMs: displaySharedMs - OFFSET_MS,
      absentFields: absentKey && k === 0 ? Object.freeze([absentKey]) : HEAD.absentFields,
    });
    if (k === 0) push('rate-write', { commandedRate: 1, readbackRate: 1, appliedOk: null });
    records.push({
      seq: 101 + k, epochMs: EPOCH_MS, mediaMs, displaySharedMs,
      scheduledMediaMs: displaySharedMs - EPOCH_MS, driftMs: mediaMs - (displaySharedMs - EPOCH_MS),
      presentedFrames: dropRecordKey && k === 3 ? null : presentedFrames, clock: CLOCK,
    });
  }
  push('poll', { resolved: true, retargets: retargetsSecond, opens: 1, begun: 1 });

  if (keep) return { events, records };
  return reduceStart({
    label: 'resume-0', condition: 'resume', phase: 0, requestedTargetMs, events, records,
    start: { afterSeq: 100 }, nextAfterSeq: Infinity,
    frameIntervalMs: FRAME_INTERVAL_MS, latticeOffsetMs: 0, telemetry, nativeRateReadback,
    expectedAdvanceMs,
  });
}

/** A reduced start's summary, the only shape `reduceCapture` reads. */
function makeStart(overrides = {}) {
  const { medianMs = -40, ...rest } = overrides;
  return {
    label: 'x', condition: 'resume', phase: 0, dispatchMs: 5, maxHalfWidthMs: HALF_WIDTH_MS,
    residual: { status: 'met', medianMs, count: 24 },
    // Stationarity is defined against the median, so these move with it.
    earlyMs: medianMs, lateMs: medianMs, tailMs: medianMs, unusable: [],
    ...rest,
  };
}

const baseline = ({ all = {}, at = {} } = {}) => CONDITIONS.flatMap((condition, ci) => PHASES.map((phase, pi) => {
  const index = ci * PHASES.length + pi;
  return makeStart({ label: `${condition}-${phase}`, condition, phase, ...all, ...(at[index] ?? {}) });
}));

const capture = (starts, overrides = {}) => reduceCapture({
  starts, frameIntervalMs: FRAME_INTERVAL_MS, displayCadenceMs: DISPLAY_CADENCE_MS, ...overrides,
});

/** Every dotted path whose leaf differs, with array indices collapsed away. */
function differingKeys(left, right, prefix = '') {
  const paths = [];
  for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    const path = Array.isArray(left) ? prefix : (prefix ? `${prefix}.${key}` : key);
    const a = left?.[key];
    const b = right?.[key];
    if (a && b && typeof a === 'object' && typeof b === 'object') paths.push(...differingKeys(a, b, path));
    else if (!Object.is(a, b)) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

const gateOf = (result, name) => result.gates.find((entry) => entry.name === name) ?? null;

/**
 * The same start again, in the order a `load` really records it — the park is
 * hls.js's `startPosition` on the paused load, so it PRECEDES the frame it
 * presents and the readiness that follows it — recorded into a real telemetry
 * ring. `read(cursor)` is then the window the runner actually drains, not a
 * second copy of it, and `prologue` is a previous start already in the ring.
 */
function ringStart({ firstReadAfter = () => false, prologue = false } = {}) {
  const telemetry = createStartTelemetry({ enabled: true, now: () => 999_000 });
  const context = { nowSharedMs: 999_500, clockOffsetMs: OFFSET_MS, clockHalfWidthMs: HALF_WIDTH_MS, attemptId: 7, lineage: 'L', version: 1 };
  let recorded = 0;
  let firstRead = null;
  const push = (kind, fields) => {
    telemetry.record(kind, fields, context);
    recorded += 1;
    if (firstRead === null && firstReadAfter(kind, fields)) firstRead = recorded;
  };
  const park = (positionMs) => push('action', { action: 'load', positionMs, scheduledPositionMs: positionMs, advanceMs: 0 });
  const play = (startAtSharedMs) => push('action', {
    action: 'play', positionMs: PARK_MS, scheduledPositionMs: PARK_MS, advanceMs: 0, startAtSharedMs,
    latenessMs: 0, dispatchedAtLocalMs: 999_505, returnedAtLocalMs: 999_507, elementPausedBefore: true, threw: null,
  });

  if (prologue) {
    park(PARK_MS - 5000);
    push('frame', { paused: true, presentedFrames: 900, mediaTimeMs: PARK_MS - 5020, expectedDisplayTimeMs: 990_000, timeOriginMs: 0 });
    push('element-event', { type: 'canplay', readyState: 4, paused: true, offeredReadiness: true, observedSharedMs: S_MS - 10_000 });
    play(S_MS - 9000);
    push('play-settled', { outcome: 'resolved', errorName: null, settledAtLocalMs: 990_015, settledSharedMs: 991_015 });
  }
  const armedAt = recorded;

  push('poll', { resolved: true, retargets: 0, opens: 1, begun: prologue ? 1 : 0 });
  park(PARK_MS);
  push('frame', { paused: true, presentedFrames: 1000, mediaTimeMs: 59_980, expectedDisplayTimeMs: 999_400, timeOriginMs: 0 });
  push('element-event', { type: 'canplay', readyState: 4, paused: true, offeredReadiness: true, observedSharedMs: S_MS - 100 });
  play(S_MS);
  push('play-settled', { outcome: 'resolved', errorName: null, settledAtLocalMs: 999_515, settledSharedMs: 1_000_015 });

  const records = [];
  for (let k = 0; k < 72; k += 1) {
    const presentedFrames = 1001 + k;
    const mediaMs = 60_010 + FRAME_INTERVAL_MS * k;
    const displaySharedMs = 1_000_050 + FRAME_INTERVAL_MS * k;
    push('frame', {
      paused: false, commandedRate: 1, timeOriginMs: 0, mediaTimeMs: mediaMs, presentedFrames,
      expectedDisplayTimeMs: displaySharedMs - OFFSET_MS,
    });
    records.push({
      seq: 101 + k, epochMs: EPOCH_MS, mediaMs, displaySharedMs,
      scheduledMediaMs: displaySharedMs - EPOCH_MS, driftMs: mediaMs - (displaySharedMs - EPOCH_MS),
      presentedFrames, clock: CLOCK,
    });
  }
  push('poll', { resolved: true, retargets: 0, opens: 1, begun: 1 });

  const reduceAt = (cursor) => reduceStart({
    label: 'load-0', condition: 'load', phase: 0, requestedTargetMs: PARK_MS,
    events: telemetry.read(cursor).events, records, start: { afterSeq: 100 }, nextAfterSeq: Infinity,
    frameIntervalMs: FRAME_INTERVAL_MS, latticeOffsetMs: 0,
    telemetry: { missed: 0, droppedDelta: 0 }, nativeRateReadback: 1,
  });
  return { telemetry, records, firstRead, armedAt, latestSeq: recorded, reduceAt };
}

/** One in-page expression, run against a page this file builds. */
const evaluateExpression = (source, app) => new Function('window', `return ${source};`)({ __app: app });

export default async function startTimingSuite() {
  await check('start timing: U is half a content interval plus half a refresh plus the clock half-width', async () => {
    assertNear(uncertaintyMs({ displayCadenceMs: 16.667, frameIntervalMs: 41.667, maxHalfWidthMs: 4 }), 33.167, 1e-9, 'worked by hand');
    assertEqual(uncertaintyMs({ displayCadenceMs: DISPLAY_CADENCE_MS, frameIntervalMs: FRAME_INTERVAL_MS, maxHalfWidthMs: HALF_WIDTH_MS }), U, 'the suite constant');
    assertEqual(uncertaintyMs({ displayCadenceMs: Number.NaN, frameIntervalMs: 40, maxHalfWidthMs: 4 }), null, 'a missing cadence is null, not a default');
    assertEqual(uncertaintyMs({ displayCadenceMs: 16, frameIntervalMs: 40, maxHalfWidthMs: null }), null, 'a missing half-width is null');

    assertEqual(decisionToleranceMs({ medians: [-40, -40], maxHalfWidthMs: 4 }), 4, 'Um floors at the clock half-width');
    assertEqual(decisionToleranceMs({ medians: [-50, -30], maxHalfWidthMs: 4 }), 10, 'and is half the span where the span is wider');
    assertEqual(decisionToleranceMs({ medians: [], maxHalfWidthMs: 4 }), null, 'no medians is null');
  });

  await check('start timing: frames join records on presentedFrames and nothing is silently dropped', async () => {
    const frame = (presentedFrames) => ({ kind: 'frame', presentedFrames });
    const record = (seq, presentedFrames) => ({ seq, presentedFrames });

    const clean = joinFrames({ events: [frame(1), frame(2), frame(3)], records: [record(10, 1), record(11, 3)] });
    assertEqual(clean.joined.length, 2, 'both records joined');
    assertEqual(clean.joined[0].frame.presentedFrames, 1, 'to the frame carrying their key');
    assertEqual(clean.unjoined.length + clean.duplicates.length, 0, 'nothing unjoined, nothing duplicated');

    const missing = joinFrames({ events: [frame(1)], records: [record(10, 1), record(11, 2)] });
    assertEqual(JSON.stringify(missing.unjoined), '[11]', 'a record with no frame is reported by seq');

    const nullKey = joinFrames({ events: [frame(1)], records: [record(10, null)] });
    assertEqual(JSON.stringify(nullKey.unjoined), '[10]', 'a record with no key cannot join');

    const dupFrames = joinFrames({ events: [frame(1), frame(1)], records: [record(10, 1)] });
    assertEqual(JSON.stringify(dupFrames.duplicates), '[1]', 'one key over two frames is named');
    assertEqual(JSON.stringify(dupFrames.unjoined), '[10]', 'and its record is refused, not matched to the first');

    const dupRecords = joinFrames({ events: [frame(1)], records: [record(10, 1), record(11, 1)] });
    assertEqual(JSON.stringify(dupRecords.duplicates), '[1]', 'one key over two records is named too');
    assertEqual(JSON.stringify(dupRecords.unjoined), '[11]', 'and the second record is refused');
  });

  await check('start timing: one start reduces to the figures worked out by hand', async () => {
    const start = buildStart();
    assertEqual(JSON.stringify(start.unusable), '[]', 'the constructed start is usable');
    assertEqual(start.requestedParkMs, PARK_MS, 'requested park');
    assertEqual(start.scheduledParkMs, PARK_MS, 'scheduled park');
    assertEqual(start.advanceMs, 0, 'advance is zero before task 12');
    assertEqual(start.S, S_MS, 'S is the action\'s own start instant');
    assertEqual(start.dispatchMs, 5, 'dispatch = 999_505 + 500 − 1_000_000');
    assertEqual(start.callDurationMs, 2, 'call duration = 999_507 − 999_505');
    assertEqual(start.settleMs, 8, 'settle = 999_515 − 999_507');
    assertEqual(start.pausedFramePtsMs, 59_980, 'the frame the park presented');
    assertEqual(start.pausedSnapErrorMs, -20, 'which sits 20ms before the requested position');
    assertEqual(start.snapErrorMs, 10, 'the first playing frame sits 10ms after it');
    assertEqual(start.mediaAdvanceMs, 30, 'and 30ms after the paused one');
    assertEqual(start.displayMinusSMs, 50, 'its display instant is 50ms after S');
    assertEqual(start.achievedPhase, 0, 'the park lands on the lattice');
    assertEqual(start.identityResidualMs, 0, 'the drift identity closes exactly');
    assertEqual(start.residual.medianMs, -40, 'D11 residual over its own 24');
    assertEqual(start.residual.count, 24, 'and its population is untouched');
    assertEqual(start.residual.status, 'met', 'inside one content interval');
    assertEqual(`${start.earlyMs},${start.lateMs},${start.tailMs}`, '-40,-40,-40', 'early, late and tail agree');
    assertNear(start.slope, 1, 1e-9, 'media advances one millisecond per display millisecond');
    assertEqual(start.maxHalfWidthMs, HALF_WIDTH_MS, 'the widest clock in the window');
    assertEqual(start.joinedCount, 72, 'all 72 records joined');
    assertEqual(JSON.stringify(start.commandedRates), '[1,1]', 'the rates commanded between play and the last joined frame');
    assertEqual(start.nativeRateReadback, 1, 'the element itself played at 1.0');
  });

  await check('start timing: the drift identity and the snap decomposition hold on every frame', async () => {
    const start = buildStart();
    const { records } = buildStart({ keep: true });
    for (const record of records) {
      const modelled = (record.mediaMs - start.scheduledParkMs) - (record.displaySharedMs - start.S);
      assertNear(record.driftMs, modelled, 1e-9, `the drift identity at record ${record.seq}`);
    }
    // Three separately non-zero terms — an identity that holds because both
    // sides are zero proves nothing.
    assert(start.snapErrorMs !== 0 && start.pausedSnapErrorMs !== 0 && start.mediaAdvanceMs !== 0, 'all three terms are non-zero');
    assertNear(start.snapErrorMs, start.pausedSnapErrorMs + start.mediaAdvanceMs, 1e-9, 'the snap decomposes into what the park chose and what ran through');
  });

  await check('start timing: a slope off unity refuses the start, and only a figure that is read can', async () => {
    assertEqual(JSON.stringify(buildStart({ slopeFactor: 1 }).unusable), '[]', 'media at exactly the display rate is usable');
    assertNear(buildStart({ slopeFactor: 1 }).slope, 1, 1e-9, 'and reports unity');
    assertEqual(JSON.stringify(buildStart({ slopeFactor: 1.0021 }).unusable), '["slope-off-unity"]', '2100 ppm fast is not');
    assertNear(buildStart({ slopeFactor: 1.0021 }).slope, 1.0021, 1e-9, 'and the measured slope is reported either way');
    assertEqual(JSON.stringify(buildStart({ slopeFactor: 1.0019 }).unusable), '[]', '1900 ppm is inside the bar');

    assertEqual(JSON.stringify(buildStart({ absentKey: 'expectedDisplayTime' }).unusable), '["absent:expectedDisplayTime"]', 'a frame without its display instant is refused');
    assertEqual(JSON.stringify(buildStart({ absentKey: 'processingDuration' }).unusable), '[]', 'but an absent processingDuration is not — no figure reads it');
  });

  await check('start timing: each sufficiency clause refuses by name, and holds at its own boundary', async () => {
    const reasons = (edit) => JSON.stringify(buildStart(edit).unusable);
    assertEqual(reasons({ telemetry: { missed: 1, droppedDelta: 0 } }), '["telemetry-missed"]', 'a telemetry gap');
    assertEqual(reasons({ telemetry: { missed: 0, droppedDelta: 1 } }), '["telemetry-dropped"]', 'an eviction during the window');
    assertEqual(reasons({ retargetsSecond: 1 }), '["retargets-moved"]', 'a retarget inside the attempt');
    assertEqual(reasons({ readinessSharedMs: S_MS + 1 }), '["readiness-after-S"]', 'readiness offered after S');
    assertEqual(reasons({ readinessSharedMs: S_MS }), '[]', 'readiness exactly at S is in time');
    assertEqual(reasons({ nativeRateReadback: 1.0001 }), '["native-rate-not-unity"]', 'the element was not pinned');
    assertEqual(reasons({ dropRecordKey: true }), '["join-unjoined"]', 'a record that cannot join');
    assertEqual(reasons({ duplicateFrameKey: true }), '["join-unjoined","join-duplicates"]', 'a key over two frames refuses both ways');
    assertEqual(reasons({ frameCount: 71 }), '["records-under-72"]', 'one frame short of the window');
    assertEqual(reasons({ frameCount: 72 }), '[]', 'exactly 72 is enough');
    assertEqual(reasons({ absentKey: 'presentedFrames' }), '["absent:presentedFrames"]', 'a frame naming a key it never had');
    assertEqual(reasons({ requestedTargetMs: PARK_MS + 0.001 }), '[]', 'a park at the tolerance holds');
    assertEqual(reasons({ requestedTargetMs: PARK_MS + 0.0011 }), '["park-off-target"]', 'and past it is refused');
  });

  await check('start timing: eight such starts advance, and the aggregate is the median of the medians', async () => {
    const starts = Array.from({ length: 8 }, (_, i) => ({
      ...buildStart(), label: `s${i}`, condition: CONDITIONS[i < 4 ? 1 : 0], phase: PHASES[i % 4],
    }));
    const result = capture(starts);
    assertEqual(result.verdict, 'ADVANCE', 'every gate holds');
    assertEqual(result.reason, null, 'with no sentinel');
    assertEqual(result.usableCount, 8, 'all eight usable');
    assertEqual(result.aggregate, -40, 'the median of eight −40s');
    assertEqual(result.advanceMs, 40, 'advance = round(40 × 10) / 10');
    assertEqual(result.U, U, 'U from this run\'s own cadence and clock');
    assertEqual(result.Um, HALF_WIDTH_MS, 'Um floors at the half-width when the medians agree');
    assertEqual(result.gates.map((entry) => entry.name).join(','), 'G0,U,G1,G2,G3,G4', 'the gates ran in §13\'s order');
    assert(result.gates.every((entry) => entry.held), 'and every one of them held');
    assertEqual(JSON.stringify(result.medians), JSON.stringify(Array(8).fill(-40)), 'ADVANCE carries the eight medians it came from');

    // The verdict is a name, never a figure, and it cannot be argued past G0.
    const verdicts = new Set(['ADVANCE', 'DISPATCH', 'SPREAD', 'NONSTATIONARY', 'INCONCLUSIVE']);
    assert(verdicts.has(result.verdict), 'the verdict is one of the five');
    const seven = capture(starts.slice(0, 7));
    assertEqual(seven.verdict, 'INCONCLUSIVE', 'seven usable starts decide nothing, whatever the figures say');
    assertEqual(seven.advanceMs, null, 'and propose nothing');
  });

  await check('start timing: G0 refuses the capture when one planned start is unusable', async () => {
    const held = baseline();
    const failed = baseline({ at: { 5: { unusable: ['telemetry-missed'] } } });
    assertEqual(JSON.stringify(differingKeys(held, failed)), '["unusable"]', 'the pair differs in one figure');
    assertEqual(capture(held).verdict, 'ADVANCE', 'eight usable starts advance');
    const result = capture(failed);
    assertEqual(result.verdict, 'INCONCLUSIVE', 'one unusable start is not a weaker answer');
    assertEqual(result.reason, 'S-DIAG-EVIDENCE', 'it is the evidence sentinel');
    assertEqual(result.usableCount, 7, 'and it reports how many survived');
    assertEqual(result.gates.length, 1, 'no later gate was consulted');
    assertEqual(JSON.stringify(gateOf(result, 'G0').inputs.unusable), '[{"label":"resume-0.25","reasons":["telemetry-missed"]}]', 'naming the start and why');
  });

  await check('start timing: the tolerance is itself bounded at 60ms', async () => {
    const starts = baseline();
    // U = cadence/2 + 20 + 4, so cadence 72 puts U exactly on the bound.
    const held = capture(starts, { displayCadenceMs: 72 });
    const failed = capture(starts, { displayCadenceMs: 72.002 });
    assertEqual(held.U, MAX_UNCERTAINTY_MS, 'U exactly at the bound');
    assertEqual(held.verdict, 'ADVANCE', 'and the capture still decides');
    assertNear(failed.U, 60.001, 1e-9, 'one hundredth of a refresh past it');
    assertEqual(failed.verdict, 'INCONCLUSIVE', 'refuses');
    assertEqual(failed.reason, 'S-CADENCE', 'as a cadence problem, not a regime one');
    assertEqual(failed.gates.length, 2, 'after G0 and before G1');
  });

  await check('start timing: G1 holds the aggregate inside the expected band, both ends', async () => {
    const [low, high] = AGGREGATE_BAND_MS;
    const at = (medianMs) => capture(baseline({ all: { medianMs } }));
    assertEqual(JSON.stringify(differingKeys(baseline({ all: { medianMs: high } }), baseline({ all: { medianMs: -14.9 } }))),
      '["earlyMs","lateMs","residual.medianMs","tailMs"]', 'the pair moves the median and what is defined against it');

    assertEqual(at(high).verdict, 'ADVANCE', 'exactly −15 is inside');
    assertEqual(at(high).advanceMs, 15, 'and advances by 15');
    assertEqual(at(-14.9).verdict, 'INCONCLUSIVE', '−14.9 is not');
    assertEqual(at(-14.9).reason, 'S-DIAG-REGIME', 'the regime sentinel');
    assertEqual(at(low).verdict, 'ADVANCE', 'exactly −60 is inside');
    assertEqual(at(low).advanceMs, 60, 'and advances by 60');
    assertEqual(at(-60.1).verdict, 'INCONCLUSIVE', '−60.1 is not');
    assertEqual(at(-40.06).advanceMs, 40.1, 'the advance is rounded to a tenth');
    assertEqual(JSON.stringify(ADVANCE_CLAMP_MS), '[0,250]', 'the clamp cannot bind inside the band, and is kept anyway');
  });

  await check('start timing: G2 refuses when the dispatch accounts for half the aggregate or more', async () => {
    const held = baseline({ all: { dispatchMs: 20 } });
    const failed = baseline({ all: { dispatchMs: 20.004 } });
    assertEqual(JSON.stringify(differingKeys(held, failed)), '["dispatchMs"]', 'the pair differs in the dispatch alone');
    assertEqual(capture(held).verdict, 'ADVANCE', '20 / 40 is exactly the share allowed');
    assertEqual(gateOf(capture(held), 'G2').inputs.share, 0.5, 'and the share is reported');
    const beyond = capture(failed);
    assertEqual(beyond.verdict, 'DISPATCH', 'a hair past it attributes the lag to the call');
    assertEqual(beyond.reason, 'S-DISPATCH', 'with the dispatch sentinel');
    assertEqual(beyond.advanceMs, null, 'and no advance is proposed');

    const early = capture(baseline({ all: { dispatchMs: -5.001 } }));
    assertEqual(early.verdict, 'DISPATCH', 'a dispatch more than 5ms early is refused by the floor');
    assertEqual(capture(baseline({ all: { dispatchMs: -5 } })).verdict, 'ADVANCE', 'exactly 5ms early is not');
  });

  await check('start timing: G3 holds every spread inside half a content interval', async () => {
    const bar = FRAME_INTERVAL_MS / 2;
    const held = baseline({ at: { 3: { medianMs: -40 + bar } } });
    const failed = baseline({ at: { 3: { medianMs: -40 + bar + 0.001 } } });
    assertEqual(JSON.stringify(differingKeys(held, failed)), '["earlyMs","lateMs","residual.medianMs","tailMs"]', 'one start moves');
    assertEqual(capture(held).verdict, 'ADVANCE', 'a spread exactly at the bar holds');
    assertEqual(gateOf(capture(held), 'G3').inputs.overall, bar, 'and the spread is reported');
    const wide = capture(failed);
    assertEqual(wide.verdict, 'SPREAD', 'one thousandth past it does not');
    assertEqual(wide.reason, 'S-ADVANCE-SPREAD', 'with the spread sentinel');
    assertEqual(wide.aggregate, -40, 'the aggregate is still reported for the record');

    const split = capture(baseline({ at: Object.fromEntries([4, 5, 6, 7].map((i) => [i, { medianMs: -40 + bar + 0.001 }])) }));
    assertEqual(split.verdict, 'SPREAD', 'a gap between the two conditions is the same refusal');
    assertNear(gateOf(split, 'G3').inputs.conditionGap, bar + 0.001, 1e-9, 'and it is the condition gap that is named');
  });

  await check('start timing: G4 refuses a start whose tail has walked away from its own median', async () => {
    const held = baseline({ at: { 2: { tailMs: -40 - U } } });
    const failed = baseline({ at: { 2: { tailMs: -40 - U - 0.001 } } });
    assertEqual(JSON.stringify(differingKeys(held, failed)), '["tailMs"]', 'the pair differs in the tail alone');
    assertEqual(capture(held).verdict, 'ADVANCE', 'a tail exactly U from the median holds');
    const drifted = capture(failed);
    assertEqual(drifted.verdict, 'NONSTATIONARY', 'past U it does not');
    assertEqual(drifted.reason, 'S-ADVANCE-UNRESOLVED', 'with the unresolved sentinel');
    assertEqual(gateOf(drifted, 'G4').inputs.U, U, 'judged against this run\'s own U');

    const swung = capture(baseline({ at: { 2: { earlyMs: -40 - U - 0.001 } } }));
    assertEqual(swung.verdict, 'NONSTATIONARY', 'early against late is the same refusal');
    assertEqual(capture(baseline({ at: { 2: { earlyMs: -40 - U } } })).verdict, 'ADVANCE', 'and it too holds exactly at U');
  });

  await check('start timing: the PTS lattice is measured, never assumed', async () => {
    const on = (count, offset) => Array.from({ length: count }, (_, i) => offset + FRAME_INTERVAL_MS * i);
    const clean = reduceLattice({ mediaTimeMs: on(48, 10), frameIntervalMs: FRAME_INTERVAL_MS });
    assertEqual(clean.latticeOffsetMs, 10, 'the offset the content actually sits at');
    assertEqual(clean.frameCount, 48, 'over the frames it saw');
    assertEqual(clean.dispersionMs, 0, 'with no dispersion');
    assertEqual(clean.usable, true, 'so it is usable');

    assertEqual(reduceLattice({ mediaTimeMs: on(47, 10), frameIntervalMs: FRAME_INTERVAL_MS }).usable, false, '47 frames is too few');

    const scattered = on(48, 10).map((value, i) => value + (i % 2 === 0 ? 0 : 11));
    const spread = reduceLattice({ mediaTimeMs: scattered, frameIntervalMs: FRAME_INTERVAL_MS });
    assertEqual(spread.dispersionMs, 11, 'a scattered lattice reports its width');
    assertEqual(spread.usable, false, 'and is refused past a quarter interval');
    assertEqual(reduceLattice({ mediaTimeMs: on(48, 10), frameIntervalMs: 0 }).usable, false, 'no interval, no lattice');

    // The real content, at the microsecond quantisation Chrome reports
    // `mediaTime` at: 125, 166.666, 208.333, 250, … Taken linearly, the values a
    // hair BELOW a lattice point wrap to nearly a whole interval and the lattice
    // reads as maximally dispersed. On the circle it is tight to a thousandth.
    const interval = 1000 / 24;
    const quantised = Array.from({ length: 60 }, (_, i) => Math.trunc(125_000 + i * interval * 1000) / 1000);
    const linear = quantised.map((value) => ((value % interval) + interval) % interval);
    assert(Math.max(...linear) - Math.min(...linear) > interval * 0.9, 'the linear remainders do span nearly the whole interval');
    const circular = reduceLattice({ mediaTimeMs: quantised, frameIntervalMs: interval });
    assert(circular.dispersionMs <= 0.002, `the circular dispersion is a quantisation step, got ${circular.dispersionMs}`);
    assertEqual(circular.usable, true, 'so the real content is usable');
    assert(circular.latticeOffsetMs < 0.002 || circular.latticeOffsetMs > interval - 0.002, 'and its lattice offset sits on the zero of the interval');

    // A genuinely split lattice still has no centre and is still refused.
    const split = Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? 10 : 10 + interval / 2) + interval * i);
    assertEqual(reduceLattice({ mediaTimeMs: split, frameIntervalMs: interval }).usable, false, 'two opposed lattices are not one lattice');
  });

  await check('start timing: the page probes name their own origin and build shared instants from the server\'s stamp', async () => {
    const syntax = (source) => {
      // eslint-disable-next-line no-new-func
      new Function(`return (${source})`);
      return true;
    };

    const host = probeHostExpression({ origin: 'http://127.0.0.1:8100' });
    assert(syntax(host), 'the host probe parses');
    assert(host.includes('"http://127.0.0.1:8100"'), 'and pins the origin it must be on');

    const state = probeStateExpression({ room: 'r1', lineage: 'lin-1', mapping: { mediaMs: 12_000, leadMs: 1200 } });
    assert(syntax(state), 'the state probe parses');
    assert(state.includes('recv + 1200'), 'its instant is the request\'s server stamp plus the lead');
    assert(!/Date\.now|performance\.now/.test(state), 'and no page clock is joined to the room\'s (R17)');
    assert(state.includes('throughSeq: state.lastSeq'), 'it answers through the highest room seq it has seen');
    assert(state.includes('"lin-1"') && state.includes('12000'), 'carrying the lineage and position asked for');

    const seek = probeSeekExpression({ room: 'r1', positionMs: 60_000, basis: 'b1', leadMs: 1200 });
    assert(syntax(seek), 'the seek probe parses');
    assert(seek.includes("'echo'") && seek.includes('echo-reply'), 'it learns a shared instant by echoing the server');
    assert(seek.includes('recv + 1200') && seek.includes('60000'), 'and seeks to the requested position at that instant plus the lead');
    assert(!/Date\.now|performance\.now/.test(seek), 'with no page clock in the join');

    // The server refuses any client envelope without a `payload`, and a probe
    // that is refused sits silently until its deadline. This is the assertion
    // that caught a `payload`-less echo during the qualification.
    for (const source of [state, seek]) {
      for (const sent of source.match(/ws\.send\(JSON\.stringify\(\{[^}]*\}/g) ?? []) {
        assert(sent.includes('payload'), `every envelope a probe sends carries a payload: ${sent}`);
      }
      assert(source.includes("env.type === 'error'"), 'and a refusal is reported rather than waited out');
    }

    const lattice = latticeExpression(17);
    assert(syntax(lattice), 'the lattice probe parses');
    assert(lattice.includes('startTiming?.(17)'), 'it reads from the cursor it was given');
    assert(lattice.includes('paused === false'), 'and takes only frames presented while playing');
  });

  await check('start timing: the rate shim pins the element and leaves the native readback reachable', async () => {
    // The script is RUN, against a prototype carrying a real accessor, because
    // what has to be true of it is behavioural: reading the source cannot show
    // that a write stopped short of the element.
    const install = (media) => {
      const element = new media();
      const window = {};
      // eslint-disable-next-line no-new-func
      new Function('HTMLMediaElement', 'document', 'performance', 'window', rateShimScript())(
        media, { querySelector: () => element }, { timeOrigin: 0, now: () => 5 }, window,
      );
      return { element, shim: window.__rateShim };
    };

    class Media {
      constructor() {
        this.rate = 1;
      }
    }
    Object.defineProperty(Media.prototype, 'playbackRate', {
      configurable: true,
      enumerable: true,
      get() { return this.rate; },
      set(value) { this.rate = value; },
    });

    const { element, shim } = install(Media);
    assertEqual(shim.installed, true, 'the shim installs over a real accessor');
    element.playbackRate = 1.05;
    assertEqual(shim.commanded(), 1.05, 'the commanded rate is recorded');
    assertEqual(element.playbackRate, 1.05, 'and read back, so the controller sees what it wrote');
    assertEqual(shim.nativeReadback(), 1, 'but the element itself never left 1.0');
    assertEqual(element.rate, 1, 'the native setter was not reached');
    assertEqual(shim.writes().length, 1, 'one write was seen');
    assertEqual(shim.writes()[0].value, 1.05, 'carrying the rate asked for');

    // And the pin is necessary: the same element moves when the native setter
    // IS reached, which is what the shim is standing in the way of.
    shim.nativeWrite(1.05);
    assertEqual(shim.nativeReadback(), 1.05, 'the native path still moves the element');
    assertEqual(shim.commanded(), 1.05, 'without disturbing the commanded rate');

    class Bare {}
    assertEqual(install(Bare).shim.installed, false, 'no accessor, no shim');
    assert(install(Bare).shim.reason.length > 0, 'and it says why rather than answering quietly');

    const state = rateShimStateExpression();
    // eslint-disable-next-line no-new-func
    new Function(`return (${state})`);
    assert(state.includes('installed: false'), 'the reading distinguishes an uninstalled shim from a silent one');
    assert(state.includes('nativeReadback'), 'and carries what the element itself is playing at');
  });

  await check('start timing: a fresh document is reduced from sequence zero, however much it recorded before the first read', async () => {
    // Already parked: the first read lands after the park, which is what the
    // 2026-09-17 baseline hit on two `load` starts.
    const parked = ringStart({ firstReadAfter: (kind, fields) => kind === 'action' && fields.action === 'load' });
    assertEqual(parked.firstRead, 2, 'the page had already parked when the runner first looked');

    const boundary = captureBoundary({ freshDocument: true, latestSeq: parked.firstRead, startCount: 1 });
    assertEqual(JSON.stringify(parked.reduceAt(boundary.cursor).unusable), '[]', 'the window this boundary opens holds the whole start');
    assertEqual(boundary.cursor, 0, 'because a fresh document opens at sequence zero');
    assertEqual(boundary.pick, 'first', 'and is about its first attempt');
    assertEqual(boundary.droppedBaseline, 0, 'with nothing before it to discount');

    // The behaviour that was repaired, reproduced exactly: the capture refused
    // `load-0.25` and `load-0.5` with these three reasons and no others.
    assertEqual(
      JSON.stringify(parked.reduceAt(parked.firstRead).unusable),
      JSON.stringify(['no-park-action', 'park-off-target', 'identity-residual']),
      'where a window opened at the first read loses the park it must measure',
    );

    // Already playing: the first read lands after playback has begun.
    const playing = ringStart({ firstReadAfter: (kind, fields) => kind === 'frame' && fields.paused === false });
    assertEqual(playing.firstRead, 7, 'the page was already playing when the runner first looked');
    assertEqual(JSON.stringify(playing.reduceAt(0).unusable), '[]', 'sequence zero still holds the whole start');
    const lost = playing.reduceAt(playing.firstRead).unusable;
    for (const reason of ['no-play-action', 'no-park-action', 'no-paused-frame', 'no-playing-frame']) {
      assert(lost.includes(reason), `a window opened there loses ${reason}`);
    }

    // And the wait is over a start that already exists, rather than one more.
    assertEqual(boundary.startsRequired, 1, 'the first attempt is the one waited for');
    assertEqual(startSatisfied(boundary, { startCount: 1, recordCount: 72, framesPerStart: 72 }), true, 'so an already-published start satisfies it');
    assertEqual(startSatisfied(boundary, { startCount: 1, recordCount: 71, framesPerStart: 72 }), false, 'but only once its records have filled');
    assertEqual(startSatisfied(captureBoundary({ startCount: 1 }), { startCount: 1, recordCount: 72, framesPerStart: 72 }), false, 'which the armed boundary refuses, because that start is the previous one');
  });

  await check('start timing: a start armed into a running page still opens after the action that opened it', async () => {
    const resumed = ringStart({ prologue: true });
    const boundary = captureBoundary({ freshDocument: false, latestSeq: resumed.armedAt, startCount: 1, dropped: 2 });
    assertEqual(JSON.stringify(resumed.reduceAt(boundary.cursor).unusable), '[]', 'the window this boundary opens holds this start and not the one before it');
    assertEqual(boundary.mode, 'before-action', 'because the resume condition keeps its before-action cursor');
    assertEqual(boundary.cursor, resumed.armedAt, 'at the sequence the page had published when it was armed');
    assertEqual(boundary.pick, 'last', 'and is about the start that appears after it');
    assertEqual(boundary.startsRequired, 2, 'so the start already on the page cannot satisfy the wait');
    assertEqual(boundary.droppedBaseline, 2, 'and eviction is counted from where the window opened');

    // Opening this window at zero would read the PREVIOUS start's park, 5s away.
    const fromZero = resumed.reduceAt(0);
    assertEqual(fromZero.requestedParkMs, PARK_MS - 5000, 'where a window opened at zero reads the previous park');
    assertEqual(JSON.stringify(fromZero.unusable), JSON.stringify(['park-off-target', 'identity-residual']), 'and the start is refused for it');
  });

  await check('start timing: the page reports the start the boundary names, first or last', async () => {
    const built = ringStart({});
    const starts = [
      { attemptId: 1, afterSeq: 100, startAtSharedMs: S_MS },
      { attemptId: 2, afterSeq: 160, startAtSharedMs: S_MS + 5000 },
    ];
    const page = {
      playback: () => ({ playing: true, opens: 1, begun: 1, retargets: 0, starts }),
      drift: (afterSeq) => ({ records: built.records.filter((record) => record.seq > afterSeq), missed: 0 }),
      startTiming: (cursor) => built.telemetry.read(cursor),
      timeline: () => ({ identity: { lineage: 'L', version: 1 } }),
      clock: () => ({ offsetMs: OFFSET_MS }),
    };

    const first = evaluateExpression(progressExpression(0, 'first'), page);
    assertEqual(first.chosen.attemptId, 1, 'a fresh document is reported by its first attempt');
    assertEqual(first.recordCount, 72, 'with the records that attempt accepted');
    assertEqual(first.latestSeq, built.latestSeq, 'and the whole ring behind it');

    const last = evaluateExpression(progressExpression(built.latestSeq, 'last'), page);
    assertEqual(last.chosen.attemptId, 2, 'an armed start is reported by the newest attempt');
    assertEqual(last.recordCount, 12, 'with only the records after that attempt');
    assertEqual(last.events, undefined, 'the progress read carries counts, not the stream');

    assertEqual(evaluateExpression(progressExpression(0, 'first'), null).present, false, 'a page with no seam says so rather than throwing');
    let threw = null;
    try {
      progressExpression(0, 'newest');
    } catch (error) {
      threw = error.message;
    }
    assert(threw !== null && threw.includes('newest'), 'and an unknown pick is refused by name, never defaulted');
  });

  // The treated run's own G0 clause (§13.1): a start that did not apply the
  // compiled advance is unusable, never a treated observation. The pairs below
  // differ in the advance alone (R6).
  await check('start timing: a treated start that did not apply the advance is unusable', async () => {
    const A = 1000 / 24;
    const untreated = buildStart({});
    assertEqual(JSON.stringify(untreated.unusable), '[]', 'the baseline start, asked for no advance, is usable');
    assertEqual(untreated.advanceMs, 0, 'and reports the advance it applied');

    const treated = buildStart({ advanceMs: A, expectedAdvanceMs: A });
    assertEqual(JSON.stringify(treated.unusable), '[]', 'a start that applied the advance it was asked for is usable');
    assertEqual(treated.advanceMs, A, 'and reports it');
    assertNear(treated.requestedParkMs - treated.scheduledParkMs, A, 0.001, 'the physical park is the room position plus the advance');
    assertEqual(treated.scheduledParkMs, untreated.scheduledParkMs, 'and the room position did not move');
    assertEqual(treated.residual.medianMs, untreated.residual.medianMs, 'the frozen residual reads the records, not the park');

    assertEqual(JSON.stringify(buildStart({ advanceMs: 0, expectedAdvanceMs: A }).unusable), JSON.stringify(['advance-not-applied', 'park-not-advanced']), 'an uncompensated start in a treated run is refused by name');
    assertEqual(JSON.stringify(buildStart({ advanceMs: A - 0.002, expectedAdvanceMs: A }).unusable), JSON.stringify(['advance-not-applied', 'park-not-advanced']), 'and so is one two thousandths short of it');
    assertEqual(JSON.stringify(buildStart({ advanceMs: A - 0.0005, expectedAdvanceMs: A }).unusable), '[]', 'half a thousandth is inside the tolerance');
  });
}
