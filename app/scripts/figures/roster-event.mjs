import { resyncAfter } from './behind.mjs';
import { counterReading, harnessSharedMs, latestPagePoll, POLL_FRESH_MS, runwayMs, runwaySource, sharedWallMs } from './poll-coverage.mjs';
import { frameStalls } from './frame-stalls.mjs';
import { viewerOrder, edgeRank } from '../../public/lib/edge-assignment.mjs';
import { startResiduals } from './start-requalification.mjs';
import { aheadForGood, doubleStalls } from './ahead-for-good.mjs';

/*
 * Presence streams are arrays of { cdpMs, seq, recvSharedMs, event, tabId,
 * clientId, roster: [{ clientId, tabId, role }] }.
 * roster-event.json is { kind, client, tabId, clientId, at,
 * issuedAtHarnessMs, readBack, presence: { event, seq, recvSharedMs } | null,
 * receipts: { <tag>: { seq, recvSharedMs, cdpMs } | null }, observed } plus
 * leave/rejoin { seq, recvSharedMs, clientId } | null for drop-socket.
 *
 * Viewer-control polls use harnessBeforeMs, harnessAfterMs, heldAhead and state;
 * peer-bytes attempts use kind, path, peerId, bytes, endMs and segments use
 * path, mediaStartMs, completedAtMs. Page polls use atMs, clock.offsetMs and
 * playback; asks use index, reason, rank and atMs; starts use afterSeq,
 * reprojections, coverElapsedMs, reparks and positionMs.
 */

const finite = (value) => Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const row = (name, status, figures = {}) => ({ row: name, status, ...figures });

function tagsFor(condition) {
  const count = condition?.clients;
  if (!Number.isSafeInteger(count) || count < 1) return [];
  return Array.from({ length: count }, (_, index) => `c${String(index + 1).padStart(2, '0')}`);
}

function targetTag(event) {
  return event?.client;
}

function othersFor(condition, target) {
  return tagsFor(condition).filter((tag) => tag !== target);
}

function pollSharedMs(poll, timebase) {
  return harnessSharedMs(timebase, poll?.harnessBeforeMs, poll?.harnessAfterMs);
}

function stream(input, tag) {
  return input && Object.prototype.hasOwnProperty.call(input, tag) ? input[tag] : undefined;
}

function eventFrameFor(presence, tags, event, sequence, expectedEvent) {
  for (const tag of tags) {
    const records = stream(presence, tag);
    if (!Array.isArray(records)) continue;
    const found = records.find((record) => record?.seq === sequence
      && record?.event === expectedEvent && record?.tabId === event.tabId);
    if (found) return { tag, frame: found };
  }
  return null;
}

function eventState(condition, event, presence) {
  const target = targetTag(event);
  const others = othersFor(condition, target);
  const eventPresence = event?.presence;

  const missing = [];
  if (!eventPresence) {
    missing.push(...others);
  } else {
    for (const tag of others) {
      const records = stream(presence, tag);
      if (!Array.isArray(records) || !records.some((record) => record?.seq === eventPresence.seq
        && record?.event === eventPresence.event && record?.tabId === event.tabId)) missing.push(tag);
    }
  }
  const frame = () => eventFrameFor(presence, others, event, eventPresence.seq, eventPresence.event)?.frame ?? null;
  if (event?.observed !== true || missing.length) return { notObserved: true, missing, eventFrame: eventPresence ? frame() : null };
  const eventFrame = frame();
  if (!eventFrame) return { missing: others, eventFrame: null };
  if (!finite(eventPresence.recvSharedMs)) return { timeFailure: 'event-time-missing', eventFrame };
  return { eventFrame, eventTime: eventPresence.recvSharedMs, missing: [] };
}

function firstFrame(records, eventTime) {
  if (!Array.isArray(records)) return null;
  return records.filter((record) => finite(record?.displaySharedMs)
    && record.displaySharedMs >= eventTime).sort((left, right) => left.displaySharedMs - right.displaySharedMs)[0] ?? null;
}

