// The host's capacity drops deep, and rises once every viewer
// has published a held-ahead below the edge figure or the deep phase's ceiling
// has passed. Each step is applied and read back as a single capacity step is.

import fs from 'node:fs';
import path from 'node:path';
import { parseRate, parseSize, parseTime } from '../../harness/apply-qdisc.mjs';
import { edgeRank } from '../../public/lib/edge-assignment.mjs';
import { POLL_FRESH_MS, pollAt, runwayMs } from '../figures/poll-coverage.mjs';

export { POLL_FRESH_MS };

export const SCHEDULE_FILE = 'capacity-schedule.json';
export const SCHEDULE_TICK_MS = 250;
const SEEK_SETTLE_MS = 120_000;
const SCHEDULE_KEYS = 'ceilingMs,drop,dropAfterReadyMs,edgeHeldAheadMsBelow,recordAfterRiseMs,rise';
const EDGE_SCHEDULE_KEYS = `${SCHEDULE_KEYS},riseOn`;

const finite = (value) => Number.isFinite(value);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => (object(value) ? Object.keys(value).sort().join(',') : '');
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The shape `capacityStep` must have: the origin's tbf on the media network, three parsed parameters. */
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
  const valid = [SCHEDULE_KEYS, EDGE_SCHEDULE_KEYS].includes(keysOf(schedule))
    && durations.every((name) => finite(schedule[name]) && schedule[name] > 0)
    && stepShapeValid(schedule.drop) && stepShapeValid(schedule.rise)
    && condition.delivery === 'host'
    && !Object.prototype.hasOwnProperty.call(condition, 'capacityStep')
    && (schedule.riseOn === undefined || schedule.riseOn === 'first-fetcher-edge')
    && (condition.seek ? schedule.dropAfterReadyMs >= condition.seek.issueAfterReadyMs + SEEK_SETTLE_MS
      : schedule.dropAfterReadyMs >= condition.excludedPrefixMs);
  return valid ? null : 'capacity-schedule-invalid';
}

/** From the clients' readiness to the end of the recording, at the ceiling. */
export function scheduleLengthMs(condition = {}) {
  const schedule = condition.capacitySchedule;
  return schedule ? schedule.dropAfterReadyMs + schedule.ceilingMs + schedule.recordAfterRiseMs : 0;
}

async function applyStep(declared, stepQdisc, now) {
  const appliedAtMs = now();
  const result = await stepQdisc(declared);
  return { declared, readBack: result?.readings ?? {}, appliedAtMs, readBackAtMs: now(), inForce: result?.matches === true };
}

function firstFetcherEdge({ state, viewerPolls, atMs, schedule } = {}) {
  const tags = state.tags ?? [];
  const viewerIds = typeof state.viewerIds === 'function' ? state.viewerIds() : state.viewerIds;
  const ids = Array.isArray(viewerIds) ? viewerIds : [];
  if (!ids.length) return null;
  const candidates = [];
  for (const tag of tags) {
    const poll = pollAt(viewerPolls?.[tag], atMs, (entry) => entry?.harnessAfterMs, POLL_FRESH_MS);
    const heldAhead = poll?.heldAhead;
    const edgeIndex = heldAhead?.edgeIndex;
    if (!poll || !finite(edgeIndex) || runwayMs(poll, `capacity schedule: ${tag}`) >= schedule.edgeHeldAheadMsBelow) continue;
    const clientIds = typeof state.clientIds === 'function' ? state.clientIds() : state.clientIds;
    const selfId = clientIds?.[tag] ?? tag;
    const ranked = tags.map((candidate) => ({
      tag: candidate,
      rank: edgeRank({ viewerIds: ids, selfId: clientIds?.[candidate] ?? candidate, segmentIndex: edgeIndex }),
    })).sort((left, right) => left.rank - right.rank || left.tag.localeCompare(right.tag));
    const first = ranked[0];
    if (first && first.tag !== tag && edgeRank({ viewerIds: ids, selfId, segmentIndex: edgeIndex }) !== 0) {
      candidates.push({ viewer: tag, index: edgeIndex, leaver: first.tag, roster: ids.slice(), atMs,
        heldAheadMs: runwayMs(poll, `capacity schedule: ${tag}`) });
    }
  }
  return candidates.sort((left, right) => left.viewer.localeCompare(right.viewer))[0] ?? null;
}

/**
 * `state` is `{ readyAtMs, tags }`; `viewerPolls` the live arrays the poll loops
 * append to. A step read back at another rate ends the schedule there, and the
 * run is refused by it.
 */
export async function runSchedule({ condition, state, viewerPolls, stepQdisc, now = Date.now, sleep = realSleep,
  onEdge = null }) {
  const schedule = condition.capacitySchedule;
  const dropAtMs = state.readyAtMs + schedule.dropAfterReadyMs;
  while (now() < dropAtMs) await sleep(Math.min(SCHEDULE_TICK_MS, dropAtMs - now()));
  const drop = await applyStep(schedule.drop, stepQdisc, now);
  if (!drop.inForce) return { drop, rise: null, edge: null, exercised: false };
  let edge = null;
  while (!edge) {
    await sleep(SCHEDULE_TICK_MS);
    const atMs = now();
    const heldAheadMsByClient = Object.fromEntries(state.tags.map((tag) => {
      const poll = pollAt(viewerPolls?.[tag], atMs, (entry) => entry?.harnessAfterMs, POLL_FRESH_MS);
      return [tag, poll ? runwayMs(poll, `capacity schedule: ${tag}`) : null];
    }));
    const event = schedule.riseOn === 'first-fetcher-edge'
      ? firstFetcherEdge({ state, viewerPolls, atMs, schedule }) : null;
    const reached = schedule.riseOn === 'first-fetcher-edge'
      ? Boolean(event)
      : state.tags.length > 0
        && state.tags.every((tag) => heldAheadMsByClient[tag] !== null && heldAheadMsByClient[tag] < schedule.edgeHeldAheadMsBelow);
    if (reached || atMs - drop.readBackAtMs >= schedule.ceilingMs) {
      edge = { reached, atMs, heldAheadMsByClient, ...(event ?? {}) };
      if (event) await onEdge?.(event);
    }
  }
  const rise = await applyStep(schedule.rise, stepQdisc, now);
  return { drop, rise, edge, exercised: edge.reached };
}

/**
 * Runs the schedule, keeps it in the run's directory and manifest, and, where
 * the condition declares no seek, opens the measure window at the rise's
 * read-back. Returns the instant the recording may end.
 */
export async function recordSchedule({ condition, window, tags, viewerPolls, stepQdisc, manifestFile, runDir, now, sleep,
  viewerIds, clientIds, onEdge }) {
  const schedule = await runSchedule({ condition, state: { readyAtMs: window.clientsReadyAtMs, tags, viewerIds, clientIds }, viewerPolls, stepQdisc, now, sleep, onEdge });
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
