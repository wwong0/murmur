import { harnessSharedMs, pagePollSharedMs } from '../figures/poll-coverage.mjs';
import { removesMember } from '../harness/roster-kinds.mjs';
import { weightedPercentile } from './stats.mjs';
import { frameGaps, labInstant } from './lab-position.mjs';

const finite = (value) => Number.isFinite(value);
const bins = ['[0,10)', '[10,20)', '[20,40)', '[40,100)', '[100,250)', '[250,1000)', '[1000,∞)'];

function binFor(value) {
  if (value < 10) return bins[0];
  if (value < 20) return bins[1];
  if (value < 40) return bins[2];
  if (value < 100) return bins[3];
  if (value < 250) return bins[4];
  if (value < 1000) return bins[5];
  return bins[6];
}

function pollEvents(polls) {
  const values = (polls ?? []).map((poll) => ({ poll, atMs: pagePollSharedMs(poll) }))
    .filter((entry) => finite(entry.atMs)).sort((a, b) => a.atMs - b.atMs);
  const starts = [];
  const reparks = [];
  const stalls = [];
  let previousReparks = null;
  let previousStalls = null;
  for (const entry of values) {
    const playback = entry.poll.playback ?? {};
    // The first only: after a seek the page carries the seek's start here (13c `d1-findings.md` F5).
    if (finite(playback.startAtSharedMs) && !starts.length) starts.push(playback.startAtSharedMs);
    if (Number.isSafeInteger(playback.reparks) && previousReparks !== null && playback.reparks > previousReparks) reparks.push(entry.atMs);
    if (Number.isSafeInteger(entry.poll.stalls?.count) && previousStalls !== null && entry.poll.stalls.count > previousStalls) stalls.push(entry.atMs);
    if (Number.isSafeInteger(playback.reparks)) previousReparks = playback.reparks;
    if (Number.isSafeInteger(entry.poll.stalls?.count)) previousStalls = entry.poll.stalls.count;
  }
  return { values, starts, reparks, stalls };
}

function inCauseWindow(eventAt, skipAt) {
  return finite(eventAt) && eventAt <= skipAt && eventAt >= skipAt - 10_000;
}

function causeFor({ skipAt, starts, reparks, seekAt, joinAt, capacity, lossAt, staticLoss, gaps, stalls }) {
  if ([...starts, ...reparks].some((at) => inCauseWindow(at, skipAt))) return 'start';
  if (inCauseWindow(seekAt, skipAt)) return 'seek';
  if (inCauseWindow(joinAt, skipAt)) return 'join';
  if (finite(capacity.drop) && skipAt >= capacity.drop && skipAt <= (finite(capacity.rise) ? capacity.rise + 10_000 : Infinity)) return 'capacity-drop';
  if (staticLoss || inCauseWindow(lossAt, skipAt)) return 'loss';
  if (gaps.some((gap) => inCauseWindow(gap.startMs, skipAt)) || stalls.some((at) => inCauseWindow(at, skipAt))) return 'stall';
  return 'unattributed';
}

// The events a viewer's skip may be attributed to, on the shared clock.
function causesInReach(evidence, tag, polls, gaps) {
  const applied = (change) => harnessSharedMs(evidence.timebase, change?.appliedAtMs, change?.appliedAtMs);
  // The applied instants are the manifest's; the condition holds only the declaration.
  const schedule = evidence.manifest?.capacitySchedule ?? {};
  const drop = applied(schedule.drop);
  const roster = evidence.rosterEvent;
  return { starts: polls.starts, reparks: polls.reparks, stalls: polls.stalls, gaps,
    seekAt: evidence.seek?.host?.atSharedMs,
    joinAt: roster?.kind === 'join' && roster.client === tag ? roster.presence?.recvSharedMs : null,
    capacity: { drop: finite(drop) ? drop : applied(evidence.manifest?.capacityStep), rise: applied(schedule.rise) },
    lossAt: roster && removesMember(roster.kind) ? roster.presence?.recvSharedMs : null,
    staticLoss: (evidence.condition?.qdiscs ?? []).some((qdisc) => qdisc?.params?.loss !== undefined) };
}

