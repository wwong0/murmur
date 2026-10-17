import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeRoomClient } from '../fake-rtc.mjs';
import { createHostAnswer } from '../../../public/lib/host-answer.mjs';

function setup({ active = true, closeThrows = false, detachThrows = false } = {}) {
  const peers = [];
  const reports = [];
  const attached = [];
  const client = createFakeRoomClient({ clientId: 'host-1', roster: [{ clientId: 'v1', tabId: 'one', role: 'viewer' }] });
  class FakePeer {
    constructor(config) {
      this.config = config;
      this.events = new Map();
      this.remote = null;
      this.local = null;
      this.candidates = [];
      this.closed = false;
      peers.push(this);
    }
    addEventListener(type, fn) {
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
    emit(type, value = {}) { for (const fn of [...(this.events.get(type) ?? [])]) fn(value); }
    async setRemoteDescription(value) { this.remote = value; }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription(value) { this.local = value; }
    async addIceCandidate(value) { this.candidates.push(value); }
    close() {
      if (closeThrows) throw new Error('close failed');
      this.closed = true;
    }
  }
  const origin = {
    attach(channel, options) {
      attached.push({ channel, options });
      return () => { if (detachThrows) throw new Error('detach failed'); };
    },
  };
  const answer = createHostAnswer({
    client,
    RTCPeerConnection: FakePeer,
    rtcConfig: () => ({ iceServers: [] }),
    origin: () => origin,
    isActive: () => active,
    report: (label, error) => reports.push([label, error.message]),
  });
  return { answer, client, peers, reports, attached };
}

async function offer(rig, viewerId = 'v1', linkId = 'L1') {
  await rig.answer.answerOffer({ from: viewerId, payload: { linkId, sdp: 'offer-sdp' } });
  return rig.peers.at(-1);
}

export default async function hostAnswerSuite() {
  await check('host-answer: inactive hosts ignore offers', async () => {
    const rig = setup({ active: false });
    await rig.answer.answerOffer({ from: 'v1', payload: { linkId: 'L1', sdp: 'offer' } });
    assertEqual(rig.peers.length, 0, 'inactive host creates no peer');
  });

  await check('host-answer: malformed offers throw before creating a peer', async () => {
    const rig = setup();
    let error;
    try { await rig.answer.answerOffer({ from: 'v1', payload: { linkId: 'L1' } }); } catch (caught) { error = caught; }
    assert(error instanceof TypeError, 'malformed offer TypeError');
    assertEqual(rig.peers.length, 0, 'malformed offer creates no peer');
  });

  await check('host-answer: answers retain the offer link id', async () => {
    const rig = setup();
    await offer(rig, 'v1', 'offer-link');
    const answer = rig.client.sent.find((message) => message.type === 'host-link-answer');
    assertEqual(answer.payload.linkId, 'offer-link', 'answer link id');
  });

  await check('host-answer: a re-offer closes the previous peer', async () => {
    const rig = setup();
    const first = await offer(rig);
    await offer(rig, 'v1', 'L2');
    assertEqual(first.closed, true, 're-offer closes first peer');
  });

  await check('host-answer: stale ICE candidates are not forwarded', async () => {
    const rig = setup();
    const first = await offer(rig);
    const second = await offer(rig, 'v1', 'L2');
    first.emit('icecandidate', { candidate: { candidate: 'stale' } });
    second.emit('icecandidate', { candidate: { candidate: 'current' } });
    assertEqual(rig.client.sent.filter((message) => message.type === 'host-link-ice').length, 1, 'only current ICE forwards');
    assertEqual(rig.client.sent.at(-1).payload.linkId, 'L2', 'current ICE link id');
  });

  await check('host-answer: ICE with a wrong link id is ignored', async () => {
    const rig = setup();
    const peer = await offer(rig, 'v1', 'L1');
    await rig.answer.routeIce({ from: 'v1', payload: { linkId: 'wrong', candidate: 'bad' } });
    await rig.answer.routeIce({ from: 'v1', payload: { linkId: 'L1', candidate: 'good' } });
    assertEqual(JSON.stringify(peer.candidates), JSON.stringify(['good']), 'matching ICE only');
  });

  await check('host-answer: data channels attach with the viewer tag', async () => {
    const rig = setup();
    const peer = await offer(rig, 'v1', 'L1');
    const channel = {};
    peer.emit('datachannel', { channel });
    assertEqual(rig.attached[0].options.viewerTag, 'one', 'viewer tab tag');
    assert(rig.attached[0].channel === channel, 'channel attaches');
  });

  await check('host-answer: closeDeparted closes only absent viewers', async () => {
    const rig = setup();
    const first = await offer(rig, 'v1', 'L1');
    const second = await offer(rig, 'v2', 'L2');
    rig.answer.closeDeparted([{ clientId: 'v1' }]);
    assertEqual(first.closed, false, 'present viewer remains');
    assertEqual(second.closed, true, 'departed viewer closes');
  });

  await check('host-answer: close and detach failures are reported by label', async () => {
    const rig = setup({ closeThrows: true, detachThrows: true });
    const peer = await offer(rig, 'v1', 'L1');
    peer.emit('datachannel', { channel: {} });
    rig.answer.close('v1');
    assertEqual(JSON.stringify(rig.reports), JSON.stringify([
      ['host link detach', 'detach failed'],
      ['host link close', 'close failed'],
    ]), 'close failures report independently');
  });
}
