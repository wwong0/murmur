import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { segmentNameForMediaPosition } from '../../../harness/goodput.mjs';
import { computeHeldAhead } from '../../figures/held-ahead.mjs';
import { recoverySpans, widenedBars } from '../../figures/control-figures.mjs';
import { mediaTimeRatio } from '../../figures/edge-figures.mjs';
import { computeNoP2pSteady } from '../../figures/nop2p-steady.mjs';
import { computeOneViewing, bytesForStretch } from '../../figures/one-viewing.mjs';
import { appliedSeekEvidence } from '../../figures/seek-evidence.mjs';
import { trapFigures } from '../../figures/trap-figures.mjs';
import { segmentAtMediaPosition } from '../../harness/qualification.mjs';

const BARS = { steadyUtilisationMax: 0.9, steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25, steadyRealtimeMin: 0.98 };
const FOUR_SIZES = [100, 200, 300];
const ONE_SIZES = [100, 200, 300, 400, 500, 600, 700, 800];
const drift = (endMs) => ({ records: [
  { displaySharedMs: 0, mediaMs: 0, scheduledMediaMs: 0 },
  { displaySharedMs: endMs, mediaMs: endMs, scheduledMediaMs: endMs },
] });

function oneViewing(segmentSeconds, segmentSizes) {
  return computeOneViewing({ clients: { c01: drift(8_000) }, tags: ['c01'],
    window: { startMs: 0, endMs: 8_000 }, segmentSizes, segmentSeconds });
}

function held(segmentSeconds) {
  const paths = [{ path: '/media/seg-00000.m4s', completedAtMs: 0 }];
  return computeHeldAhead({ clients: { c01: { records: drift(1_000).records, peerRecords: paths } }, tags: ['c01'],
    window: { startMs: 0, endMs: 1_000 }, segmentSeconds });
}

function trap(segmentSeconds) {
  return { segmentSeconds, declaredClientTags: [], clients: {}, window: { startMs: 0, endMs: 1_000 },
    seek: { host: { version: 1, positionMs: 8_000, atSharedMs: 0 } } };
}

