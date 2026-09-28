import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { computeSpanCourse } from '../../figures/span-course.mjs';

function input() {
  const records = [
    { displaySharedMs: 0, mediaMs: 0 }, { displaySharedMs: 20_000, mediaMs: 20_000 },
    { displaySharedMs: 65_000, mediaMs: 20_000 },
  ];
  const attempts = [
    { kind: 'attempt', attemptId: 1, path: '/media/seg-00000.m4s', source: 'http', bytes: 100, endMs: 61_000, end: 'loaded' },
    { kind: 'attempt', attemptId: 2, path: '/media/seg-00005.m4s', source: 'p2p', bytes: 100, endMs: 62_000, end: 'loaded', peerId: 'peer' },
    { kind: 'segment', path: '/media/seg-00000.m4s', lengthBytes: 100, completedAtMs: 61_000, keptAttemptIds: [1] },
    { kind: 'segment', path: '/media/seg-00005.m4s', lengthBytes: 100, completedAtMs: 62_000, keptAttemptIds: [2] },
  ];
  return {
    declaredClientTags: ['c01'], clients: { c01: { records, peerRecords: attempts, polls: [] } },
    window: { clientsReadyAtMs: 0, startMs: 30_000, endMs: 65_000 }, content: { frameRate: 24, segmentSizes: Array(6).fill(100) }, segmentSeconds: 4,
    condition: { capacityMbps: 20 }, capacityBitsPerSecond: 20_000_000,
    capacityStep: { stepAtMs: 20_000, readBackAtMs: 40_000, before: { rate: { got: 20_000_000 } }, readBack: { rate: { got: 5_000_000 } }, declared: { params: { rate: '5mbit' } } },
    seek: { landingMs: 20_000, effectiveSharedMs: 30_000, host: { positionMs: 20_000, atSharedMs: 30_000 } },
    linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 30_000, txBytes: 15_000_000 }, { atMs: 40_000, txBytes: 20_000_000 }, { atMs: 60_000, txBytes: 30_000_000 }, { atMs: 65_000, txBytes: 32_500_000 }],
  };
}

export default async function spanCourseSuite() {
  await check('T6: span course has a pre-step span, weighted straddling capacity and a partial tail', async () => {
    const result = computeSpanCourse(input());
    assertEqual(result.label, 'diagnostic-undeclared-spans', 'course is diagnostic');
    assertEqual(result.spans.length, 3, 'course covers two full spans and a partial tail');
    assertEqual(result.spans[0].partial, false, 'first span is full');
    assertNear(result.spans[0].uplinkUtilisationMean, 0.2, 1e-12, 'pre-step span uses 20 Mbit/s');
    assertNear(result.spans[1].uplinkUtilisationMean, 0.4, 1e-12, 'straddling span uses read-back weighted capacity');
    assertEqual(result.spans[2].partial, true, 'final span is marked partial');
  });

  await check('T6: post-seek span keeps pre-landing segments apart', async () => {
    const result = computeSpanCourse(input());
    const after = result.spans[2];
    assert(after.preLandingSegmentsByClient.c01.count === 1, 'post-seek pre-landing segment is listed');
    assertNear(after.peerFractionAggregate, 1, 0, 'post-seek fraction excludes pre-landing bytes');
  });
}
