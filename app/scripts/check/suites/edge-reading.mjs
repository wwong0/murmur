// 9b design.md D3, D4, D8: the reading of an arm registered under 9b — the drop
// criterion, the comparison with a control arm, and what a run publishes beside them.

import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { baselineTable, classifyControlReading, classifyControlRun, validateControlReading } from '../../figures/control-reading.mjs';
import { gain, NOT_ESTABLISHED } from '../../figures/edge-reading.mjs';
import { capUsed } from '../../figures/cap-used.mjs';
import { recoverySpans, recoveryTime } from '../../figures/control-figures.mjs';
import { sweepPositions } from '../../control-reading.mjs';
import { PROBE_FACTOR } from '../../../public/lib/host-pace.mjs';

const IMAGES = { origin: 'sha256:origin-a', client: 'sha256:client-a' };
const WINDOWS = { highDemandTimeWindow: 15, httpDownloadTimeWindow: 60, p2pDownloadTimeWindow: 60 };
const CONTROL = { condition: 'p2p-scattered', peerFractionMin: 0.50 };
const reading = (criteria, extra = {}) => ({ kind: 'control', criteria, published: [], acceptedRunsMin: 2, attemptsMax: 3,
  productInputs: true, control: CONTROL, hostPollCoverage: true, aheadMsMin: 15_000, scatteredSpreadMsAbove: 4_000,
  behindHeldAheadMsBelow: 15_000, ...extra });
const TEN = reading({ multiplier: { max: 2 } }, { controlArm: 'edge-control-ten' });
const CONTROL_TEN = reading({ multiplier: { max: 2 } }, { attemptsMax: 2 });
const DROP = reading({ dropRecovery: { maxMs: 240_000 } });

const viewer = (peerId) => ({ role: 'viewer', buildId: 'build-a', peerId, engineWindows: { declared: null, inForce: WINDOWS, pageError: null } });

// One accepted run on one build: steady, peer fraction 0.70, and whatever `edge` the case hands it.
function run(directory, condition, { multiplier = 1.4, edge = null, images = IMAGES } = {}) {
  return {
    directory, condition, outcome: 'complete', publishes: true, finalization: { writeByte: true },
    manifest: { clients: { c00: { role: 'host', headroom: { fraction: 0.85, supplied: false, available: true } }, c01: viewer('peer-a'), c02: viewer('peer-b') },
      topology: { boundaries: { start: { readback: { refusals: [] } }, end: { readback: { refusals: [] } } }, regime: { images } },
      condition: { capacityMbps: 10, clients: 2 }, window: { startMs: 0, endMs: 180_000 } },
    report: { figures: {
      peerFractionAggregate: 0.70, peerFractionByClient: { c01: 0.70, c02: 0.70 }, hostUploadMultiplier: multiplier,
      steadyState: { steady: true, legs: {}, pace: { tested: 'capUsed', capUsed: { value: 0.61 }, paceBound: { value: 0.02 } } },
      control: { holds: { start: null, seek: { viewers: { c01: { waitMs: 2_100 }, c02: { waitMs: 2_600 } } } }, recovery: { start: null, seek: null },
        timebase: { halfWidthMs: 9, bracketHalfWidthMedianMs: 6, bracketHalfWidthMaxMs: 40 },
        pollGaps: { host: { maxGapMs: 260 } } },
      ...(edge ? { edge } : {}),
    } },
  };
}

const scattered = run('scattered', 'p2p-scattered');
const dropEdge = (dropRecovery) => ({ dropRecovery });
const roomEdge = { reached: true, atMs: 260_000, heldAheadMsByClient: { c01: 9_000, c02: 11_000 } };
const ceilingEdge = { reached: false, atMs: 360_000, heldAheadMsByClient: { c01: 9_000, c02: 22_000 } };
const recoveredAt = (recoveryMs) => dropEdge({ notExercised: false, edge: roomEdge, result: { recovered: true, recoveryMs } });

