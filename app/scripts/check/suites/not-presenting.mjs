import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';
import { notPresenting, playingPresentedFrames } from '../../harness/not-presenting.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';

const WINDOW = { startMs: 0, endMs: 180_000 };
const BARS = { recordCoverageMin: 0.95, droppedFrameFractionMax: 0.02, driftLogMissedMax: 0 };

function poll(atMs, frames, { playing = true, epoch = 'e1', offsetMs = 0 } = {}) {
  return {
    atMs,
    playback: { playing },
    quality: { totalVideoFrames: frames, droppedVideoFrames: 0 },
    clock: { offsetMs },
    stalls: { epoch, count: 0 },
  };
}

function regularPolls({ endMs = WINDOW.endMs, freezeAt = endMs, playing = true } = {}) {
  return Array.from({ length: Math.floor(endMs / 200) + 1 }, (_, index) => {
    const atMs = index * 200;
    return poll(atMs, Math.min(atMs, freezeAt) / 200, { playing });
  });
}

function fiveSecondPolls({ endMs = WINDOW.endMs, freezeAt = endMs, playing = true } = {}) {
  return Array.from({ length: Math.floor(endMs / 5_000) + 1 }, (_, index) => {
    const atMs = index * 5_000;
    return poll(atMs, Math.min(atMs, freezeAt) / 5_000, { playing });
  });
}

function refusalEvidence({ polls, records = [], driftLogMissed = 0 } = {}) {
  return {
    condition: { name: 'constructed', bars: BARS },
    window: WINDOW,
    declaredClientTags: ['c01'],
    clients: {
      c01: {
        polls,
        records,
        finalPlayback: { begun: 1 },
        driftLogMissed,
        maxDriftDrainGapMs: 0,
      },
    },
  };
}

function figureInput({ polls, records }) {
  const counters = {
    mediaBytesDelivered: 0,
    abortedMediaBytesDelivered: 0,
    segmentBytesDelivered: 0,
    initBytesDelivered: 0,
  };
  return {
    window: WINDOW,
    declaredClientTags: ['A'],
    content: { identity: 'constructed', frameRate: 24 },
    condition: { name: 'constructed', capacityBitsPerSecond: 10_000_000 },
    originStart: { mediaBytesDelivered: 0, abortedMediaBytesDelivered: 0, byClient: { A: counters } },
    originEnd: { mediaBytesDelivered: 0, abortedMediaBytesDelivered: 0, byClient: { A: counters } },
    clients: { A: { records, polls, requests: [], requestTimebase: 'measure-window' } },
  };
}

