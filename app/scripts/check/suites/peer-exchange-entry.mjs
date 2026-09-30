import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function loadEvent(page) {
  return page.events.find((event) => event.kind === 'load')?.detail;
}

export default async function peerExchangeEntrySuite() {
  const product = await bundleProductEntry();

  await check('peer-exchange-entry case 1: a viewer without a tracker stays on HTTP', async () => {
    const page = runEntry(product.code, { role: 'viewer', settings: { delivery: 'host', iceServers: [], trackerUrl: null } });
    await drain();
    page.open({});
    assertEqual(loadEvent(page).p2p, null, 'case 1 load has no p2p engine');
    assertEqual(page.app.peerExchange(), 'off', 'case 1 peer exchange is off');
    assertEqual(JSON.stringify(page.app.peerBytes()), JSON.stringify({ attribution: null, peerExchange: 'off', peerId: null, peerIds: [] }), 'case 1 publishes the stub');
    // T10 prevention claim: stage the work, then mutate execute() to derive
    // p2p from delivery + role while dropping the tracker requirement. The
    // 'case 1 load has no p2p engine' assertion goes red; restore the one-value
    // roomHasPeerExchange derivation and check green again.
  });

  await check('peer-exchange-entry case 2: a tracked viewer receives the configured engine', async () => {
    const trackerUrl = 'ws://tracker.test:1';
    const iceServers = [{ urls: 'stun:stun.test:3478' }];
    const page = runEntry(product.code, { role: 'viewer', settings: { delivery: 'host', iceServers, trackerUrl } });
    await drain();
    page.open({});
    const p2p = loadEvent(page).p2p;
    assert(p2p && p2p.core, 'case 2 load has p2p config');
    assertEqual(JSON.stringify(p2p.core), JSON.stringify(peerEngineConfig({ roomId: 'r', trackerUrl, iceServers }).core), 'case 2 engine config is exact');
    assertEqual(page.app.peerExchange(), 'on', 'case 2 peer exchange is on');
    assertEqual(JSON.stringify(page.app.peerBytes()), JSON.stringify({ attribution: null, peerExchange: 'on', peerId: null, peerIds: [] }), 'case 2 publishes the stub until an engine is attached');
  });

  await check('peer-exchange-entry case 3: a host never receives a peer engine', async () => {
    const page = runEntry(product.code, { role: 'host', settings: { delivery: 'host', iceServers: [], trackerUrl: 'ws://tracker.test:1' } });
    await drain();
    page.open({});
    assertEqual(loadEvent(page).p2p, null, 'case 3 host load has no p2p engine');
    assertEqual(page.app.peerExchange(), 'host', 'case 3 peer exchange identifies the host');
    assertEqual(JSON.stringify(page.app.peerBytes()), JSON.stringify({ attribution: null, peerExchange: 'host', peerId: null, peerIds: [] }), 'case 3 publishes the host stub');
  });
}
