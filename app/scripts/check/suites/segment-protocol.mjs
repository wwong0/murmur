// Pure wire-format and fake-channel checks for the host-origin segment path.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeChannel, createFakeClock, createFakeLink } from '../fake-channel.mjs';
import {
  decodeFrame,
  encodeControl,
  encodeFrame,
  parseControl,
  parseRange,
  sliceForRange,
  createChannelSender,
} from '../../../public/lib/segment-protocol.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { createFakeRoomClient } from '../fake-rtc.mjs';

export default async function segmentProtocolSuite() {
  await check('fake-channel: bufferedamountlow fires only on a downward crossing', async () => {
    const clock = createFakeClock();
    const channel = createFakeChannel({ clock, drainBytesPerMs: 10, label: 'self-check' });
    channel._open();
    channel.bufferedAmountLowThreshold = 1000;
    let lows = 0;
    channel.addEventListener('bufferedamountlow', () => lows++);

    channel.send(new Uint8Array(100));
    clock.advance(20);
    assertEqual(lows, 0, 'a buffer that never rose above the threshold has no low event');

    channel.send(new Uint8Array(5000));
    clock.advance(500);
    assertEqual(lows, 1, 'one downward crossing produces exactly one low event');
  });

  await check('segment protocol: frames, controls and ranges use the wire contract', async () => {
    const payload = new Uint8Array([0, 1, 255, 7]);
    const frame = encodeFrame(0xfeed, 17, payload);
    const decoded = decodeFrame(frame);
    assertEqual(decoded.id, 0xfeed, 'frame request id is little-endian uint32');
    assertEqual(decoded.seq, 17, 'frame sequence is little-endian uint32');
    assertEqual(JSON.stringify([...new Uint8Array(decoded.payload)]), JSON.stringify([...payload]), 'frame payload is exact');
    assertEqual(decodeFrame(new Uint8Array(7)), null, 'short input is not a frame');

    const control = { t: 'req', id: 4, path: '/media/x', range: { start: 2, end: null } };
    assertEqual(JSON.stringify(parseControl(encodeControl(control))), JSON.stringify(control), 'known control round-trips as JSON');
    assertEqual(parseControl('{"t":"unknown"}'), null, 'unknown control types are rejected');
    assertEqual(parseControl('{bad'), null, 'bad JSON is rejected');

    assertEqual(JSON.stringify(parseRange('bytes=4-9')), JSON.stringify({ start: 4, end: 9 }), 'closed range parses');
    assertEqual(JSON.stringify(parseRange('bytes=4-')), JSON.stringify({ start: 4, end: null }), 'open range parses');
    assertEqual(parseRange('bytes=-9'), null, 'suffix range is unsupported');
    assertEqual(parseRange('bytes=1-2,4-5'), null, 'multi-range is unsupported');
    assertEqual(JSON.stringify(sliceForRange(10, null)), JSON.stringify({ status: 200, start: 0, end: 9, length: 10 }), 'whole response is 200');
    assertEqual(JSON.stringify(sliceForRange(10, { start: 3, end: 99 })), JSON.stringify({ status: 206, start: 3, end: 9, length: 7 }), 'range end is clamped');
    assertEqual(sliceForRange(10, { start: 10, end: null }).status, 416, 'range past the resource is unsatisfiable');
  });

  await check('segment protocol: urgent, then near, then normal bodies are selected in order', async () => {
    const clock = createFakeClock();
    const channel = createFakeChannel({ clock, drainBytesPerMs: 1000, label: 'class-order' });
    channel._open();
    let held = true;
    const sender = createChannelSender({ channel, clock, held: () => held });
    sender.start(1, new Uint8Array([1, 1]));
    sender.start(2, new Uint8Array([2, 2]), { near: true });
    sender.start(3, new Uint8Array([3, 3]), { urgent: true });
    held = false;
    sender.start(4, new Uint8Array());
    const ids = channel.ledger
      .filter((entry) => typeof entry.data !== 'string')
      .map((entry) => decodeFrame(entry.data).id);
    assertEqual(JSON.stringify(ids), JSON.stringify([3, 2, 1]), 'urgent is sent before near, and near before normal');
    // Mutation (b) proof, T6: the opportunity is one channel holding normal,
    // near, and urgent bodies; the boundary is urgent before near before normal.
    // Making select() ignore near made the named assertion red (expected [3, 2,
    // 1], got [3, 1, 2]). `git checkout -- app/public/lib/segment-protocol.mjs`
    // restored the staged copy, and the rerun was green.
    sender.close();
    channel.close();
  });

  await check('segment 2.8: the data channel, never room signalling, carries requests and responses', async () => {
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const room = createFakeRoomClient({ clientId: 'viewer-1' });
    const origin = createHostOrigin({ clock, readSource: async (path) => ({ status: 200, bytes: path.endsWith('.m4s') ? new Uint8Array([3, 4, 5]) : new TextEncoder().encode('#EXTM3U\n') }) });
    origin.attach(link.host);
    class FakePeerConnection {
      constructor() { this.remoteDescription = null; this.connectionState = 'new'; this.listeners = new Map(); }
      addEventListener(type, fn) { this.listeners.set(type, fn); }
      createDataChannel() { return link.viewer; }
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription(value) { this.remoteDescription = value; }
      async addIceCandidate() {}
      async getStats() { return new Map(); }
      close() { link.viewer.close(); }
    }
    const viewer = createHostLink({ client: room, RTCPeerConnection: FakePeerConnection, clock });
    room.send = (message) => {
      room.sent.push(message);
      if (message.type === 'host-link-offer') {
        queueMicrotask(() => room.emit('host-link-answer', { from: message.to, payload: { linkId: message.payload.linkId, sdp: 'answer' } }));
      }
      return message;
    };
    room.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const signallingBeforeRequest = room.sent.length;
    let ended = false;
    let body = [];
    viewer.request({
      path: '/media/seg-00000.m4s',
      handlers: {
        onChunk: (chunk) => { body = body.concat([...chunk]); },
        onEnd: () => { ended = true; },
        onError: (status) => { throw new Error(`segment request failed with ${status}`); },
      },
    });
    clock.advance(1000);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    clock.advance(1000);
    assert(ended, 'viewer request completes');
    assertEqual(JSON.stringify(body), JSON.stringify([3, 4, 5]), 'viewer receives exact body');
    assertEqual(room.sent.length, signallingBeforeRequest, 'room client send is untouched by the segment request');
    assert(link.viewer.ledger.some((entry) => parseControl(entry.data)?.t === 'req'), 'req appears on the viewer data channel');
    assert(link.host.ledger.some((entry) => parseControl(entry.data)?.t === 'head'), 'head appears on the host data channel');
    assert(link.host.ledger.some((entry) => decodeFrame(entry.data)), 'body frame appears on the host data channel');
    assert(link.host.ledger.some((entry) => parseControl(entry.data)?.t === 'end'), 'end appears on the host data channel');
    // Positive control recorded: replacing viewer.request's channel send with
    // room.send({type:'req',...}) makes the `room client send is untouched`
    // assertion red; the mutation was reverted before this green run.
    viewer.close();
    link.closeBoth();
  });
}
