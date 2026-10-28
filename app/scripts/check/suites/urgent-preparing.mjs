import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { CONTROL_8B, CONTROL_PRODUCT } from '../../../public/lib/edge-control.mjs';
import { parseSegmentTimes, requestClass } from '../../../public/lib/urgent-request.mjs';

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:2',
  ...Array.from({ length: 130 }, (_, index) => `#EXTINF:2.000,\nseg-${String(index).padStart(5, '0')}.m4s`),
  '#EXT-X-ENDLIST',
].join('\n');
const segments = parseSegmentTimes(PLAYLIST, '/media/master.m3u8');
const base = {
  control: CONTROL_PRODUCT,
  path: '/media/seg-00092.m4s',
  positionMs: 186_030,
  segments,
  runwayMs: 4_000,
  nearMs: 15_000,
};

export default async function urgentPreparingSuite() {
  await check('urgent-preparing: product preparing segments are urgent, with control and path boundaries', async () => {
    assertEqual(JSON.stringify(segments.get('/media/seg-00092.m4s')), JSON.stringify({ startMs: 184_000, endMs: 186_000 }), 'seg-00092 spans 184–186 s');
    assertEqual(requestClass({ ...base, preparing: true }), 'urgent', 'a preparing product viewer marks its segment urgent');
    assertEqual(requestClass({ ...base, preparing: false }), null, 'the same segment is not urgent when not preparing');
    assertEqual(requestClass({ ...base, preparing: undefined }), null, 'undefined preparing keeps today’s behavior');
    assertEqual(requestClass({ ...base, preparing: 'true' }), null, 'only boolean true enables preparing urgency');
    assertEqual(requestClass({ ...base, control: CONTROL_8B, preparing: true }), null, '8b keeps its existing segment behavior');
    assertEqual(requestClass({ ...base, path: '/media/seg-99999.m4s', preparing: true }), null, 'a path outside the playlist is not urgent');
    assertEqual(requestClass({ ...base, segments: null, preparing: true }), null, 'a segment is not urgent before the playlist exists');
    assertEqual(requestClass({ ...base, path: '/media/seg-00123.m4s', positionMs: 186_000, preparing: true }), 'urgent', 'a segment 60 seconds ahead is urgent while preparing');
    assertEqual(requestClass({ ...base, path: '/media/master.m3u8', preparing: false }), 'urgent', 'the playlist remains urgent when not preparing');
    assertEqual(requestClass({ ...base, path: '/media/master.m3u8', preparing: true }), 'urgent', 'the playlist remains urgent while preparing');
    assert(requestClass({ ...base, path: '/media/seg-00092.m4s', preparing: 1 }) !== 'urgent', 'non-boolean preparing values are ignored');
  });

  // 13e-2 d1-findings.md F3: the page, not only the rule, passes its start's preparing state.
  await check('urgent-preparing: the page marks a segment urgent while its start is preparing', async () => {
    const product = await bundleProductEntry();
    const page = runEntry(product.code, {
      role: 'viewer',
      search: '?room=r&role=viewer&tab=v',
      settings: { delivery: 'host', iceServers: [], trackerUrl: null, mediaSource: 'dir', targetSegmentSeconds: 2, autoStart: false },
      globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
    });
    for (let i = 0; i < 20; i += 1) await page.settled();
    assertEqual(typeof page.harness.urgency, 'function', 'the page hands the host link its urgency');
    page.harness.segmentTimes = segments;
    const far = '/media/seg-00123.m4s';
    assertEqual(page.harness.urgency(far), null, 'a far segment is not urgent while the start is idle');
    page.harness.startState.waiting = 'preparing';
    assertEqual(page.harness.urgency(far), 'urgent', 'the same segment is urgent while the start is preparing');
    // Mutation (M1b), staged: startIsPreparing() returning false in room.entry.js turned this red.
  });
}
