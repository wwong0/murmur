import { frameStalls } from './frame-stalls.mjs';
import { doubleStalls, earliestObservationEnd, skipCountBefore } from './ahead-for-good.mjs';
import { coverageGap, harnessSharedMs, POLL_FRESH_MS, runwayMs, sharedWallMs } from './poll-coverage.mjs';

export const REFILL_WINDOW_MS = 60_000;
export const CLIMB_WINDOW_MS = 120_000;
export const STALL_GAP_MS = 250;
export const CLIMB_COVERAGE_SLACK_MS = 2_000;
const ESTIMATE_BAR_FRACTION = 0.9;

const finite = (value) => Number.isFinite(value);
const stream = (input, tag) => (input && Object.prototype.hasOwnProperty.call(input, tag) ? input[tag] : undefined);
const segmentIndex = (path) => {
  const match = typeof path === 'string' ? path.match(/(?:^|\/)seg-(\d+)\.m4s/) : null;
  return match ? Number(match[1]) : null;
};
const askedClass = (receipt) => (receipt.urgent ? 'urgent' : receipt.near ? 'near' : 'normal');
const failure = (reason, detail = {}) => ({ status: 'evidence-failure', reason, ...detail });

function shape(status, reason, extra = {}) {
  return { row: 'rise-recovery', status, reason, exercised: null,
    rise: null, contentBitsPerSecond: null, climb: null, refill: null, doubleStalls: null,
    lateHostLoads: null, published: null, ...extra };
}

function climbReading({ hostPace, rise, wallOffsetMs, contentBitsPerSecond, tbfBitsPerSecond, recordingEndMs }) {
  const intervals = Array.isArray(hostPace?.intervals) ? hostPace.intervals : [];
  const riseAt = rise.readBackAtMs;
  const endOfWindow = riseAt + CLIMB_WINDOW_MS;
  const kept = intervals.map((record) => ({ record, atHarnessMs: record.endWallMs - wallOffsetMs }))
    .filter(({ atHarnessMs }) => atHarnessMs > riseAt && atHarnessMs <= endOfWindow)
    .sort((left, right) => left.record.seq - right.record.seq);
  const recordingEnded = finite(recordingEndMs) && recordingEndMs < endOfWindow;
  const coveredToMs = recordingEnded ? recordingEndMs : endOfWindow;
  if (!kept.length) return failure('pace-evidence-incomplete', { detail: 'no-intervals-in-window' });
  const consecutive = kept.every(({ record }, index) => index === 0 || record.seq - kept[index - 1].record.seq === 1);
  const first = kept[0];
  const last = kept.at(-1);
  const startsLate = first.atHarnessMs - first.record.durationMs - riseAt > CLIMB_COVERAGE_SLACK_MS;
  const endsEarly = coveredToMs - last.atHarnessMs > CLIMB_COVERAGE_SLACK_MS;
  const evictedInWindow = hostPace.evicted > 0 && first.record.seq <= hostPace.evicted;
  if (!consecutive || startsLate || evictedInWindow || endsEarly) {
    return failure('pace-evidence-incomplete', { detail: !consecutive ? 'seq-gap' : startsLate ? 'starts-after-rise'
      : evictedInWindow ? 'evicted' : 'ends-before-window' });
  }
  if (kept.some(({ record }) => !('estimateBytesPerSecond' in record) || !('paceBytesPerSecond' in record))) {
    return failure('interval-fields-missing');
  }
  const bits = (bytesPerSecond) => (finite(bytesPerSecond) ? bytesPerSecond * 8 : null);
  const rows = kept.map(({ record, atHarnessMs }) => ({ seq: record.seq, afterRiseMs: atHarnessMs - riseAt,
    estimateBitsPerSecond: bits(record.estimateBytesPerSecond), paceBitsPerSecond: bits(record.paceBytesPerSecond),
    wireBitsPerSecond: finite(record.wireBytes) ? (record.wireBytes * 8000) / record.durationMs : null,
    paceBoundMs: record.paceBoundMs, probe: record.probe, raised: record.raised, climbing: record.climbing }));
  const paceAbove = rows.find((row) => !row.probe && finite(contentBitsPerSecond) && row.paceBitsPerSecond > contentBitsPerSecond);
  const estimateAbove = rows.find((row) => row.estimateBitsPerSecond > ESTIMATE_BAR_FRACTION * tbfBitsPerSecond);
  const notWithin = `not-within-${coveredToMs - riseAt}ms`;
  return { status: recordingEnded ? 'evidence-failure' : 'published', reason: recordingEnded ? 'recording-ended' : null,
    ...(recordingEnded ? { coveredMs: { fromMs: 0, toMs: coveredToMs - riseAt } } : {}),
    windowMs: CLIMB_WINDOW_MS, rows,
    paceAboveContentAfterMs: paceAbove?.afterRiseMs ?? null, paceAboveContent: paceAbove ? 'reached' : notWithin,
    estimateAboveNinetyAfterMs: estimateAbove?.afterRiseMs ?? null, estimateAboveNinety: estimateAbove ? 'reached' : notWithin };
}