// Both arms of the comparison, read as the reading script reads them: each against its own reading block.
function arms(tenRuns, controlRuns) {
  const runs = [scattered, ...tenRuns, ...controlRuns];
  return {
    'edge-ten': classifyControlReading({ runs, reading: TEN, armNames: ['edge-ten'] }).arms['edge-ten'],
    'edge-control-ten': classifyControlReading({ runs, reading: CONTROL_TEN, armNames: ['edge-control-ten'] }).arms['edge-control-ten'],
  };
}

function thrownBy(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

export default async function edgeReadingSuite() {
  await check('edge reading: an arm that meets a criterion its control arm fails reads met against failed', async () => {
    const read = arms([run('ten-1', 'edge-ten', { multiplier: 1.4 }), run('ten-2', 'edge-ten', { multiplier: 1.6 })],
      [run('ctl-1', 'edge-control-ten', { multiplier: 2.6 }), run('ctl-2', 'edge-control-ten', { multiplier: 2.8 })]);
    const [multiplier] = gain({ arms: read })['edge-ten'].criteria;
    assertEqual(JSON.stringify(multiplier.comparison), '{"arm":"met","control":"failed"}', 'met against failed');
    assertEqual(multiplier.arm.runs.map((entry) => `${entry.directory}:${entry.value}`).join(' '), 'ten-1:1.4 ten-2:1.6', 'with each arm run\'s value');
    assertEqual(multiplier.control.runs.map((entry) => `${entry.directory}:${entry.value}`).join(' '), 'ctl-1:2.6 ctl-2:2.8', 'and each control run\'s');
  });

  // The control arm's result cannot change the headline's.
  // Opportunity: `gain` holds both arms' objects when it compares them. Action
  // boundary: it returns a new object and assigns into neither. Mutation: in
  // `gain`, `arm.criteria[criterion] = { ...arm.criteria[criterion], result: NOT_ESTABLISHED }`
  // where the control is split — 'the arm still reads met' goes red, got
  // "not-established-against-the-control". Restored: green.
  await check('edge reading: a split control arm leaves the comparison not established and the arm\'s own result standing', async () => {
    const read = arms([run('ten-1', 'edge-ten', { multiplier: 1.4 }), run('ten-2', 'edge-ten', { multiplier: 1.6 })],
      [run('ctl-1', 'edge-control-ten', { multiplier: 1.9 }), run('ctl-2', 'edge-control-ten', { multiplier: 2.8 })]);
    assertEqual(read['edge-control-ten'].criteria.multiplier.result, 'split', 'two attempts, one met and one failed, read split');
    const [multiplier] = gain({ arms: read })['edge-ten'].criteria;
    assertEqual(multiplier.comparison, NOT_ESTABLISHED, 'the comparison is not established against the control');
    assertEqual(multiplier.control.runs.map((entry) => `${entry.directory}:${entry.result}`).join(' '), 'ctl-1:met ctl-2:failed', 'listing both control runs');
    assertEqual(read['edge-ten'].criteria.multiplier.result, 'met', 'the arm still reads met');
    assertEqual(read['edge-ten'].reading, 'classified', 'and is classified');
    const absent = gain({ arms: { 'edge-ten': read['edge-ten'] } })['edge-ten'];
    assertEqual(absent.criteria.length, 0, 'with no control arm read, no criterion is shared and none is compared');
    assertEqual(Object.keys(gain({ arms: { 'edge-control-ten': read['edge-control-ten'] } })).length, 0, 'an arm naming no control arm has no comparison');
  });

  await check('edge reading: a drop run that never reached the edge is listed and does not vote', async () => {
    const notExercised = run('drop-1', 'edge-drop', { edge: dropEdge({ notExercised: true, edge: ceilingEdge }) });
    const met = (name) => run(name, 'edge-drop', { edge: recoveredAt(120_000) });
    const two = classifyControlReading({ runs: [scattered, notExercised, met('drop-2')], reading: DROP, armNames: ['edge-drop'] }).arms['edge-drop'];
    assertEqual(two.acceptedCount, 1, 'one of the two runs counts toward the accepted minimum');
    assertEqual(two.reading, 'No reading', 'so two attempts give no reading');
    const listed = two.runs[0].classification;
    assertEqual(`${listed.criteria.dropRecovery.result}/${listed.criteria.dropRecovery.reason}`, 'not-classified/drop-not-exercised', 'the run is not classified');
    assertEqual(listed.criteria.dropRecovery.edge.heldAheadMsByClient.c02, 22_000, 'and is listed with the viewer that held 22 000 ms');
    const three = classifyControlReading({ runs: [scattered, notExercised, met('drop-2'), met('drop-3')], reading: DROP, armNames: ['edge-drop'] }).arms['edge-drop'];
    assertEqual(`${three.acceptedCount}/${three.criteria.dropRecovery.result}/${three.criteria.dropRecovery.value}`, '2/met/120000', 'a third attempt makes two votes, met at 120 000 ms');
  });

  await check('edge reading: the drop criterion reads the schedule recovery against its bar', async () => {
    const verdict = (edge) => classifyControlRun(run('drop', 'edge-drop', { edge }), DROP).criteria.dropRecovery;
    assertEqual(verdict(recoveredAt(240_000)).result, 'met', 'recovered 240 000 ms after the rise, against 240 000');
    assertEqual(`${verdict(recoveredAt(300_000)).result}/${verdict(recoveredAt(300_000)).reason}`, 'failed/threshold:recovery', 'recovered at 300 000 ms');
    const never = verdict(dropEdge({ notExercised: false, edge: roomEdge, result: { recovered: false, recoveryMs: null } }));
    assertEqual(`${never.result}/${never.reason}`, 'failed/not-recovered', 'never recovered');
    const bounded = verdict(dropEdge({ notExercised: false, edge: roomEdge, result: { recovered: true, recoveryMs: null, recoveryAtMostMs: 60_000 } }));
    assertEqual(`${bounded.result}/${bounded.value}/${bounded.upperBound}`, 'met/60000/true', 'an upper bound of 60 000 ms meets the bar as a bound');
    assertEqual(verdict(null).reason, 'drop-recovery-unavailable', 'a run with no schedule reading is unestablished, not met');
    assertEqual(verdict(dropEdge({ notInForce: true, edge: null })).reason, 'capacity-schedule-not-in-force', 'as is one whose drop was not in force');
  });

  await check('edge reading: the prefetch-wait criterion reads the instant its bar names', async () => {
    const wait = { count: 12, unanswered: 1, maxAnswerMs: 4_600, maxDurationMs: 16_200 };
    const verdict = (of, edge = { prefetchWait: wait }) => classifyControlRun(run('five', 'edge-five', { edge }),
      reading({ prefetchWait: { maxMs: 15_000, of } })).criteria.prefetchWait;
    assertEqual(`${verdict('answer').result}/${verdict('answer').value}`, 'met/4600', 'answered within 4 600 ms against 15 000');
    assertEqual(`${verdict('duration').result}/${verdict('duration').value}/${verdict('duration').reason}`, 'failed/16200/threshold:wait', 'the same run by its whole duration, 16 200 ms');
    assertEqual(`${verdict('answer').count}/${verdict('answer').unanswered}`, '12/1', 'with the count and the unanswered beside it');
    const none = verdict('answer', { prefetchWait: { count: 0, unanswered: 0, maxAnswerMs: null, maxDurationMs: null } });
    assertEqual(`${none.result}/${none.reason}`, 'unestablished/no-edge-prefetch', 'no prefetch at the edge is no value, not a wait of zero');
    assert(thrownBy(() => verdict('answer', { prefetchWait: { ...wait, maxAnswerMs: -1 } })) instanceof RangeError, 'a wait below zero is a hard error');
    assertEqual(thrownBy(() => validateControlReading(reading({ prefetchWait: { maxMs: 15_000 } })))?.message,
      'control-reading-field-invalid:prefetchWait.of', 'a bar that names no instant does not load');
  });

  await check('edge reading: the 9b reading fields are validated, and a run publishes its figures only under them', async () => {
    for (const [name, value] of [['controlArm', ''], ['hostPollCoverage', 'yes'], ['aheadMsMin', -1], ['scatteredSpreadMsAbove', null]]) {
      assertEqual(thrownBy(() => validateControlReading(reading({}, { [name]: value })))?.message, `control-reading-field-invalid:${name}`, `${name} malformed`);
    }
    const edge = { hostCopies: { segments: 40, meanCopies: 1.25, distribution: { 1: 30, 2: 10 }, asksByReason: { first: 40, 'fallback-slow-holder': 10 }, perSegment: [{ path: 'x' }] },
      prefetchWait: { count: 3, maxAnswerMs: 400 }, roomPosition: { spreadMs: 900 }, assignmentControl: { declared: '8b' } };
    const published = classifyControlRun(run('ten', 'edge-ten', { edge }), TEN).edge;
    assertEqual(`${published.hostCopies.meanCopies}/${'perSegment' in published.hostCopies}`, '1.25/false', 'the mean copies, without the per-segment list');
    assertEqual(published.hostCopies.asksByReason['fallback-slow-holder'], 10, 'the asks by reason');
    assertEqual(`${published.seekWaitByViewer.c01.waitMs}/${published.seekWaitByViewer.c02.waitMs}`, '2100/2600', 'the seek wait per viewer');
    assertEqual(`${published.timebase.halfWidthMs}/${published.timebase.bracketHalfWidthMedianMs}/${published.timebase.bracketHalfWidthMaxMs}`, '9/6/40', 'the three half-widths');
    assertEqual(published.pollGaps.host.maxGapMs, 260, 'the largest poll gap');
    assertEqual(`${published.pace.capUsed.value}/${published.pace.paceBound.value}`, '0.61/0.02', 'the cap used and the pace-bound values');
    assertEqual(published.assignmentControl.declared, '8b', 'the control reading');
    const { hostPollCoverage, ...before } = TEN;
    const earlier = classifyControlRun(run('ten', 'control-ten', { edge }), before);
    assertEqual(`${'edge' in earlier}/${'notExercised' in earlier}`, 'false/false', 'a reading registered before 9b carries neither key');
  });

  await check('edge reading: the baseline table has a row per 9b arm, and the sweep reads 0.85 from edge-seek', async () => {
    const baseline = run('baseline', 'baseline-nop2p-steady', { multiplier: 5.1 });
    const table = baselineTable({ runs: [baseline], controlRuns: { 'edge-five': run('five', 'edge-five'), 'edge-ten': run('ten', 'edge-ten', { images: { ...IMAGES, client: 'sha256:other' } }) } });
    assertEqual(Object.keys(table).join(','), 'edge-five,edge-ten', 'one row per arm handed in');
    assertEqual(`${table['edge-five'].cells.sameBuildBaseline.source}/${table['edge-five'].multiplier.sameBuildBaseline}`, 'baseline/5.1', 'the same-build baseline');
    assertEqual(table['edge-ten'].cells.sameBuildBaseline.reason, 'baseline-build-mismatch', 'and none for an arm on other images');
    const seek = { issueAfterReadyMs: 120_000 };
    const conditions = {
      'control-seek': { name: 'control-seek', seek, reading: { kind: 'control' } },
      'edge-seek': { name: 'edge-seek', seek, reading: reading({}) },
      'edge-control-seek': { name: 'edge-control-seek', seek, assignmentControl: '8b', reading: reading({}) },
      'edge-sweep-070': { name: 'edge-sweep-070', seek, headroomFraction: 0.7, reading: reading({}, { sweep: true }) },
    };
    assertEqual(sweepPositions([], conditions, '9b').map((position) => `${position.condition}@${position.fraction}`).join(' '),
      'edge-sweep-070@0.7 edge-seek@0.85', '9b\'s positions: its sweeps, and the product\'s from edge-seek, not from its control arm');
    assertEqual(sweepPositions([], conditions).map((position) => position.condition).join(' '), 'control-seek', '8b2\'s positions gain none of them');
  });

  // F6, pinned (design.md D3): the cap leg's two readings.
  await check('edge reading: a probe interval at its allowance reads a cap used of 1.0, and a span before any estimate is incomplete', async () => {
    const record = (seq, fields) => ({ seq, endWallMs: 100 + 1_000 * seq, durationMs: 1_000, paceBoundMs: 0, handedBytes: 300_000, wireBytes: 300_000,
      readingBytesPerSecond: null, linkBound: false, reason: 'no-queue', probe: false, headQueueMs: 0, tailQueueMs: 0, raised: false, climbing: true, ...fields });
    const seed = { handedBytes: 2_000_000, wireBytes: 2_000_000, readingBytesPerSecond: 2_000_000, linkBound: true, reason: null };
    // Estimate 2 000 000 B/s from record 1; record 3 is a probe handed PROBE_FACTOR × 2 000 000 × 1 s = 2 200 000 bytes.
    assertEqual(PROBE_FACTOR, 1.1, 'the probe factor the expected bytes are written from');
    const probing = [record(1, seed), record(2, {}), record(3, { probe: true, handedBytes: 2_200_000, wireBytes: 2_200_000 }), record(4, {})];
    const probe = capUsed({ intervals: probing, window: { startMs: 2_000, endMs: 3_000 }, wallOffsetMs: 100, fraction: 0.5 });
    assertEqual(`${probe.handedBytes}/${probe.reason}`, '2200000/null', 'the probe interval alone, 2 200 000 bytes handed');
    assertNear(probe.allowedBytes, 2_200_000, 1e-6, 'against 2 200 000 allowed');
    assertNear(probe.value, 1.0, 1e-9, 'a cap used of 1.0, not above');

    // Record 1 has no estimate in force; spans of 60 s from 0: the first holds it, the next two are paced at 0.30.
    const intervals = [record(1, seed), ...Array.from({ length: 200 }, (_, index) => record(index + 2, {}))];
    const input = { condition: { peerExchange: true, bars: { steadyUtilisationMax: 0.90, steadyDownloadRatioMin: 0.95, steadyDownloadRatioMax: 1.25,
      steadyRealtimeMin: 0.98, steadyCapUsedMax: 0.90 } }, declaredClientTags: [], clients: {}, viewerPolls: {}, headroom: { fraction: 0.5 },
    hostPace: { intervals, fraction: 0.5 }, hostPaceFinal: { estimate: { bytesPerSecond: 2_000_000 } }, wallOffsetMs: 100,
    linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 60_000, txBytes: 63_000_000 }, { atMs: 120_000, txBytes: 126_000_000 }, { atMs: 180_000, txBytes: 189_000_000 }],
    capacityBitsPerSecond: 10_000_000, content: { segmentSizes: [] }, segmentSeconds: 4 };
    const { spans } = recoverySpans({ input, transition: 0, recordingEnd: 180_000, spanMs: 60_000, hostPace: input.hostPace, wallOffsetMs: 100 });
    assertEqual(`${spans[0].legs.capUsed.reason}/${spans[0].incomplete}`, 'pace-not-in-force/true', 'the start span reads pace-not-in-force, incomplete');
    assertEqual(`${spans[1].pass}/${spans[2].pass}`, 'true/true', 'the next two pass');
    const result = recoveryTime(spans, 60_000);
    assertEqual(`${result.recovered}/${result.recoveryMs}/${result.recoveryAtMostMs}`, 'true/null/60000', 'recovered within at most 60 000 ms');
    const entry = run('five', 'edge-five');
    entry.report.figures.control.recovery.start = { spans, result };
    const verdict = classifyControlRun(entry, reading({ startRecovery: { maxMs: 120_000 } })).criteria.startRecovery;
    assertEqual(`${verdict.result}/${verdict.value}/${verdict.upperBound}`, 'met/60000/true', 'met against 120 000');
  });
}
