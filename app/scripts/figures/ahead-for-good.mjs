import { frameStalls } from './frame-stalls.mjs';
import { harnessSharedMs, pagePollSharedMs, runwayMs } from './poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const row = (name, status, figures = {}) => ({ row: name, status, ...figures });

function stream(input, tag) {
  return input && Object.prototype.hasOwnProperty.call(input, tag) ? input[tag] : undefined;
}

function controlPollSharedMs(poll, timebase) {
  return harnessSharedMs(timebase, poll?.harnessBeforeMs, poll?.harnessAfterMs);
}

function harnessToShared(timebase, value) {
  return finite(value) ? harnessSharedMs(timebase, value, value) : null;
}

/** End the observation at the earliest shared instant from each writer's clock. */
export function earliestObservationEnd({ window, event, seek, capacitySchedule, timebase } = {}) {
  const values = [harnessToShared(timebase, window?.endMs)];
  if (finite(event?.presence?.recvSharedMs)) values.push(event.presence.recvSharedMs);
  values.push(harnessToShared(timebase, event?.issuedAtHarnessMs));
  values.push(harnessToShared(timebase, seek?.seekIssuedAtMs));
  for (const value of [capacitySchedule?.edge?.atMs, capacitySchedule?.drop?.appliedAtMs]) {
    values.push(harnessToShared(timebase, value));
  }
  const finiteValues = values.filter(finite);
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

export function skipCountBefore(pagePolls, tag, fromMs, toMs) {
  const values = (stream(pagePolls, tag) ?? []).map((poll) => ({ atMs: pagePollSharedMs(poll), skips: poll?.playback?.skips }))
    .filter((entry) => finite(entry.atMs) && entry.atMs >= fromMs && entry.atMs <= toMs && integer(entry.skips));
  if (!values.length) return { count: null, evidence: 'unavailable' };
  return { count: Math.max(0, values.at(-1).skips - values[0].skips), evidence: 'measured' };
}

/** Read the first stable runway instant, requiring no later stall. */
export function aheadForGood({ condition, tags = [], window, event, seek, capacitySchedule, drift, polls,
  pagePolls, timebase } = {}) {
  const readyMs = harnessToShared(timebase, window?.clientsReadyAtMs);
  const endMs = earliestObservationEnd({ window, event, seek, capacitySchedule, timebase });
  if (!finite(readyMs) || !finite(endMs) || !(endMs > readyMs)) {
    return row('ahead-for-good', 'unreadable', { reason: 'observation-window-unavailable', readySharedMs: finite(readyMs) ? readyMs : null,
      endSharedMs: finite(endMs) ? endMs : null });
  }
  const runway = {};
  const stallsByClient = {};
  let evidenceFailure = null;
  for (const tag of tags) {
    const values = (stream(polls, tag) ?? []).map((poll) => ({ poll, atMs: controlPollSharedMs(poll, timebase) }))
      .filter((entry) => finite(entry.atMs) && entry.atMs >= readyMs && entry.atMs <= endMs);
    if (!values.length) evidenceFailure = evidenceFailure ?? `poll-window-empty:${tag}`;
    runway[tag] = values.map(({ poll, atMs }) => ({ atSharedMs: atMs, runwayMs: runwayMs(poll, tag) }));
    if (runway[tag].some((entry) => !finite(entry.runwayMs))) evidenceFailure = evidenceFailure ?? `runway-missing:${tag}`;
    const stall = frameStalls({ records: stream(drift, tag), playing: stream(polls, 'host') ?? [],
      fromMs: readyMs, toMs: endMs, gapMs: condition?.churn?.stall?.gapMs ?? 250 });
    if (stall.status !== 'ok') evidenceFailure = evidenceFailure ?? `${tag}:${stall.reason}`;
    stallsByClient[tag] = stall.status === 'ok' ? stall.stalls : [];
  }
  const candidateTimes = [...new Set(tags.flatMap((tag) => runway[tag].map((entry) => entry.atSharedMs)))].sort((a, b) => a - b);
  let candidate = null;
  for (const atMs of candidateTimes) {
    const stableRunway = tags.every((tag) => {
      const values = runway[tag].filter((entry) => entry.atSharedMs >= atMs);
      return values.length > 0 && values.every((entry) => entry.runwayMs > 15_000);
    });
    const stableStalls = Object.values(stallsByClient).every((stalls) => stalls.every((stall) => stall.startMs < atMs));
    if (stableRunway && stableStalls) {
      candidate = atMs;
      break;
    }
  }
  const stopForSkips = finite(candidate) ? candidate : endMs;
  const skipsByClient = Object.fromEntries(tags.map((tag) => [tag,
    skipCountBefore(pagePolls, tag, readyMs, stopForSkips)]));
  const allStalls = Object.values(stallsByClient).flat();
  if (evidenceFailure) return row('ahead-for-good', 'unreadable', { reason: evidenceFailure, readySharedMs: readyMs, endSharedMs: endMs,
    aheadForGoodAfterReadyMs: null, runway, stallsByClient, skipsByClient });
  const status = finite(candidate) ? 'met' : 'never';
  return row('ahead-for-good', status, { readySharedMs: readyMs, endSharedMs: endMs,
    aheadForGoodAfterReadyMs: finite(candidate) ? candidate - readyMs : null,
    aheadForGoodAtSharedMs: finite(candidate) ? candidate : null, runway, stallsByClient, skipsByClient,
    stallsBefore: allStalls.filter((stall) => !finite(candidate) || stall.startMs < candidate) });
}

export function doubleStalls({ drift = {}, polls = {}, tags = Object.keys(drift), fromMs = -Infinity,
  toMs = Infinity, aheadForGoodAtSharedMs = null, gapMs = 250 } = {}) {
  return Object.fromEntries(tags.map((tag) => {
    const result = frameStalls({ records: stream(drift, tag), playing: stream(polls, 'host') ?? [], fromMs, toMs, gapMs });
    const stalls = result.status === 'ok' ? result.stalls : [];
    const pairs = [];
    for (let left = 0; left < stalls.length; left += 1) {
      for (let right = left + 1; right < stalls.length; right += 1) {
        const distanceMs = stalls[right].startMs - stalls[left].startMs;
        if (distanceMs <= 60_000) pairs.push({ first: stalls[left], second: stalls[right], distanceMs,
          phase: finite(aheadForGoodAtSharedMs) && stalls[left].startMs >= aheadForGoodAtSharedMs ? 'after' : 'before' });
      }
    }
    return [tag, { status: result.status, pairs, before: pairs.filter((pair) => pair.phase === 'before').length,
      after: pairs.filter((pair) => pair.phase === 'after').length }];
  }));
}
