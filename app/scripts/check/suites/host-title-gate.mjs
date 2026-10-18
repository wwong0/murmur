import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import {
  createPlaybackStart,
  MISSING_HOST_LINK,
  MISSING_HOST_TITLE,
} from '../../../public/lib/playback-start.mjs';
import { driftLineForm } from '../../../public/lib/drift-readout.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const paused = () => ({
  lineage: 'room',
  version: 1,
  current: { playing: false, atSharedMs: 1000, mediaMs: 0 },
  previous: null,
  controlMode: 'open',
});

async function drain() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function pollRig() {
  const start = createPlaybackStart({ prepareLeadMs: 400 });
  const input = { nowSharedMs: 1000, resolved: true, state: paused(), linkOpen: true, finished: null, last: null };
  return { start, input };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function viewerPage(code, settings = {}) {
  return runEntry(code, {
    role: 'viewer',
    search: '?room=r&role=viewer&tab=v',
    settings: { delivery: 'host', iceServers: [], mediaSource: 'dir', ...settings },
    globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
  });
}

function lastPoll(page) {
  return page.events.filter((event) => event.kind === 'playback-start-poll').at(-1)?.detail;
}

export default async function hostTitleGateSuite() {
  await check('host-title-gate: the first load waits for the host title', async () => {
    const { start, input } = pollRig();
    const held = start.poll({ ...input, titleReady: false });
    assertEqual(held.actions.length, 0, 'unready title emits no load');
    assertEqual(held.missing, MISSING_HOST_TITLE, 'unready title is named');
    const opened = start.poll({ ...input, titleReady: true });
    assertEqual(opened.actions.map((action) => action.kind).join(','), 'load', 'ready title permits the load');
  });

  await check('host-title-gate: the closed host link remains the first missing input', async () => {
    const { start, input } = pollRig();
    const held = start.poll({ ...input, linkOpen: false, titleReady: false });
    assertEqual(held.actions.length, 0, 'closed link emits no load');
    assertEqual(held.missing, MISSING_HOST_LINK, 'host link precedes host title');
  });

  await check('host-title-gate: an already loaded page is not unloaded by a title reset', async () => {
    const { start, input } = pollRig();
    const loaded = start.poll({ ...input, titleReady: true });
    assertEqual(loaded.actions.map((action) => action.kind).join(','), 'load', 'the fixture has loaded');
    const held = start.poll({ ...input, titleReady: false });
    assertEqual(held.actions.length, 0, 'title reset emits no replacement action');
    assertEqual(held.missing, MISSING_HOST_TITLE, 'loaded paused snapshot reports host title');
  });

  await check('host-title-gate: waiting for host-title is a not-playing drift line', async () => {
    const line = 'drift: not playing — waiting for host-title';
    assertEqual(driftLineForm(line), 'not-playing', 'host-title line is accepted');
  });

  await check('host-title-gate: a preparing host rejects media requests before the channel', async () => {
    const clock = createFakeClock();
    const client = createFakeRoomClient({ clientId: 'v' });
    const rtc = createFakeRtcFactory({ clock });
    const sent = [];
    const originalSend = client.send;
    client.send = (message) => {
      sent.push(message);
      originalSend(message);
      if (message.type === 'host-link-offer') queueMicrotask(() => client.emit('host-link-answer', {
        from: message.to,
        payload: { linkId: message.payload.linkId, sdp: 'answer' },
      }));
    };
    let preparing = true;
    const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, clock, hostPreparing: () => preparing });
    client.emitEvent('joined', { clientId: 'v', roster: [{ clientId: 'h', role: 'host' }] });
    await flush();
    assertEqual(link.snapshot().state, 'open', 'the fake host link is open');
    const errors = [];
    link.request({ path: '/media/seg.m4s', handlers: { onError: (status) => errors.push(status) } });
    await flush();
    assertEqual(JSON.stringify(errors), '[0]', 'preparing request fails with status zero');
    assertEqual(link.snapshot().requestsByPath['/media/seg.m4s'], undefined, 'preparing request is not counted');
    preparing = false;
    link.request({ path: '/media/seg.m4s', handlers: { onError: (status) => { throw new Error(`open request failed ${status}`); } } });
    assertEqual(link.snapshot().requestsByPath['/media/seg.m4s'], 1, 'ready request is counted');
    assert(sent.some((message) => message.type === 'host-link-offer'), 'the open link still used signalling');
    link.close();
  });

  const product = await bundleProductEntry();

  await check('host-title-gate: a choosing host rejects media requests before the channel', async () => {
    const clock = createFakeClock();
    const rtc = createFakeRtcFactory({ clock });
    const page = runEntry(product.code, {
      role: 'viewer',
      search: '?room=r&role=viewer&tab=v',
      settings: { delivery: 'host', iceServers: [], mediaSource: 'dir' },
      globals: { RTCPeerConnection: rtc.RTCPeerConnection, TextEncoder, TextDecoder },
    });
    await drain();
    const host = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
    const viewer = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };
    page.emit('joined', { clientId: 'v', role: 'viewer', roster: [host, viewer] });
    await flush();
    const offer = page.sent().find((env) => env.type === 'host-link-offer');
    if (!offer) throw new Error('viewer link offer was not sent');
    page.deliver({ type: 'host-link-answer', from: 'h', payload: { linkId: offer.payload.linkId, sdp: 'answer' } });
    await flush();
    assertEqual(page.app.hostLink().state, 'open', 'viewer link is open');
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'choosing' } });
    assertEqual(page.view().hostStatus.state, 'choosing', 'viewer believes the host is choosing');
    const xhr = page.xhr();
    let failed = false;
    xhr.addEventListener('error', () => { failed = true; });
    xhr.open('GET', 'http://127.0.0.1:8100/media/seg.m4s');
    xhr.send();
    await flush();
    assertEqual(failed, true, 'choosing request fails');
    assertEqual(xhr.status, 0, 'choosing request has status zero');
    assertEqual(page.app.hostLink().requestsByPath['/media/seg.m4s'], undefined, 'choosing request is not counted');
  });

  await check('host-title-gate: viewer titleReady follows only the roster host report', async () => {
    const page = viewerPage(product.code);
    const host = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
    page.harness.roster = [host];
    page.harness.sharedNowMs = 1000;
    page.tick();
    assertEqual(lastPoll(page).titleReady, false, 'viewer without a report is not ready');
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'preparing', fraction: 0.4 } });
    page.tick();
    assertEqual(lastPoll(page).titleReady, false, 'preparing host is not ready');
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'ready' } });
    page.tick();
    assertEqual(lastPoll(page).titleReady, true, 'ready host permits the title');
  });

  await check('host-title-gate: a viewer report is disbelieved and cannot ready the title', async () => {
    const page = viewerPage(product.code);
    page.harness.roster = [
      { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 },
      { clientId: 'v2', tabId: 'v2', role: 'viewer', joinedAt: 2 },
    ];
    page.deliver({ type: 'host-status', from: 'v2', payload: { state: 'ready' } });
    page.harness.sharedNowMs = 1000;
    page.tick();
    assertEqual(lastPoll(page).titleReady, false, 'viewer report leaves title unready');
    assertEqual(page.view().hostStatus.disbelieved, 1, 'viewer report increments disbelieved');
  });

  await check('host-title-gate: http delivery never gates on a host report', async () => {
    const page = viewerPage(product.code, { delivery: 'http' });
    await drain();
    page.harness.sharedNowMs = 1000;
    page.tick();
    assertEqual(lastPoll(page).titleReady, true, 'http title is ready without a report');
  });
}
