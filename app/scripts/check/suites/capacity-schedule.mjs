// 9b design.md D5: the deep drop, the rise at the room's edge or at the ceiling,
// and the refusal of a step that is not in force. Fake clock, polls and stepQdisc.

import { assert, assertEqual, check } from '../harness.mjs';
import {
  capacityScheduleReason, runSchedule, scheduleLengthMs, scheduleRefusals,
} from '../../harness/capacity-schedule.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';
import { capacityBitsForManifest } from '../../harness-figures.mjs';

const step = (rate) => ({ container: 'origin', network: 'wa-media', discipline: 'tbf', params: { rate, burst: '32kbit', latency: '400ms' } });
const SCHEDULE = { dropAfterReadyMs: 120_000, drop: step('2mbit'), rise: step('10mbit'),
  edgeHeldAheadMsBelow: 15_000, ceilingMs: 240_000, recordAfterRiseMs: 300_000 };
const CONDITION = { delivery: 'host', peerExchange: true, excludedPrefixMs: 120_000, capacitySchedule: SCHEDULE };
const TAGS = ['c01', 'c02', 'c03', 'c04', 'c05'];
const DROP_AT_MS = 120_000;
// A held room publishes its runway as it stands; the playing case is the runway suite's.
const HELD = { playing: false, held: true };