function refillReading({ viewers, drift, hostPoll, riseShared, arm }) {
  const fromMs = riseShared;
  const toMs = riseShared + REFILL_WINDOW_MS;
  const base = { arm, windowMs: REFILL_WINDOW_MS, gapMs: STALL_GAP_MS };
  const gap = coverageGap((hostPoll ?? []).map((poll) => ({ harnessAfterMs: poll?.sharedMs })), { startMs: fromMs, endMs: toMs });
  if (gap > POLL_FRESH_MS) return { status: 'unreadable', reason: 'host-poll-gap', gapMs: gap, ...base, viewers: null, refilled: null };
  const byViewer = {};
  for (const tag of viewers) {
    const result = frameStalls({ records: stream(drift, tag), playing: hostPoll, fromMs, toMs, gapMs: STALL_GAP_MS });
    byViewer[tag] = result.status === 'ok'
      ? { status: 'ok', stalls: result.stalls.map((stall) => ({ ...stall, afterRiseMs: stall.startMs - riseShared })) }
      : { status: 'evidence-failure', reason: result.reason };
  }
  const entries = Object.values(byViewer);
  const stalled = entries.some((entry) => entry.status === 'ok' && entry.stalls.length > 0);
  const readable = entries.length > 0 && entries.every((entry) => entry.status === 'ok');
  const refilled = stalled ? false : readable ? true : null;
  return { status: refilled === null ? 'evidence-failure' : 'published',
    reason: refilled === null ? (entries.length ? 'viewer-evidence-failure' : 'no-viewers') : null,
    ...base, viewers: byViewer, refilled };
}

function doubleStallReading({ viewers, drift, hostPoll, pagePolls, riseShared, observationEndMs }) {
  if (!finite(observationEndMs) || !(observationEndMs > riseShared)) return failure('observation-window-unavailable');
  const result = doubleStalls({ drift, polls: { host: hostPoll }, tags: viewers, fromMs: riseShared,
    toMs: observationEndMs, gapMs: STALL_GAP_MS });
  const byClient = Object.fromEntries(Object.entries(result).map(([tag, reading]) => [tag, {
    status: reading.status,
    pairs: reading.pairs.map(({ first, second, distanceMs }) => ({ first, second, distanceMs,
      skippedBetween: skipCountBefore(pagePolls, tag, first.startMs + first.lengthMs, second.startMs) })),
  }]));
  return { status: 'published', reason: null, fromSharedMs: riseShared, toSharedMs: observationEndMs, byClient };
}

function mediaStarts(contentManifest) {
  const durations = contentManifest?.segmentDurations;
  if (!Array.isArray(durations) || !durations.every(finite)) return null;
  let total = 0;
  return durations.map((seconds) => { const start = total * 1000; total += seconds; return start; });
}

function crossing(records, mediaStartMs, askShared) {
  for (let index = 1; index < records.length; index += 1) {
    const a = records[index - 1];
    const b = records[index];
    if (a.mediaMs < mediaStartMs && b.mediaMs >= mediaStartMs && b.displaySharedMs > askShared) {
      return a.displaySharedMs + (mediaStartMs - a.mediaMs);
    }
  }
  return null;
}