function farSkips(evidence, tag, polls, gaps) {
  const causes = causesInReach(evidence, tag, polls, gaps);
  let previous = null;
  const result = [];
  for (const { poll } of polls.values) {
    const skips = poll?.playback?.skips;
    if (!Number.isSafeInteger(skips)) continue;
    if (previous !== null && skips > previous) {
      const skipAt = finite(poll.playback.lastSkipAtSharedMs) ? poll.playback.lastSkipAtSharedMs : null;
      const increment = skips - previous;
      result.push({ atSharedMs: skipAt, abandonedMs: poll.playback.lastSkipAbandonedMs ?? null,
        increment, multiple: increment > 1, cause: causeFor({ skipAt, ...causes }) });
    }
    if (previous === null || skips > previous) previous = skips;
  }
  return result;
}

function viewerGap(evidence, tag) {
  const records = evidence.clients[tag]?.drift;
  const gaps = frameGaps(records);
  const histogram = Object.fromEntries(bins.map((bin) => [bin, 0]));
  const weighted = [];
  let playingMs = 0;
  let noFrameMs = 0;
  let above40Ms = 0;
  let above100Ms = 0;
  const sorted = (records ?? []).map((record) => ({ record, L: labInstant(record) }))
    .filter((entry) => finite(entry.L)).sort((a, b) => a.L - b.L);
  for (let index = 0; index < sorted.length; index += 1) {
    const weight = index + 1 < sorted.length ? sorted[index + 1].L - sorted[index].L : 0;
    if (!(weight > 0)) continue;
    if (weight > 250) { noFrameMs += weight; continue; }
    const gap = Math.abs(sorted[index].record.driftMs);
    if (!finite(gap)) continue;
    playingMs += weight;
    histogram[binFor(gap)] += weight;
    weighted.push([gap, weight]);
    if (gap > 40) above40Ms += weight;
    if (gap > 100) above100Ms += weight;
  }
  const polls = pollEvents(evidence.clients[tag]?.polls);
  const perHour = (weight) => playingMs ? weight / 1000 / (playingMs / 3_600_000) : null;
  return {
    bins: histogram, weightAbove40Ms: above40Ms, weightAbove100Ms: above100Ms,
    p50Ms: weightedPercentile(weighted, 0.5), p90Ms: weightedPercentile(weighted, 0.9), p99Ms: weightedPercentile(weighted, 0.99),
    maxMs: weighted.length ? Math.max(...weighted.map(([value]) => value)) : null,
    playingMs, noFrameMs, secondsAbove40PerHour: perHour(above40Ms), secondsAbove100PerHour: perHour(above100Ms),
    farSkips: farSkips(evidence, tag, polls, gaps),
  };
}

export function gapCount(evidence) {
  const viewers = Object.fromEntries((evidence.tags ?? []).map((tag) => [tag, viewerGap(evidence, tag)]));
  return { reader: 'gap-count', version: 1, run: evidence.run ?? null, condition: evidence.condition?.name ?? null, viewers };
}

function emptyClass() {
  return { bins: Object.fromEntries(bins.map((bin) => [bin, 0])), playingMs: 0, above40Ms: 0, above100Ms: 0,
    secondsAbove40PerHour: null, secondsAbove100PerHour: null };
}

export function gapCountSet(readings, classes = {}) {
  const result = { healthy: emptyClass(), stress: emptyClass(), unmapped: [] };
  const runs = readings?.runs ?? readings ?? {};
  for (const [run, reading] of Object.entries(runs)) {
    const classification = classes[run] ?? classes[reading?.condition] ?? null;
    if (classification !== 'healthy' && classification !== 'stress') {
      result.unmapped.push(run);
      continue;
    }
    const aggregate = result[classification];
    for (const viewer of Object.values(reading?.viewers ?? {})) {
      for (const bin of bins) aggregate.bins[bin] += viewer.bins?.[bin] ?? 0;
      aggregate.playingMs += viewer.playingMs ?? 0;
      aggregate.above40Ms += viewer.weightAbove40Ms ?? 0;
      aggregate.above100Ms += viewer.weightAbove100Ms ?? 0;
    }
  }
  for (const classification of ['healthy', 'stress']) {
    const aggregate = result[classification];
    aggregate.secondsAbove40PerHour = aggregate.playingMs ? aggregate.above40Ms / 1000 / (aggregate.playingMs / 3_600_000) : null;
    aggregate.secondsAbove100PerHour = aggregate.playingMs ? aggregate.above100Ms / 1000 / (aggregate.playingMs / 3_600_000) : null;
  }
  return result;
}
