import { assert, assertEqual, check } from '../harness.mjs';
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
}