export default async function notPresentingSuite() {
  await check('not-presenting: healthy, frozen and parked viewers use the last presenting rise', async () => {
    const healthy = notPresenting(regularPolls(), WINDOW);
    assertEqual(healthy.recordingRan, true, 'healthy recording ran');
    assertEqual(healthy.why.length, 0, 'healthy has no reasons');
    assertEqual(healthy.noFrameMs, 0, 'healthy has no no-frame time');
    assertEqual(healthy.counted, false, 'healthy is not counted');

    const frozen = notPresenting(regularPolls({ freezeAt: 60_000 }), WINDOW);
    assertEqual(frozen.fromMs, 60_000, 'frozen viewer stops at its last presenting rise');
    assertEqual(frozen.noFrameMs, 120_000, 'frozen viewer no-frame time');
    assertEqual(frozen.counted, true, 'frozen viewer is counted');

    const parked = notPresenting(regularPolls({ playing: false }), WINDOW);
    assertEqual(parked.fromMs, 0, 'parked viewer has no presenting rise');
    assertEqual(parked.noFrameMs, 180_000, 'parked viewer no-frame time');
    assertEqual(parked.counted, true, 'parked viewer is counted');
  });

  await check('not-presenting: edges, gaps and evidence reasons are ordered and bounded', async () => {
    assertEqual(notPresenting(regularPolls({ endMs: 120_000 }), WINDOW).why.join(','), 'last-poll-early', 'early final poll');
    const exactGap = notPresenting(Array.from({ length: 37 }, (_, index) => poll(index * 5_000, index)), WINDOW);
    assertEqual(exactGap.why.join(','), '', 'a gap of exactly five seconds runs');
    const oneGap = notPresenting([poll(0, 0), poll(5_000, 1), poll(10_000, 2), poll(15_001, 3), poll(20_001, 4), poll(180_000, 5)], WINDOW);
    assertEqual(oneGap.why.join(','), 'poll-gap', 'a gap above five seconds is refused');

    const firstAtFive = notPresenting([poll(5_000, 0), ...Array.from({ length: 35 }, (_, index) => poll(10_000 + index * 5_000, index + 1))], WINDOW);
    assertEqual(firstAtFive.why.join(','), '', 'first poll at the edge runs');
    const firstAtLate = notPresenting([poll(5_001, 0), ...Array.from({ length: 35 }, (_, index) => poll(10_001 + index * 5_000, index + 1)), poll(180_000, 36)], WINDOW);
    assertEqual(firstAtLate.why.join(','), 'first-poll-late', 'first poll past the edge is refused');

    const clock = regularPolls();
    clock[10].clock.offsetMs = null;
    assertEqual(notPresenting(clock, WINDOW).why.join(','), 'clock', 'clock evidence');
    const epoch = regularPolls();
    epoch[10].stalls.epoch = 'e2';
    assertEqual(notPresenting(epoch, WINDOW).why.join(','), 'epoch', 'epoch evidence');
    const frames = regularPolls();
    frames[10].quality.totalVideoFrames -= 2;
    assertEqual(notPresenting(frames, WINDOW).why.join(','), 'frames', 'frame evidence');

    const atTwoSeconds = regularPolls({ freezeAt: 178_000 });
    assertEqual(notPresenting(atTwoSeconds, WINDOW).noFrameMs, 2_000, 'two-second boundary counts');
    const belowTwoSeconds = atTwoSeconds.map((entry) => ({ ...entry, quality: { ...entry.quality } }));
    for (const entry of belowTwoSeconds) if (entry.atMs >= 178_200) entry.quality.totalVideoFrames += 1;
    belowTwoSeconds.splice(1 + 178_000 / 200, 0, poll(178_001, 891));
    assertEqual(notPresenting(belowTwoSeconds, WINDOW).noFrameMs, 1_999, 'one millisecond below the boundary does not count');
    assertEqual(notPresenting([{ atMs: 0 }], WINDOW).why.join(','), 'fewer-than-two-polls', 'short recordings only report poll count');
    assertEqual(JSON.stringify(notPresenting([], {})), JSON.stringify({ recordingRan: false, why: ['window'], fromMs: null, noFrameMs: null, counted: false }), 'missing window shape');
  });

  await check('not-presenting: counted viewers move only stall-family refusal reasons', async () => {
    const frozen = evaluateRefusals(refusalEvidence({ polls: fiveSecondPolls({ playing: false }) }));
    assertEqual(frozen.runRefused, false, 'parked viewer does not refuse the run');
    assertEqual(frozen.reasons.length, 0, 'moved reasons leave no refusal');
    assertEqual(frozen.countedAsStall.length, 1, 'one counted viewer is returned');
    assertEqual(frozen.countedAsStall[0].reasons.map((entry) => entry.reason).join(','), 'client-holds-no-drift-records,record-coverage-unavailable', 'moved reasons keep order');
    assertEqual(frozen.published.noFrameMsByClient.c01, 180_000, 'published no-frame time');
    assertEqual(frozen.published.realtimeFactorByClient.c01, 0, 'empty records publish zero realtime');

    const stopped = evaluateRefusals(refusalEvidence({ polls: fiveSecondPolls({ endMs: 120_000, freezeAt: 120_000 }) }));
    assert(stopped.reasons.some((entry) => entry.reason === 'record-coverage-unavailable'), 'short recording keeps coverage refusal');
    assertEqual(stopped.runRefused, true, 'short recording refuses the run');
    assertEqual(stopped.countedAsStall.length, 0, 'short recording is not counted');

    const lowCoverage = evaluateRefusals(refusalEvidence({
      polls: fiveSecondPolls(),
      records: [
        { seq: 1, displaySharedMs: 0, mediaMs: 0, presentedFrames: 1 },
        { seq: 2, displaySharedMs: 180_000, mediaMs: 100_000, presentedFrames: 100 },
      ],
    }));
    assert(lowCoverage.reasons.some((entry) => entry.reason === 'record-coverage-below-declared-fraction'), 'low coverage remains a refusal');
    assertEqual(lowCoverage.countedAsStall.length, 0, 'healthy presenter is not counted');

    const nonStall = evaluateRefusals(refusalEvidence({ polls: fiveSecondPolls({ freezeAt: 60_000 }), driftLogMissed: 1 }));
    assert(nonStall.reasons.some((entry) => entry.reason === 'drift-log-discarded-records'), 'non-stall reason stays');
    assertEqual(nonStall.countedAsStall[0].reasons.some((entry) => entry.reason === 'drift-log-discarded-records'), false, 'non-stall reason is not moved');
  });

  await check('not-presenting: poll coverage distinguishes stopped records and the bar edge', async () => {
    const polls = regularPolls({ freezeAt: 178_000 }).map((p) => ({ ...p, quality: { ...p.quality, totalVideoFrames: p.quality.totalVideoFrames * 5 } }));
    const records = (count, spacing) => Array.from({ length: count }, (_, i) => ({ seq: i + 1, presentedFrames: i + 1, displaySharedMs: i * spacing, mediaMs: i * spacing }));
    const stopped = evaluateRefusals(refusalEvidence({ polls, records: [...records(1440, 41.67), { seq: 1441, presentedFrames: 1441, displaySharedMs: 170_000, mediaMs: 170_000 }] }));
    assertEqual(stopped.runRefused, true, 'trailing stall does not excuse stopped records');
    assertEqual(stopped.countedAsStall.length, 1, 'viewer remains counted');
    assert(stopped.reasons.some((entry) => entry.reason === 'record-coverage-below-declared-fraction'), 'coverage stays');
    const complete = evaluateRefusals(refusalEvidence({ polls, records: records(4450, 40) }));
    assertEqual(complete.runRefused, false, 'covered frames pass');
    assertEqual(complete.published.coverageFromPollsByClient.c01.presentedFrames, 4450, 'playing frames counted');
    assertEqual(complete.published.coverageFromPollsByClient.c01.records, 4450, 'in-window records counted');
    assertEqual(complete.published.coverageFromPollsByClient.c01.coverage, 1, 'poll coverage is published');
    const noRecordPolls = regularPolls({ freezeAt: 170_000 }).map((p) => ({ ...p, quality: { ...p.quality, totalVideoFrames: p.quality.totalVideoFrames * 5 } }));
    const none = evaluateRefusals(refusalEvidence({ polls: noRecordPolls, records: [] }));
    assertEqual(none.runRefused, true, 'frames without records refuse');
    assert(none.reasons.some((entry) => entry.reason === 'record-coverage-unavailable' && entry.basis === 'polls'), 'unavailable coverage remains with poll basis');
    assert(stopped.reasons.some((entry) => entry.basis === 'polls'), 'polls identify the added coverage reason');
    const parked = regularPolls({ playing: false });
    assertEqual(playingPresentedFrames(parked, WINDOW), 0, '8b park-frame rises do not count');
    assertEqual(evaluateRefusals(refusalEvidence({ polls: parked })).runRefused, false, 'parked viewer is counted');
    const edgePolls = regularPolls({ freezeAt: 40_000 }).map((p) => ({ ...p, quality: { ...p.quality, totalVideoFrames: p.quality.totalVideoFrames * 5 } }));
    for (const [n, refused] of [[950, false], [949, true]]) {
      const result = evaluateRefusals(refusalEvidence({ polls: edgePolls, records: records(n, 40) }));
      assertEqual(result.runRefused, refused, `coverage with ${n} records`);
    }
  });

  await check('not-presenting: counted figures use window-end realtime and frame quality without records', async () => {
    const records = [
      { displaySharedMs: 0, mediaMs: 0, presentedFrames: 1 },
      { displaySharedMs: 60_000, mediaMs: 60_000, presentedFrames: 2 },
    ];
    const counted = computeFigures(figureInput({ polls: fiveSecondPolls({ freezeAt: 60_000 }), records }));
    assertNear(counted.realtimeFactorByClient.A, 0.3333333333333333, 1e-12, 'counted realtime uses window end');
    assertEqual(counted.noFrameMsByClient.A, 120_000, 'counted figure publishes no-frame time');

    const emptyRecords = computeFigures(figureInput({ polls: fiveSecondPolls({ freezeAt: 60_000 }), records: [] }));
    assertEqual(emptyRecords.realtimeFactorByClient.A, 0, 'counted empty records publish realtime zero');
    assertNear(emptyRecords.realtimeFactorFromFrameQualityByClient.A, 12 / (24 * 180), 1e-12, 'counted empty records retain frame-quality factor');

    const healthy = computeFigures(figureInput({ polls: fiveSecondPolls(), records }));
    assertNear(healthy.realtimeFactorByClient.A, 1, 1e-12, 'uncounted realtime keeps today\'s record-span formula');
    assertEqual(Object.prototype.hasOwnProperty.call(healthy.noFrameMsByClient, 'A'), false, 'uncounted viewer has no no-frame entry');
  });
}
