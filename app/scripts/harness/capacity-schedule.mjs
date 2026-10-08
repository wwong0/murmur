// 9b design.md D5: the host's capacity drops deep, and rises once every viewer
// has published a held-ahead below the edge figure or the deep phase's ceiling
// has passed. Each step is applied and read back as 8a's capacity step is.

import fs from 'node:fs';
import path from 'node:path';
import { parseRate, parseSize, parseTime } from '../../harness/apply-qdisc.mjs';

export const SCHEDULE_FILE = 'capacity-schedule.json';
export const SCHEDULE_TICK_MS = 250;
export const POLL_FRESH_MS = 1_000;
const SEEK_SETTLE_MS = 120_000;
const SCHEDULE_KEYS = 'ceilingMs,drop,dropAfterReadyMs,edgeHeldAheadMsBelow,recordAfterRiseMs,rise';

const finite = (value) => Number.isFinite(value);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => (object(value) ? Object.keys(value).sort().join(',') : '');
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The shape 8a's `capacityStep` must have: the origin's tbf on the media network, three parsed parameters. */
export function stepShapeValid(step) {
  const params = step?.params;
  if (keysOf(step) !== 'container,discipline,network,params' || keysOf(params) !== 'burst,latency,rate') return false;
  if (step.container !== 'origin' || step.network !== 'wa-media' || step.discipline !== 'tbf') return false;
  if (Object.values(params).some((value) => typeof value !== 'string' || value.length === 0)) return false;
  return [parseRate(params.rate), parseSize(params.burst), parseTime(params.latency)].every((value) => finite(value) && value > 0);
}

export function capacityScheduleReason(condition = {}) {
  if (!Object.prototype.hasOwnProperty.call(condition, 'capacitySchedule')) return null;
  const schedule = condition.capacitySchedule;
  const durations = ['dropAfterReadyMs', 'edgeHeldAheadMsBelow', 'ceilingMs', 'recordAfterRiseMs'];
  const valid = keysOf(schedule) === SCHEDULE_KEYS
    && durations.every((name) => finite(schedule[name]) && schedule[name] > 0)
    && stepShapeValid(schedule.drop) && stepShapeValid(schedule.rise)
    && condition.delivery === 'host'
    && !Object.prototype.hasOwnProperty.call(condition, 'capacityStep')
    && (condition.seek ? schedule.dropAfterReadyMs >= condition.seek.issueAfterReadyMs + SEEK_SETTLE_MS
      : schedule.dropAfterReadyMs >= condition.excludedPrefixMs);
  return valid ? null : 'capacity-schedule-invalid';
}

/** From the clients' readiness to the end of the recording, at the ceiling. */
export function scheduleLengthMs(condition = {}) {
  const schedule = condition.capacitySchedule;
  return schedule ? schedule.dropAfterReadyMs + schedule.ceilingMs + schedule.recordAfterRiseMs : 0;
}

// A viewer with no poll in the last second has no value, and no value is not below the figure.
function heldAheadNow(viewerPolls, tags, atMs) {
  return Object.fromEntries(tags.map((tag) => {
    const poll = viewerPolls?.[tag]?.at(-1);
    const fresh = poll && finite(poll.harnessAfterMs) && atMs - poll.harnessAfterMs <= POLL_FRESH_MS;
    const value = fresh ? poll.heldAhead?.heldAheadMs : null;
    if (finite(value) && value < 0) throw new Error(`capacity schedule: ${tag} published a held-ahead below zero: ${value}`);
    return [tag, finite(value) ? value : null];
  }));
}

async function applyStep(declared, stepQdisc, now) {
  const appliedAtMs = now();
  const result = await stepQdisc(declared);
  return { declared, readBack: result?.readings ?? {}, appliedAtMs, readBackAtMs: now(), inForce: result?.matches === true };
}

/**
 * `state` is `{ readyAtMs, tags }`; `viewerPolls` the live arrays the poll loops
 * append to. A step read back at another rate ends the schedule there, and the
 * run is refused by it.
 */
export async function runSchedule({ condition, state, viewerPolls, stepQdisc, now = Date.now, sleep = realSleep }) {
  const schedule = condition.capacitySchedule;
  const dropAtMs = state.readyAtMs + schedule.dropAfterReadyMs;
  while (now() < dropAtMs) await sleep(Math.min(SCHEDULE_TICK_MS, dropAtMs - now()));
  const drop = await applyStep(schedule.drop, stepQdisc, now);
  if (!drop.inForce) return { drop, rise: null, edge: null, exercised: false };
  let edge = null;
  while (!edge) {
    await sleep(SCHEDULE_TICK_MS);
    const atMs = now();
    const heldAheadMsByClient = heldAheadNow(viewerPolls, state.tags, atMs);
    const reached = state.tags.length > 0
      && state.tags.every((tag) => heldAheadMsByClient[tag] !== null && heldAheadMsByClient[tag] < schedule.edgeHeldAheadMsBelow);
    if (reached || atMs - drop.readBackAtMs >= schedule.ceilingMs) edge = { reached, atMs, heldAheadMsByClient };
  }
  const rise = await applyStep(schedule.rise, stepQdisc, now);
  return { drop, rise, edge, exercised: edge.reached };
}

/**
 * Runs the schedule, keeps it in the run's directory and manifest, and, where
 * the condition declares no seek, opens the measure window at the rise's
 * read-back. Returns the instant the recording may end.
 */
export async function recordSchedule({ condition, window, tags, viewerPolls, stepQdisc, manifestFile, runDir, now, sleep }) {
  const schedule = await runSchedule({ condition, state: { readyAtMs: window.clientsReadyAtMs, tags }, viewerPolls, stepQdisc, now, sleep });
  fs.writeFileSync(path.join(runDir, SCHEDULE_FILE), `${JSON.stringify(schedule, null, 2)}\n`);
  manifestFile.merge({ capacitySchedule: schedule });
  if (!schedule.rise) { manifestFile.write(); return window.endMs; }
  const recordAfterRiseMs = condition.capacitySchedule.recordAfterRiseMs;
  const endMs = schedule.rise.readBackAtMs + recordAfterRiseMs;
  if (!condition.seek) {
    Object.assign(window, { startMs: schedule.rise.readBackAtMs, endMs, measureWindowMs: recordAfterRiseMs,
      declaredStartMs: schedule.rise.readBackAtMs, declaredEndMs: endMs, opensAt: 'capacity-schedule-rise' });
  }
  manifestFile.write();
  return Math.max(window.endMs, endMs);
}

export function scheduleRefusals(schedule) {
  if (!schedule) return [];
  return ['drop', 'rise'].filter((step) => schedule[step] && schedule[step].inForce === false)
    .map((step) => ({ reason: 'capacity-schedule-not-in-force', step, declared: schedule[step].declared, readBack: schedule[step].readBack }));
}
