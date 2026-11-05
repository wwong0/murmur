// scripts/check/suites/playback-start-repark.mjs
//
// The late-start re-park: the reducer with a fake
// element, then the entry's wiring and telemetry. No browser, no timer.

import { check, assert, assertEqual } from '../harness.mjs';
import { createPlaybackStart } from '../../../public/lib/playback-start.mjs';
import { offsetView } from '../../../public/lib/playback-state.mjs';
import { LATE_START_REPARK_MS, MAX_LATE_REPARKS } from '../../../public/lib/playback-leads.mjs';
import { createStartTelemetry } from '../../../public/lib/start-telemetry.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const json = (value) => JSON.stringify(value);
const OPTIONS = Object.freeze({ prepareLeadMs: 400, reparkAfterMs: 600, maxReparks: 2 });

const playing = () => ({
  lineage: 'repark',
  version: 1,
  current: { playing: true, atSharedMs: 1000, mediaMs: 500 },
  previous: null,
  controlMode: 'open',
});

function rig({ options = OPTIONS, state = playing() } = {}) {
  const start = createPlaybackStart(options);
  const writes = [];
  const plays = [];
  let paused = true;
  const poll = (nowSharedMs) => {
    const result = start.poll({ nowSharedMs, resolved: true, state, linkOpen: true });
    for (const action of result.actions) {
      if (action.kind === 'pause') paused = true;
      else if (action.kind === 'load' || action.kind === 'park') writes.push({ ...action, paused });
      else if (action.kind === 'play') {
        paused = false;
        plays.push(action);
      }
    }
    return result;
  };
  return { start, writes, plays, poll };
}

