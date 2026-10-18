import { assert, assertEqual, check } from '../harness.mjs';
import { buildHostStatusEnvelope, readHostStatus } from '../../../public/lib/envelope.mjs';
import { STATUS_INTERVAL_MS, createHostStatusBook, ownHostStatus, statusDue } from '../../../public/lib/host-status.mjs';

const roster = [{ clientId: 'h', role: 'host' }, { clientId: 'v', role: 'viewer' }];

export default async function hostStatusSuite() {
  await check('host-status: envelope reader accepts only the two exact payload shapes', async () => {
    const preparing = buildHostStatusEnvelope({ state: 'preparing', fraction: 0.4 });
    preparing.from = 'h';
    const ready = buildHostStatusEnvelope({ state: 'ready', fraction: 0.4 });
    ready.from = 'h';
    const choosing = buildHostStatusEnvelope({ state: 'choosing', fraction: 0.4 });
    choosing.from = 'h';
    assertEqual(JSON.stringify(preparing.payload), JSON.stringify({ state: 'preparing', fraction: 0.4 }), 'preparing payload shape');
    assertEqual(JSON.stringify(readHostStatus(preparing)), JSON.stringify({ from: 'h', state: 'preparing', fraction: 0.4 }), 'preparing report');
    assertEqual(JSON.stringify(ready.payload), JSON.stringify({ state: 'ready' }), 'ready payload shape');
    assertEqual(JSON.stringify(readHostStatus(ready)), JSON.stringify({ from: 'h', state: 'ready', fraction: null }), 'ready report');
    assertEqual(JSON.stringify(choosing.payload), JSON.stringify({ state: 'choosing' }), 'choosing payload shape');
    assertEqual(JSON.stringify(readHostStatus(choosing)), JSON.stringify({ from: 'h', state: 'choosing', fraction: null }), 'choosing report');
    const invalid = [
      { state: 'preparing', fraction: -0.01 }, { state: 'preparing', fraction: 1.01 }, { state: 'preparing', fraction: NaN },
      { state: 'preparing', fraction: '0.4' }, { state: 'preparing' }, { state: 'ready', fraction: 1 },
      { state: 'choosing', fraction: null }, { state: 'choosing', reason: 'x' },
      { state: 'choosing', fraction: 0 }, { state: 'choosing', name: 'a' }, { state: 'choosing', extra: true },
      { state: 'waiting', fraction: 0.4 }, { state: 'preparing', fraction: 0.4, extra: true },
    ];
    for (const payload of invalid) assertEqual(readHostStatus({ from: 'h', payload }), null, `rejects ${JSON.stringify(payload)}`);
    for (const from of [undefined, '']) assertEqual(readHostStatus({ from, payload: { state: 'ready' } }), null, 'rejects missing or empty from');
    assertEqual(readHostStatus({ from: 'h', payload: [] }), null, 'rejects an array payload');
  });

  await check('host-status: only the roster host is believed', async () => {
    const book = createHostStatusBook();
    assertEqual(book.accept({ from: 'h', state: 'preparing', fraction: 0.4 }, roster, 10), 'believed', 'host report is believed');
    assertEqual(JSON.stringify(book.current(roster)), JSON.stringify({ hostId: 'h', state: 'preparing', fraction: 0.4, identity: null, name: null, atMs: 10 }), 'host status is current');
    assertEqual(book.accept({ from: 'v', state: 'ready', fraction: null }, roster, 20), 'disbelieved', 'viewer report is disbelieved');
    assertEqual(book.counts().disbelieved, 1, 'disbelief is counted');
    assertEqual(book.current(roster).state, 'preparing', 'viewer cannot replace host status');
    assertEqual(book.current([{ clientId: 'v', role: 'viewer' }]).state, 'unknown', 'departed host makes status unknown');
    assertEqual(book.current([{ clientId: 'h2', role: 'host' }]).state, 'unknown', 'new host makes old status unknown');
    assertEqual(book.counts().received, 1, 'only the host report is received');
  });

  await check('host-status: advancing progress is sent about once a second', async () => {
    assertEqual(statusDue({ nowMs: 10, last: { state: 'ready' }, next: { state: 'choosing', fraction: null } }), true, 'choosing state change is due immediately');
    assertEqual(statusDue({ nowMs: 10, last: { state: 'choosing', fraction: null }, next: { state: 'choosing', fraction: null } }), false, 'constant choosing status is not repeated');
    let last = null;
    const sends = [];
    for (let nowMs = 0; nowMs <= 20_000; nowMs += 20) {
      const next = nowMs === 20_000 ? { state: 'ready', fraction: null } : { state: 'preparing', fraction: nowMs / 20_000 };
      if (statusDue({ nowMs, last, next })) {
        sends.push({ ...next, atMs: nowMs });
        last = sends.at(-1);
      }
    }
    const preparing = sends.filter((send) => send.state === 'preparing');
    assert(preparing.length > 1, 'advancing progress has multiple sends');
    assert(preparing.every((send, i) => i === 0 || send.fraction >= preparing[i - 1].fraction), 'sent fractions do not decrease');
    assert(preparing.slice(1).every((send, i) => send.atMs - preparing[i].atMs >= STATUS_INTERVAL_MS && send.atMs - preparing[i].atMs <= 2000), 'progress cadence is bounded');
    assertEqual(JSON.stringify(sends.at(-1)), JSON.stringify({ state: 'ready', fraction: null, atMs: 20_000 }), 'ready is sent at the boundary');
    let heldLast = null;
    const heldSends = [];
    for (let nowMs = 0; nowMs <= 20_000; nowMs += 20) {
      const next = { state: 'preparing', fraction: 0.4 };
      if (statusDue({ nowMs, last: heldLast, next })) {
        heldSends.push({ ...next, atMs: nowMs });
        heldLast = heldSends.at(-1);
      }
    }
    assertEqual(heldSends.length, 1, 'constant progress sends only once');
  });

  await check('host-status: own status maps media source and file states', async () => {
    const expected = { state: 'ready', fraction: null };
    assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'dir', hostFile: null })), JSON.stringify(expected), 'dir is ready');
    assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'file', hostFile: null })), JSON.stringify({ state: 'choosing', fraction: null }), 'missing file is choosing');
    for (const state of ['starting', 'awaiting-file', 'refused', 'failed']) assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'file', hostFile: { state } })), JSON.stringify({ state: 'choosing', fraction: null }), `${state} is choosing`);
    assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'file', hostFile: { state: 'inspecting' } })), JSON.stringify({ state: 'preparing', fraction: 0 }), 'inspecting is preparing zero');
    assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'file', hostFile: { state: 'preparing', fraction: 0.4 } })), JSON.stringify({ state: 'preparing', fraction: 0.4 }), 'preparing keeps its fraction');
    assertEqual(JSON.stringify(ownHostStatus({ mediaSource: 'file', hostFile: { state: 'ready', fraction: 0.4, manifest: { identity: `v1:${'a'.repeat(64)}` } } })), JSON.stringify({ ...expected, identity: `v1:${'a'.repeat(64)}` }), 'ready carries its identity and clears its fraction');
  });
}
