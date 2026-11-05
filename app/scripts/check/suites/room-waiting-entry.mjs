// The view values behind the viewer's waiting card and the reconnecting pill, through the real
// entry. The card and the pill themselves are components the harness fakes.

import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const HOST = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
const VIEWER = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };

async function drain() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function sessionStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

// Enough browser for a file host to open and wait for a pick, which it reports as `choosing`.
function fileHostGlobals() {
  const root = { getDirectoryHandle() { const error = new Error('missing'); error.name = 'NotFoundError'; throw error; } };
  return {
    sessionStorage: sessionStorage(),
    MediaSource: { isTypeSupported: () => true },
    TextEncoder,
    TextDecoder,
    navigator: {
      storage: { getDirectory: async () => root, estimate: async () => ({ quota: 10_000_000, usage: 0 }) },
      locks: { request: async (name, options, callback) => callback(null) },
    },
    Worker: class { addEventListener() {} postMessage() {} },
  };
}

function settingsFor(delivery, mediaSource) {
  return { delivery, iceServers: [], mediaSource, targetSegmentSeconds: 2, autoStart: false };
}

export default async function roomWaitingEntrySuite() {
  const product = await bundleProductEntry();

  await check('room-waiting-entry: connection is connecting until a connect, then reconnecting after a loss and connected after the next connect', async () => {
    const page = runEntry(product.code);
    assertEqual(page.view().connection, 'connecting', 'before any connect');
    page.emit('status', { connected: false });
    assertEqual(page.view().connection, 'connecting', 'a lost first attempt is not a reconnect');
    page.emit('status', { connected: true });
    assertEqual(page.view().connection, 'connected', 'the first connect');
    page.emit('status', { connected: false });
    assertEqual(page.view().connection, 'reconnecting', 'a disconnect after a connect');
    page.emit('status', { connected: false });
    assertEqual(page.view().connection, 'reconnecting', 'a second disconnect keeps it');
    page.emit('status', { connected: true });
    assertEqual(page.view().connection, 'connected', 'the next connect');
  });

  await check('room-waiting-entry: a close the page will not retry never reads reconnecting', async () => {
    const superseded = runEntry(product.code);
    superseded.emit('status', { connected: true });
    superseded.emit('status', { connected: false, superseded: true });
    assertEqual(superseded.view().connection, 'connected', 'a superseded page is not trying');

    const refused = runEntry(product.code);
    refused.emit('status', { connected: true });
    refused.emit('refused', { code: 'host-taken', detail: 'the room already has a host' });
    refused.emit('status', { connected: false });
    assertEqual(refused.view().connection, 'connected', 'a page refused for good is not trying');
  });

  await check('room-waiting-entry: a file host is host side while it chooses, and never renders as a viewer first', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      search: '?room=r&role=host&tab=h',
      settings: settingsFor('host', 'file'),
      globals: fileHostGlobals(),
    });
    const frames = [];
    page.screens().view.subscribe((key, snapshot) => frames.push({ hostSide: snapshot.hostSide, state: snapshot.hostStatus.state }));
    await drain();
    page.emit('joined', { clientId: 'h', role: 'host', seq: 1, roster: [HOST] });
    assertEqual(page.view().hostStatus.state, 'choosing', 'the file host is choosing');
    assertEqual(page.view().hostSide, true, 'and is host side');
    assert(frames.length > 0, 'the page painted while the host chose');
    assert(frames.every((frame) => frame.state === 'unknown' || frame.hostSide), 'no frame shows the host\'s status without its role');
  });

  await check('room-waiting-entry: a viewer is not host side whatever the host reports', async () => {
    const page = runEntry(product.code, {
      role: 'viewer',
      search: '?room=r&role=viewer&tab=v',
      settings: settingsFor('host', 'dir'),
      globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
    });
    await drain();
    page.emit('joined', { clientId: 'v', role: 'viewer', roster: [HOST, VIEWER] });
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'choosing' } });
    assertEqual(page.view().hostStatus.state, 'choosing', 'the viewer believes the host is choosing');
    assertEqual(page.view().hostSide, false, 'and is not host side');
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'preparing', fraction: 0.4 } });
    assertEqual(page.view().hostStatus.fraction, 0.4, 'the fraction the card shows');
    assertEqual(page.view().hostSide, false, 'still not host side while it prepares');
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'leave', member: HOST, roster: [VIEWER] } });
    assertEqual(page.view().hostStatus.state, 'absent', 'the host left');
    assertEqual(page.view().hostSide, false, 'and the viewer is still not host side');
  });

  await check('room-waiting-entry: a host page on http delivery is not host side', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      search: '?room=r&role=host&tab=h',
      settings: settingsFor('http', 'dir'),
    });
    await drain();
    page.emit('joined', { clientId: 'h', role: 'host', seq: 1, roster: [HOST] });
    assertEqual(page.view().hostSide, false, 'only host delivery has a host-side source');
  });
}