function pairSamples(joinerRecords, otherRecords, firstMs, horizonMs) {
  const joiner = joinerRecords.filter((record) => finite(record?.displaySharedMs)
    && record.displaySharedMs >= firstMs && record.displaySharedMs <= firstMs + horizonMs)
    .slice().sort((left, right) => left.displaySharedMs - right.displaySharedMs);
  const other = otherRecords.filter((record) => finite(record?.displaySharedMs))
    .slice().sort((left, right) => left.displaySharedMs - right.displaySharedMs);
  const samples = [];
  let cursor = 0;
  for (const record of joiner) {
    while (cursor + 1 < other.length
      && Math.abs(other[cursor + 1].displaySharedMs - record.displaySharedMs)
        <= Math.abs(other[cursor].displaySharedMs - record.displaySharedMs)) cursor += 1;
    const nearest = other[cursor];
    if (nearest && finite(record.driftMs) && finite(nearest.driftMs)) {
      samples.push({ atMs: record.displaySharedMs, driftMs: record.driftMs - nearest.driftMs });
    }
  }
  return samples;
}

function coverageGap(times, fromMs, toMs) {
  const values = times.filter(finite).filter((atMs) => atMs >= fromMs && atMs <= toMs).sort((a, b) => a - b);
  if (!values.length) return { gapMs: Infinity, fromMs, toMs };
  let largest = { gapMs: values[0] - fromMs, fromMs, toMs: values[0] };
  for (let index = 1; index < values.length; index += 1) {
    const gapMs = values[index] - values[index - 1];
    if (gapMs > largest.gapMs) largest = { gapMs, fromMs: values[index - 1], toMs: values[index] };
  }
  const tail = toMs - values.at(-1);
  if (tail > largest.gapMs) largest = { gapMs: tail, fromMs: values.at(-1), toMs };
  return largest;
}

export function runwayRow(name, tags, polls, eventTime, durationMs, barMs, timebase) {
  const endMs = eventTime + durationMs;
  const runwayMsByClient = {};
  const gaps = {};
  const failures = [];
  if (!finite(timebase?.offsetMs)) return row(name, 'evidence-failure', { reason: 'timebase-offset-missing' });
  if (!finite(durationMs) || durationMs < 0) return row(name, 'evidence-failure', { reason: 'runway-window-invalid' });
  for (const tag of tags) {
    const values = stream(polls, tag);
    if (!Array.isArray(values)) {
      failures.push(`poll-stream-missing:${tag}`);
      continue;
    }
    const inWindow = values.filter((poll) => {
      const atMs = pollSharedMs(poll, timebase);
      return finite(atMs) && atMs >= eventTime && atMs <= endMs;
    });
    if (!inWindow.length) failures.push(`poll-window-empty:${tag}`);
    const gap = coverageGap(values.map((poll) => pollSharedMs(poll, timebase)), eventTime, endMs);
    gaps[tag] = gap;
    if (gap.gapMs > POLL_FRESH_MS) failures.push(`poll-gap:${tag}:${gap.gapMs}`);
    const readings = [];
    for (const poll of inWindow) {
      if (runwaySource(poll) !== 'own') {
        failures.push(`runway-source:${tag}`);
        continue;
      }
      try {
        const value = runwayMs(poll, tag);
        if (!finite(value)) failures.push(`runway-missing:${tag}`);
        else readings.push(value);
      } catch {
        failures.push(`runway-invalid:${tag}`);
      }
    }
    runwayMsByClient[tag] = readings.length ? Math.min(...readings) : null;
  }
  const figures = { runwayMsByClient, gaps, barMs: finite(barMs) ? barMs : null };
  if (failures.length) return row(name, 'evidence-failure', { ...figures, reason: failures.join(',') });
  const status = barMs === null || barMs === undefined
    ? 'published' : Object.values(runwayMsByClient).every((value) => finite(value) && value > barMs) ? 'met' : 'missed';
  return row(name, status, { ...figures, lowestRunwayMs: Math.min(...Object.values(runwayMsByClient)) });
}

const isSegmentPath = (path) => typeof path === 'string' && /(?:^|\/)seg-\d+\./.test(path);

/**
 * From the joiner's first segment request to its first request for the segment holding
 * its start position. Both instants are the page's, so the difference needs no clock join.
 */
