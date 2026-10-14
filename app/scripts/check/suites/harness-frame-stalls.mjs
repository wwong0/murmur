import { assertEqual, check } from '../harness.mjs';
import { frameStalls } from '../../figures/frame-stalls.mjs';

const frames = (times, { presented = null, seq = null } = {}) => times.map((displaySharedMs, index) => ({
  displaySharedMs,
  presentedFrames: presented?.[index] ?? index + 1,
  seq: seq?.[index] ?? index + 1,
}));
const playing = (states) => states.map(([sharedMs, value]) => ({ sharedMs, state: { playing: value, held: !value } }));

export default async function harnessFrameStallsSuite() {
  await check('10b H1: a post-event 900ms gap is placed and exact 250ms is not', async () => {
    const result = frameStalls({ records: frames([14_000, 14_050, 14_950, 15_000]), playing: [],
      fromMs: 14_000, toMs: 15_000, gapMs: 250 });
    assertEqual(result.status, 'ok', 'the frame stream is readable');
    assertEqual(result.stalls.length, 1, 'one gap exceeds the 250ms bar');
    assertEqual(result.stalls[0].startMs, 14_050, 'the stall starts at the last frame');
    assertEqual(result.stalls[0].lengthMs, 900, 'the stall length is 900ms');
    assertEqual(frameStalls({ records: frames([0, 50, 300, 350]), playing: [], fromMs: 0, toMs: 350, gapMs: 250 }).stalls.length,
      0, '250ms exactly is not a stall');
    assertEqual(frameStalls({ records: frames([0, 50, 301, 351]), playing: [], fromMs: 0, toMs: 351, gapMs: 250 }).stalls.length,
      1, '251ms is a stall');
  });

  await check('10b H3: a held stretch is excluded while an active gap remains', async () => {
    const result = frameStalls({ records: frames([0, 50, 5_100, 5_400, 5_450]),
      playing: playing([[0, true], [100, false], [5_100, true]]), fromMs: 0, toMs: 5_400, gapMs: 250 });
    assertEqual(result.stalls.length, 1, 'only the active 300ms gap is counted');
    assertEqual(result.stalls[0].startMs, 5_100, 'the active gap starts after the hold');
    assertEqual(result.stalls[0].lengthMs, 300, 'the hold is not included');
  });

  await check('10b H4: a sequence loss refuses the stream, while contiguous uncalled frames do not', async () => {
    const uncalled = frameStalls({ records: frames([0, 50, 100], { presented: [1, 3, 4] }), playing: [],
      fromMs: 0, toMs: 100, gapMs: 250 });
    assertEqual(uncalled.status, 'ok', 'contiguous sequence records remain readable');
    assertEqual(uncalled.uncalledFrames, 1, 'one compositor-only frame is counted');
    const lost = frameStalls({ records: frames([0, 300], { presented: [1, 6], seq: [1, 3] }), playing: [],
      fromMs: 0, toMs: 300, gapMs: 250 });
    assertEqual(lost.status, 'evidence-failure', 'a missing sequence refuses the stream');
    assertEqual(lost.reason, 'drift-record-lost', 'the missing record is named');
    assertEqual(lost.stalls, undefined, 'a refusal is not an array carrying stall properties');
  });

  await check('11a-2: a shared-clock backstep with contiguous records is not a loss, and a real gap still is', async () => {
    const backstep = frameStalls({ records: frames([0, 40, 80, 30, 70, 110]), playing: [],
      fromMs: 0, toMs: 110, gapMs: 250 });
    assertEqual(backstep.status, 'ok', 'a 50ms re-anchor backstep keeps the stream readable');
    assertEqual(backstep.uncalledFrames, 0, 'no frame is counted uncalled');
    assertEqual(backstep.stalls.length, 0, 'no stall is read');
    const lost = frameStalls({ records: frames([0, 40, 80, 30, 70], { presented: [1, 2, 3, 5, 6], seq: [1, 2, 3, 5, 6] }),
      playing: [], fromMs: 0, toMs: 80, gapMs: 250 });
    assertEqual(lost.reason, 'drift-record-lost', 'a missing record across a backstep is still named');
  });
}
