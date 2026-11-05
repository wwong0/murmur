import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { decodeFrame, parseControl } from '../../../public/lib/segment-protocol.mjs';

const BASE = 'https://media.test/';
const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-00000.m4s\n#EXT-X-ENDLIST\n';
const init = new Uint8Array([7, 8, 9]);
const segment = new Uint8Array(256).map((_, index) => index);

function fixtureRead(path) {
  const values = new Map([
    ['/media/master.m3u8', { status: 200, bytes: new TextEncoder().encode(playlist) }],
    ['/media/init.mp4', { status: 200, bytes: init }],
    ['/media/seg-00000.m4s', { status: 200, bytes: segment }],
    ['/media/seg-big.m4s', { status: 200, bytes: new Uint8Array(1_000_000) }],
  ]);
  return async (requested) => {
    const value = values.get(requested);
    if (!value) return { status: 404, bytes: new Uint8Array() };
    return { status: value.status, bytes: value.bytes.slice() };
  };
}

// A shim promise that never settles must fail its check, not stall the run.
function bounded(promise, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: did not settle`)), 2000); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function settle(clock, ms = 1000) {
  clock.advance(ms);
  await flush();
  clock.advance(ms);
  await flush();
}

function stats() {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', id: 'pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', id: 'local', candidateType: 'relay' }],
    ['remote', { type: 'remote-candidate', id: 'remote', candidateType: 'host' }],
  ]);
}

function setup({ drain = 1000, answer = true, open = true, urgency = null } = {}) {
  const clock = createFakeClock();
  const client = createFakeRoomClient({ clientId: 'viewer-1' });
  const origin = createHostOrigin({ clock, readSource: fixtureRead() });
  let lastLink = null;
  const rtc = createFakeRtcFactory({
    clock,
    stats: stats(),
    hostDrainBytesPerMs: drain,
    viewerDrainBytesPerMs: 1000,
    onLink(link) {
      lastLink = link;
      if (!open) {
        link.host.readyState = 'connecting';
        link.viewer.readyState = 'connecting';
      }
      origin.attach(link.host);
    },
  });
  const originalSend = client.send;
  client.send = (message) => {
    originalSend(message);
    if (answer && message.type === 'host-link-offer') {
      queueMicrotask(() => client.emit('host-link-answer', {
        from: message.to,
        payload: { linkId: message.payload.linkId, sdp: 'fake-answer' },
      }));
    }
    return message;
  };
  const changes = [];
  const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, rtcConfig: { iceServers: [], iceTransportPolicy: 'all' }, clock, onChange: (value) => changes.push(value), urgency });
  client.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
  return { clock, client, origin, rtc, link, changes, get rawLink() { return lastLink; } };
}

export default async function hostLinkSuite() {
  await check('host-link: XHR range and fetch Request route exact bytes over the channel', async () => {
    const rig = setup();
    await flush();
    assertEqual(rig.link.snapshot().state, 'open', 'link reaches open');
    const XHR = rig.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const xhr = new XHR();
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', 'bytes=10-99');
    xhr.open('GET', `${BASE}media/seg-00000.m4s?cache=1`, true);
    const states = [];
    xhr.onreadystatechange = () => { if (xhr.readyState >= 2) states.push(xhr.readyState); };
    xhr.send();
    await settle(rig.clock);
    assertEqual(xhr.status, 206, 'XHR range status');
    assertEqual(xhr.getResponseHeader('content-range'), 'bytes 10-99/256', 'XHR content-range');
    assertEqual(JSON.stringify([...new Uint8Array(xhr.response)]), JSON.stringify([...segment.slice(10, 100)]), 'XHR range body');
    assertEqual(JSON.stringify(states), JSON.stringify([2, 3, 4]), 'XHR transitions 2, 3, 4');

    const RequestCtor = globalThis.Request;
    const request = new RequestCtor(`${BASE}media/seg-00000.m4s`, { headers: { Range: 'bytes=10-99' } });
    const responsePromise = rig.link.createShimFetch({ realFetch: () => { throw new Error('real fetch used'); }, baseUrl: BASE })(request);
    await settle(rig.clock);
    const response = await bounded(responsePromise, 'fetch Request range');
    assertEqual(response.status, 206, 'fetch Request range status');
    assertEqual(response.headers.get('content-range'), 'bytes 10-99/256', 'fetch content-range');
    assertEqual(JSON.stringify([...new Uint8Array(await response.arrayBuffer())]), JSON.stringify([...segment.slice(10, 100)]), 'fetch Request range body');
    rig.link.close();
  });

  await check('host-link: an XHR listener added before open fires once the link answers', async () => {
    const rig = setup();
    await flush();
    const XHR = rig.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const xhr = new XHR();
    const loads = [];
    xhr.addEventListener('load', () => loads.push(xhr.status));
    xhr.open('GET', `${BASE}media/seg-00000.m4s`, true);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    await settle(rig.clock);
    assertEqual(JSON.stringify(loads), '[200]', 'a listener added before open hears load');
    // Mutation, 2026-09-23: `_use` copying the pending listeners onto the backing
    // as a `_listeners` field threw `target._listeners.get is not a function`; restored, green.
    rig.link.close();
  });

  await check('host-link: heads precede progress, fetch resolves before body, playlist text and walk are correct', async () => {
    const rig = setup();
    await flush();
    const XHR = rig.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const xhr = new XHR();
    xhr.responseType = 'text';
    const order = [];
    xhr.onreadystatechange = () => order.push(`rs${xhr.readyState}`);
    xhr.onprogress = () => order.push('progress');
    xhr.onload = () => order.push('load');
    xhr.onloadend = () => order.push('loadend');
    xhr.open('GET', `${BASE}media/master.m3u8`, true);
    xhr.send();
    await settle(rig.clock);
    assertEqual(xhr.status, 200, 'playlist status');
    const expectedPlaylist = playlist.replace('URI="init.mp4"', `URI="data:video/mp4;base64,${btoa(String.fromCharCode(...init))}"`);
    assertEqual(xhr.responseText, expectedPlaylist, 'playlist responseText');
    assertEqual(JSON.stringify(order.filter((value) => value !== 'rs1')), JSON.stringify(['rs2', 'rs3', 'progress', 'rs4', 'load', 'loadend']), 'playlist event order');

    const second = new XHR();
    const walk = [];
    second.onreadystatechange = () => { if (second.readyState >= 2) walk.push(second.readyState); };
    second.onload = () => walk.push('load');
    second.onloadend = () => walk.push('loadend');
    second.open('GET', `${BASE}media/seg-00000.m4s`, true);
    second.responseType = 'arraybuffer';
    second.send();
    await settle(rig.clock);
    assertEqual(JSON.stringify(walk), JSON.stringify([2, 3, 4, 'load', 'loadend']), 'segment XHR walk');
    assertEqual(second.response.byteLength, 256, 'segment response size');

    const fetchPromise = rig.link.createShimFetch({ realFetch: () => { throw new Error('real fetch used'); }, baseUrl: BASE })(`${BASE}media/seg-00000.m4s`);
    await settle(rig.clock);
    // The response is resolved by head before the next fake-channel message
    // (the first body chunk) becomes readable.
    assert((await bounded(fetchPromise, 'fetch at head')).status === 200, 'fetch resolves at head');
    rig.link.close();
  });

  await check('host-link: abort and link close fail requests and remove table entries', async () => {
    const rig = setup({ drain: 100 });
    await flush();
    const XHR = rig.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const xhr = new XHR();
    xhr.responseType = 'arraybuffer';
    let progress = 0;
    let aborted = false;
    xhr.onprogress = () => { progress += 1; };
    xhr.onabort = () => { aborted = true; };
    xhr.open('GET', `${BASE}media/seg-00000.m4s`, true);
    xhr.send();
    await settle(rig.clock, 1);
    const before = progress;
    xhr.abort();
    await settle(rig.clock, 1000);
    assert(aborted, 'XHR abort event fires');
    assertEqual(progress, before, 'abort receives no later progress');

    const closeXhr = new XHR();
    let closeError = false;
    let closeEnd = false;
    closeXhr.onerror = () => { closeError = true; };
    closeXhr.onloadend = () => { closeEnd = true; };
    closeXhr.open('GET', `${BASE}media/seg-00000.m4s`, true);
    closeXhr.send();
    await flush();
    rig.rawLink.closeBoth();
    await flush();
    assert(closeError && closeEnd, 'link close is an asynchronous network error');
    assertEqual(rig.link.snapshot().requests, 0, 'close clears request table');
    rig.link.close();
  });

  await check('host-link: absent and connecting fail immediately without channel req', async () => {
    const clock = createFakeClock();
    const client = createFakeRoomClient({ clientId: 'viewer-1' });
    const rtc = createFakeRtcFactory({ clock });
    const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, clock });
    const failures = [];
    link.request({ path: '/media/seg-00000.m4s', handlers: { onError: (status) => failures.push(status) } });
    await flush();
    assertEqual(failures[0], 0, 'absent request fails status 0');
    link.close();
    // Keep the fake channel connecting so this assertion observes the
    // fail-fast state rather than an already-open test double.
    const rig = setup({ answer: false, open: false });
    const pending = [];
    rig.link.request({ path: '/media/seg-00000.m4s', handlers: { onError: (status) => pending.push(status) } });
    await flush();
    assertEqual(pending[0], 0, 'connecting request fails status 0');
    assertEqual(rig.client.sent.filter((message) => message.type === 'host-link-offer').length, 1, 'only signalling offer was sent');
    assert(!rig.client.sent.some((message) => message.type === 'req'), 'room client never carries segment req');
    rig.link.close();
  });

  await check('host-link: non-media and foreign-origin calls use real implementations unchanged', async () => {
    const rig = setup();
    await flush();
    const calls = [];
    const realFetch = (...args) => { calls.push(['fetch', ...args]); return Promise.resolve('real-fetch'); };
    const fetch = rig.link.createShimFetch({ realFetch, baseUrl: BASE });
    const input = new Request(`${BASE}room.bundle.js`);
    assertEqual(await fetch(input), 'real-fetch', 'non-media fetch passes through');
    const foreign = new URL('https://other.test/media/seg-00000.m4s');
    assertEqual(await fetch(foreign, { method: 'GET' }), 'real-fetch', 'foreign-origin fetch passes through');
    assertEqual(calls[0][1], input, 'Request object argument is unchanged');
    assertEqual(calls[1][1], foreign, 'URL argument is unchanged');

    class RealXHR {
      open(...args) { calls.push(['xhr-open', ...args]); }
      setRequestHeader() {}
      send() { calls.push(['xhr-send']); }
      addEventListener() {}
      removeEventListener() {}
      getAllResponseHeaders() { return ''; }
      getResponseHeader() { return null; }
    }
    const XHR = rig.link.createShimXhr({ RealXHR, baseUrl: BASE });
    const xhr = new XHR();
    xhr.open('GET', `${BASE}room.bundle.js`, true);
    xhr.send();
    assert(calls.some((value) => value[0] === 'xhr-open'), 'non-media XHR uses real implementation');
    rig.link.close();
  });

  await check('host-link: paths carry no query or tab identity and lifecycle rotates hosts', async () => {
    const rig = setup();
    await flush();
    const fetch = rig.link.createShimFetch({ realFetch: () => { throw new Error('real fetch used'); }, baseUrl: BASE });
    const first = fetch(`${BASE}media/seg-00000.m4s?tab=secret`);
    await settle(rig.clock);
    await bounded(first, 'identity fetch');
    const reqs = rig.rawLink.viewer.ledger
      .filter((entry) => typeof entry.data === 'string')
      .map((entry) => parseControl(entry.data))
      .filter((value) => value?.t === 'req');
    assertEqual(reqs[0].path, '/media/seg-00000.m4s', 'wire path strips query');
    assert(!('tabId' in reqs[0]), 'wire request carries no tab identity');

    const oldLinkId = rig.link.snapshot().linkId;
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-2', role: 'host' }] } });
    await flush();
    assert(rig.client.sent.some((message) => message.type === 'host-link-offer' && message.to === 'host-2'), 'new host receives a new offer');
    rig.client.emit('host-link-answer', { from: 'host-1', payload: { linkId: oldLinkId, sdp: 'stale' } });
    assertEqual(rig.rtc.peers.at(-1).remoteDescription?.sdp, 'fake-answer', 'stale answer cannot alter current peer');
    rig.link.close();
  });

  await check('host-link: shim edges — fetch before body, abort read by the host, not-open facades, identity-free req', async () => {
    const slow = setup({ drain: 100 });
    await flush();
    let binary = 0;
    slow.rawLink.viewer.addEventListener('message', ({ data }) => { if (typeof data !== 'string') binary += 1; });
    let resolved = false;
    slow.link.createShimFetch({ realFetch: null, baseUrl: BASE })(`${BASE}media/seg-00000.m4s`).then(() => { resolved = true; });
    slow.clock.advance(1);
    await flush();
    slow.clock.advance(1);
    await flush();
    assert(resolved, 'fetch resolves once the head has drained');
    assertEqual(binary, 0, 'no body frame had reached the viewer when fetch resolved');
    slow.link.close();

    const rig = setup();
    await flush();
    const XHR = rig.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const xhr = new XHR();
    xhr.responseType = 'arraybuffer';
    let progress = 0;
    xhr.onprogress = () => { progress += 1; };
    xhr.open('GET', `${BASE}media/seg-big.m4s`, true);
    xhr.send();
    let abortReadAt = null;
    rig.rawLink.host.addEventListener('message', ({ data }) => {
      if (parseControl(data)?.t === 'abort') abortReadAt = rig.clock.now();
    });
    rig.clock.advance(1);
    await flush();
    rig.clock.advance(300);
    await flush();
    const frames = () => rig.rawLink.host.ledger.filter((entry) => typeof entry.data !== 'string' && decodeFrame(entry.data).id === 1);
    assert(frames().length > 1 && frames().length < 16, 'the body was mid-transfer when aborted');
    xhr.abort();
    const progressAtAbort = progress;
    await settle(rig.clock);
    assert(abortReadAt !== null, 'the host read the abort');
    assertEqual(frames().filter((entry) => entry.sentAt >= abortReadAt).length, 0, 'the host hands no frame for the id after reading the abort');
    assertEqual(progress, progressAtAbort, 'the viewer sees no progress after abort');
    // Mutation, 2026-09-23: host-origin skipping `sender.abort` on a read abort turned
    // 'the host hands no frame for the id after reading the abort' red (3 frames); restored, green.
    rig.link.close();

    const clock = createFakeClock();
    const client = createFakeRoomClient({ clientId: 'viewer-1' });
    const absent = createHostLink({ client, RTCPeerConnection: createFakeRtcFactory({ clock }).RTCPeerConnection, clock });
    const events = [];
    const AbsentXHR = absent.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
    const failing = new AbsentXHR();
    failing.onerror = () => events.push(`error:${failing.status}:${failing.readyState}`);
    failing.onloadend = () => events.push('loadend');
    failing.open('GET', `${BASE}media/seg-00000.m4s`, true);
    failing.send();
    assertEqual(events.length, 0, 'the not-open failure is not raised inside send');
    await flush();
    assertEqual(JSON.stringify(events), JSON.stringify(['error:0:4', 'loadend']), 'a not-open XHR fails with status 0, error then loadend');
    let rejection = null;
    await absent.createShimFetch({ realFetch: null, baseUrl: BASE })(`${BASE}media/seg-00000.m4s`).catch((error) => { rejection = error; });
    assert(rejection instanceof TypeError, 'a not-open fetch rejects with TypeError');
    absent.close();

    const reqs = [];
    for (const tab of ['tab-A', 'tab-B']) {
      const viewer = setup();
      await flush();
      const TabXHR = viewer.link.createShimXhr({ RealXHR: class {}, baseUrl: BASE });
      const request = new TabXHR();
      request.open('GET', `${BASE}media/seg-00000.m4s`, true);
      request.setRequestHeader('x-app-tab', tab);
      request.send();
      await settle(viewer.clock);
      reqs.push(viewer.rawLink.viewer.ledger.map((entry) => entry.data).find((data) => parseControl(data)?.t === 'req'));
      viewer.link.close();
    }
    assert(typeof reqs[0] === 'string', 'the first viewer sent a req');
    assertEqual(reqs[0], reqs[1], 'two tabs send byte-identical req messages');
  });

  await check('host-link: lifecycle — absent, open with relayed, host change fails pending, a rejoin re-links a failed link', async () => {
    const rig = setup();
    await flush();
    const offersTo = (id) => rig.client.sent.filter((message) => message.type === 'host-link-offer' && message.to === id).length;
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'viewer-1', role: 'viewer' }] } });
    assertEqual(rig.link.snapshot().state, 'absent', 'a roster without a host reads absent');
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-1', role: 'host' }] } });
    await flush();
    const states = rig.changes.map((value) => value.state);
    assert(states.lastIndexOf('connecting') < states.lastIndexOf('open'), 'the link passes connecting on its way to open');
    assertEqual(rig.link.snapshot().relayed, true, 'relayed is read from the selected pair');
    assertEqual(JSON.stringify(rig.link.snapshot().candidateTypes), JSON.stringify({ local: 'relay', remote: 'host' }), 'the selected pair types are published');

    const errors = [];
    rig.link.request({ path: '/media/seg-00000.m4s', handlers: { onError: (status) => errors.push(status) } });
    await flush();
    assertEqual(rig.link.snapshot().requests, 1, 'the request is pending before the clock drains it');
    const openBefore = rig.changes.length;
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-2', role: 'host' }] } });
    await flush();
    assertEqual(JSON.stringify(errors), '[0]', 'a host change fails the pending request with status 0');
    assertEqual(rig.link.snapshot().requests, 0, 'the request table is empty after the host change');
    assert(rig.changes.slice(openBefore).some((value) => value.state !== 'open'), 'the state leaves open on a host change');
    assertEqual(offersTo('host-2'), 1, 'one offer goes to the new host');
    assertEqual(rig.link.snapshot().state, 'open', 'the link returns to open');
    assertEqual(rig.link.snapshot().hostClientId, 'host-2', 'the link names the new host');

    // Without a rejoin a failed link stays failed: there is no retry timer.
    rig.rawLink.viewer.close();
    await flush();
    assertEqual(rig.link.snapshot().state, 'failed', 'a closed channel reads failed');
    assertEqual(offersTo('host-2'), 1, 'a failure with no rejoin sends no offer');
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-2', role: 'host' }] } });
    await flush();
    assertEqual(offersTo('host-2'), 1, 'an unchanged roster does not re-link a failed link');

    // The viewer rejoins; its open link survives until the host drops
    // the pc it holds for the departed id, and that failure re-links.
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-2', role: 'host' }] } });
    rig.client.emitEvent('joined', { clientId: 'viewer-3', roster: [{ clientId: 'host-2', role: 'host' }] });
    await flush();
    assertEqual(offersTo('host-2'), 2, 'a rejoin re-links a failed link');
    assertEqual(rig.link.snapshot().state, 'open', 'the re-linked link is open');
    rig.client.emitEvent('joined', { clientId: 'viewer-4', roster: [{ clientId: 'host-2', role: 'host' }] });
    await flush();
    assertEqual(offersTo('host-2'), 2, 'an open link survives the viewer rejoin');
    rig.rawLink.viewer.close();
    await flush();
    assertEqual(offersTo('host-2'), 3, 'the host dropping the departed viewer id re-links at once');
    assertEqual(rig.link.snapshot().state, 'open', 'the link is open again after the drop');
    // Mutation, 2026-09-23: `fail` without its re-initiate line turned
    // 'the host dropping the departed viewer id re-links at once' red; restored, green.
    rig.link.close();
  });

  await check('host-link: a member-relayed presence does not re-target the link', async () => {
    const rig = setup();
    rig.client.emit('presence', { from: 'server', payload: { roster: [{ clientId: 'host-1', role: 'host' }] } });
    await flush();
    const linkId = rig.link.snapshot().linkId;
    rig.client.emit('presence', { from: 'viewer-9', payload: { roster: [{ clientId: 'viewer-9', role: 'host' }] } });
    rig.client.emit('presence', { from: 'viewer-9', payload: { roster: [] } });
    await flush();
    assert(!rig.client.sent.some((message) => message.to === 'viewer-9'), 'a forged presence draws no offer');
    assertEqual(rig.link.snapshot().linkId, linkId, 'a forged presence leaves the link in place');
    assertEqual(rig.link.snapshot().state, 'open', 'a forged presence leaves the link open');
    // Mutation, 2026-09-23: the unguarded `client.on('presence', discover)`
    // turned 'a forged presence leaves the link in place' red; restored, green.
    rig.link.close();
  });

  await check('host-link: near requests carry only near and receipts retain both class booleans', async () => {
    const rig = setup({ urgency: () => 'near' });
    await flush();
    let ended = false;
    rig.link.request({
      path: '/media/seg-00000.m4s',
      handlers: { onEnd: () => { ended = true; }, onError: (status) => { throw new Error(`near request failed with ${status}`); } },
    });
    await settle(rig.clock);
    assert(ended, 'the near request completes');
    const req = rig.rawLink.viewer.ledger
      .map((entry) => typeof entry.data === 'string' ? parseControl(entry.data) : null)
      .find((value) => value?.t === 'req');
    assertEqual(req.near, true, 'the req carries near');
    assert(!('urgent' in req), 'the req carries no urgent flag');
    assertEqual(JSON.stringify({ near: rig.link.receipts().records[0].near, urgent: rig.link.receipts().records[0].urgent }), JSON.stringify({ near: true, urgent: false }), 'the receipt carries both class booleans');
    assertEqual(rig.origin.stats().nearResponses, 1, 'the host counts the near response');
    rig.link.close();
  });

  await check('host-link: the viewer answers the host\'s echo with the same message, and the host reads a round trip', async () => {
    // The fake link here does not answer an echo itself.
    const rig = setup();
    await flush();
    await settle(rig.clock, 1100);
    const echoesOn = (channel) => channel.ledger.map((entry) => entry.data).filter((data) => typeof data === 'string' && parseControl(data)?.t === 'echo');
    const sent = echoesOn(rig.rawLink.host);
    const answered = echoesOn(rig.rawLink.viewer);
    assert(sent.length >= 10, `the host sent an echo a period (got ${sent.length})`);
    assert(answered.length >= sent.length - 1, `the viewer answered each one (${answered.length} of ${sent.length})`);
    assertEqual(JSON.stringify(answered), JSON.stringify(sent.slice(0, answered.length)), 'each answer is the message it received');
    const interval = rig.origin.pace().intervals.at(-1);
    assert(interval.echoSamples >= 9, `the host read the answers as samples (got ${interval.echoSamples})`);
    assert(interval.queueMs !== null && interval.queueMs <= 1, `and a round trip at its floor (got ${interval.queueMs})`);
    // Mutation probe, staged: host-link.mjs's echo branch removed. `npm run check`
    // turned 'the viewer answered each one' red (0 of 23). Reverted; green again.
    rig.link.close();
  });
}