// The clock moves only in `sleep`, and every viewer polls at each tick: `heldAhead`
// gives its published value `sinceDropMs` after the drop, or undefined for no poll.
function world({ heldAhead, matches = () => true }) {
  let t = 0;
  const viewerPolls = Object.fromEntries(TAGS.map((tag) => [tag, []]));
  const steps = [];
  const sleep = async (ms) => {
    t += ms;
    for (const tag of TAGS) {
      const value = heldAhead(tag, t - DROP_AT_MS);
      if (value !== undefined) viewerPolls[tag].push({ harnessAfterMs: t, heldAhead: { heldAheadMs: value }, state: HELD });
    }
  };
  const stepQdisc = async (declared) => {
    steps.push(`${t}:${declared.params.rate}`);
    return { readings: { rate: { wanted: declared.params.rate } }, matches: matches(declared) };
  };
  return { run: () => runSchedule({ condition: CONDITION, state: { readyAtMs: 0, tags: TAGS }, viewerPolls, stepQdisc, now: () => t, sleep }), steps };
}

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function capacityScheduleSuite() {
  await check('capacity schedule: a condition declares both steps whole, with no capacity step, after its seek has settled', async () => {
    assertEqual(capacityScheduleReason(CONDITION), null, 'the registered shape is valid');
    assertEqual(conditionValidationReason(CONDITION), null, 'and needs no seek');
    assertEqual(scheduleLengthMs(CONDITION), 660_000, '120 s, the 240 s ceiling and 300 s after the rise');
    assertEqual(scheduleLengthMs({}), 0, 'a condition with no schedule adds nothing');
    const invalid = (change) => conditionValidationReason({ ...CONDITION, ...change });
    assertEqual(invalid({ capacityStep: step('5mbit') }), 'capacity-schedule-invalid', 'not beside a capacity step');
    assertEqual(invalid({ capacitySchedule: { ...SCHEDULE, drop: { ...step('2mbit'), container: 'c01' } } }), 'capacity-schedule-invalid', 'a step on a viewer is not one');
    assertEqual(invalid({ capacitySchedule: { ...SCHEDULE, rise: step('fast') } }), 'capacity-schedule-invalid', 'a rate that does not parse is not one');
    const { ceilingMs: _ceiling, ...noCeiling } = SCHEDULE;
    assertEqual(invalid({ capacitySchedule: noCeiling }), 'capacity-schedule-invalid', 'a schedule with no ceiling is refused');
    assertEqual(invalid({ delivery: 'http' }), 'peer-exchange-requires-host-delivery', 'host delivery is required');
    const seek = { issueAfterReadyMs: 120_000, deltaMs: 600_000, appliedTimeoutMs: 30_000 };
    assertEqual(invalid({ seek, capacitySchedule: { ...SCHEDULE, dropAfterReadyMs: 239_999 } }), 'capacity-schedule-invalid', 'a drop 119 999 ms after the seek is too early');
    assertEqual(invalid({ seek, capacitySchedule: { ...SCHEDULE, dropAfterReadyMs: 240_000 } }), null, 'one 120 000 ms after it is valid');
    assertEqual(capacityBitsForManifest({ condition: { ...CONDITION, capacityMbps: 5 } }), 10_000_000, 'the figures read at the rise\'s rate');
  });

  await check('capacity schedule: the rise follows the poll at which the last viewer crosses 15 000 ms', async () => {
    const fake = world({ heldAhead: (tag, since) => (tag !== 'c05' ? 9_000 : since < 140_000 ? 20_000 : 14_000) });
    const schedule = await fake.run();
    assertEqual(fake.steps.join(' '), '120000:2mbit 260000:10mbit', 'the drop 120 s after ready, the rise 140 s after the drop');
    assertEqual(schedule.edge.reached, true, 'the room reached its edge');
    assertEqual(schedule.edge.atMs, 260_000, 'at that poll');
    assertEqual(schedule.edge.heldAheadMsByClient.c05, 14_000, 'with the last viewer at 14 000 ms');
    assertEqual(schedule.exercised, true, 'the run is exercised');
    assertEqual(`${schedule.drop.appliedAtMs}/${schedule.drop.readBackAtMs}/${schedule.drop.inForce}`, '120000/120000/true', 'the drop is recorded with its read-back');
    assertEqual(schedule.rise.declared.params.rate, '10mbit', 'the rise is the declared one');
  });

  await check('capacity schedule: a room that never reaches its edge rises at the ceiling and is not exercised', async () => {
    const fake = world({ heldAhead: (tag) => (tag === 'c03' ? 22_000 : 9_000) });
    const schedule = await fake.run();
    assertEqual(fake.steps.join(' '), '120000:2mbit 360000:10mbit', 'the rise 240 s after the drop');
    assertEqual(schedule.exercised, false, 'not exercised');
    assertEqual(schedule.edge.reached, false, 'the edge was not reached');
    assertEqual(schedule.edge.heldAheadMsByClient.c03, 22_000, 'naming the viewer still 22 000 ms ahead');
  });

  await check('capacity schedule: a viewer with no poll in the last second is not below the figure', async () => {
    // The pair differs only in c05's polls after 100 s: published, or absent.
    const others = (since) => (since < 140_000 ? 20_000 : 14_000);
    const polled = await world({ heldAhead: (tag, since) => (tag === 'c05' ? 14_000 : others(since)) }).run();
    assertEqual(`${polled.exercised}@${polled.edge.atMs}`, 'true@260000', 'with c05 polling, the edge is reached at 140 s');
    const silent = await world({ heldAhead: (tag, since) => (tag !== 'c05' ? others(since) : since <= 100_000 ? 14_000 : undefined) }).run();
    assertEqual(silent.exercised, false, 'with c05 silent, the room is not read as at its edge');
    assertEqual(silent.edge.heldAheadMsByClient.c05, null, 'and c05 has no value, not its last one');
    assertEqual(silent.edge.atMs, 360_000, 'the deep phase ends at the ceiling');
    // Prevention claim: a room that never reached its edge is not read as recovered.
    // Opportunity: four viewers below the figure and one silent. Action boundary:
    // runSchedule's edge test. Mutation, with capacity-schedule.mjs copied aside: a
    // missing value treated as below the figure (`!== null &&` dropped from the
    // test). `npm run check` turned 'with c05 silent, the room is not read as at
    // its edge' red (got true). Restored from the copy, diff empty; green again.
    const negative = await thrownBy(() => world({ heldAhead: () => -1 }).run());
    assert(negative?.message.includes('held-ahead below zero'), 'a held-ahead below zero is a hard error');
  });

  await check('capacity schedule: a drop read back at the old rate refuses the run, and no rise follows', async () => {
    const fake = world({ heldAhead: () => 9_000, matches: (declared) => declared.params.rate !== '2mbit' });
    const schedule = await fake.run();
    assertEqual(fake.steps.join(' '), '120000:2mbit', 'only the drop was attempted');
    assertEqual(schedule.drop.inForce, false, 'the drop is recorded as not in force');
    assertEqual(schedule.rise, null, 'there is no rise');
    assertEqual(schedule.exercised, false, 'and the run is not exercised');
    const refusals = scheduleRefusals(schedule);
    assertEqual(refusals.map((entry) => `${entry.reason}:${entry.step}`).join(' '), 'capacity-schedule-not-in-force:drop', 'the run is refused, naming the step');
    const inForce = await world({ heldAhead: () => 9_000 }).run();
    assertEqual(scheduleRefusals(inForce).length, 0, 'a schedule in force refuses nothing');
    assertEqual(scheduleRefusals(null).length, 0, 'and a run with no schedule has none to refuse');
  });
}
