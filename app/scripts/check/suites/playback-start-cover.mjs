// scripts/check/suites/playback-start-cover.mjs

import { check, assert, assertEqual } from '../harness.mjs';
import { createPlaybackStart } from '../../../public/lib/playback-start.mjs';
import {
  START_COVER_MARGIN_MS,
  START_PROJECTION_MAX_MS,
  START_PROJECTION_MS,
} from '../../../public/lib/playback-leads.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const json = (value) => JSON.stringify(value);
const playing = (atSharedMs = 0, mediaMs = 0) => ({
  lineage: 'cover',
  version: 1,
  current: { playing: true, atSharedMs, mediaMs },
  previous: null,
  controlMode: 'open',
});
const segments = (mediaEndMs) => [{ mediaStartMs: 0, mediaEndMs }];
const titleSegments = [
  { index: 0, mediaStartMs: 0, mediaEndMs: 4_000 },
  { index: 1, mediaStartMs: 4_000, mediaEndMs: 8_000 },
  { index: 2, mediaStartMs: 8_000, mediaEndMs: 11_016 },
];

function rig({ margin = 0, projection = 350, projectionMax = projection, prepareLead = 350, reparkAfterMs = Infinity, maxReparks = 0, state = playing(), last = null } = {}) {
  const start = createPlaybackStart({
    prepareLeadMs: prepareLead,
    coverMarginMs: margin,
    projectionMs: projection,
    projectionMaxMs: projectionMax,
    reparkAfterMs,
    maxReparks,
  });
  const element = { paused: true, writes: [], plays: [] };
  const context = { nowSharedMs: 0, resolved: true, state, linkOpen: true, finished: null, last };
  function apply(actions) {
    for (const action of actions) {
      if (action.kind === 'pause') element.paused = true;
      if (action.kind === 'load' || action.kind === 'park') {
        element.writes.push({ ...action, paused: element.paused });
      }
      if (action.kind === 'play') {
        element.paused = false;
        element.plays.push(action);
      }
    }
  }
  function poll(input = {}) {
    Object.assign(context, input);
    const result = start.poll(context);
    apply(result.actions);
    return result;
  }
  return { start, element, context, poll };
}

async function coverAt(elapsedMs, options = {}) {
  const r = rig({ margin: 1000, projection: 3000, projectionMax: 30000, prepareLead: 1801, ...options });
  r.poll({ nowSharedMs: 0, finished: [] });
  const result = r.poll({ nowSharedMs: elapsedMs, finished: segments(4000) });
  return { r, result };
}

