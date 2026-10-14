import { assertEqual, assertNear, check } from '../harness.mjs';
import { computeHeldAhead } from '../../figures/held-ahead.mjs';

function drift(records) { return { records }; }
function segment(index, completedAtMs = -1) {
  return { kind: 'segment', path: `/media/seg-${String(index).padStart(5, '0')}.m4s`, lengthBytes: 1, completedAtMs };
}

export default async function heldAheadSuite() {
  await check('T5(a): contiguous completed segments make 42 seconds with 10-14 equal 18 seconds', async () => {
    const records = [
      { displaySharedMs: 0, mediaMs: 42_000 }, { displaySharedMs: 1_000, mediaMs: 43_000 },
    ];
    const peerRecords = [10, 11, 12, 13, 14, 16].map((index) => segment(index));
    const clients = { c01: { records, peerRecords } };
    const result = computeHeldAhead({ tags: ['c01'], window: { startMs: 0, endMs: 1_000 }, segmentSeconds: 4,
      clients, input: { clients, declaredClientTags: ['c01'], window: { startMs: 0, endMs: 1_000 } } });
    assertNear(result.heldAheadMsMedianByClient.c01, 18_000, 0, 'gap after segment 14 ends the held run');
  });

  await check('T5(b): spread is the widest pair and is rounded to 100 ms', async () => {
    const clients = Object.fromEntries([
      ['c01', 100_000], ['c02', 101_500], ['c03', 103_000],
    ].map(([tag, mediaMs]) => [tag, drift([{ displaySharedMs: 0, mediaMs }, { displaySharedMs: 1_000, mediaMs }])]));
    const result = computeHeldAhead({ tags: ['c01', 'c02', 'c03'], window: { startMs: 0, endMs: 1_000 }, segmentSeconds: 4, clients,
      input: { clients: Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, { ...client, peerRecords: [] }])), declaredClientTags: ['c01', 'c02', 'c03'], window: { startMs: 0, endMs: 1_000 } } });
    assertNear(result.positionSpreadMsMedian, 3_000, 0, 'spread is max minus min');
    assertEqual(result.positionSpreadSecondsUsed, 1, 'one complete second contributes');
  });

  await check('T5(c): a parked viewer holds L, while a pre-seek unbracketed second is unavailable', async () => {
    const input = {
      declaredClientTags: ['c01', 'c02'], window: { startMs: 0, endMs: 3_000 }, segmentSeconds: 4,
      seek: { landingMs: 100_000, effectiveSharedMs: 1_500, viewers: {} },
      clients: {
        c01: { records: [{ displaySharedMs: 0, mediaMs: 90_000 }, { displaySharedMs: 1_000, mediaMs: 91_000 }, { displaySharedMs: 2_000, mediaMs: 101_000 }], peerRecords: [] },
        c02: { records: [{ displaySharedMs: 0, mediaMs: 90_000 }], peerRecords: [] },
      },
    };
    const result = computeHeldAhead({ input, clients: input.clients, tags: input.declaredClientTags,
      window: input.window, segmentSeconds: input.segmentSeconds });
    assertEqual(result.positionsByClient.c02[2], 100_000, 'parked viewer uses L after E');
    assertEqual(result.positionUnavailableSecondsByClient.c02, 1, 'unbracketed pre-seek second is counted unavailable');
  });
}
