import { assertEqual, check } from '../harness.mjs';
import { byteInventory } from '../../measure/byte-inventory.mjs';

function evidence({ missing = false, giant = false, end = 1_000 } = {}) {
  const sizes = giant ? [4_294_967_296] : [100, 200, 300, 400];
  const tags = ['c01', 'c02'];
  const drift = [{ displaySharedMs: 100, mediaMs: 100, clock: { offsetMs: 0 } }];
  const peerBytes = [
    { kind: 'attempt', source: 'http', path: '/media/seg-0.m4s', bytes: 300, end: 'abort' },
    { kind: 'attempt', source: 'p2p', peerId: 'peer-a', path: '/media/seg-1.m4s', bytes: 1_000, end: 'loaded' },
    ...sizes.map((_, index) => ({ kind: 'segment', path: `/media/seg-${index}.m4s`, lengthBytes: sizes[index], completedAtMs: index * 100, keptAttemptIds: [] })),
  ];
  const clients = Object.fromEntries(tags.map((tag) => [tag, { drift, peerBytes: missing && tag === 'c02' ? null : tag === 'c01' ? peerBytes : [
    { kind: 'attempt', source: 'p2p', peerId: 'peer-a', path: '/media/seg-1.m4s', bytes: 1_000, end: 'loaded' },
    { kind: 'segment', path: '/media/seg-1.m4s', lengthBytes: 200, completedAtMs: 200 },
    { kind: 'segment', path: '/media/seg-2.m4s', lengthBytes: 201, completedAtMs: 300 },
  ], polls: [{ atMs: end, clock: { offsetMs: 0 } }], receipts: [] }]));
  return { run: 'bytes', manifest: { window: { startMs: 0, endMs: end }, clients: { c01: { peerId: 'peer-a', driftLogMissed: 0, peerLogHealth: { missed: 0 } }, c02: { peerId: 'peer-b', driftLogMissed: 0, peerLogHealth: { missed: 0 } } } },
    content: { segmentSizes: sizes, segmentDurations: sizes.map(() => 1) }, tags, timebase: { offsetMs: 0, wallOffsetMs: 0 },
    hostPoll: [{ harnessAfterMs: end }], originLink: [{ atMs: 0, txBytes: 1 }, { atMs: end, txBytes: 2 }], clients };
}

export default async function measureBytesSuite() {
  await check('measurement bytes: host, peer upload and watched inventory', async () => {
    const result = byteInventory(evidence());
    assertEqual(result.viewers.c01.uploadBytes, 1_000, 'peer id attributes upload to c01');
    assertEqual(result.viewers.c01.p2pBytes, 1_000, 'peer attempt counts for receiver');
    assertEqual(result.viewers.c01.watchedBytes, 100, 'presented segment is watched');
    assertEqual(result.room.hostMediaBytes, 300, 'aborted host attempt bytes count');
    assertEqual(result.agreement.segmentLengthMismatches.count, 1, 'one segment length mismatch is counted');
    assertEqual(result.finalFlush.status, 'met', 'flush at exactly one second is met');
  });

  await check('measurement bytes: missing streams and storage limit are explicit', async () => {
    assertEqual(byteInventory(evidence({ missing: true })).reason, 'stream-missing', 'missing peer stream refuses');
    const giant = byteInventory(evidence({ giant: true }));
    assertEqual(giant.viewers.c01.peakStoredBytes, null, 'storage at the limit is unreadable');
    assertEqual(giant.viewers.c01.peakReason, 'eviction-possible', 'storage refusal names eviction');
  });
}
