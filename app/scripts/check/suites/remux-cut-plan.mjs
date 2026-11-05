import { assert, assertEqual, check } from '../harness.mjs';
import { targetMillis } from '../../../public/lib/remux-settings.mjs';
import { assignAudio, planCuts } from '../../../public/lib/remux-cut-plan.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';
import { loadFixture, memorySource } from '../remux-rig.mjs';

// Section 3's rule written a second way: every later boundary is a candidate, the
// furthest one that fits wins, and the nearest one is taken when none fits.
function independentCuts(ticks, endTick, targetMs, timescale) {
  const boundaries = [...ticks, endTick];
  const out = [];
  let from = 0;
  while (from < ticks.length) {
    const later = boundaries.map((tick, at) => ({ tick, at })).filter(({ at }) => at > from);
    const fitting = later.filter(({ tick }) => (tick - boundaries[from]) * 1000 <= targetMs * timescale);
    const chosen = fitting.length > 0 ? fitting.at(-1) : later[0];
    out.push({ startTick: boundaries[from], endTick: chosen.tick, firstKeyframe: from, keyframeCount: chosen.at - from });
    from = chosen.at;
  }
  return out;
}

function comparePlans(actual, expected, label) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), `${label} follows the integer cut rule`);
}

export default async function remuxCutPlanSuite() {
  await check('remux-cut-plan: setting validates millisecond targets', async () => {
    assertEqual(targetMillis(4), 4000, 'four seconds is 4000 milliseconds');
    for (const value of [0, 0.0009, 3600.001, Infinity, NaN, '4', 4.000000000002]) {
      let threw = false;
      try { targetMillis(value); } catch (error) { threw = error instanceof RangeError; }
      assert(threw, `target ${String(value)} is refused`);
    }
  });

  await check('remux-cut-plan: boundaries tile the constructed scenarios', async () => {
    const cases = [
      { name: 'one-second keyframes at four seconds', ticks: [0, 1000, 2000, 3000, 4000], end: 5000, target: 4, scale: 1000, starts: [0, 4000], ends: [4000, 5000] },
      { name: 'four-second keyframes at four seconds', ticks: [0, 4000, 8000], end: 12000, target: 4, scale: 1000, starts: [0, 4000, 8000], ends: [4000, 8000, 12000] },
      { name: 'one ten-second interval remains whole', ticks: [0, 1000, 2000, 3000, 4000, 14000, 15000], end: 16000, target: 4, scale: 1000, starts: [0, 4000, 14000], ends: [4000, 14000, 16000] },
      { name: 'two-second target prefers two intervals', ticks: [0, 1000, 2000, 3000, 4000, 5000], end: 6000, target: 2, scale: 1000, starts: [0, 2000, 4000], ends: [2000, 4000, 6000] },
    ];
    const results = cases.map((item) => ({ item, plan: planCuts({ keyframeTicks: item.ticks, endTick: item.end, timescale: item.scale, targetMs: item.target * 1000 }) }));
    for (const { item, plan } of results) {
      assertEqual(JSON.stringify(plan.map((segment) => segment.startTick)), JSON.stringify(item.starts), `${item.name} starts`);
      assertEqual(JSON.stringify(plan.map((segment) => segment.endTick)), JSON.stringify(item.ends), `${item.name} ends`);
      assertEqual(plan[0].startTick, item.ticks[0], `${item.name} begins at a keyframe`);
      for (let i = 1; i < plan.length; i += 1) assertEqual(plan[i].startTick, plan[i - 1].endTick, `${item.name} tiles at ${i}`);
      for (const segment of plan) assert(item.ticks.includes(segment.startTick), `${item.name} segment start is a keyframe`);
      assertEqual(plan.at(-1).endTick, item.end, `${item.name} reaches the end`);
      for (const segment of plan) if (segment.endTick - segment.startTick > item.target * item.scale) assertEqual(segment.keyframeCount, 1, `${item.name} oversized segment has one interval`);
    }
    assertEqual(planCuts({ keyframeTicks: [0], endTick: 99, timescale: 1000, targetMs: 1 }).length, 1, 'one keyframe gives one segment');
    assertEqual(planCuts({ keyframeTicks: [0, 1000, 2000], endTick: 3000, timescale: 1000, targetMs: 3600000 }).length, 1, 'a target above the length gives one segment');
    const second = Array.from({ length: 60 }, (_, i) => i * 1000);
    const [atTwo, atFour] = [2000, 4000].map((targetMs) => planCuts({ keyframeTicks: second, endTick: 60000, timescale: 1000, targetMs }).length);
    assertEqual(atFour, 15, 'sixty one-second intervals at four seconds give fifteen segments');
    assert(Math.abs(atTwo - 2 * atFour) <= 1, `halving the target doubles the count within one, got ${atTwo} and ${atFour}`);
    const refused = [
      { keyframeTicks: [], endTick: 10 }, { keyframeTicks: [0, 5, 5], endTick: 10 }, { keyframeTicks: [0, 10], endTick: 10 },
    ].map((bad) => { try { planCuts({ ...bad, timescale: 1000, targetMs: 4000 }); return null; } catch (error) { return error; } });
    for (const error of refused) assert(error instanceof RangeError, 'a keyframe list that is empty, unordered or past the end is refused');
  });

  await check('remux-cut-plan: exact integer comparison catches the float edge', async () => {
    const exact = planCuts({ keyframeTicks: [0, 49152, 98304, 147456], endTick: 196608, timescale: 12288, targetMs: 4000 });
    const over = planCuts({ keyframeTicks: [0, 49153, 98306, 147459], endTick: 196612, timescale: 12288, targetMs: 4000 });
    assertEqual(exact.length, 4, 'exact four-second intervals remain four-second segments');
    assertEqual(JSON.stringify(exact.map((x) => x.endTick)), JSON.stringify([49152, 98304, 147456, 196608]), 'exact edge ends at each four-second keyframe');
    assertEqual(over.length, 4, 'one tick over four seconds does not combine');
    assert(over.every((segment) => segment.keyframeCount === 1), 'over-target intervals remain one interval each');
  });

  await check('remux-cut-plan: varying fixture is pinned to both targets', async () => {
    // Keyframes come from ffprobe's table, not from the index.
    const video = loadFixture('varying.mp4').table.streams.video;
    const ticks = video.packets.filter((packet) => packet[3] === 1).map((packet) => packet[1]);
    const endTick = video.packets.at(-1)[1] + (video.packets.at(-1)[1] - video.packets.at(-2)[1]);
    assertEqual(JSON.stringify(ticks.map((tick) => (tick - ticks[0]) / video.timescale)), JSON.stringify([0, 1.5, 2, 5.25, 6, 11]), 'the table has the forced keyframes');
    assertEqual((endTick - ticks[0]) / video.timescale, 14, 'the table ends at fourteen seconds');
    const results = [1, 2, 4].map((seconds) => {
      const expected = independentCuts(ticks, endTick, seconds * 1000, video.timescale);
      const actual = planCuts({ keyframeTicks: ticks, endTick, timescale: video.timescale, targetMs: seconds * 1000 });
      return { seconds, expected, actual, starts: actual.map((segment) => (segment.startTick - ticks[0]) / video.timescale) };
    });
    for (const result of results) comparePlans(result.actual, result.expected, `varying at ${result.seconds}s`);
    // Worked by hand from the six keyframes, so the two rules above cannot agree on a wrong answer.
    assertEqual(JSON.stringify(results[1].starts), JSON.stringify([0, 2, 5.25, 6, 11]), 'varying at 2s starts');
    assertEqual(JSON.stringify(results[2].starts), JSON.stringify([0, 2, 6, 11]), 'varying at 4s starts');
  });

  await check('remux-cut-plan: audio begins on decode time', async () => {
    const constructed = assignAudio({
      segments: [{ startTick: 0, endTick: 100 }, { startTick: 100, endTick: 200 }, { startTick: 200, endTick: 300 }],
      video: { timescale: 1000 },
      audio: { timescale: 1000, dts: new Float64Array([-1, 99, 100, 201, 300]) },
    });
    assertEqual(JSON.stringify(constructed), JSON.stringify([{ from: 0, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 5 }]),
      'a frame starting one tick before a cut stays earlier, and one starting at the cut goes later');
    const short = assignAudio({
      segments: [{ startTick: 0, endTick: 100 }, { startTick: 100, endTick: 200 }, { startTick: 200, endTick: 300 }],
      video: { timescale: 1000 },
      audio: { timescale: 1000, dts: new Float64Array([0, 50]) },
    });
    assertEqual(JSON.stringify(short), JSON.stringify([{ from: 0, to: 2 }, { from: 2, to: 2 }, { from: 2, to: 2 }]), 'audio that ends early leaves empty ranges');
    const rows = [];
    for (const name of ['even-1s.mp4', 'long-audio-frame.mp4', 'bframes.mp4']) {
      const fixture = loadFixture(name);
      const index = await readSourceIndex(memorySource(fixture.bytes));
      const { video, audio } = fixture.table.streams;
      // The table's times are the output's less one constant per track, which remux-index.mjs pins.
      const vShift = index.video.dts[0] + index.video.shift - video.packets[0][1];
      const aShift = index.audio.dts[0] + index.audio.shift - audio.packets[0][1];
      const ticks = video.packets.filter((packet) => packet[3] === 1).map((packet) => packet[1] + vShift);
      const endTick = index.video.dts.at(-1) + index.video.durations.at(-1) + index.video.shift;
      for (const seconds of [1, 4]) {
        const segments = planCuts({ keyframeTicks: ticks, endTick, timescale: video.timescale, targetMs: seconds * 1000 });
        const ranges = assignAudio({ segments, video: index.video, audio: index.audio });
        const frame = (audio.packets[1][1] - audio.packets[0][1]) / audio.timescale;
        const deltas = ranges.slice(1).map((range, i) => (audio.packets[range.from][1] + aShift) / audio.timescale - segments[i + 1].startTick / video.timescale);
        rows.push({ label: `${name} at ${seconds}s`, segments, ranges, frame, deltas, count: audio.packets.length });
      }
    }
    for (const row of rows) {
      assert(row.segments.length > 1, `${row.label} has a cut to test`);
      assertEqual(row.ranges.length, row.segments.length, `${row.label} has one range per segment`);
      assertEqual(row.ranges[0].from, 0, `${row.label} begins at audio sample 0`);
      assertEqual(row.ranges.at(-1).to, row.count, `${row.label} ends at the audio's count`);
      for (let i = 1; i < row.ranges.length; i += 1) assertEqual(row.ranges[i].from, row.ranges[i - 1].to, `${row.label} ranges tile at ${i}`);
      assert(row.frame > 0.02 && row.frame < 0.05, `${row.label} audio frame is ${row.frame}s`);
      for (const delta of row.deltas) assert(delta >= 0 && delta < row.frame, `${row.label} audio begins ${delta}s after its video, within one frame of ${row.frame}s`);
    }
  });
}