export default async function playbackStartCoverSuite() {
  const last = titleSegments.at(-1);
  const tailRig = (mediaMs) => rig({ margin: 3_000, projection: 3_000, projectionMax: 30_000, state: playing(0, mediaMs), last });

  // Prevention proof: dropping the edgeIndexAfter clause from covered() turns
  // `a play 2 s before the end starts` red.
  await check('playback-start-cover: a play 2 s before the end starts', async () => {
    const allFinished = tailRig(9_016);
    const prepared = allFinished.poll({ nowSharedMs: 0, finished: titleSegments });
    allFinished.start.ready(prepared.attemptId, 0);
    const due = allFinished.poll({ nowSharedMs: prepared.nextAtSharedMs, finished: titleSegments });
    assertEqual(due.actions[0]?.kind, 'play', 'a play 2 s before the end starts');
    assertEqual(due.startAtSharedMs, prepared.nextAtSharedMs, 'the play is issued at the chosen S');
  });

  // Prevention proof: comparing against last.index instead of last.index + 1
  // turns `a finished run that stops before the last segment does not cover` red.
  await check('playback-start-cover: the tail is not covered until it is finished', async () => {
    const unfinished = tailRig(9_016);
    const waiting = unfinished.poll({ nowSharedMs: 0, finished: titleSegments.slice(0, 2) });
    assertEqual(waiting.startAtSharedMs, null, 'the tail is not covered until it is finished');
    const shortRun = tailRig(7_016).poll({ nowSharedMs: 0, finished: titleSegments.slice(0, 2) });
    assertEqual(shortRun.startAtSharedMs, null, 'a finished run that stops before the last segment does not cover');
  });

  await check('playback-start-cover: a position short of the margin is not covered, as before', async () => {
    const marginResult = tailRig(1_016).poll({ nowSharedMs: 0, finished: [titleSegments[0]] });
    assertEqual(marginResult.startAtSharedMs, null, 'a position short of the margin is not covered');
  });

  // Prevention proof: removing the projection's bound turns `the projection
  // does not pass the end` red.
  await check('playback-start-cover: the projection does not pass the end', async () => {
    const projected = tailRig(9_016).poll({ nowSharedMs: 0, finished: titleSegments.slice(0, 2) });
    assert(projected.actions[0].positionMs < last.mediaEndMs, 'the projection does not pass the end');
    const later = tailRig(9_016);
    later.poll({ nowSharedMs: 0, finished: titleSegments.slice(0, 2) });
    assert(Number.isFinite(later.poll({ nowSharedMs: 0, finished: titleSegments }).startAtSharedMs), 'the tail finished later chooses S');
  });

  await check('playback-start-cover: last null preserves the existing rule', async () => {
    const first = rig({ margin: 3_000, projection: 3_000, projectionMax: 30_000, state: playing(0, 9_016) });
    const second = rig({ margin: 3_000, projection: 3_000, projectionMax: 30_000, state: playing(0, 9_016) });
    const left = first.poll({ nowSharedMs: 0, finished: titleSegments });
    const right = second.poll({ nowSharedMs: 0, finished: titleSegments });
    assertEqual(json(left.actions), json(right.actions), 'last null keeps the existing actions');
    assertEqual(left.nextAtSharedMs, right.nextAtSharedMs, 'last null keeps the existing deadline');
  });

  await check('playback-start-cover: a position already past the end is unchanged', async () => {
    const options = { margin: 3_000, projection: 3_000, projectionMax: 30_000, state: playing(0, 12_000) };
    const withLast = rig({ ...options, last: titleSegments.at(-1) }).poll({ nowSharedMs: 0, finished: titleSegments });
    const without = rig(options).poll({ nowSharedMs: 0, finished: titleSegments });
    assertEqual(withLast.startAtSharedMs, null, 'a position past the end is not covered');
    assertEqual(json(withLast.actions), json(without.actions), 'a position past the end projects as before');
  });

  await check('playback-start-cover case 1: coverage after the candidate still starts at P', async () => {
    const r = rig({ margin: 1000, projection: 1500, projectionMax: 30000 });
    const first = r.poll({ nowSharedMs: 0, finished: [] });
    assertEqual(first.startAtSharedMs, null, 'uncovered media leaves S unchosen');
    assertEqual(first.nextAtSharedMs, null, 'uncovered media schedules no deadline');
    r.start.ready(first.attemptId, 1000);
    const covered = r.poll({ nowSharedMs: 1000, finished: segments(2500) });
    assertEqual(covered.startAtSharedMs, 1500, 'coverage chooses the projection as S');
    assertEqual(covered.nextAtSharedMs, 1500, 'the chosen S is the next poll');
    const due = r.poll({ nowSharedMs: 1500, finished: segments(2500) });
    assertEqual(json(due.actions.map((action) => action.kind)), json(['play']), 'P dispatches play');
    assertEqual(due.actions[0].latenessMs, 0, 'play at P has zero lateness');
    assertEqual(json(r.element.writes.map((write) => write.kind)), json(['load']), 'one load serves the start');
  });

  await check('playback-start-cover case 2: late coverage makes one re-projection', async () => {
    const r = rig({ margin: 1000, projection: 1500, projectionMax: 30000 });
    const first = r.poll({ nowSharedMs: 0, finished: [] });
    r.start.ready(first.attemptId, 500);
    const missed = r.poll({ nowSharedMs: 1200, finished: segments(2500) });
    assertEqual(missed.reprojections, 1, 'the new attempt counts one re-projection');
    assertEqual(json([missed.reparks, missed.retargets]), json([0, 0]), 'a miss is neither a re-park nor a retarget');
    assertEqual(json(r.element.writes.map((write) => write.kind)), json(['load', 'park']), 'the miss writes exactly load then park');
    assertEqual(r.element.plays.length, 0, 'the first attempt never plays from its park');
    assertEqual(json([missed.actions[0].reprojections, missed.actions[0].reprojectionOf, missed.actions[0].coverElapsedMs]), json([1, first.attemptId, 1200]), 'the park reports its replacement');
    assertEqual(missed.actions[0].projectionMs, 1500, 'the park reports the replaced projection');
  });

  await check('playback-start-cover case 3: passing P while uncovered does nothing until coverage', async () => {
    const r = rig({ margin: 1000, projection: 1500, projectionMax: 30000 });
    const first = r.poll({ nowSharedMs: 0, finished: [] });
    r.start.ready(first.attemptId, 1000);
    const atP = r.poll({ nowSharedMs: 1500, finished: [] });
    assertEqual(atP.actions.length, 0, 'the poll at P has no action');
    assertEqual(atP.startAtSharedMs, null, 'the poll at P keeps S unchosen');
    const afterP = r.poll({ nowSharedMs: 1600, finished: [] });
    assertEqual(afterP.actions.length, 0, 'the poll after P still has no action');
    const covered = r.poll({ nowSharedMs: 1600, finished: segments(2500) });
    assertEqual(covered.reprojections, 1, 'coverage after P makes a new attempt');
    assertEqual(json(covered.actions.map((action) => action.kind)), json(['park']), 'the covered late poll parks the new attempt');
  });

  await check('playback-start-cover case 4: margin edges and the product setting discriminate', async () => {
    const justShort = rig({ margin: 2500, projection: 1500 }).poll({ nowSharedMs: 0, finished: segments(2849) });
    const exact = rig({ margin: 2500, projection: 1500 }).poll({ nowSharedMs: 0, finished: segments(2850) });
    const productMargin = rig({ margin: 3000, projection: 1500 }).poll({ nowSharedMs: 0, finished: segments(2850) });
    assertEqual(justShort.startAtSharedMs, null, '2499 ms ahead is not covered');
    assertEqual(exact.startAtSharedMs, 350, '2500 ms ahead is covered');
    assertEqual(productMargin.startAtSharedMs, null, 'the same run is short of a 3000 ms margin');

    const product = await bundleProductEntry();
    const page = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] } });
    const made = page.events.find((event) => event.kind === 'playback-start-created')?.detail;
    assertEqual(made.coverMarginMs, START_COVER_MARGIN_MS, 'the entry passes the product margin');
    assertEqual(made.projectionMs, START_PROJECTION_MS, 'the entry passes the product projection');
    assertEqual(made.projectionMaxMs, START_PROJECTION_MAX_MS, 'the entry passes the product projection cap');
    page.harness.finished = segments(1000);
    page.tick();
    const poll = page.events.filter((event) => event.kind === 'playback-start-poll').at(-1)?.detail;
    assert(Array.isArray(poll?.finished), 'the entry passes finished fragments into poll');
    assertEqual(page.harness.finishedHandlers.length, 1, 'the entry subscribes to finished fragments');
  });

  await check('playback-start-cover case 5: already covered at S0 is unchanged from margin zero', async () => {
    const covered = rig({ margin: 2500, projection: 1500 }).poll({ nowSharedMs: 0, finished: segments(3000) });
    const zero = rig({ margin: 0, projection: 1500 }).poll({ nowSharedMs: 0, finished: [] });
    assertEqual(json(covered.actions), json(zero.actions), 'covered media has identical actions');
    assertEqual(covered.nextAtSharedMs, zero.nextAtSharedMs, 'covered media has the same deadline');
  });

  await check('playback-start-cover case 6: missed coverage doubles elapsed time and respects the cap', async () => {
    for (const [elapsedMs, expectedProjectionMs] of [[1200, 3000], [10_000, 20_000], [40_000, 30_000]]) {
      const { r, result } = await coverAt(elapsedMs);
      assertEqual(result.reprojections, 1, `elapsed ${elapsedMs} makes one re-projection`);
      assertEqual(result.projectedAtSharedMs - elapsedMs, expectedProjectionMs, `elapsed ${elapsedMs} uses projection ${expectedProjectionMs}`);
      assertEqual(result.actions[0].coverElapsedMs, elapsedMs, `elapsed ${elapsedMs} is reported`);
      assertEqual(r.element.writes.length, 2, `elapsed ${elapsedMs} writes one replacement park`);
    }
  });

  await check('playback-start-cover case 7: a late re-park uses the same preparation routine', async () => {
    const repark = rig({ margin: 3000, projection: 1500, projectionMax: 30000, reparkAfterMs: 600, maxReparks: 1 });
    const prepared = repark.poll({ nowSharedMs: 0, finished: segments(3350) });
    repark.start.ready(prepared.attemptId, 1000);
    const result = repark.poll({ nowSharedMs: 2100, finished: segments(3350) });
    assertEqual(repark.start.state().reparks, 1, 'a late chosen attempt re-parks once');
    assertEqual(result.reprojections, 0, 'the re-park itself is not a re-projection');
    assertEqual(result.startAtSharedMs, null, 'the uncovered re-park has no chosen S');
    assertEqual(json(result.actions.map((action) => action.kind)), json(['park']), 'the re-park writes one park');
  });

  await check('playback-start-cover case 8: native null coverage equals margin zero, empty coverage does not', async () => {
    const native = rig({ margin: 2500, projection: 1500 }).poll({ nowSharedMs: 0, finished: null });
    const empty = rig({ margin: 2500, projection: 1500 }).poll({ nowSharedMs: 0, finished: [] });
    assertEqual(native.startAtSharedMs, 350, 'null coverage keeps the existing start');
    assertEqual(empty.startAtSharedMs, null, 'an empty finished set is not covered');
    assertEqual(native.actions[0].positionMs, 350, 'native null loads at S0');
    assertEqual(empty.actions[0].positionMs, 1500, 'empty coverage loads at P');
  });

  await check('playback-start-cover case 9: every covered-start write is paused and once per attempt', async () => {
    const cases = [
      () => { const r = rig({ margin: 1000, projection: 1500 }); r.poll({ nowSharedMs: 0, finished: [] }); return r; },
      () => { const r = rig({ margin: 1000, projection: 1500 }); r.poll({ nowSharedMs: 0, finished: [] }); r.poll({ nowSharedMs: 1200, finished: segments(2500) }); return r; },
      () => { const r = rig({ margin: 1000, projection: 1500 }); r.poll({ nowSharedMs: 0, finished: [] }); r.poll({ nowSharedMs: 1600, finished: segments(2500) }); return r; },
      () => { const r = rig({ margin: 2500, projection: 1500 }); r.poll({ nowSharedMs: 0, finished: segments(3000) }); return r; },
      () => { const r = rig({ margin: 3000, projection: 1500 }); r.poll({ nowSharedMs: 0, finished: segments(3350) }); r.start.ready(1, 1000); r.poll({ nowSharedMs: 2100, finished: segments(3350) }); return r; },
    ];
    const rigs = cases.map((make) => {
      const value = make();
      return value?.element ? value : null;
    }).filter(Boolean);
    const writes = rigs.flatMap((r) => r.element.writes);
    assert(writes.length > 0, 'the cases exercised position writes');
    assert(writes.every((write) => write.paused), 'every write observed a paused element');
    const counts = new Map();
    for (const [index, r] of rigs.entries()) {
      for (const write of r.element.writes) {
        const key = `${index}:${write.attemptId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    assert([...counts.values()].every((count) => count <= 1), 'each attempt has at most one position write');
  });

  await check('playback-start-cover F5: an accepted skip pauses and parks a fresh attempt', async () => {
    const r = rig({ margin: 0, projection: 350, prepareLead: 350 });
    const first = r.poll({ nowSharedMs: 0, finished: [] });
    r.start.ready(first.attemptId, 200);
    const play = r.poll({ nowSharedMs: 350, finished: [] });
    r.start.playResolved(play.actions[0].attemptId);
    assertEqual(r.start.skip({ abandonedDriftMs: -25_000 }), true, 'a resolved presenting start accepts the skip');
    const parked = r.poll({ nowSharedMs: 400, finished: [] });
    assertEqual(json(parked.actions.map((action) => action.kind)), json(['pause', 'park']), 'the replacement pauses then parks');
    assertEqual(json([parked.actions[1].positionMs, parked.actions[1].skipOf, parked.actions[1].abandonedDriftMs]), json([750, first.attemptId, -25_000]), 'the park uses the timeline position and skip lineage');
    assertEqual(json([parked.skips, parked.reparks, parked.retargets]), json([1, 0, 0]), 'the skip is its own count, not a re-park or retarget');
    assertEqual(r.element.writes.length, 2, 'the skip adds one park after the first load');
    r.start.ready(parked.attemptId, 600);
    const due = r.poll({ nowSharedMs: 750, finished: [] });
    assertEqual(json([due.actions[0].kind, due.actions[0].skipOf, due.actions[0].abandonedDriftMs]), json(['play', first.attemptId, -25_000]), 'the new play carries the same skip lineage');
    assert(r.element.writes.every((write) => write.paused), 'both position writes observed a paused element');

    const stopped = rig({ margin: 0, projection: 350, prepareLead: 350 });
    stopped.poll({ nowSharedMs: 0, finished: [] });
    assertEqual(stopped.start.skip({ abandonedDriftMs: 1 }), false, 'a non-presenting client cannot skip');
    assertEqual(stopped.poll({ nowSharedMs: 100, finished: [] }).actions.length, 0, 'a rejected skip produces no action');
  });
}
