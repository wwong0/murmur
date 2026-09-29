import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { capacityBitsForManifest } from '../../harness-figures.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';
import { computePeerFigures } from '../../figures/peer-figures.mjs';
import { publish, PEER_TRAP_FIELDS } from '../../figures/publication.mjs';
import { trapFigures } from '../../figures/trap-figures.mjs';

const WINDOW = { startMs: 0, endMs: 180_000 };

function attempt(attemptId, path, source, bytes, endMs) {
  return { kind: 'attempt', attemptId, path, source, bytes, endMs, end: 'loaded', peerId: source === 'p2p' ? 'peer' : null };
}

function segment(path, lengthBytes, attemptId, completedAtMs) {
  return { kind: 'segment', path, lengthBytes, completedAtMs, keptAttemptIds: [attemptId] };
}

function fixture(overrides = {}) {
  const records = [
    attempt(1, '/media/seg-00001.m4s', 'http', 100, 5_000),
    segment('/media/seg-00001.m4s', 100, 1, 5_000),
    attempt(2, '/media/seg-00002.m4s', 'p2p', 100, 10_000),
    segment('/media/seg-00002.m4s', 100, 2, 10_000),
    attempt(3, '/media/seg-00003.m4s', 'http', 100, 20_000),
    segment('/media/seg-00003.m4s', 100, 3, 20_000),
  ];
  const clients = {
    c01: { peerRecords: records, polls: [
      { atMs: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } },
      { atMs: 180_000, quality: { totalVideoFrames: 4_080, droppedVideoFrames: 0 } },
    ] },
    c02: { peerRecords: records, polls: [
      { atMs: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } },
      { atMs: 180_000, quality: { totalVideoFrames: 4_080, droppedVideoFrames: 0 } },
    ] },
  };
  return {
    byteAccountingMethod: 'peer-attempt-cohort-v1', multiplierDenominator: 'none-across-seek',
    declaredClientTags: ['c01', 'c02'], window: WINDOW,
    seek: { host: { version: 4, positionMs: 8_000, atSharedMs: 0 }, landingMs: 8_000, effectiveSharedMs: 0 },
    condition: { name: 'trap', capacityMbps: 20, bars: {} }, content: { segmentSizes: [100, 100, 100, 100], frameRate: 24 },
    segmentSeconds: 4, originStart: { mediaBytesDelivered: 0, responseRecords: [] },
    originEnd: { mediaBytesDelivered: 300, responseRecords: [] }, clients, ...overrides,
  };
}

function publishedTrapFixture(overrides = {}) {
  const byClient = { c01: 0, c02: 0 };
  const figure = {
    byteAccountingMethod: 'peer-attempt-cohort-v1', multiplierDenominator: 'none-across-seek',
    keptHostBytesByClient: byClient, keptPeerBytesByClient: byClient, peerFractionByClient: byClient,
    peerFractionAggregate: 0, mediaBytesDeliveredInWindow: 1, distinctSegmentBytesInWindow: 1,
    distinctSegmentsCompletedInWindow: 1, hostFetchOnceRatio: 1, hostWasteFraction: 0, hostWasteBytes: 0,
    hostExcusedResponses: 0, hostExcusedBytes: 0, hostDeliveredBytesSettledInWindow: 1,
    peerWasteBytesByClient: byClient, realtimeFactorByClient: byClient, stallCountByClient: byClient,
    declaredOffsetMsByClient: byClient, startLatenessMsByClient: byClient, achievedSpacingMsByClient: byClient,
    peerFractionSteady: false, hostUploadMultiplierRefusal: { reason: 'seek-in-window', detail: { version: 1, L: 8, E: 0 } },
    trapLandingSegment: 2, preLandingSegmentsByClient: { c01: { count: 0, bytes: 0 }, c02: { count: 0, bytes: 0 } },
    presentedFrameRealtimeFactorByClient: byClient, mediaAdvanceFactorByClient: byClient,
    heldAheadMsMedianByClient: byClient, heldAheadMsRoomMedian: 0, positionSpreadMsMedian: 0,
    positionSpreadSecondsUsed: 1, positionUnavailableSecondsByClient: byClient,
    parkAdvanceMsByClient: byClient, ...overrides,
  };
  return { figure, context: {
    condition: { name: 'trap', capacityMbps: 5 }, window: {
      startMs: 0, endMs: 1, startSnapshotAtMs: 0, endSnapshotAtMs: 1,
    },
    content: { identity: 'content', frameRate: 24 }, declaredClientTags: ['c01', 'c02'],
    byteAccountingMethod: 'peer-attempt-cohort-v1', multiplierDenominator: 'none-across-seek',
  } };
}