function throws(fn) {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
}

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export default async function playbackStartReparkSuite() {
  await check('playback-start-repark (a): a ready start beyond the bound parks again at the room position', async () => {
    const r = rig();
    const first = r.poll(1000);
    assertEqual(json([first.actions[0].kind, first.actions[0].positionMs, first.nextAtSharedMs]), json(['load', 900, 1400]), 'the first load is at mediaMsAt(S)');
    r.start.ready(first.attemptId, 1500);
    const late = r.poll(2100);
    assertEqual(json(late.actions.map((action) => action.kind)), json(['park']), 'a start 700 ms late parks and does not play');
    const park = late.actions[0];
    assert(park.attemptId !== first.attemptId, 'the re-park is a new attempt');
    assertEqual(json([park.reparkOf, park.reparks, park.abandonedLatenessMs]), json([first.attemptId, 1, 700]), 'the re-park names what it replaced and how late it was');
    assertEqual(json([park.positionMs, late.nextAtSharedMs]), json([2000, 2500]), 'it parks at mediaMsAt(now + lead) and schedules that S');
    assertEqual(r.plays.length, 0, 'nothing played before the re-park');
    assert(r.writes.every((write) => write.paused), 'both writes are made to a paused element');

    r.start.ready(park.attemptId, 2300);
    const due = r.poll(2500);
    assertEqual(json(due.actions.map((action) => action.kind)), json(['play']), 'the re-parked attempt plays at its S');
    const play = due.actions[0];
    assertEqual(json([play.latenessMs, play.startAtSharedMs, play.positionMs, play.seamEpochMs]), json([0, 2500, 2000, 500]), 'on time, from the new park, on the room epoch');
    assertEqual(json([play.reparks, play.firstStartAtSharedMs]), json([1, 1400]), 'the play carries the re-park count and the first S');
    assertEqual(r.start.state().reparks, 1, 'the snapshot counts the re-park');
  });

  await check('playback-start-repark (b): at or under the bound the start plays from its park', async () => {
    for (const [now, lateness] of [[1900, 500], [2000, 600]]) {
      const r = rig();
      const first = r.poll(1000);
      r.start.ready(first.attemptId, 1500);
      const due = r.poll(now);
      assertEqual(json(due.actions.map((action) => action.kind)), json(['play']), `a start ${lateness} ms late plays`);
      assertEqual(json([due.actions[0].positionMs, due.actions[0].latenessMs, due.actions[0].reparks]), json([900, lateness, 0]), `it plays from the first park, ${lateness} ms late, never re-parked`);
      assertEqual(r.writes.length, 1, `no second write at ${lateness} ms`);
    }
  });

  await check('playback-start-repark (c): the re-park holds the position offset', async () => {
    const r = rig({ state: offsetView(playing(), 30_000) });
    const first = r.poll(1000);
    r.start.ready(first.attemptId, 1500);
    const park = r.poll(2100).actions[0];
    assertEqual(json([park.kind, park.positionMs]), json(['park', 32_000]), 'the re-park is the room position plus the offset');
    r.start.ready(park.attemptId, 2300);
    const play = r.poll(2500).actions[0];
    assertEqual(json([play.kind, play.seamEpochMs]), json(['play', -29_500]), 'the seam epoch has the offset removed');
  });

  await check('playback-start-repark (d): two re-parks, then the start plays late from the last park', async () => {
    const r = rig();
    let result = r.poll(1000);
    let now = 1000;
    for (const expected of [1, 2]) {
      r.start.ready(result.attemptId, result.nextAtSharedMs + 100);
      now = result.nextAtSharedMs + 700;
      result = r.poll(now);
      assertEqual(json([result.actions.map((action) => action.kind), result.actions[0]?.reparks]), json([['park'], expected]), `late readiness ${expected} re-parks`);
    }
    r.start.ready(result.attemptId, result.nextAtSharedMs + 100);
    const S = result.nextAtSharedMs;
    const last = r.poll(S + 700);
    assertEqual(json(last.actions.map((action) => action.kind)), json(['play']), 'the third late readiness plays');
    assertEqual(json([last.actions[0].latenessMs, last.actions[0].reparks, last.actions[0].firstStartAtSharedMs]), json([700, 2, 1400]), 'it plays late, capped at two, from the first S');
    assertEqual(json([r.writes.length, r.start.state().reparks]), json([3, 2]), 'one load and two re-parks');
  });

  await check('playback-start-repark (e): no readiness, no re-park', async () => {
    const r = rig();
    const first = r.poll(1000);
    for (let now = 1400; now <= 11_400; now += 500) {
      assertEqual(r.poll(now).actions.length, 0, `nothing is written at ${now} before readiness`);
    }
    assertEqual(json([r.writes.length, r.start.state().attemptId]), json([1, first.attemptId]), 'the slow load keeps its one attempt');
  });

  await check('playback-start-repark (f): invalid options throw and the defaults never re-park', async () => {
    for (const reparkAfterMs of [-1, Number.NaN, '600']) {
      assert(throws(() => createPlaybackStart({ prepareLeadMs: 400, reparkAfterMs })), `reparkAfterMs ${String(reparkAfterMs)} throws`);
    }
    for (const maxReparks of [1.5, -1]) {
      assert(throws(() => createPlaybackStart({ prepareLeadMs: 400, maxReparks })), `maxReparks ${maxReparks} throws`);
    }
    const r = rig({ options: { prepareLeadMs: 400 } });
    const first = r.poll(1000);
    r.start.ready(first.attemptId, 1500);
    const due = r.poll(2100);
    assertEqual(json([due.actions.map((action) => action.kind), due.actions[0].latenessMs]), json([['play'], 700]), 'without the options a late start plays from its park');
  });

  const product = await bundleProductEntry();
  await check('playback-start-repark (g): the page enables the re-park and publishes it on its start', async () => {
    const page = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] } });
    await drain();
    const constructed = page.events.find((event) => event.kind === 'playback-start-created');
    assert(constructed !== undefined, 'the page constructed the scheduled start');
    const { reparkAfterMs, maxReparks } = constructed.detail ?? {};
    assert(Object.is(reparkAfterMs, LATE_START_REPARK_MS) && reparkAfterMs === 600, `the page passed the 600 ms bound, got ${reparkAfterMs}`);
    assert(Object.is(maxReparks, MAX_LATE_REPARKS) && maxReparks === 2, `the page passed two re-parks, got ${maxReparks}`);
    page.open({ positionMs: 0, scheduledPositionMs: 0, seamEpochMs: 1000 });
    page.act([{ kind: 'play', attemptId: 3, positionMs: 2000, scheduledPositionMs: 2000, advanceMs: 0, seamEpochMs: 500, startAtSharedMs: 2500, latenessMs: 0, reparks: 1, firstStartAtSharedMs: 1400 }]);
    const entry = page.app.playback().starts.at(-1);
    assertEqual(json([entry?.reparks, entry?.firstStartAtSharedMs]), json([1, 1400]), 'the starts entry carries the re-park count and the first S');
  });

  await check('playback-start-repark (h): start telemetry keeps the re-park fields', async () => {
    const telemetry = createStartTelemetry({ enabled: true, now: () => 1 });
    const event = telemetry.record('action', { action: 'park', reparkOf: 1, reparks: 1, abandonedLatenessMs: 700, firstStartAtSharedMs: 1400 }, null);
    assertEqual(json([event.reparkOf, event.reparks, event.abandonedLatenessMs, event.firstStartAtSharedMs]), json([1, 1, 700, 1400]), 'an action record keeps all four');
  });
}
