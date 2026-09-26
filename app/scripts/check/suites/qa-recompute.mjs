import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { figuresForWindows, recomputeQaRun, step0WindowForViewer } from '../../figures/qa-recompute.mjs';

function drift(first, last, offset = 0) {
  return { records: [
    { displaySharedMs: 0, mediaMs: first, scheduledMediaMs: first },
    { displaySharedMs: 5_000, mediaMs: last, scheduledMediaMs: last },
  ], peerRecords: [] };
}

function fixture() {
  return {
    declaredClientTags: ['c01', 'c02'],
    clients: { c01: drift(0, 5_000), c02: drift(10_000, 15_000) },
    content: { segmentSizes: [1_000, 1_000, 1_000, 1_000, 1_000] },
    segmentSeconds: 1,
    capacityBitsPerSecond: 10_000_000,
    linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 300_000, txBytes: 60_000_000 }],
  };
}

export default async function qaRecomputeSuite() {
  await check('qa: a viewer starting 10 seconds late gets its own playback window', async () => {
    const input = fixture();
    input.clients.c01.records = [
      { displaySharedMs: 0, mediaMs: 0 }, { displaySharedMs: 300_000, mediaMs: 300_000 },
    ];
    input.clients.c02.records = [
      { displaySharedMs: 10_000, mediaMs: 0 }, { displaySharedMs: 310_000, mediaMs: 300_000 },
    ];
    const early = step0WindowForViewer(input.clients.c01, 'c01');
    const late = step0WindowForViewer(input.clients.c02, 'c02');
    assertNear(early.startMs, 30_000, 0, 'on-time viewer starts at +30s');
    assertNear(late.startMs, 40_000, 0, 'late-starting viewer starts from its own +30s');
    assertNear(late.endMs - early.endMs, 10_000, 0, 'viewer windows retain the 10s offset');
  });

  await check('qa: a span boundary counts completion once by completedAtMs', async () => {
    const input = fixture();
    input.declaredClientTags = ['c01'];
    input.clients = { c01: {
      records: [{ displaySharedMs: 0, mediaMs: 0 }, { displaySharedMs: 2_000, mediaMs: 2_000 }],
      peerRecords: [
        { kind: 'attempt', attemptId: 1, source: 'http', bytes: 100, endMs: 500 },
        { kind: 'attempt', attemptId: 2, source: 'p2p', bytes: 100, endMs: 1_500 },
        { kind: 'segment', path: '/seg-0.m4s', lengthBytes: 100, completedAtMs: 1_000, keptAttemptIds: [1] },
        { kind: 'segment', path: '/seg-1.m4s', lengthBytes: 100, completedAtMs: 1_500, keptAttemptIds: [2] },
      ],
    } };
    const first = figuresForWindows(input, { c01: { startMs: 0, endMs: 1_000 } });
    const second = figuresForWindows(input, { c01: { startMs: 1_000, endMs: 2_000 } });
    assertEqual(first.completedSegmentsByClient.c01, 0, 'completion at end boundary is excluded');
    assertEqual(second.completedSegmentsByClient.c01, 2, 'completion at start boundary is included once');
    assertNear(second.peerFractionAggregate, 0.5, 0, 'second span uses the kept peer attempt');
  });

  await check('qa: registered outcome is diagnostic and criterion-free', async () => {
    const input = fixture();
    input.declaredClientTags = ['c01'];
    input.content.segmentSizes = Array.from({ length: 300 }, () => 1_000);
    input.clients.c01.records = [
      { displaySharedMs: 0, mediaMs: 0 }, { displaySharedMs: 300_000, mediaMs: 300_000 },
    ];
    input.clients.c01.peerRecords = [
      { kind: 'attempt', attemptId: 1, source: 'http', bytes: 100, startMs: 99_000, endMs: 100_000 },
      { kind: 'segment', path: '/seg-0.m4s', lengthBytes: 100, completedAtMs: 100_000, keptAttemptIds: [1] },
    ];
    const result = recomputeQaRun(input, 'constructed');
    assert(result.directory === 'constructed', 'run directory is retained');
    assert(result.step0Window.windowsByClient.c01.startMs < result.step0Window.windowsByClient.c01.endMs,
      'Step 0 window is ordered');
  });
}