function landingAskDelay(start, attempts, segments) {
  const positionMs = start?.positionMs;
  const asked = (attempts ?? []).filter((attempt) => attempt?.kind === 'attempt' && isSegmentPath(attempt.path)
    && finite(attempt.startMs));
  const holding = (segments ?? []).find((segment) => finite(segment?.mediaStartMs) && finite(segment?.mediaEndMs)
    && segment.mediaStartMs <= positionMs && positionMs < segment.mediaEndMs);
  const landing = asked.filter((attempt) => attempt.path === holding?.path);
  if (!finite(positionMs) || !landing.length) return null;
  return Math.min(...landing.map((attempt) => attempt.startMs)) - Math.min(...asked.map((attempt) => attempt.startMs));
}

function startFigure(starts, records, first, content, attempts, segments) {
  const empty = { reprojections: null, coverElapsedMs: null, reparks: null, residualMs: null, landingAskDelayMs: null };
  if (!Array.isArray(starts) || !first || !integer(first.seq)) return empty;
  let selected = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const nextAfterSeq = starts[index + 1]?.afterSeq ?? Infinity;
    if (integer(start?.afterSeq) && start.afterSeq < first.seq && first.seq <= nextAfterSeq) selected = index;
  }
  if (selected < 0) return empty;
  const start = starts[selected];
  const residual = startResiduals({ clients: { joiner: { records, starts } }, tags: ['joiner'], content })
    .startResidualsByClient.joiner[selected];
  return {
    reprojections: start.reprojections ?? null,
    coverElapsedMs: start.coverElapsedMs ?? null,
    reparks: start.reparks ?? null,
    residualMs: residual?.signedMedianMs ?? null,
    landingAskDelayMs: landingAskDelay(start, attempts, segments),
  };
}

function fillRow(condition, attempts, eventTime, timebase) {
  const criteria = condition.churn?.fill ?? {};
  if (!Array.isArray(attempts)) return row('J3', 'evidence-failure', { reason: 'attempt-stream-missing' });
  if (!finite(timebase?.offsetMs) || !finite(timebase?.wallOffsetMs)) {
    return row('J3', 'evidence-failure', { reason: 'wall-clock-offset-missing' });
  }
  const overMs = criteria.overMs;
  const endMs = eventTime + overMs;
  const entries = [];
  for (const attempt of attempts) {
    if (attempt?.kind !== 'attempt' || !isSegmentPath(attempt?.path)) continue;
    if (!finite(attempt.endMs) || !finite(attempt.bytes) || attempt.bytes < 0) continue;
    const endSharedMs = sharedWallMs(timebase, attempt.endMs);
    if (finite(endSharedMs) && endSharedMs >= eventTime && endSharedMs <= endMs) entries.push(attempt);
  }
  if (!entries.length) return row('J3', 'evidence-failure', { reason: 'attempt-stream-empty' });
  const fromPeer = (entry) => typeof entry.peerId === 'string' && entry.peerId.length > 0;
  const bytesOf = (list) => list.reduce((sum, entry) => sum + entry.bytes, 0);
  const fromHost = entries.filter((entry) => !fromPeer(entry));
  const peerBytes = bytesOf(entries.filter(fromPeer));
  const hostBytes = bytesOf(fromHost);
  const totalBytes = peerBytes + hostBytes;
  const peerFraction = totalBytes > 0 ? peerBytes / totalBytes : null;
  const hostBodies = fromHost.filter((entry) => entry.bytes > 0).length;
  const status = finite(peerFraction) && peerFraction >= criteria.peerFractionMin && hostBodies <= criteria.hostBodiesMax
    ? 'met' : 'missed';
  return row('J3', status, { peerBytes, hostBytes, peerFraction, hostBodies, overMs,
    peerFractionMin: criteria.peerFractionMin, hostBodiesMax: criteria.hostBodiesMax });
}

function stallInterval(value, eventTime) {
  if (!value || value.status !== 'ok') return value;
  return { ...value, stalls: value.stalls.map((stall) => ({ ...stall,
    startAfterMs: stall.startMs - eventTime })) };
}

