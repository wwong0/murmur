import { assert, assertEqual, check } from '../harness.mjs';
import { landingHostCopies, landingSegments, waitParts } from '../../figures/landing.mjs';
import { aheadForGood, doubleStalls } from '../../figures/ahead-for-good.mjs';
import { buildCheck, lengthRule } from '../../figures/length-rule.mjs';
import { leaveArmReading, rosterEventReading } from '../../figures/roster-event.mjs';
import { evaluateRefusals, excusedByRosterEvent } from '../../harness/refusals.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';
import { absoluteSeekExpression, issuedSeekEvidence, stepThenSeek } from '../../harness/seek-sequence.mjs';

const timebase = { offsetMs: 100, wallOffsetMs: 1_000 };
const pageAt = (sharedMs) => sharedMs + timebase.wallOffsetMs - timebase.offsetMs;
const rowOf = (rows, name) => rows.find((row) => row.row === name);
const okFive = (startWaits = [50], seekWaits = [60]) => ({ accepted: true,
  criterion2: true, criterion3: true, startRecovery: true, startWaits, seekWaits });

function drift(start, end, gaps = []) {
  const rows = [];
  let seq = 1;
  for (let at = start; at <= end; at += 250) {
    if (gaps.some(([from, to]) => at > from && at < to)) continue;
    rows.push({ displaySharedMs: at, seq, presentedFrames: seq });
    seq += 1;
  }
  return rows;
}

function hostPoll(fromMs, toMs) {
  return [{ sharedMs: fromMs, state: { playing: true } }, { sharedMs: toMs, state: { playing: true } }];
}

function rosterK0Input(runway) {
  const event = { kind: 'join', client: 'c02', tabId: 'c02', clientId: 'c02-old', observed: true,
    presence: { event: 'join', seq: 1, recvSharedMs: 10_000 } };
  const frames = { c01: drift(0, 70_000), c02: drift(10_000, 70_000) };
  const polls = { c01: [9_000, 10_000].map((atMs) => ({ harnessBeforeMs: atMs - 1, harnessAfterMs: atMs + 1,
    heldAhead: { ownHeldAheadMs: runway } })),
    host: [{ sharedMs: 10_000, state: { playing: true, held: false } }] };
  return { condition: { clients: 2, rosterEvent: { kind: 'join', client: 'c02' }, churn: {
    firstFrameMaxMs: 4_000, horizonMs: 15_000, runwayMinMs: 15_000,
    stall: { beforeMs: 1_000, afterMs: 1_000, gapMs: 250 }, resync: { windowMs: 1_000, medianMaxMs: 40, holdMs: 1_000, maxMs: 2_000 },
    fill: { overMs: 1_000, peerFractionMin: 0, hostBodiesMax: 0 },
  } }, event, presence: { c01: [{ event: 'join', seq: 1, tabId: 'c02' }] }, drift: frames, polls,
    attempts: { c02: [] }, segments: { c01: [], c02: [] }, asks: {}, starts: { c02: [] },
    timebase: { offsetMs: 0, wallOffsetMs: 0 }, content: { frameRate: 24 } };
}

function leaveEventReasons() {
  return ['client-never-began-playback', 'record-coverage-unavailable', 'dropped-frame-evidence-unavailable',
    'required-context-absent:stallCountByClient[c01]', 'required-context-absent:keptHostBytesByClient[c01]',
    'viewer-interface-evidence-unavailable', 'engine-windows-unavailable'];
}

function leaveFixture(records = [{ displaySharedMs: 10, presentedFrames: 1 }]) {
  return { condition: { rosterEvent: { kind: 'leave-clean' } }, event: { client: 'c01', presence: { recvSharedMs: 50 } },
    clients: { c01: { records } } };
}

