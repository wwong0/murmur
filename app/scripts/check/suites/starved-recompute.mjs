import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { recomputeStarvedRun } from '../../figures/starved-recompute.mjs';

const TAGS = ['c01', 'c02', 'c03', 'c04', 'c05'];
const WINDOW = { startMs: 0, endMs: 10_000 };

function inputFor() {
  const clients = Object.fromEntries(TAGS.map((tag, index) => {
    const late = tag === 'c05';
    const peer = tag === 'c05' ? 10 : 70;
    const host = 100 - peer;
    const records = [
      { kind: 'attempt', attemptId: `${tag}-host`, path: '/media/seg-00000.m4s', source: 'http', bytes: host, end: 'loaded', endMs: 5_000 },
      { kind: 'attempt', attemptId: `${tag}-peer`, path: '/media/seg-00000.m4s', source: 'p2p', bytes: peer, peerId: `peer-${(index + 1) % 5}`, end: 'loaded', endMs: 5_000 },
      { kind: 'segment', path: '/media/seg-00000.m4s', lengthBytes: 100, keptAttemptIds: [`${tag}-host`, `${tag}-peer`], completedAtMs: 5_000 },
    ];
    const drift = late ? [{ displaySharedMs: 5_000, mediaMs: 5_000, scheduledMediaMs: 5_000 },
      { displaySharedMs: 10_000, mediaMs: 10_000, scheduledMediaMs: 10_000 }]
      : [{ displaySharedMs: 0, mediaMs: 0, scheduledMediaMs: 0 },
        { displaySharedMs: 10_000, mediaMs: 10_000, scheduledMediaMs: 10_000 }];
    return [tag, {
      peerRecords: records,
      records: drift,
      polls: [{ atMs: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } },
        { atMs: 10_000, quality: { totalVideoFrames: 240, droppedVideoFrames: 0 } }],
      peerTotalsA: { peerIds: ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'] },
      drift,
    }];
  }));
  return {
    byteAccountingMethod: 'peer-attempt-cohort-v1', multiplierDenominator: 'one-viewing',
    declaredClientTags: TAGS, clientTags: TAGS, window: WINDOW, segmentSeconds: 4,
    content: { segmentSizes: [100, 100, 100], frameRate: 24 }, clients,
    condition: { name: 'regimes-starved', bars: {
      responseCutShortMaxBytes: 1000, conservationDeliveryGapMs: 0,
      conservationChannelBytes: 0, conservationRelativeMax: 0.05,
    } },
    originStart: { mediaBytesDelivered: 0, responseRecords: [] },
    originEnd: { mediaBytesDelivered: 500, responseRecords: [] },
  };
}

export default async function starvedRecomputeSuite() {
  await check('starved recompute: four checks run over all five viewers and failures are results', async () => {
    const result = recomputeStarvedRun({ input: inputFor(), directory: 'constructed' });
    assertEqual(result.label, 'diagnostic-of-refused-runs', 'diagnostic label is explicit');
    assertEqual(result.checks.length, 4, 'all four peer checks are published');
    assertEqual(result.checkResults.conservation.passed, false, 'a failed check is retained as a result');
    assertEqual(result.figures.includedClientTags.join(','), 'c01,c02,c03,c04', 'aggregate cohort is explicit');
    assertEqual(result.figures.apartClientTags.join(','), 'c05', 'late viewer is listed apart');
  });

  await check('starved recompute: peer fractions aggregate over c01-c04, not c05', async () => {
    const result = recomputeStarvedRun({ input: inputFor() });
    assertNear(result.figures.peerFractionAggregate, 0.70, 1e-12, 'aggregate excludes c05');
    assertNear(result.figures.peerFractionByClient.c01, 0.70, 1e-12, 'viewer fraction is published');
    assertNear(result.figures.c05.peerFraction, 0.10, 1e-12, 'c05 fraction is apart');
    assert(result.allViewerPeerFractionAggregate !== result.figures.peerFractionAggregate,
      'including c05 changes the aggregate');
  });

  await check('starved recompute: realtime uses presented frames and T5 room figures', async () => {
    const result = recomputeStarvedRun({ input: inputFor() });
    assertNear(result.figures.realtimeFactorByClient.c01, 1, 1e-12, 'frame realtime is one');
    assertNear(result.figures.realtimeFactorByClient.c05, 1, 1e-12, 'c05 frame realtime is listed apart');
    assert(result.figures.heldAheadMsRoomMedian !== null, 'held-ahead is recomputed');
    assert(result.figures.positionSpreadMsMedian !== null, 'spread is recomputed');
    assert(result.figures.c05.heldAheadMsMedian !== undefined, 'c05 held-ahead is listed apart');
  });

  // Mutation proof: moving c05 into the aggregate cohort changes the expected
  // aggregate, so the c05 boundary is observed rather than merely documented.
  await check('starved recompute: mutation to include c05 changes the aggregate', async () => {
    const result = recomputeStarvedRun({ input: inputFor() });
    assertNear(result.figures.peerFractionAggregate, 0.70, 1e-12, 'the four-viewer denominator is protected');
    assertNear(result.allViewerPeerFractionAggregate, 0.58, 1e-12, 'the mutation result differs');
  });
}
