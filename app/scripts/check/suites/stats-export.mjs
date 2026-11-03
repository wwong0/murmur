import { check, assert, assertEqual } from '../harness.mjs';
import { buildStatsExport, CLOSED_SETS } from '../../../public/lib/stats-export.mjs';
import { createStallLog } from '../../../public/lib/stall-log.mjs';
import { driftLineForm } from '../../../public/lib/drift-readout.mjs';
import { FAULT_REASONS, TREATMENT_FAULT_MODE } from '../../../public/lib/playback-treatment.mjs';

const seeded = ['zephyr-quay-17', 'Ottoline', 'Brannock', 'marmalade-orbit', 'c-77aa', 'c-88bb', 'tq9x2', 'tr3y8', 'peerAAA111', 'peerBBB222', '203.0.113.45', 'https://example.invalid/?room=zephyr-quay-17'];
const driftLine = 'drift: +1.0ms · rolling window over the last 2 frames: median +1.0ms, p99 +2.0ms';
function sources() {
  return {
    build: seeded[0], role: 'viewer', nowMs: 100, timeOriginMs: 1000,
    lines: { bytes: `bytes: ${seeded[0]}`, drift: driftLine },
    driftSummary: { framesHeld: 2, medianDriftMs: 1.5 },
    driftRead: { missed: 0, counters: { framesOffered: 2 }, records: [{ seq: 1, displaySharedMs: 1500, clock: { offsetMs: 25 } }] },
    peerBytes: { peerExchange: 'on', attribution: 'engine-request', peerId: seeded[8], peerIds: [seeded[8]], connected: [seeded[9]], chunkBytes: { p2p: { [seeded[8]]: 11, [seeded[9]]: 22 } }, uploadBytes: { [seeded[8]]: 33, [seeded[9]]: 44 }, kept: { hostBytes: 55, peerBytes: 66 } },
    controller: { mode: seeded[5], lastDrop: seeded[1], extra: seeded[1] },
    playback: { waiting: seeded[2] },
    notices: [
      { text: '[10:00:00] joined as c-77aa (viewer)' },
      { text: '[10:00:01] presence: join — tq9x2' },
      { text: '[10:00:02] refused (tab-taken): tabId "tr3y8" is in use in room "zephyr-quay-17"' },
      { text: '[10:00:03] urgent request: https://example.invalid/?room=zephyr-quay-17' },
      { text: '[10:00:04] settings unavailable: 203.0.113.45' },
      { text: '[10:00:05] Ottoline marmalade-orbit Brannock' },
    ],
  };
}

export default async function statsExportSuite() {
  await check('S1 nothing identifying', async () => {
    const result = buildStatsExport(sources());
    const text = JSON.stringify(result);
    for (const value of seeded) assert(!text.includes(value), `export contains ${value}`);
    assertEqual(result.lines.bytes, null, 'unknown bytes line');
    assertEqual(result.controller.mode, 'other', 'unknown controller mode');
  });
  await check('S2 real figures carried', async () => {
    const source = sources();
    const result = buildStatsExport(source);
    assertEqual(JSON.stringify(result.bytes.peers), JSON.stringify([{ peer: 1, receivedBytes: 11, uploadedBytes: 33 }, { peer: 2, receivedBytes: 22, uploadedBytes: 44 }]), 'peer totals');
    assertEqual(result.drift.summary.medianDriftMs, source.driftSummary.medianDriftMs, 'median');
    assert(driftLineForm(driftLine) !== null, 'valid drift line');
    assertEqual(result.lines.drift, driftLine, 'drift line');
    assertEqual(JSON.stringify(result.notices.map((notice) => notice.kind)), JSON.stringify(['joined', 'presence-join', 'refused', 'urgent-request', 'settings-unavailable', 'other']), 'notice kinds');
    assertEqual(result.drift.records[0].atMs, 475, 'page-relative time');
  });
  await check('S3 every string is allowed', async () => {
    const result = buildStatsExport(sources());
    const allowed = new Set(['murmur-stats-1', 'other', ...Object.values(CLOSED_SETS).flatMap((set) => [...set])]);
    function walk(value, key) {
      if (typeof value === 'string') {
        assert(allowed.has(value) || (key === 'drift' && driftLineForm(value) !== null) || (key === 'build' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-z]+$/.test(value)), `unexpected string ${value}`);
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
      }
    }
    walk(result, '');
  });
  await check('S5 the treatment-fault copies equal playback-treatment.mjs', async () => {
    assert(CLOSED_SETS.mode.has(TREATMENT_FAULT_MODE), `mode set lacks ${TREATMENT_FAULT_MODE}`);
    for (const reason of FAULT_REASONS) assert(CLOSED_SETS.reason.has(reason), `reason set lacks ${reason}`);
  });
  await check('S4 stall log', async () => {
    for (const capacity of [100, 1]) {
      const log = createStallLog({ capacity });
      log.waiting(100); log.resumed(350); log.waiting(400); log.waiting(450); log.resumed(500); log.resumed(600);
      const result = log.read();
      assertEqual(result.count, 2, 'count'); assertEqual(result.totalMs, 350, 'duration');
      assertEqual(result.evicted, capacity === 1 ? 1 : 0, 'evicted');
      assertEqual(JSON.stringify(result.records), JSON.stringify(capacity === 1 ? [{ atMs: 400, durationMs: 100 }] : [{ atMs: 100, durationMs: 250 }, { atMs: 400, durationMs: 100 }]), 'records');
    }
  });
}