function wideBandInput(bandMs) {
  const event = { kind: 'join', client: 'c03', tabId: 'c03', clientId: 'new', observed: true,
    presence: { event: 'join', seq: 1, recvSharedMs: 10_000 } };
  const presence = { c01: [{ event: 'join', seq: 1, tabId: 'c03' }], c02: [{ event: 'join', seq: 1, tabId: 'c03' }] };
  const make = (driftMs) => [0, 5_000, 10_000, 12_000, 15_000].map((displaySharedMs, index) => ({ displaySharedMs,
    driftMs, presentedFrames: index + 1, seq: index + 1 }));
  return { condition: { clients: 3, rosterEvent: { kind: 'join', client: 'c03' }, churn: { firstFrameMaxMs: 4_000,
    horizonMs: 2_000, resync: { windowMs: 1_000, medianMaxMs: 40, holdMs: 1_000, maxMs: 2_000 }, fill: { overMs: 1, peerFractionMin: 0, hostBodiesMax: 0 },
    runwayMinMs: 15_000, stall: { beforeMs: 1_000, afterMs: 1_000, gapMs: 250 } } }, event, presence,
    drift: { c01: make(0), c02: make(bandMs), c03: make(0) }, polls: { host: hostPoll(10_000, 15_000) },
    attempts: { c03: [] }, segments: { c01: [], c02: [], c03: [] }, asks: {}, starts: { c03: [] },
    timebase: { offsetMs: 0, wallOffsetMs: 0 }, content: { frameRate: 24 } };
}