function lateLoadReading({ viewers, clients, contentManifest, timebase }) {
  const starts = mediaStarts(contentManifest);
  if (!starts) return failure('segment-times-missing');
  const rows = [];
  const unread = [];
  const unreadableViewers = [];
  let lateWithoutPeerCopy = 0;
  for (const tag of viewers) {
    const receipts = clients?.[tag]?.requests;
    const frames = clients?.[tag]?.records;
    if (!Array.isArray(receipts) || !Array.isArray(frames) || !frames.length) { unreadableViewers.push(tag); continue; }
    const ordered = frames.filter((frame) => finite(frame?.mediaMs) && finite(frame?.displaySharedMs))
      .slice().sort((left, right) => left.displaySharedMs - right.displaySharedMs);
    for (const receipt of receipts) {
      const index = segmentIndex(receipt?.url);
      if (receipt?.finished !== true || index === null) continue;
      const askSharedMs = sharedWallMs(timebase, receipt.startMs);
      const endSharedMs = sharedWallMs(timebase, receipt.endMs);
      if (!finite(starts[index]) || !finite(askSharedMs) || !finite(endSharedMs)) { unread.push({ viewer: tag, index, reason: 'segment-or-receipt-time-missing' }); continue; }
      const reachedAtSharedMs = crossing(ordered, starts[index], askSharedMs);
      if (reachedAtSharedMs === null) { unread.push({ viewer: tag, index, reason: 'not-reached' }); continue; }
      if (!(endSharedMs > reachedAtSharedMs)) continue;
      const proxy = viewers.filter((other) => other !== tag).flatMap((other) => (clients?.[other]?.peerRecords ?? [])
        .filter((record) => record?.kind === 'segment' && segmentIndex(record.path) === index)
        .map((record) => ({ viewer: other, atSharedMs: sharedWallMs(timebase, record.completedAtMs) })))
        .filter((entry) => finite(entry.atSharedMs) && entry.atSharedMs < reachedAtSharedMs)
        .sort((left, right) => left.atSharedMs - right.atSharedMs)[0] ?? null;
      if (!proxy) { lateWithoutPeerCopy += 1; continue; }
      rows.push({ viewer: tag, path: receipt.url, index, askedClass: askedClass(receipt),
        rises: Array.isArray(receipt.rises) ? receipt.rises.map((rise) => ({ ...rise })) : null,
        askSharedMs, reachedAtSharedMs, endSharedMs, lateByMs: endSharedMs - reachedAtSharedMs,
        announcedLoadedProxy: proxy });
    }
  }
  return { status: 'published', reason: null, rows, lateWithoutPeerCopy, unread, unreadableViewers };
}

function runwaysReading({ viewers, edge, viewerPolls }) {
  if (!finite(edge?.atMs)) return null;
  const lowestAfterEdge = Object.fromEntries(viewers.map((tag) => {
    const readings = [];
    for (const poll of stream(viewerPolls, tag) ?? []) {
      const atMs = finite(poll?.harnessBeforeMs) && finite(poll?.harnessAfterMs) ? (poll.harnessBeforeMs + poll.harnessAfterMs) / 2 : null;
      if (!finite(atMs) || atMs < edge.atMs || atMs > edge.atMs + REFILL_WINDOW_MS) continue;
      try { const value = runwayMs(poll, tag); if (finite(value)) readings.push(value); } catch { /* an invalid poll has no runway */ }
    }
    return [tag, { lowestRunwayMs: readings.length ? Math.min(...readings) : null, polls: readings.length }];
  }));
  return { atEdgeByClient: edge.heldAheadMsByClient ?? null, lowestAfterEdge };
}

function stallOnsets({ refill, rosterRows, riseShared, leaveShared }) {
  const onset = (viewer, source, stall) => ({ viewer, source, startSharedMs: stall.startMs, lengthMs: stall.lengthMs,
    afterRiseMs: stall.startMs - riseShared, afterLeaveMs: finite(leaveShared) ? stall.startMs - leaveShared : null });
  const fromRefill = Object.entries(refill.viewers ?? {}).flatMap(([tag, entry]) => (entry.status === 'ok'
    ? entry.stalls.map((stall) => onset(tag, 'refill', stall)) : []));
  const k1 = Array.isArray(rosterRows) ? rosterRows.find((entry) => entry?.row === 'K1') : null;
  const fromK1 = Object.entries(k1?.intervals ?? {}).flatMap(([tag, sides]) => ['before', 'after'].flatMap((side) => (
    sides?.[side]?.status === 'ok' ? sides[side].stalls.map((stall) => onset(tag, `k1-${side}`, stall)) : [])));
  return [...fromRefill, ...fromK1];
}

