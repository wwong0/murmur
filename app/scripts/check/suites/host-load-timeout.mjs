import { assert, assertEqual, check } from '../harness.mjs';
import { HttpRequestExecutor } from '../../../node_modules/p2p-media-loader-core/lib/http-loader.js';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';
import { createRig, flush } from '../peer-bytes-fixture.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { PATCHED_HYBRID_LOADER } from '../../engine-patch.mjs';
import fs from 'node:fs';

const HOST_TIMEOUT = peerEngineConfig({ roomId: 'room', trackerUrl: 'ws://tracker', iceServers: [] }).core.httpNotReceivingBytesTimeoutMs;

function installWindow(fetch) {
  const previousWindow = globalThis.window;
  const previousPerformance = globalThis.performance;
  const timers = [];
  globalThis.window = {
    fetch,
    setTimeout(callback, delay) {
      const timer = { callback, delay, ran: false };
      timers.push(timer);
      return timers.length;
    },
    clearTimeout() {},
  };
  return {
    timers,
    setNow(nowMs) { globalThis.performance = { now: () => nowMs }; },
    restore() {
      globalThis.window = previousWindow;
      globalThis.performance = previousPerformance;
    },
  };
}

async function timeoutRig({ fetch }) {
  const rig = createRig();
  const failures = [];
  rig.eventTarget.addEventListener('onSegmentError', ({ error }) => failures.push(error.type));
  const windowState = installWindow(fetch);
  windowState.setNow(0);
  new HttpRequestExecutor(rig.request, { httpNotReceivingBytesTimeoutMs: HOST_TIMEOUT }, rig.eventTarget).execute();
  await flush();
  return { rig, failures, windowState };
}

async function deadLinkRig() {
  const clock = createFakeClock();
  const client = createFakeRoomClient({ clientId: 'viewer-1' });
  const origin = createHostOrigin({ clock, readSource: async () => ({ status: 200, bytes: new Uint8Array([1, 2, 3]) }) });
  const rtc = createFakeRtcFactory({ clock, onLink: (link) => origin.attach(link.host) });
  const originalSend = client.send;
  client.send = (message) => {
    originalSend(message);
    if (message.type === 'host-link-offer') {
      queueMicrotask(() => client.emit('host-link-answer', { from: message.to, payload: { linkId: message.payload.linkId, sdp: 'fake-answer' } }));
    }
    return message;
  };
  const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, rtcConfig: { iceServers: [] }, clock });
  client.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
  await flush();
  return { link, baseUrl: 'https://media.test/' };
}

export default async function hostLoadTimeoutSuite() {
  await check('host-load-timeout: product config arms 15 000 ms for a stuck HTTP attempt', async () => {
    const windowState = installWindow(() => new Promise(() => {}));
    try {
      windowState.setNow(0);
      const rig = createRig();
      new HttpRequestExecutor(rig.request, { httpNotReceivingBytesTimeoutMs: HOST_TIMEOUT }, rig.eventTarget).execute();
      await flush();
      assertEqual(windowState.timers.map(({ delay }) => delay).join(','), '15000', 'initial timeout is 15 000 ms');
    } finally {
      windowState.restore();
    }
  });

  await check('host-load-timeout: five seconds without bytes stays loading and re-arms', async () => {
    const { rig, windowState } = await timeoutRig({ fetch: () => new Promise(() => {}) });
    try {
      windowState.setNow(5_000);
      windowState.timers[0].ran = true;
      windowState.timers[0].callback();
      assertEqual(rig.request.status, 'loading', 'five seconds has not failed the request');
      assertEqual(windowState.timers.at(-1).delay, 10_000, 'false alarm re-arms for the remaining 10 000 ms');
      // Prevention proof: opportunity is the timer at +5 000 ms; action boundary
      // is the product timeout constant. Mutation: 15 000 to 3 000. Named red:
      // `five seconds has not failed the request`.
    } finally {
      windowState.restore();
    }
  });

  await check('host-load-timeout: fifteen seconds without bytes fails the request', async () => {
    const { rig, failures, windowState } = await timeoutRig({ fetch: () => new Promise(() => {}) });
    try {
      windowState.setNow(15_000);
      windowState.timers[0].ran = true;
      windowState.timers[0].callback();
      assertEqual(rig.request.status, 'failed', 'fifteen seconds fails the request');
      assertEqual(failures.join(','), 'bytes-receiving-timeout', 'the failure names the no-bytes timeout');
    } finally {
      windowState.restore();
    }
  });

  await check('host-load-timeout: a closed host link fails before its timer', async () => {
    const { link, baseUrl } = await deadLinkRig();
    const rig = createRig({ url: `${baseUrl}media/seg-00001.m4s` });
    const failures = [];
    rig.eventTarget.addEventListener('onSegmentError', ({ error }) => failures.push(error.type));
    const windowState = installWindow(link.createShimFetch({ realFetch: () => { throw new Error('real fetch used'); }, baseUrl }));
    try {
      windowState.setNow(0);
      new HttpRequestExecutor(rig.request, { httpNotReceivingBytesTimeoutMs: HOST_TIMEOUT }, rig.eventTarget).execute();
      link.close();
      await flush();
      assertEqual(rig.request.status, 'failed', 'closing the link fails the host load');
      assertEqual(failures.join(','), 'http-error', 'a closed link is not reported as a bytes timeout');
      assertEqual(windowState.timers.filter((timer) => timer.ran).length, 0, 'the timer callback never runs');
    } finally {
      windowState.restore();
    }
  });

  await check('host-load-timeout: product loading host requests publish one ask', async () => {
    const loader = fs.readFileSync(PATCHED_HYBRID_LOADER, 'utf8');
    const start = loader.indexOf('if (this.edgeControl !== "8b") { // wa-patch: product control assigns high-demand peers');
    const end = loader.indexOf('// wa-patch: finish product-control assignment', start);
    const branch = loader.slice(start, end);
    assert(start >= 0 && end > start, 'the product branch is found');
    assert(branch.includes('if (loading && !loadingFromP2P) continue;'), 'a loading host request is skipped');
    assertEqual(branch.split('this.noteHostAsk(').length - 1, 1, 'the product branch publishes one ask');
    assert(branch.includes('this.noteHostAsk(segment, step, now);'), 'the ask is immediately before the host load');
    assert(branch.indexOf('this.noteHostAsk(segment, step, now);') < branch.indexOf('this.loadThroughHttp(segment);'), 'the ask precedes the host load');
  });
}
