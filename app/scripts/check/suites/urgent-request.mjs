// T13 (design.md D9): which host requests a viewer marks urgent, and that the
// mark crosses the host link into the `req` control and the receipt.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { READY_HELD_AHEAD_MS } from '../../../public/lib/hold-resume.mjs';
import { parseSegmentTimes, requestIsUrgent, urgentPositionMs } from '../../../public/lib/urgent-request.mjs';
import { offsetView } from '../../../public/lib/playback-state.mjs';
import { parseControl } from '../../../public/lib/segment-protocol.mjs';

const BASE = 'https://media.test/';
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:4.000,',
  'seg-00000.m4s',
  '#EXTINF:4.000,',
  'seg-00001.m4s',
  '#EXTINF:4.000,',
  '../other/seg-00002.m4s',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function linkRig(urgency) {
  const clock = createFakeClock();
  const client = createFakeRoomClient({ clientId: 'viewer-1' });
  const sources = new Map([
    ['/media/master.m3u8', new TextEncoder().encode(PLAYLIST)],
    ['/media/init.mp4', new Uint8Array([7, 8, 9])],
    ['/media/seg-00001.m4s', new Uint8Array(512)],
  ]);
  const origin = createHostOrigin({ clock, readSource: async (path) => (sources.has(path) ? { status: 200, bytes: sources.get(path).slice() } : { status: 404, bytes: new Uint8Array() }) });
  const reqs = [];
  const rtc = createFakeRtcFactory({
    clock,
    stats: new Map(),
    hostDrainBytesPerMs: 1000,
    viewerDrainBytesPerMs: 1000,
    onLink(link) {
      link.host.addEventListener('message', ({ data }) => {
        const control = parseControl(data);
        if (control?.t === 'req') reqs.push(control);
      });
      origin.attach(link.host);
    },
  });
  const originalSend = client.send;
  client.send = (message) => {
    originalSend(message);
    if (message.type === 'host-link-offer') {
      queueMicrotask(() => client.emit('host-link-answer', { from: message.to, payload: { linkId: message.payload.linkId, sdp: 'fake-answer' } }));
    }
    return message;
  };
  const link = createHostLink({ client, RTCPeerConnection: rtc.RTCPeerConnection, rtcConfig: { iceServers: [], iceTransportPolicy: 'all' }, clock, urgency });
  client.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
  return { clock, link, reqs, origin };
}

async function fetchThrough(rig, path) {
  const response = rig.link.createShimFetch({ realFetch: () => { throw new Error('real fetch used'); }, baseUrl: BASE })(`${BASE}${path.slice(1)}`);
  for (let i = 0; i < 4; i += 1) {
    rig.clock.advance(50);
    await flush();
  }
  return (await response).arrayBuffer();
}

