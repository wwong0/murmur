// The page tick re-evaluates each unfinished host request, and the near
// span is the window handed to the class rule.

import { assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { requestClass } from '../../../public/lib/urgent-request.mjs';

const TICK_MS = 250;
const WINDOW_MS = 1000;
const NEAR_NARROW_MS = 9000;
const NEAR_WIDE_MS = 15_000;
const POSITION_MS = 100_000;
const SEGMENT_AHEAD_MS = 10_000;
const SEGMENT_SPAN_MS = 4000;

const segmentAhead = (aheadMs) => new Map([['/media/s.m4s', { startMs: POSITION_MS + aheadMs, endMs: POSITION_MS + aheadMs + SEGMENT_SPAN_MS }]]);
const classAt = (aheadMs, nearMs) => requestClass({ control: 'product', path: '/media/s.m4s', positionMs: POSITION_MS, segments: segmentAhead(aheadMs), runwayMs: 4000, nearMs });

export default async function classRiseEntrySuite() {
  await check('class-rise-entry: the near span is the window handed to the class rule', async () => {
    assertEqual(classAt(SEGMENT_AHEAD_MS, NEAR_NARROW_MS), null, 'a segment 10 000 ms ahead is neither at a 9 000 ms span');
    assertEqual(classAt(8000, NEAR_NARROW_MS), 'near', 'at 8 000 ms ahead it is near');
    assertEqual(classAt(SEGMENT_AHEAD_MS, NEAR_WIDE_MS), 'near', 'at a 15 000 ms span the 10 000 ms segment is near');
  });

  await check('class-rise-entry: a viewer under host delivery re-evaluates its requests at every tick', async () => {
    const product = await bundleProductEntry();
    const page = runEntry(product.code, {
      role: 'viewer',
      search: '?room=r&role=viewer&tab=v',
      settings: { delivery: 'host', iceServers: [], trackerUrl: null, mediaSource: 'dir', targetSegmentSeconds: 2, autoStart: false },
      globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
    });
    for (let i = 0; i < 20; i += 1) await page.settled();
    for (let elapsed = 0; elapsed < WINDOW_MS; elapsed += TICK_MS) page.tick();
    assertEqual(page.harness.reclassifyCalls, WINDOW_MS / TICK_MS, 'one reclassify per 250 ms tick');
    // Mutation (T6), staged: deleting the 'host-class' step in tickPlayback() turned this red.
  });
}
