// Readers for the wait and seek landing evidence. Page instants join the shared
// clock only through the run's timebase, as roster-event.mjs → sharedWallMs does;
// harness instants are never mixed into these differences.

const finite = (value) => Number.isFinite(value);

function pathOf(value) {
  return String(value ?? '').split(/[?#]/, 1)[0];
}

/** Join a page epoch instant to the shared clock; null when the timebase has no wall offset. */
export function pageSharedMs(atPageMs, timebase) {
  if (!finite(atPageMs) || !finite(timebase?.offsetMs) || !finite(timebase?.wallOffsetMs)) return null;
  return atPageMs - timebase.wallOffsetMs + timebase.offsetMs;
}

function heldPolls(polls, transitionSharedMs, effectiveSharedMs, timebase) {
  return (Array.isArray(polls) ? polls : []).map((poll) => ({ poll, atMs: pageSharedMs(poll?.heldAhead?.atPageMs, timebase) }))
    .filter(({ poll, atMs }) => finite(atMs) && finite(poll?.heldAhead?.heldAheadMs)
      && (!finite(transitionSharedMs) || atMs >= transitionSharedMs)
      && (!finite(effectiveSharedMs) || atMs <= effectiveSharedMs))
    .sort((left, right) => left.atMs - right.atMs);
}

function firstAtOrAbove(polls, transitionSharedMs, effectiveSharedMs, threshold, timebase) {
  return heldPolls(polls, transitionSharedMs, effectiveSharedMs, timebase)
    .find(({ poll }) => poll.heldAhead.heldAheadMs >= threshold) ?? null;
}

function coverageGap(polls, transitionSharedMs, effectiveSharedMs, timebase) {
  if (!finite(transitionSharedMs) || !finite(effectiveSharedMs)) return null;
  const times = heldPolls(polls, transitionSharedMs, effectiveSharedMs, timebase).map((entry) => entry.atMs);
  if (!times.length) return { gapMs: Infinity, fromMs: transitionSharedMs, toMs: effectiveSharedMs };
  let largest = { gapMs: times[0] - transitionSharedMs, fromMs: transitionSharedMs, toMs: times[0] };
  for (let index = 1; index < times.length; index += 1) {
    const gapMs = times[index] - times[index - 1];
    if (gapMs > largest.gapMs) largest = { gapMs, fromMs: times[index - 1], toMs: times[index] };
  }
  const tail = effectiveSharedMs - times.at(-1);
  if (tail > largest.gapMs) largest = { gapMs: tail, fromMs: times.at(-1), toMs: effectiveSharedMs };
  return largest;
}

function holdValues(hold = {}) {
  return {
    transitionSharedMs: hold.transitionSharedMs,
    issuedSharedMs: hold.issuedAtSharedMs,
    effectiveSharedMs: hold.effectiveSharedMs ?? hold.resumedAtSharedMs,
  };
}

/** The three wait parts and D9's threshold instants for each hold. */
export function waitParts({ holds = {}, viewerPolls = {}, declaredViewers = [], timebase } = {}) {
  const read = (hold) => {
    if (!hold) return null;
    const { transitionSharedMs, issuedSharedMs, effectiveSharedMs } = holdValues(hold);
    const perViewer = {};
    const missingReady = [];
    const gaps = {};
    for (const tag of declaredViewers) {
      const polls = viewerPolls?.[tag];
      const thresholds = {};
      for (const threshold of [1_000, 2_000, 3_000]) {
        const found = firstAtOrAbove(polls, transitionSharedMs, effectiveSharedMs, threshold, timebase);
        thresholds[threshold] = found ? { atSharedMs: found.atMs, heldAheadMs: found.poll.heldAhead.heldAheadMs,
          waitMs: finite(transitionSharedMs) ? found.atMs - transitionSharedMs : null } : null;
      }
      const ready = firstAtOrAbove(polls, transitionSharedMs, effectiveSharedMs, 4_000, timebase);
      if (!ready) missingReady.push(tag);
      const gap = coverageGap(polls, transitionSharedMs, effectiveSharedMs, timebase);
      if (gap) gaps[tag] = gap;
      perViewer[tag] = { thresholds, ready: ready ? { atSharedMs: ready.atMs, heldAheadMs: ready.poll.heldAhead.heldAheadMs } : null };
    }
    const readyTimes = Object.values(perViewer).map((entry) => entry.ready?.atSharedMs).filter(finite);
    const allReadySharedMs = missingReady.length || readyTimes.length !== declaredViewers.length
      ? null : Math.max(...readyTimes);
    const badGap = Object.entries(gaps).find(([, gap]) => gap.gapMs > 1_000);
    const readable = !badGap;
    const parts = {
      transitionSharedMs,
      allReadySharedMs,
      issuedSharedMs,
      effectiveSharedMs,
      loadingMs: finite(allReadySharedMs) && finite(transitionSharedMs) ? allReadySharedMs - transitionSharedMs : null,
      readyToIssueMs: finite(issuedSharedMs) && finite(allReadySharedMs) ? issuedSharedMs - allReadySharedMs : null,
      leadMs: finite(effectiveSharedMs) && finite(issuedSharedMs) ? effectiveSharedMs - issuedSharedMs : null,
      cause: hold.cause ?? null,
      status: readable ? 'readable' : 'unreadable',
      ...(missingReady.length ? { missingReady } : {}),
      ...(badGap ? { gap: { tag: badGap[0], ...badGap[1] } } : {}),
    };
    return { parts, perViewer, gaps };
  };
  return Object.fromEntries(['start', 'seek'].filter((kind) => holds[kind]).map((kind) => [kind, read(holds[kind])]));
}

function cumulativeStarts(segmentDurations, segmentSeconds, count) {
  if (Array.isArray(segmentDurations) && segmentDurations.length) {
    const starts = [0];
    for (const duration of segmentDurations) starts.push(starts.at(-1) + duration * 1000);
    return starts;
  }
  if (!finite(segmentSeconds) || segmentSeconds <= 0) return null;
  return Array.from({ length: count ?? 0 }, (_, index) => index * segmentSeconds * 1000);
}

function segmentBoundaries({ segmentDurations, segmentSeconds, segmentCount, positionMs }) {
  if (!finite(positionMs) || positionMs < 0) return null;
  const starts = cumulativeStarts(segmentDurations, segmentSeconds, segmentCount);
  if (!starts?.length) return null;
  const index = starts.findIndex((start, candidate) => start <= positionMs
    && (candidate + 1 >= starts.length || positionMs < starts[candidate + 1]));
  if (index < 0) return null;
  return { index, starts, endMs: starts[index + 1] ?? positionMs + segmentSeconds * 1000 };
}

export function landingSegments({ positionMs, segmentSeconds, segmentDurations, segmentCount, windowMs = 4_000 } = {}) {
  const boundary = segmentBoundaries({ positionMs, segmentSeconds, segmentDurations, segmentCount });
  if (!boundary) return null;
  const needed = [];
  const end = positionMs + windowMs;
  for (let index = boundary.index; index < boundary.starts.length; index += 1) {
    const start = boundary.starts[index];
    const stop = boundary.starts[index + 1] ?? Infinity;
    if (stop > positionMs && start < end) needed.push(index);
    if (start >= end) break;
  }
  return { index: boundary.index, playlistStartMs: boundary.starts[boundary.index],
    offsetMs: positionMs - boundary.starts[boundary.index], segmentsNeeded: needed };
}

function responseReceipts(receiptsByClient, responseId) {
  return Object.entries(receiptsByClient ?? {}).flatMap(([tag, value]) => (value ?? []).map((receipt) => ({ tag, receipt })))
    .filter(({ receipt }) => receipt?.originResponseId === responseId);
}

/** Count delivered bytes for responses whose matching receipt began in the hold. */
export function landingHostCopies({ segments = [], transitionSharedMs, effectiveSharedMs, hostResponses = [],
  receiptsByClient = {}, timebase, segmentSizes = [] } = {}) {
  const rows = segments.map((index) => {
    const path = `/media/seg-${String(index).padStart(5, '0')}.m4s`;
    const expected = segmentSizes[index];
    let deliveredBytes = 0;
    let responseCount = 0;
    let uncountedResponses = 0;
    for (const response of hostResponses) {
      if (pathOf(response?.urlPath) !== path || !response?.originResponseId) continue;
      const matching = responseReceipts(receiptsByClient, response.originResponseId);
      if (!matching.length) continue;
      const receipts = matching.filter(({ receipt }) => {
        const atSharedMs = pageSharedMs(receipt.startMs, timebase);
        return finite(atSharedMs) && finite(transitionSharedMs) && finite(effectiveSharedMs)
          && atSharedMs >= transitionSharedMs && atSharedMs <= effectiveSharedMs;
      });
      if (matching.some(({ receipt }) => !finite(pageSharedMs(receipt.startMs, timebase)))) uncountedResponses += 1;
      if (!receipts.length) continue;
      deliveredBytes += Number(response.delivered) || 0;
      responseCount += 1;
    }
    return { index, path, deliveredBytes, expectedBytes: finite(expected) ? expected : null,
      copies: finite(expected) && expected > 0 ? deliveredBytes / expected : null, responseCount, uncountedResponses };
  });
  const values = rows.map((entry) => entry.copies).filter(finite);
  return { rows, meanCopies: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
}

function traceRows(segments, asks = {}) {
  return Object.fromEntries(Object.entries(asks).map(([tag, records]) => [tag, Object.fromEntries(segments.map((index) => {
    const matches = (records ?? []).filter((record) => record?.index === index && record.reason === 'first');
    return [index, { countAfterFirst: Math.max(0, matches.length - 1), totalFirst: matches.length }];
  }))]));
}

function askDelay({ tag, path, transitionSharedMs, asks, requests, timebase }) {
  const peer = (asks ?? []).filter((record) => pathOf(record.path) === path)
    .map((record) => ({ at: pageSharedMs(record.atMs, timebase), source: 'peer' })).filter((entry) => finite(entry.at));
  const host = (requests ?? []).filter((record) => pathOf(record.url) === path)
    .map((record) => ({ at: pageSharedMs(record.startMs, timebase), source: 'host' })).filter((entry) => finite(entry.at));
  const first = [...peer, ...host].filter((entry) => finite(transitionSharedMs) && entry.at >= transitionSharedMs)
    .sort((left, right) => left.at - right.at)[0];
  return first ? { delayMs: first.at - transitionSharedMs, source: first.source, atSharedMs: first.at, tag } : null;
}

function landingRow({ hold, positionMs, content = {}, deltaMs = null, asks, clients, timebase } = {}) {
  if (!finite(positionMs)) return null;
  const geometry = landingSegments({ positionMs, segmentSeconds: content.segmentSeconds,
    segmentDurations: content.segmentDurations, segmentCount: content.segmentCount ?? content.segmentSizes?.length });
  if (!geometry) return { positionMs, reason: 'segment-boundaries-unavailable' };
  const traces = traceRows(geometry.segmentsNeeded, asks);
  const delays = Object.fromEntries(Object.entries(clients ?? {}).map(([tag, client]) => [tag,
    Object.fromEntries(geometry.segmentsNeeded.map((index) => [index, askDelay({ tag,
      path: `/media/seg-${String(index).padStart(5, '0')}.m4s`, transitionSharedMs: hold?.transitionSharedMs,
      asks: asks?.[tag], requests: client?.requests, timebase })]))]));
  return { positionMs, segment: geometry.index, playlistOffsetMs: geometry.offsetMs,
    firstPresentedOffsetMs: finite(deltaMs) ? geometry.offsetMs - deltaMs : null,
    segmentsNeeded: geometry.segmentsNeeded, hostCopies: null, traces, askDelays: delays };
}

/** Publish the landing geometry, host copies, D6 trace and ask delay for a run. */
export function landingReading({ holds = {}, seek = null, content = {}, hostResponses = [], clients = {}, asks = {},
  timebase, segmentSizes = content.segmentSizes ?? [] } = {}) {
  const build = (kind, hold, positionMs) => {
    if (!hold || !finite(positionMs)) return null;
    const row = landingRow({ hold, positionMs, content, asks, clients, timebase });
    if (!row?.segmentsNeeded) return row;
    // A host arm's `requests` stream is its receipts (arms.mjs → clientStreams).
    const receiptsByClient = Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, client?.requests ?? []]));
    row.hostCopies = landingHostCopies({ segments: row.segmentsNeeded, transitionSharedMs: hold.transitionSharedMs,
      effectiveSharedMs: hold.effectiveSharedMs ?? hold.resumedAtSharedMs, hostResponses, receiptsByClient,
      timebase, segmentSizes });
    row.kind = kind;
    return row;
  };
  const startPosition = holds.start?.held?.positionMs;
  const seekPosition = seek?.landedPositionMs ?? seek?.landingMs ?? seek?.host?.positionMs;
  return { start: build('start', holds.start, startPosition), seek: build('seek', holds.seek, seekPosition) };
}