function stallRow(condition, kind, eventTime, drift, hostPoll, target, issuedTime = eventTime) {
  const stall = condition.churn?.stall ?? {};
  const others = othersFor(condition, target);
  const beforeStart = issuedTime - stall.beforeMs;
  const afterEnd = eventTime + stall.afterMs;
  if (!Array.isArray(hostPoll) || !hostPoll.length) return row('K1', 'evidence-failure', { reason: 'host-poll-stream-missing' });
  const beforeGap = coverageGap(hostPoll.map((poll) => poll?.sharedMs), beforeStart, issuedTime);
  const afterGap = coverageGap(hostPoll.map((poll) => poll?.sharedMs), issuedTime, afterEnd);
  if (beforeGap.gapMs > POLL_FRESH_MS || afterGap.gapMs > POLL_FRESH_MS) {
    const gap = beforeGap.gapMs > POLL_FRESH_MS ? beforeGap : afterGap;
    return row('K1', 'unreadable', { reason: 'host-poll-gap', gap });
  }
  const intervals = {};
  let beforeStall = false;
  let afterStall = false;
  let evidenceFailure = null;
  for (const tag of others) {
    const records = stream(drift, tag);
    if (!Array.isArray(records)) {
      evidenceFailure = `drift-stream-missing:${tag}`;
      intervals[tag] = { before: null, after: null };
      continue;
    }
    const before = frameStalls({ records, playing: hostPoll, fromMs: beforeStart, toMs: issuedTime, gapMs: stall.gapMs });
    const after = frameStalls({ records, playing: hostPoll, fromMs: issuedTime, toMs: afterEnd, gapMs: stall.gapMs });
    intervals[tag] = { before: stallInterval(before, eventTime), after: stallInterval(after, eventTime) };
    if (before.status === 'evidence-failure' || after.status === 'evidence-failure') evidenceFailure = 'frame-stall-evidence-failure';
    else {
      beforeStall ||= before.stalls.length > 0;
      afterStall ||= after.stalls.length > 0;
    }
  }
  if (evidenceFailure) return row('K1', 'evidence-failure', { reason: evidenceFailure, intervals });
  const status = beforeStall ? 'unreadable' : afterStall ? 'missed' : 'met';
  return row('K1', status, { kind, intervals, beforeMs: stall.beforeMs, afterMs: stall.afterMs, gapMs: stall.gapMs,
    window: { beforeStartMs: beforeStart, issuedMs: issuedTime, eventMs: eventTime, afterEndMs: afterEnd },
    ...(beforeStall ? { reason: 'before-window-not-clean' } : {}) });
}

function k0Row(tags, polls, issuedTime, condition, timebase) {
  const raw = runwayRow('K0', tags, polls, issuedTime, condition.churn?.stall?.beforeMs,
    condition.churn?.runwayMinMs, timebase);
  return raw.status === 'missed' ? { ...raw, status: 'unreadable', reason: 'runway-below-bar' } : raw;
}

