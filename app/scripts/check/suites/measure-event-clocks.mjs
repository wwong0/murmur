import { assertEqual, check } from '../harness.mjs';
import { eventClocks } from '../../measure/event-clocks.mjs';

function drift(L, mediaMs) { return { displaySharedMs: L, mediaMs, clock: { offsetMs: 0 } }; }
function joinEvidence() {
  const values = Array.from({ length: 101 }, (_, index) => index * 100);
  const joiner = values.filter((L) => L < 1_000 || L >= 1_800).map((L) => drift(L, L < 3_300 ? L - 100 : L));
  const other = values.map((L) => drift(L, L));
  return { run: 'join', tags: ['c01', 'c02'], manifest: { content: { frameRate: 10 }, window: { startMs: 0, endMs: 10_000 } },
    rosterEvent: { kind: 'join', client: 'c01', presence: { recvSharedMs: 1_000 } },
    clients: { c01: { drift: joiner }, c02: { drift: other } } };
}
function cutEvidence(victim = 'c01') {
  return { run: 'cut', tags: ['c01', 'c02'], timebase: { offsetMs: 0, wallOffsetMs: 0 }, manifest: { clients: { c01: { peerId: 'peer-a' }, c02: { peerId: 'peer-b' } } },
    rosterEvent: { kind: 'leave-supplier-silent', victim, issuedAtHarnessMs: 2_000,
      selection: { segment: { index: 1, path: '/media/seg-00001.m4s' } } },
    clients: { c01: { peerBytes: [{ kind: 'attempt', source: 'http', path: '/media/seg-00001.m4s', startMs: 1_000, endMs: 2_500 }] },
      c02: { peerBytes: [{ kind: 'attempt', attemptId: 2, source: 'p2p', peerId: 'peer-a', path: '/media/seg-00001.m4s' },
        { kind: 'segment', path: '/media/seg-00001.m4s', keptAttemptIds: [2] }] , polls: [], drift: [] } } };
}

export default async function measureEventClocksSuite() {
  await check('measurement event clocks: join intervals', async () => {
    const result = eventClocks(joinEvidence()).join;
    assertEqual(result.entryToFirstFrameMs, 800, 'entry to first frame');
    assertEqual(result.firstFrameToInSyncMs, 1_500, 'first frame to held sync');
    assertEqual(result.entryToInSyncMs, 2_300, 'entry to held sync');
  });

  await check('measurement event clocks: a joiner two frames off at 24 fps never syncs', async () => {
    const step = 1000 / 24;
    const frames = Array.from({ length: 480 }, (_, k) => k);
    const fixture = { run: 'join', tags: ['c01', 'c02'], manifest: { content: { frameRate: 24 }, window: { startMs: 0, endMs: 20_000 } },
      rosterEvent: { kind: 'join', client: 'c01', presence: { recvSharedMs: 1_000 } },
      clients: { c01: { drift: frames.filter((k) => k * step >= 1_200).map((k) => drift(k * step, (k - 2) * step)) },
        c02: { drift: frames.map((k) => drift(k * step, k * step)) } } };
    const result = eventClocks(fixture).join;
    assertEqual(result.entryToInSyncMs, null, 'two frames (83.3 ms) off is never in sync');
    assertEqual(result.reason, 'not-within-observation', 'and says why');
  });

  await check('measurement event clocks: supplier replacement and unreadable cut', async () => {
    const result = eventClocks(cutEvidence()).supplierCut;
    assertEqual(result.victimVerified, true, 'victim evidence is rechecked');
    assertEqual(result.replacement.c02[1], 'c01', 'peer id resolves to supplier tag');
    assertEqual(eventClocks(cutEvidence(null)).supplierCut.reason, 'no-active-supplier', 'null victim is unreadable');
  });
}