/** The rise-recovery row: one object per run, every key present, `null` where not exercised. */
export function riseRecovery(input = {}) {
  const rise = input.capacitySchedule?.rise;
  if (!rise || rise.inForce !== true) return shape('not-exercised', 'no-rise', { exercised: input.capacitySchedule?.exercised ?? null });
  const timebase = input.timebase;
  const tbfBitsPerSecond = rise.readBack?.rate?.got;
  if (!finite(timebase?.offsetMs) || !finite(timebase?.wallOffsetMs) || !finite(rise.readBackAtMs)
    || !(tbfBitsPerSecond > 0)) {
    return shape('evidence-failure', !(tbfBitsPerSecond > 0) ? 'rise-rate-missing' : 'timebase-offset-missing',
      { exercised: input.capacitySchedule.exercised ?? null });
  }
  const riseShared = harnessSharedMs(timebase, rise.readBackAtMs, rise.readBackAtMs);
  const event = input.condition?.rosterEvent && typeof input.rosterEvent?.client === 'string' ? input.rosterEvent : null;
  const leaver = event?.client ?? null;
  const leaveShared = event ? harnessSharedMs(timebase, event.issuedAtHarnessMs, event.issuedAtHarnessMs) : null;
  const viewers = (input.declaredClientTags ?? Object.keys(input.clients ?? {})).filter((tag) => tag !== leaver);
  const clients = input.clients ?? {};
  const byClient = (field) => Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, client?.[field]]));
  const drift = byClient('records');
  const hostPoll = input.hostPoll ?? [];
  const total = input.contentManifest?.totalBytes;
  const duration = input.contentManifest?.duration;
  const contentBitsPerSecond = total > 0 && duration > 0 ? (total * 8) / duration : null;
  const recordingEndMs = input.window?.endMs;

  const climb = contentBitsPerSecond === null ? failure('content-rate-missing')
    : climbReading({ hostPace: input.hostPace, rise, wallOffsetMs: timebase.wallOffsetMs, contentBitsPerSecond,
      tbfBitsPerSecond, recordingEndMs });
  const refill = refillReading({ viewers, drift, hostPoll, riseShared, arm: event ? 'leave' : 'comparand' });
  // The edge, the drop and the leave precede the rise (the leaver is not read), so none ends the observation.
  const observationEndMs = earliestObservationEnd({ window: input.window, seek: input.seek, timebase });
  const doubles = doubleStallReading({ viewers, drift, hostPoll, pagePolls: byClient('polls'), riseShared, observationEndMs });
  const lateHostLoads = lateLoadReading({ viewers, clients, contentManifest: input.contentManifest, timebase });
  const dropReadBackAtMs = input.capacitySchedule.drop?.readBackAtMs;
  const hostBodies = finite(dropReadBackAtMs) ? Object.entries(clients).flatMap(([tag, client]) => (
    input.declaredClientTags?.includes(tag) ? (client?.requests ?? []).filter((receipt) => finite(receipt?.startMs)
      && receipt.startMs - timebase.wallOffsetMs >= dropReadBackAtMs).map((receipt) => ({ viewer: tag, path: receipt.url,
      askedClass: askedClass(receipt), rises: Array.isArray(receipt.rises) ? receipt.rises.map((r) => ({ ...r })) : null,
      startSharedMs: sharedWallMs(timebase, receipt.startMs), endSharedMs: sharedWallMs(timebase, receipt.endMs),
      finished: receipt.finished === true, canceled: receipt.canceled === true })) : [])) : null;
  const asksAfterLeave = finite(leaveShared) ? (input.declaredClientTags ?? []).flatMap((tag) => (stream(input.asks, tag) ?? [])
    .map((ask) => ({ ask, atSharedMs: sharedWallMs(timebase, ask?.atMs) }))
    .filter(({ atSharedMs }) => finite(atSharedMs) && atSharedMs >= leaveShared && atSharedMs <= leaveShared + REFILL_WINDOW_MS)
    .map(({ ask, atSharedMs }) => ({ viewer: tag, index: ask.index, reason: ask.reason, rank: ask.rank,
      afterLeaveMs: atSharedMs - leaveShared }))) : null;
  return shape('published', null, {
    exercised: input.capacitySchedule.exercised ?? null,
    rise: { readBackAtMs: rise.readBackAtMs, readBackSharedMs: riseShared, tbfBitsPerSecond },
    contentBitsPerSecond, climb, refill, doubleStalls: doubles, lateHostLoads,
    published: { stallOnsets: stallOnsets({ refill, rosterRows: input.rosterReading, riseShared, leaveShared }),
      runways: runwaysReading({ viewers, edge: input.capacitySchedule.edge, viewerPolls: input.viewerPolls }),
      asksAfterLeave, hostBodies },
  });
}