export default async function urgentRequestSuite() {
  await check('urgent-request: a media playlist gives each segment its span, a relative URI resolved', async () => {
    const times = parseSegmentTimes(PLAYLIST, '/media/master.m3u8');
    assertEqual(times.size, 3, 'three segments');
    assertEqual(JSON.stringify(times.get('/media/seg-00001.m4s')), JSON.stringify({ startMs: 4000, endMs: 8000 }), 'segment 1 spans 4–8 s');
    assertEqual(JSON.stringify(times.get('/other/seg-00002.m4s')), JSON.stringify({ startMs: 8000, endMs: 12000 }), 'the relative URI resolves against the playlist');
    assert(!times.has('/media/init.mp4'), 'the map is not a segment');
    assertEqual(parseSegmentTimes('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n', '/media/master.m3u8'), null, 'a multivariant playlist has no segment times');
  });

  await check('urgent-request: the segments across the ready runway from the viewer\'s own position are urgent', async () => {
    const segments = parseSegmentTimes(PLAYLIST, '/media/master.m3u8');
    const at = (positionMs, runwayMs = READY_HELD_AHEAD_MS) => ['/media/seg-00000.m4s', '/media/seg-00001.m4s', '/other/seg-00002.m4s']
      .filter((path) => requestIsUrgent({ path, positionMs, segments, runwayMs })).join(',');
    assertEqual(READY_HELD_AHEAD_MS, 4000, 'the runway is D3\'s 4 000 ms');
    assertEqual(at(5000), '/media/seg-00001.m4s,/other/seg-00002.m4s', 'inside segment 1: segments 1 and 2, not 0');
    assertEqual(at(4000), '/media/seg-00001.m4s', 'on a boundary: only the segment starting there');
    assertEqual(at(5000, 0), '/media/seg-00001.m4s', 'runway 0: only the containing segment');
    assertEqual(at(12000), '', 'past the last segment: none');
    assert(requestIsUrgent({ path: '/media/master.m3u8', positionMs: null, segments: null, runwayMs: 4000 }), 'a playlist is always urgent');
    assert(!requestIsUrgent({ path: '/media/seg-09999.m4s', positionMs: 0, segments, runwayMs: 4000 }), 'an unknown path is not urgent');
    assert(!requestIsUrgent({ path: '/media/seg-00000.m4s', positionMs: null, segments, runwayMs: 4000 }), 'no position: not urgent');
    assert(!requestIsUrgent({ path: '/media/seg-00000.m4s', positionMs: 0, segments: null, runwayMs: 4000 }), 'no playlist yet: not urgent');
  });

  await check('urgent-request: a viewer that loads inside the held creation\'s lead marks its start segment urgent', async () => {
    // 8b2's attempt 4: the first viewer asked for seg-00000 90 ms before the held
    // creation took effect, with no mapping in effect and so no position.
    const segments = parseSegmentTimes(PLAYLIST, '/media/master.m3u8');
    const created = { lineage: 'room', version: 2, current: { playing: false, atSharedMs: 10_000, mediaMs: 0, held: true }, previous: null, controlMode: 'open' };
    const urgentAt = (state, sharedMs) => ['/media/seg-00000.m4s', '/media/seg-00001.m4s']
      .filter((path) => requestIsUrgent({ path, positionMs: urgentPositionMs(state, sharedMs), segments, runwayMs: READY_HELD_AHEAD_MS })).join(',');
    assertEqual(urgentPositionMs(created, 9_910), 0, 'in the lead the position is where the creation starts');
    assertEqual(urgentAt(created, 9_910), '/media/seg-00000.m4s', 'the start segment is urgent in the lead, the next is not');
    assertEqual(urgentAt(created, 10_050), '/media/seg-00000.m4s', 'and stays so once the creation is in effect');
    assertEqual(urgentPositionMs(offsetView(created, 5000), 9_910), 5000, 'an offset viewer\'s own position carries its offset');
    const seek = { ...created, version: 3, current: { playing: false, atSharedMs: 20_000, mediaMs: 8000, held: true }, previous: created.current };
    assertEqual(urgentPositionMs(seek, 19_900), 0, 'a transition\'s lead keeps the prior mapping\'s position');
    assertEqual(urgentPositionMs(seek, 5_000), null, 'before every mapping of a state with a prior one: none');
    assertEqual(urgentPositionMs(null, 9_910), null, 'no state: no position');
    assertEqual(urgentPositionMs(created, null), null, 'no shared clock: no position');
    // Mutation probe, staged: urgentPositionMs returning mediaMsAt's null in the
    // lead. `npm run check` turned 'in the lead the position is where the creation
    // starts' red (null). Reverted; green.
  });

  await check('urgent-request: the host link carries the mark to the host, and keeps the playlist\'s segment times', async () => {
    let marked = new Set(['/media/master.m3u8', '/media/seg-00001.m4s']);
    const rig = linkRig((path) => marked.has(path));
    await flush();
    assertEqual(rig.link.snapshot().state, 'open', 'link reaches open');
    await fetchThrough(rig, '/media/master.m3u8');
    await fetchThrough(rig, '/media/seg-00001.m4s');
    marked = new Set();
    await fetchThrough(rig, '/media/seg-00001.m4s');
    assertEqual(rig.reqs.map((req) => req.urgent === true).join(','), 'true,true,false', 'the req carries urgent exactly when urgency says so');
    assert(!('urgent' in rig.reqs[2]), 'an unmarked req carries no urgent field');
    assertEqual(rig.origin.stats().urgentResponses, 2, 'the host started two urgent responses');
    const receipts = rig.link.receipts().records;
    assertEqual(receipts.map((receipt) => receipt.urgent).join(','), 'true,true,false', 'each receipt says whether it was urgent');
    assertEqual(JSON.stringify(rig.link.segmentTimes().get('/media/seg-00001.m4s')), JSON.stringify({ startMs: 4000, endMs: 8000 }), 'the loaded playlist\'s segment times are kept');
    // Mutation probe, staged: host-link.mjs's request() sending the plain req
    // whatever `urgent` was. `npm run check` turned 'the req carries urgent
    // exactly when urgency says so' red (false,false,false). Reverted; green.
    rig.link.close();
  });

  await check('urgent-request: an urgency that throws marks nothing and the load proceeds', async () => {
    const rig = linkRig(() => { throw new Error('page failure'); });
    await flush();
    const body = await fetchThrough(rig, '/media/seg-00001.m4s');
    assertEqual(body.byteLength, 512, 'the segment loaded');
    assertEqual(rig.reqs.length === 1 && rig.reqs[0].urgent === undefined, true, 'the req went unmarked');
    rig.link.close();
  });
}