export default async function segmentSecondsSuite() {
  await check('segment seconds: bytes and one-viewing readers take 4s and 1s explicitly', async () => {
    // At 4 s, 8,000 ms covers two whole segments: 100 + 200 = 300 bytes.
    assertEqual(bytesForStretch(0, 8_000, FOUR_SIZES, 4), 300, '4s stretch sums two segments');
    assertEqual(oneViewing(4, FOUR_SIZES).oneViewingBytesInWindow, 300, 'one-viewing 4s sum');
    // At 1 s, 8,000 ms covers all eight segments: 100+200+...+800 = 3,600 bytes.
    assertEqual(bytesForStretch(0, 8_000, ONE_SIZES, 1), 3_600, '1s stretch sums eight segments');
    assertEqual(oneViewing(1, ONE_SIZES).oneViewingBytesInWindow, 3_600, 'one-viewing 1s sum');
  });

  await check('segment seconds: held-ahead, recovery bars and media ratio scale at 4s and 1s', async () => {
    // A complete current segment at position 0 leaves 4,000 ms at 4 s and 1,000 ms at 1 s.
    assertEqual(held(4).heldAheadMsMedianByClient.c01, 4_000, 'held-ahead 4s');
    assertEqual(held(1).heldAheadMsMedianByClient.c01, 1_000, 'held-ahead 1s');
    const recovery = (segmentSeconds) => recoverySpans({ input: { segmentSeconds, declaredClientTags: [], clients: {}, viewerPolls: {},
      condition: { bars: BARS } }, transition: 0, recordingEnd: 60_000 }).spans[0].bars;
    // Widening is 2*1*L*1000/60000: 0.133333... at 4s and 0.033333... at 1s.
    assertNear(widenedBars(BARS, 60_000, 1, 4).downloadRatioMin, 0.8166666666666667, 1e-12, 'widened 4s lower bar');
    assertNear(recovery(1).downloadRatioMin, 0.9166666666666666, 1e-12, 'recovery 1s lower bar');
    assertNear(mediaTimeRatio({ completedSegmentsByClient: { c01: 2 }, playedMediaMsByClient: { c01: { start: 0, end: 8_000 } } }, ['c01'], 4).c01, 1, 0, 'media ratio 4s');
    assertNear(mediaTimeRatio({ completedSegmentsByClient: { c01: 8 }, playedMediaMsByClient: { c01: { start: 0, end: 8_000 } } }, ['c01'], 1).c01, 1, 0, 'media ratio 1s');
  });

  await check('segment seconds: seek readers map 6,000,000 ms and the landing at both lengths', async () => {
    // floor(6,000,000 / (4*1000)) = 1,500; floor(6,000,000 / (1*1000)) = 6,000.
    assertEqual(segmentAtMediaPosition(6_000_000, 4), 'seg-01500.m4s', 'qualification 4s segment');
    assertEqual(segmentAtMediaPosition(6_000_000, 1), 'seg-06000.m4s', 'qualification 1s segment');
    // floor(8,000 / (4*1000)) = 2 and floor(8,000 / (1*1000)) = 8.
    assertEqual(trapFigures(trap(4)).landingSegment, 2, 'trap landing 4s');
    assertEqual(trapFigures(trap(1)).landingSegment, 8, 'trap landing 1s');
    const applied = (segmentSeconds) => appliedSeekEvidence({ segmentSeconds, host: { lineage: 'l', version: 1, positionMs: 8_000, atSharedMs: 0 }, declaredClientTags: [] });
    assertEqual(applied(4).landingSegment, 2, 'applied seek 4s');
    assertEqual(applied(1).landingSegment, 8, 'applied seek 1s');
    assertEqual(segmentNameForMediaPosition(6_000_000, 4), 'seg-01500.m4s', 'goodput 4s segment');
    assertEqual(segmentNameForMediaPosition(6_000_000, 1), 'seg-06000.m4s', 'goodput 1s segment');
  });

  await check('segment seconds: callers pass the manifest length to steady readers', async () => {
    const input = { segmentSeconds: 1, content: { segmentSizes: [100] },
      window: { startMs: 0, endMs: 1_000 }, condition: { bars: BARS },
      clients: { c01: { records: drift(1_000).records, receipts: [
        { url: '/media/seg-00000.m4s', finished: true, canceled: false, endMs: 1_000, bodyBytes: 100 },
      ] } } };
    const noP2p = computeNoP2pSteady({ input, tags: ['c01'], figures: {
      uplinkUtilisationMean: 0, realtimeFactorByClient: { c01: 1 },
    } });
    assertEqual(noP2p.oneViewingBytesInWindow, 100, 'no-p2p caller forwards segment length');
  });

  await check('segment seconds: every listed reader refuses an absent length', async () => {
    const cases = [
      () => bytesForStretch(0, 1, [1]),
      () => oneViewing(undefined, [1]),
      () => computeHeldAhead({ clients: {}, tags: [], window: { startMs: 0, endMs: 1_000 } }),
      () => widenedBars(BARS, 60_000, 1),
      () => recoverySpans({ input: { condition: { bars: BARS } }, transition: 0, recordingEnd: 60_000 }),
      () => mediaTimeRatio({}, []),
      () => appliedSeekEvidence({ host: { lineage: 'l', version: 1, positionMs: 0, atSharedMs: 0 }, declaredClientTags: [] }),
      () => trapFigures(trap(undefined)),
      () => segmentAtMediaPosition(0),
      () => segmentNameForMediaPosition(0),
    ];
    for (const [index, invoke] of cases.entries()) {
      let thrown = null;
      try { invoke(); } catch (error) { thrown = error; }
      assertEqual(thrown?.message, 'segment-seconds-unavailable', `reader ${index + 1} refuses missing length`);
    }
  });
}