function median(values) {
  const sorted = values.filter(finite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wideBand(drift, tags, eventTime, windowMs = 60_000) {
  const pairs = [];
  for (let left = 0; left < tags.length; left += 1) {
    for (let right = left + 1; right < tags.length; right += 1) {
      pairs.push(...pairSamples(stream(drift, tags[left]) ?? [], stream(drift, tags[right]) ?? [],
        eventTime - windowMs, windowMs).map((sample) => Math.abs(sample.driftMs)));
    }
  }
  return median(pairs);
}

function segmentIndex(path) {
  if (typeof path !== 'string') return null;
  const match = path.match(/(?:^|\/)seg-(\d+)\./);
  const index = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function reassignmentRow(condition, event, eventTime, presenceFrame, segments, asks, polls, target, timebase) {
  const horizonMs = condition.churn?.horizonMs;
  if (!finite(horizonMs)) return row('K3', 'evidence-failure', { reason: 'horizon-missing' });
  if (!finite(timebase?.offsetMs) || !finite(timebase?.wallOffsetMs)) {
    return row('K3', 'evidence-failure', { reason: 'wall-clock-offset-missing' });
  }
  const tags = tagsFor(condition);
  if (!segments || typeof segments !== 'object') return row('K3', 'evidence-failure', { reason: 'segment-stream-missing' });
  const segmentStreams = {};
  for (const tag of tags) {
    segmentStreams[tag] = stream(segments, tag);
    if (!Array.isArray(segmentStreams[tag])) return row('K3', 'evidence-failure', { reason: `segment-stream-missing:${tag}` });
  }
  const viewerIds = viewerOrder([...(presenceFrame?.roster ?? []), { clientId: event.clientId, role: 'viewer' }]);
  const candidates = new Map();
  for (const owner of tags) {
    for (const segment of segmentStreams[owner]) {
      const index = segmentIndex(segment.path);
      if (index === null || !finite(segment.mediaStartMs)) continue;
      if (edgeRank({ viewerIds, selfId: event.clientId, segmentIndex: index }) !== 0) continue;
      const key = `${index}:${segment.mediaStartMs}`;
      candidates.set(key, { index, mediaStartMs: segment.mediaStartMs });
    }
  }
  const results = [];
  for (const viewer of othersFor(condition, target)) {
    const viewerPolls = stream(polls, viewer);
    if (!Array.isArray(viewerPolls)) return row('K3', 'evidence-failure', { reason: `poll-stream-missing:${viewer}` });
    const eligible = viewerPolls.map((poll) => ({ poll, atMs: pollSharedMs(poll, timebase) }))
      .filter((entry) => finite(entry.atMs) && entry.atMs <= eventTime)
      .sort((left, right) => left.atMs - right.atMs);
    const atPoll = eligible.at(-1)?.poll;
    const positionMs = atPoll?.heldAhead?.ownPositionMs;
    if (!finite(positionMs) || !eligible.length || eventTime - eligible.at(-1).atMs > POLL_FRESH_MS) {
      return row('K3', 'evidence-failure', { reason: `own-position-missing:${viewer}` });
    }
    for (const candidate of candidates.values()) {
      if (candidate.mediaStartMs < positionMs || candidate.mediaStartMs > positionMs + horizonMs) continue;
      const viewerSegments = segmentStreams[viewer];
      const completions = viewerSegments.filter((segment) => segmentIndex(segment.path) === candidate.index
        && finite(segment.completedAtMs)).map((segment) => sharedWallMs(timebase, segment.completedAtMs)).filter(finite);
      if (completions.some((completedAtSharedMs) => completedAtSharedMs <= eventTime)) continue;
      const dueAtSharedMs = eventTime + candidate.mediaStartMs - positionMs;
      const completion = completions.filter((completedAtSharedMs) => completedAtSharedMs > eventTime)
        .sort((left, right) => left - right)[0] ?? null;
      const askStream = stream(asks, viewer);
      const askRows = Array.isArray(askStream) ? askStream.filter((ask) => ask?.index === candidate.index
        && finite(ask.atMs) && sharedWallMs(timebase, ask.atMs) > eventTime)
        .map((ask) => ({ ...ask, atSharedMs: sharedWallMs(timebase, ask.atMs) })) : null;
      results.push({ viewer, index: candidate.index, mediaStartMs: candidate.mediaStartMs, dueAtSharedMs,
        completedAtSharedMs: completion, marginMs: finite(completion) ? dueAtSharedMs - completion : null,
        met: finite(completion) && completion <= dueAtSharedMs, asks: askRows });
    }
  }
  if (!results.length) return row('K3', 'not-exercised', { reason: 'no-segments-in-horizon', horizonMs });
  const missed = results.filter((result) => !result.met).map(({ viewer, index }) => ({ viewer, index }));
  return row('K3', missed.length ? 'missed' : 'met', { horizonMs, segments: results, missed });
}

function pollAtOrAfter(polls, timebase, boundaryMs, after) {
  return (polls ?? []).map((poll) => ({ poll, atMs: pollSharedMs(poll, timebase) }))
    .filter((entry) => finite(entry.atMs) && (after ? entry.atMs >= boundaryMs : entry.atMs <= boundaryMs))
    .sort((left, right) => left.atMs - right.atMs).at(after ? 0 : -1)?.poll ?? null;
}

function identityOf(poll) {
  return poll?.state && typeof poll.state === 'object'
    && typeof poll.state.lineage === 'string' && integer(poll.state.version)
    ? { lineage: poll.state.lineage, version: poll.state.version } : null;
}

function socketRow(condition, event, presence, polls, pagePolls, timebase) {
  if (event.rejoin === null || event.rejoin === undefined) return row('S1', 'missed', { reason: 'no-rejoin-frame' });
  const others = othersFor(condition, targetTag(event));
  const leave = eventFrameFor(presence, others, event, event.presence?.seq, event.presence?.event)?.frame;
  const rejoin = eventFrameFor(presence, others, event, event.rejoin.seq, 'join')?.frame;
  if (!leave || !rejoin) return row('S1', 'evidence-failure', { reason: 'presence-frame-missing' });
  if (!finite(timebase?.offsetMs)) return row('S1', 'evidence-failure', { reason: 'timebase-offset-missing' });
  const before = viewerOrder([...(leave.roster ?? []), { clientId: event.clientId, role: 'viewer' }]);
  const between = viewerOrder(leave.roster);
  const after = viewerOrder(rejoin.roster);
  const targetPolls = stream(polls, targetTag(event));
  if (!Array.isArray(targetPolls)) return row('S1', 'evidence-failure', { reason: 'poll-stream-missing' });
  const leaveAt = event.leave?.recvSharedMs;
  const rejoinAt = event.rejoin?.recvSharedMs;
  const beforePoll = pollAtOrAfter(targetPolls, timebase, leaveAt, false);
  const afterPoll = pollAtOrAfter(targetPolls, timebase, rejoinAt, true);
  const beforeIdentity = identityOf(beforePoll);
  const afterIdentity = identityOf(afterPoll);
  const targetPagePolls = stream(pagePolls, targetTag(event));
  const afterLimit = rejoinAt + (condition.churn?.stall?.afterMs ?? NaN);
  const countersBeforePoll = Array.isArray(targetPagePolls) ? latestPagePoll(targetPagePolls, leaveAt) : null;
  const countersAfterPoll = Array.isArray(targetPagePolls) ? latestPagePoll(targetPagePolls, afterLimit) : null;
  const countersBefore = counterReading(countersBeforePoll);
  const countersAfter = counterReading(countersAfterPoll);
  if (!beforePoll || !afterPoll || !beforeIdentity || !afterIdentity || !countersBefore || !countersAfter) {
    return row('S1', 'evidence-failure', { reason: 'identity-or-counter-missing', orders: { before, between, after },
      pollAtMs: { before: pollSharedMs(beforePoll, timebase), after: pollSharedMs(afterPoll, timebase) },
      counters: { before: countersBefore, after: countersAfter } });
  }
  const identityEqual = beforeIdentity.lineage === afterIdentity.lineage && beforeIdentity.version === afterIdentity.version;
  const countersEqual = Object.keys(countersBefore).every((field) => countersBefore[field] === countersAfter[field]);
  const clientChanged = typeof event.leave?.clientId === 'string' && typeof event.rejoin?.clientId === 'string'
    && event.leave.clientId !== event.rejoin.clientId;
  return row('S1', identityEqual && countersEqual && clientChanged ? 'met' : 'missed', {
    orders: { before, between, after },
    identity: { before: beforeIdentity, after: afterIdentity, equal: identityEqual },
    counters: { before: countersBefore, after: countersAfter, equal: countersEqual },
    clientIds: { leave: event.leave?.clientId ?? null, rejoin: event.rejoin?.clientId ?? null },
  });
}

/** Three-way leave-arm rule over the runs that show the leave; comparand stall evidence is retained beside it. */
export function leaveArmReading({ runs = [], comparands = [] } = {}) {
  const exercised = [];
  for (const run of runs.slice(0, 5)) {
    const rows = Array.isArray(run) ? run : run?.rows ?? run?.reading ?? [];
    const k1 = rows.find((entry) => entry.row === 'K1');
    const k3 = rows.find((entry) => entry.row === 'K3');
    if (k3?.status === 'not-exercised') continue;
    const entry = { k1: k1?.status ?? 'unreadable', k3: k3?.status ?? 'unreadable' };
    const reading = entry.k1 === 'missed' || entry.k3 === 'missed' ? 'failed'
      : entry.k1 === 'met' && entry.k3 === 'met' ? 'shown' : 'unread';
    exercised.push({ ...entry, reading });
  }
  const count = (reading) => exercised.filter((entry) => entry.reading === reading).length;
  const status = count('failed') ? 'fail' : count('shown') >= 3 ? 'pass' : 'not-established';
  return { status, exercised, exercisedCount: exercised.length, shownCount: count('shown'), unread: count('unread'),
    comparandStalls: comparands.map((comparand) => ({ directory: comparand.directory ?? null,
      stalls: comparand.stalls ?? comparand.reading?.stallsByClient ?? null })) };
}

/** Read the J/K/S matrix from the event and retained streams. */
export function rosterEventReading({ condition = {}, event, presence, drift = {}, polls = {}, pagePolls = {},
  attempts, segments, asks = {}, starts = {}, timebase, content, window, seek, capacitySchedule } = {}) {
  if (event?.__evidenceFailure) return [row('event', 'evidence-failure', { reason: event.__evidenceFailure })];
  if (!event) return [row('event', 'unreadable', { reason: 'roster-event-not-issued' })];
  const state = eventState(condition, event, presence);
  if (state.notObserved || state.missing?.length) return [row('event', 'unreadable', {
    reason: 'roster-event-not-observed', missingTags: state.missing,
  })];
  if (state.timeFailure) return [row('event', 'evidence-failure', { reason: state.timeFailure })];
  const eventTime = state.eventTime;
  const target = targetTag(event);
  const kind = event.kind;
  const result = [];
  if (kind === 'join') {
    const targetRecords = stream(drift, target);
    if (!Array.isArray(targetRecords)) return [row('J1', 'evidence-failure', { reason: `drift-stream-missing:${target}` })];
    const first = firstFrame(targetRecords, eventTime);
    const maxMs = condition.churn?.firstFrameMaxMs;
    result.push(first ? row('J1', finite(maxMs) && first.displaySharedMs - eventTime <= maxMs ? 'met' : 'missed', {
      firstFrameSharedMs: first.displaySharedMs, firstFrameDelayMs: first.displaySharedMs - eventTime, maxMs,
      start: startFigure(stream(starts, target), targetRecords, first, content,
        stream(attempts, target), stream(segments, target)),
    }) : row('J1', 'missed', { firstFrameSharedMs: null, firstFrameDelayMs: null, maxMs, start: null }));

    if (!first) result.push(row('J2', 'not-exercised', { reason: 'first-frame-not-observed' }));
    else {
      const horizonMs = condition.churn?.horizonMs;
      const resync = condition.churn?.resync ?? {};
      const missing = [];
      const otherRecords = [];
      for (const tag of othersFor(condition, target)) {
        const records = stream(drift, tag);
        if (!Array.isArray(records)) missing.push(tag);
        else {
          const times = records.map((record) => record?.displaySharedMs).filter(finite);
          if (!times.length || Math.max(...times) < first.displaySharedMs + resync.maxMs + resync.holdMs) missing.push(tag);
          otherRecords.push(records);
        }
      }
      if (!finite(horizonMs)) result.push(row('J2', 'evidence-failure', { reason: 'horizon-missing' }));
      else if (missing.length) result.push(row('J2', 'evidence-failure', { reason: `drift-stream-insufficient:${missing.join(',')}` }));
      else if (finite(wideBand(drift, othersFor(condition, target), eventTime))
        && wideBand(drift, othersFor(condition, target), eventTime) > 40) {
        result.push(row('J2', 'unreadable', { reason: 'drift-band-before-event', medianPairwiseDriftMs:
          wideBand(drift, othersFor(condition, target), eventTime), barMs: 40 }));
      }
      else {
        const pairs = otherRecords.map((records) => pairSamples(targetRecords, records, first.displaySharedMs, horizonMs));
        const resyncMs = resyncAfter({ firstFrameSharedMs: first.displaySharedMs, pairs,
          windowMs: resync.windowMs, medianMaxMs: resync.medianMaxMs, holdMs: resync.holdMs });
        const latest = Math.min(first.displaySharedMs + horizonMs,
          Math.max(...targetRecords.map((record) => record?.displaySharedMs).filter(finite)),
          ...otherRecords.map((records) => Math.max(...records.map((record) => record?.displaySharedMs).filter(finite))));
        const held = finite(resyncMs) && first.displaySharedMs + resyncMs + resync.holdMs <= latest;
        result.push(held
          ? row('J2', resyncMs <= resync.maxMs ? 'met' : 'missed', { resyncAfterMs: resyncMs, maxMs: resync.maxMs })
          : row('J2', 'missed', { resyncAfterMs: null, maxMs: resync.maxMs, reason: 'not-resynced' }));
      }
    }
    result.push(fillRow(condition, stream(attempts, target), eventTime, timebase));
    result.push(runwayRow('J4', othersFor(condition, target), polls, eventTime,
      condition.churn?.stall?.afterMs, condition.churn?.runwayMinMs, timebase));
    result.unshift(k0Row(othersFor(condition, target), polls, eventTime - (condition.churn?.stall?.beforeMs ?? NaN), condition, timebase));
    // The stall row is every arm's: the viewers already in the room, either side of the join.
    result.push(stallRow(condition, kind, eventTime, drift, stream(polls, 'host') ?? [], target));
    const ahead = aheadForGood({ condition, tags: tagsFor(condition), window, event, seek, capacitySchedule, drift, polls, pagePolls, timebase });
    result.push(ahead);
    result.push({ row: 'double-stalls', status: 'published', byClient: doubleStalls({ drift,
      polls, tags: othersFor(condition, target), fromMs: ahead.readySharedMs ?? -Infinity,
      toMs: ahead.endSharedMs ?? Infinity, aheadForGoodAtSharedMs: ahead.aheadForGoodAtSharedMs }) });
    return result;
  }
  if (['leave-clean', 'leave-silent', 'leave-supplier-silent', 'leave-first', 'drop-socket'].includes(kind)) {
    // A silent leave is issued up to the liveness interval before the room sees it: its
    // windows turn on the issue and its after-window runs on past the presence frame.
    const issuedTime = kind === 'leave-silent' || kind === 'leave-supplier-silent'
      ? harnessSharedMs(timebase, event.issuedAtHarnessMs, event.issuedAtHarnessMs) : eventTime;
    if (!finite(issuedTime) || issuedTime > eventTime) return [row('event', 'evidence-failure', { reason: 'event-issue-time-invalid' })];
    if (kind === 'leave-silent' || kind === 'leave-supplier-silent') {
      result.push(k0Row(othersFor(condition, target), polls, issuedTime, condition, timebase));
    }
    result.push(stallRow(condition, kind, eventTime, drift, stream(polls, 'host') ?? [], target, issuedTime));
    if (kind === 'drop-socket') result.unshift(socketRow(condition, event, presence, polls, pagePolls, timebase));
    else {
      result.push(runwayRow('K2', othersFor(condition, target), polls, issuedTime,
        eventTime - issuedTime + condition.churn?.stall?.afterMs, kind === 'leave-first' ? null : condition.churn?.runwayMinMs, timebase));
      result.push(reassignmentRow(condition, event, eventTime, state.eventFrame, segments, asks, polls, target, timebase));
    }
    const ahead = aheadForGood({ condition, tags: othersFor(condition, target), window, event, seek, capacitySchedule, drift, polls, pagePolls, timebase });
    result.push(ahead);
    result.push({ row: 'double-stalls', status: 'published', byClient: doubleStalls({ drift,
      polls, tags: othersFor(condition, target), fromMs: ahead.readySharedMs ?? -Infinity,
      toMs: ahead.endSharedMs ?? Infinity, aheadForGoodAtSharedMs: ahead.aheadForGoodAtSharedMs }) });
    return result;
  }
  return [row('event', 'evidence-failure', { reason: `roster-event-kind-unsupported:${kind}` })];
}
