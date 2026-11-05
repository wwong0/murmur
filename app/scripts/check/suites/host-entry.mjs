// scripts/check/suites/host-entry.mjs
//
// The entry's own host-delivery wiring, run as a page load: where the page
// reads its delivery setting, and which presence may close a host's viewer
// peers. The link and the origin have their own suites.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

async function drain() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakePeerFactory(peers) {
  return class FakePeer {
    constructor() {
      this.closed = false;
      peers.push(this);
    }

    addEventListener() {}

    async setRemoteDescription() {}

    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }

    async setLocalDescription() {}

    async addIceCandidate() {}

    close() { this.closed = true; }
  };
}

export default async function hostEntrySuite() {
  const product = await bundleProductEntry();

  await check('host-entry: a page without fetch refuses to start rather than guessing a delivery', async () => {
    const page = runEntry(product.code, { settings: null });
    await drain();
    assertEqual(page.count('connect'), 0, 'a page without fetch does not connect');
    assert(page.notices().some((text) => text.includes('settings unavailable: fetch is unavailable')), 'a page without fetch says its settings are unavailable');
    // Mutation, 2026-09-23: the `{ delivery: 'host' }` fallback restored turned
    // 'a page without fetch does not connect' red; restored, green.
  });

  await check('host-entry: a member-relayed presence does not close a host\'s viewer peer', async () => {
    const peers = [];
    const page = runEntry(product.code, {
      settings: { delivery: 'host', iceServers: [] },
      globals: { RTCPeerConnection: fakePeerFactory(peers) },
    });
    await drain();
    assertEqual(page.app.delivery(), 'host', 'the page runs host delivery');
    const host = { clientId: 'h1', tabId: 't', role: 'host', joinedAt: 1 };
    const viewer = { clientId: 'v1', tabId: 'c01', role: 'viewer', joinedAt: 2 };
    page.harness.clientId = 'h1';
    page.harness.role = 'host';
    page.harness.roster = [host, viewer];
    page.emit('joined', { clientId: 'h1', role: 'host', seq: 1, roster: [host, viewer] });
    await drain();
    page.deliver({ type: 'host-link-offer', from: 'v1', payload: { linkId: 'L1', sdp: 'offer' } });
    await drain();
    assertEqual(peers.length, 1, 'the viewer offer opens one host peer');

    page.deliver({ type: 'presence', from: 'v2', payload: { event: 'leave', member: host, roster: [host] } });
    assertEqual(peers[0].closed, false, 'a member-relayed presence leaves the viewer peer open');
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'leave', member: viewer, roster: [host] } });
    assertEqual(peers[0].closed, true, 'the server presence of the viewer leaving closes its peer');
    // Mutation, 2026-09-23: the entry's presence handler without its
    // `env.from === ADDR_SERVER` guard turned 'a member-relayed presence leaves
    // the viewer peer open' red; restored, green.
  });
}
