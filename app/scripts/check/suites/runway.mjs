// 9b design.md D5, corrected post-result: a playing page's published held-ahead
// runs from its mapping's anchor, so the runway is that figure less the time
// played. Pure; the schedule case runs on a fake clock.

import { assert, assertEqual, check } from '../harness.mjs';
import { heldAheadAt, runwayMs } from '../../figures/poll-coverage.mjs';
import { runSchedule } from '../../harness/capacity-schedule.mjs';

const ANCHOR_SHARED_MS = 1_000_000;
const OFFSET_MS = 2;

// A poll `playedMs` after a playing mapping's anchor, the page's clock 2 ms behind the shared one.
const playing = (publishedMs, playedMs, more = {}) => ({ harnessAfterMs: ANCHOR_SHARED_MS + playedMs,
  heldAhead: { heldAheadMs: publishedMs, atPageMs: ANCHOR_SHARED_MS + playedMs - OFFSET_MS },
  state: { playing: true, held: false, atSharedMs: ANCHOR_SHARED_MS }, clock: { offsetMs: OFFSET_MS }, ...more });

function thrownBy(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

export default async function runwaySuite() {
  await check('runway: a playing page\'s held-ahead is read less the time played since its anchor', async () => {
    // 9b's second qualification attempt, c01: 154 s published 109 s after the seek's anchor, and 210 s at 349 s.
    assertEqual(runwayMs(playing(154_000, 109_000)), 45_000, '45 000 ms of runway at the drop');
    assertEqual(runwayMs(playing(166_000, 151_000)), 15_000, '15 000 ms 40 s later, where the published figure had risen');
    assertEqual(runwayMs(playing(210_000, 349_000)), 0, 'and none at the ceiling: floored at zero, not below it');
    assertEqual(runwayMs(playing(4_000, -3_000)), 4_000, 'a start scheduled 3 s ahead has played nothing');
    // Mutation: with `Math.max(0, published - Math.max(0, playedMs))` replaced by
    // `published`, this check and the schedule check below go red; restored, green.
  });

  await check('runway: a held or paused page\'s held-ahead is its runway as published', async () => {
    const base = playing(9_000, 60_000);
    assertEqual(runwayMs({ ...base, state: { ...base.state, held: true } }), 9_000, 'held: the anchor is the playhead');
    assertEqual(runwayMs({ ...base, state: { ...base.state, playing: false } }), 9_000, 'paused: the same');
  });

  await check('runway: a poll that cannot place its playhead has no value, and a figure below zero is a hard error', async () => {
    assertEqual(runwayMs(playing(9_000, 60_000, { state: null })), null, 'no state');
    assertEqual(runwayMs(playing(9_000, 60_000, { clock: {} })), null, 'no clock offset');
    assertEqual(runwayMs(playing(9_000, 60_000, { heldAhead: { heldAheadMs: 9_000 } })), null, 'no instant on the figure');
    assertEqual(runwayMs({ harnessAfterMs: 1, heldAhead: null, state: { playing: true } }), null, 'no figure');
    assert(thrownBy(() => runwayMs(playing(-1, 0), 'c03'))?.message.includes('c03 published a held-ahead below zero'), 'below zero names the viewer');
  });

  await check('runway: the figures read a span\'s end through it', async () => {
    const viewerPolls = { c01: [playing(166_000, 151_000)], c02: [playing(210_000, 150_500)] };
    assertEqual(JSON.stringify(heldAheadAt(viewerPolls, ['c01', 'c02'], ANCHOR_SHARED_MS + 151_100)), '{"c01":15000,"c02":59500}', 'each viewer\'s runway, not its published figure');
  });

  await check('runway: the schedule rises on a playing room whose published held-ahead never falls', async () => {
    // Every viewer publishes 150 s and more throughout; played time overtakes it 136 s after the anchor.
    const tags = ['c01', 'c02'];
    const viewerPolls = { c01: [], c02: [] };
    const steps = [];
    let t = ANCHOR_SHARED_MS;
    const sleep = async (ms) => {
      t += ms;
      for (const tag of tags) viewerPolls[tag].push(playing(150_000 + (t - ANCHOR_SHARED_MS) / 100, t - ANCHOR_SHARED_MS));
    };
    const step = (rate) => ({ container: 'origin', network: 'wa-media', discipline: 'tbf', params: { rate, burst: '32kbit', latency: '400ms' } });
    const condition = { capacitySchedule: { dropAfterReadyMs: 120_000, drop: step('2mbit'), rise: step('10mbit'),
      edgeHeldAheadMsBelow: 15_000, ceilingMs: 240_000, recordAfterRiseMs: 300_000 } };
    const stepQdisc = async (declared) => { steps.push(declared.params.rate); return { readings: {}, matches: true }; };
    const schedule = await runSchedule({ condition, state: { readyAtMs: ANCHOR_SHARED_MS, tags }, viewerPolls, stepQdisc, now: () => t, sleep });
    assertEqual(`${schedule.edge.reached}/${schedule.exercised}`, 'true/true', 'the room is read at its edge');
    assert(schedule.edge.atMs - ANCHOR_SHARED_MS < 140_000, `well inside the ceiling, ${schedule.edge.atMs - ANCHOR_SHARED_MS} ms after the anchor`);
    assert(schedule.edge.heldAheadMsByClient.c01 < 15_000, 'with the runway recorded, not the published figure');
    assertEqual(steps.join(','), '2mbit,10mbit', 'and the rise follows the drop');
  });
}