export default async function segmentWaitSuite() {
  await check('T5 wait parts: shared timebase joins polls and reports D9 thresholds', async () => {
    const polls = {
      c01: [1_000, 2_000, 3_000, 4_000].map((heldAheadMs, index) => ({ heldAhead: { heldAheadMs,
        atPageMs: pageAt([1_250, 1_750, 2_250, 2_750][index]) } })),
      c02: [1_000, 2_000, 3_000, 4_000].map((heldAheadMs, index) => ({ heldAhead: { heldAheadMs,
        atPageMs: pageAt([1_250, 2_250, 2_750, 3_250][index]) } })),
    };
    const parts = waitParts({ holds: { start: { transitionSharedMs: 1_000, issuedAtSharedMs: 3_400, effectiveSharedMs: 3_700 } },
      declaredViewers: ['c01', 'c02'], viewerPolls: polls, timebase });
    // all-ready=max(2,750,3,250)=3,250; loading=3,250-1,000=2,250;
    // ready-to-issue=3,400-3,250=150; lead=3,700-3,400=300.
    assertEqual(parts.start.parts.loadingMs, 2_250, 'loading arithmetic');
    assertEqual(parts.start.parts.readyToIssueMs, 150, 'ready-to-issue arithmetic');
    assertEqual(parts.start.parts.leadMs, 300, 'lead arithmetic');
    // 11a-2 D9's latest polls are 1,250, 2,250 and 2,750; subtract transition 1,000.
    assertEqual(JSON.stringify(Object.values(parts.start.perViewer).map((entry) => [entry.thresholds[1000].waitMs,
      entry.thresholds[2000].waitMs, entry.thresholds[3000].waitMs])), '[[250,750,1250],[250,1250,1750]]', 'D9 waits');
  });

  await check('T5 wait boundaries: a >1,000 ms poll gap is unreadable', async () => {
    const polls = { c01: [{ heldAhead: { heldAheadMs: 4_000, atPageMs: pageAt(1_000) } },
      { heldAhead: { heldAheadMs: 4_000, atPageMs: pageAt(2_501) } }] };
    const parts = waitParts({ holds: { start: { transitionSharedMs: 1_000, issuedAtSharedMs: 3_400, effectiveSharedMs: 3_700 } },
      declaredViewers: ['c01'], viewerPolls: polls, timebase });
    assertEqual(parts.start.parts.status, 'unreadable', 'gap status');
    assertEqual(parts.start.parts.gap.gapMs, 1_501, 'gap arithmetic 2,501-1,000');
  });

  await check('T5 landing geometry: offsets and four-second segment sets are hand-computed', async () => {
    const atOne = landingSegments({ positionMs: 720_500, segmentSeconds: 1, segmentCount: 1_000 });
    const atSeven = landingSegments({ positionMs: 721_500, segmentSeconds: 7, segmentCount: 200 });
    // floor(720,500/1,000)=720, offset=500; [720,721,722,723,724] overlap [P,P+4,000).
    assertEqual(JSON.stringify([atOne.index, atOne.offsetMs, atOne.segmentsNeeded]), '[720,500,[720,721,722,723,724]]', '1s landing');
    // floor(721,500/7,000)=103, offset=500; the next start is 3,500 ms after P.
    assertEqual(JSON.stringify([atSeven.index, atSeven.offsetMs, atSeven.segmentsNeeded]), '[103,500,[103]]', '7s landing');
  });

  await check('T5 host copies: delivered bytes count partial and complete responses', async () => {
    const copies = landingHostCopies({ segments: [0], transitionSharedMs: 100, effectiveSharedMs: 300,
      segmentSizes: [330_000], timebase: { offsetMs: 0, wallOffsetMs: 0 },
      receiptsByClient: { c01: [{ originResponseId: 'a', startMs: 150 }, { originResponseId: 'b', startMs: 200 }, { originResponseId: 'c', startMs: 250 }] },
      hostResponses: [{ originResponseId: 'a', urlPath: '/media/seg-00000.m4s', delivered: 200_000, aborted: true },
        { originResponseId: 'b', urlPath: '/media/seg-00000.m4s', delivered: 130_000 },
        { originResponseId: 'c', urlPath: '/media/seg-00000.m4s', delivered: 330_000 }] });
    // (200,000+130,000+330,000)/330,000 = 2.0 copies.
    assertEqual(copies.rows[0].deliveredBytes, 660_000, 'delivered numerator');
    assertEqual(copies.rows[0].copies, 2, 'partial responses remain counted');
    assertEqual(copies.rows[0].responseCount, 3, 'three receipts in the window');
    const missing = landingHostCopies({ segments: [0], transitionSharedMs: 0, effectiveSharedMs: 10,
      segmentSizes: [10], timebase: { offsetMs: 0, wallOffsetMs: 0 }, receiptsByClient: { c01: [{ originResponseId: 'x', startMs: null }] },
      hostResponses: [{ originResponseId: 'x', urlPath: '/media/seg-00000.m4s', delivered: 10 }] });
    assertEqual(missing.rows[0].uncountedResponses, 1, 'unjoinable receipt is reported');
  });

  await check('T5 absolute seek: expression computes target delta and refusal tolerance is ±2 ms', async () => {
    let argument;
    const expression = absoluteSeekExpression(720_500);
    const page = { timeOrigin: 50_000, now: () => 2_000 };
    const app = { playbackState: () => ({ playing: true, positionMs: 100_000, atSharedMs: 50_000 }),
      clock: () => ({ offsetMs: 0 }), harnessSeek: (delta) => { argument = delta; return { issued: true }; } };
    new Function('__app', 'performance', `return ${expression};`)(app, page);
    // at=100,000+(52,000+300-50,000)=102,300; delta=720,500-102,300=618,200.
    assertEqual(argument, 618_200, 'absolute seek arithmetic');
    const condition = { excludedPrefixMs: 10, seek: { issueAfterReadyMs: 10, positionMs: 720_500, appliedTimeoutMs: 1_000 } };
    assertEqual(conditionValidationReason(condition), null, 'absolute target validates');
    const sequence = await stepThenSeek({ condition, preSeekState: { lineage: 'a', version: 1 },
      seek: async (value) => ({ issued: true, atPageMs: 123, value }), now: () => 20 });
    assertEqual(sequence.seek.declared.positionMs, 720_500, 'declared target reaches sequence');
    const evidence = issuedSeekEvidence(sequence.seek, { host: { positionMs: 720_501 }, hostAtMs: 30,
      viewers: {}, lastReadings: {}, timedOut: false }, []);
    const refusal = (landedPositionMs) => evaluateRefusals({ condition, declaredClientTags: [], clients: [],
      seek: { ...evidence, landedPositionMs, host: {}, landedOnHeldMedia: [] } });
    assert(refusal(720_503).reasons.some((entry) => entry.reason === 'seek-target-missed'), '3 ms miss is refused');
    assert(!refusal(720_502).reasons.some((entry) => entry.reason === 'seek-target-missed'), '2 ms landing is accepted');
  });

  await check('T6 length rule: strict all-pairs waits and every criterion are required', async () => {
    const met = lengthRule({ arms: { '4s': { five: okFive([100], [100]), startWaits: [100], seekWaits: [100], ten: null },
      '1s': { five: okFive([50, 70], [60]), startWaits: [50, 70], seekWaits: [60], ten: { accepted: true, criterion2: true } } } });
    assertEqual(met.candidates['1s'].replaces, true, 'all waits precede baseline');
    assertEqual(met.chosen, 1, '1s ten criterion chooses');
    const overlap = lengthRule({ arms: { '4s': { five: okFive([100], [100]), startWaits: [100], seekWaits: [100], ten: null },
      '1s': { five: okFive([50, 101], [60]), startWaits: [50, 101], seekWaits: [60], ten: null } } });
    // 101 is not < 100, so one pair overlaps and the candidate fails.
    assertEqual(overlap.candidates['1s'].replaces, false, 'one overlapping wait fails');
    const missing = lengthRule({ arms: { '4s': { five: okFive([100], [100]), startWaits: [100], seekWaits: [100], ten: null },
      '1s': { five: { ...okFive([50], [60]), criterion3: false }, startWaits: [50], seekWaits: [60], ten: null } } });
    assertEqual(missing.candidates['1s'].replaces, false, 'criterion 3 is required');
  });

  await check('T6 length order: failed or dropped candidates advance and 4s ten is final', async () => {
    const base = { five: okFive([100], [100]), startWaits: [100], seekWaits: [100], ten: { accepted: true, criterion2: true } };
    const droppedThenFour = lengthRule({ arms: { '4s': base,
      '1s': { five: okFive([50], [60]), startWaits: [50], seekWaits: [60], ten: { accepted: true, criterion2: false } },
      '2s': { five: { ...okFive([80], [90]), criterion2: false }, startWaits: [80], seekWaits: [90], ten: null } } });
    assertEqual(JSON.stringify(droppedThenFour.tested), '[1,2,4]', '1s drop then 2s fail reaches 4s');
    assertEqual(JSON.stringify(droppedThenFour.dropped), '[1]', 'only 1s is dropped at ten');
    assertEqual(droppedThenFour.chosen, 4, '4s is fallback');
    const twoChosen = lengthRule({ arms: { '4s': base,
      '1s': { five: { ...okFive([120], [130]), criterion2: false }, startWaits: [120], seekWaits: [130], ten: null },
      '2s': { five: okFive([80], [90]), startWaits: [80], seekWaits: [90], ten: { accepted: true, criterion2: true } } } });
    assertEqual(twoChosen.chosen, 2, '2s is tried after 1s fails');
    const unrunTen = lengthRule({ arms: { '4s': { ...base, ten: null }, '1s': null, '2s': null } });
    assertEqual(unrunTen.nextAction, 'run-ten-4s', 'ten runs at final length when absent');
  });

  await check('T6 build check: register manifests carry served build ids and regime images', async () => {
    const entry = (directory, buildId, images, invalidatedBy) => ({ directory, outcome: 'accepted', invalidatedBy,
      manifest: { clients: { c01: { buildId } }, regime: { images } } });
    const mixed = buildCheck({ runs: [entry('a', 'A', { origin: 'x' }), entry('b', 'B', { origin: 'x' })] });
    assertEqual(mixed.reason, 'mixed-build', 'different served bundles refuse');
    const images = buildCheck({ runs: [entry('a', 'A', { origin: 'x' }), entry('b', 'A', { origin: 'y' })] });
    assertEqual(images.reason, 'mixed-build', 'different regime images refuse');
    assert(buildCheck({ runs: [entry('a', 'A', { origin: 'x' }), entry('b', 'B', { origin: 'x' }, 'finding-1')] }).accepted,
      'marked alternate build is accepted');
  });

  await check('T7 K0: a 14,900 ms runway is unreadable and spends the attempt', async () => {
    const reading = rosterEventReading(rosterK0Input(14_900));
    assertEqual(rowOf(reading, 'K0').status, 'unreadable', 'runway miss is an evidence refusal');
  });

  await check('T7 ahead-for-good: runway-only candidate is delayed by a prior stall and records it', async () => {
    const polls = { c01: [0, 30_000, 37_250, 40_000, 50_000].map((atMs, index) => ({
      harnessBeforeMs: atMs, harnessAfterMs: atMs, heldAhead: { ownHeldAheadMs: index === 0 ? 10_000 : 16_000 } })), host: hostPoll(0, 50_000) };
    const reading = aheadForGood({ condition: { churn: { stall: { gapMs: 250 } } }, tags: ['c01'],
      window: { clientsReadyAtMs: 0, endMs: 50_000 }, drift: { c01: drift(0, 50_000, [[30_000, 31_000]]) }, polls,
      pagePolls: { c01: [] }, timebase: { offsetMs: 0, wallOffsetMs: 0 } });
    // Runway first exceeds 15,000 at 30,000, but the 30,000-31,000 stall means
    // the first instant after which both conditions hold is 37,250.
    assertEqual(reading.status, 'met', 'ahead-for-good established');
    assertEqual(reading.aheadForGoodAfterReadyMs, 37_250, 'stall delays candidate');
    assertEqual(reading.stallsBefore[0].startMs, 30_000, 'prior stall is retained');
  });

  await check('T7 double stalls and leave-arm rule: 59s pairs count, 61s do not', async () => {
    const records = (second) => {
      const times = Array.from({ length: 281 }, (_, index) => index * 250).filter((at) =>
        !(at > 0 && at < 1_000) && !(at > second && at < second + 1_000));
      return times.map((displaySharedMs, index) => ({ displaySharedMs, seq: index + 1, presentedFrames: index + 1 }));
    };
    const close = doubleStalls({ drift: { c01: records(59_000) }, polls: { host: hostPoll(0, 70_000) }, tags: ['c01'], fromMs: 0, toMs: 70_000 });
    const far = doubleStalls({ drift: { c01: records(61_000) }, polls: { host: hostPoll(0, 70_000) }, tags: ['c01'], fromMs: 0, toMs: 70_000 });
    assertEqual(close.c01.before, 1, '59,000-0=59,000 ms is within 60,000');
    assertEqual(far.c01.before, 0, '61,000-0=61,000 ms is outside 60,000');
    const arm = leaveArmReading({ runs: [
      [{ row: 'K1', status: 'met' }, { row: 'K3', status: 'met' }],
      [{ row: 'K1', status: 'met' }, { row: 'K3', status: 'met' }],
      [{ row: 'K1', status: 'met' }, { row: 'K3', status: 'met' }]], comparands: [{ directory: 'drop', stalls: { c01: [{ startMs: 2_000 }] } }] });
    assertEqual(arm.status, 'pass', 'three exercised leaves pass');
    assertEqual(leaveArmReading({ runs: arm.exercised.slice(0, 2).map((entry) => [{ row: 'K1', status: entry.k1 }, { row: 'K3', status: entry.k3 }]) }).status,
      'not-established', 'two exercised leaves are not established');
    assertEqual(leaveArmReading({ runs: [[{ row: 'K1', status: 'missed' }, { row: 'K3', status: 'met' }]] }).status,
      'fail', 'a missed exercised run fails');
    assertEqual(arm.comparandStalls[0].stalls.c01[0].startMs, 2_000, 'comparand stall is retained');
  });

  await check('T7 leave excusal: exactly seven named reasons need a prior presented frame', async () => {
    const reasons = leaveEventReasons().map((reason) => ({ reason, tag: 'c01' }));
    const excused = excusedByRosterEvent({ rosterEvent: { kind: 'leave-clean' } }, leaveFixture().event, reasons,
      leaveFixture().clients);
    assertEqual(excused.length, 7, 'all seven registered reasons are excused');
    const eighth = [{ reason: 'drift-log-discarded-records', tag: 'c01' }];
    assertEqual(excusedByRosterEvent({ rosterEvent: { kind: 'leave-clean' } }, leaveFixture().event, eighth, leaveFixture().clients).length,
      0, 'eighth reason is not excused');
    assertEqual(excusedByRosterEvent({ rosterEvent: { kind: 'leave-clean' } }, leaveFixture([{ displaySharedMs: 60, presentedFrames: 1 }]).event,
      [{ reason: leaveEventReasons()[0], tag: 'c01' }], leaveFixture([{ displaySharedMs: 60, presentedFrames: 1 }]).clients).length, 0,
      'no frame before issue means nothing is excused');
    const joinReasons = [{ reason: 'client-cadence-unavailable', tag: 'c01' }];
    assertEqual(excusedByRosterEvent({ rosterEvent: { kind: 'join' } }, { client: 'c01' }, joinReasons, {}).length, 1,
      'joiner cadence remains excusable');
  });

  await check('T7 J2: wide pre-event drift is unreadable, narrow drift is judged', async () => {
    const wide = rosterEventReading(wideBandInput(100));
    assertEqual(rowOf(wide, 'J2').status, 'unreadable', 'wide band is unreadable');
    assertEqual(rowOf(wide, 'J2').reason, 'drift-band-before-event', 'wide-band reason');
    const narrow = rosterEventReading(wideBandInput(40));
    assert(rowOf(narrow, 'J2').status !== 'unreadable', 'band at 40 ms is judged');
  });
}