export default async function trapFiguresSuite() {
  await check('T4(a): a stepped 5 Mbit/s window reads 0.8 utilisation for 4 Mbit/s', async () => {
    const capacityBitsPerSecond = capacityBitsForManifest({ condition: {
      capacityMbps: 20, capacityStep: { params: { rate: '5mbit' } },
    } });
    const input = fixture({ capacityBitsPerSecond,
      linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 180_000, txBytes: 90_000_000 }] });
    const figures = computeFigures(input);
    assertNear(figures.uplinkUtilisationMean, 0.8, 1e-12, 'stepped capacity is the denominator');
  });

  await check('T4(b): pre-landing segments are apart and do not enter the trap fraction', async () => {
    const result = trapFigures(fixture());
    assertEqual(result.preLandingSegmentsByClient.c01.count, 1, 'pre-landing count is published');
    assertEqual(result.preLandingSegmentsByClient.c01.bytes, 100, 'pre-landing bytes are published');
    assertNear(result.peerFractionAggregate, 0.5, 1e-12, 'only landing-and-later segments enter the fraction');
  });

  await check('T4(c): presented frames read 170/180 across a +600 second seek', async () => {
    const result = trapFigures(fixture({ clients: {
      c01: { peerRecords: fixture().clients.c01.peerRecords, polls: [
        { atMs: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } },
        { atMs: 180_000, quality: { totalVideoFrames: 4_080, droppedVideoFrames: 0 } },
      ] },
      c02: { peerRecords: fixture().clients.c02.peerRecords, polls: [
        { atMs: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } },
        { atMs: 180_000, quality: { totalVideoFrames: 4_080, droppedVideoFrames: 0 } },
      ] },
    } }));
    assertNear(result.presentedFrameRealtimeFactorByClient.c01, 170 / 180, 1e-12, 'frame realtime excludes the seek jump');
    const figures = computePeerFigures({ ...fixture(), realtimeFactorByClient: { c01: 4.3, c02: 4.3 } });
    assertNear(figures.mediaAdvanceFactorByClient.c01, 4.3, 0, 'position advance remains diagnostic');
    assertNear(figures.realtimeFactorByClient.c01, 170 / 180, 1e-12, 'trap realtime uses presented frames');
  });

  // 8a's second qualification attempt aborted here: a starved viewer's origin bytes
  // exceed its received bytes, which the discarded legacy column calls impossible.
  await check('T4(e): a peer run computes when its discarded legacy byte column would be impossible', async () => {
    const base = fixture();
    const figures = computeFigures(fixture({
      originStart: { ...base.originStart, byClient: { c01: { mediaBytesDelivered: 0, abortedMediaBytesDelivered: 0 } } },
      originEnd: { ...base.originEnd, byClient: { c01: { mediaBytesDelivered: 1_000, abortedMediaBytesDelivered: 0 } } },
      clients: { ...base.clients, c01: { ...base.clients.c01, requestTimebase: 'measure-window',
        requests: [{ url: '/media/seg-00001.m4s', bodyBytes: 100, finished: true, endMs: 5_000 }] } },
    }));
    assert(Number.isFinite(figures.peerFractionAggregate), 'the peer figures compute');
    assertEqual(figures.peerByteFractionByClient, undefined, 'the legacy column is not published');
  });

  await check('T4(d): publication rejects a trap multiplier by name', async () => {
    const { figure, context } = publishedTrapFixture({ hostUploadMultiplier: 1 });
    assertEqual(PEER_TRAP_FIELDS.includes('hostUploadMultiplier'), false, 'trap fields exclude the multiplier');
    const result = publish('byte', figure, context);
    assertEqual(result.missing, 'hostUploadMultiplier-forbidden-in-trap', 'trap multiplier is a hard publication error');
  });
}
