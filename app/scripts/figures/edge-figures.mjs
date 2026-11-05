// What a run publishes beside its criteria. None of these is a
// leg or a criterion; each reads `null` where its evidence gives no value.

import { median } from '../../public/lib/frame-drift.mjs';
import { heldAheadAt } from './poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);
const inside = (at, window) => finite(at) && at >= window.startMs && at < window.endMs;
const pathOf = (value) => String(value ?? '').split(/[?#]/, 1)[0];
const segmentIndex = (path) => {
  const match = pathOf(path).match(/(?:^|\/)seg-(\d+)\.m4s$/i);
  return match ? Number(match[1]) : null;
};
const sorted = (values) => values.slice().sort((a, b) => a - b);
const distribution = (values) => {
  const ascending = sorted(values);
  return ascending.length ? { count: ascending.length, minMs: ascending[0], medianMs: median(ascending), maxMs: ascending.at(-1) }
    : { count: 0, minMs: null, medianMs: null, maxMs: null };
};

/**
 * Host copies per segment asked for at the edge. `asksByClient[tag]` is
 * `{ records, wallOffsetMs, evicted, gaps }`; `hostResponses` the host's response
 * records settled between the two boundaries; `receiptsByClient` the viewers'
 * receipts, used only to test that no viewer holds a body the host did not send.
 */
export function hostCopies({ asksByClient = {}, hostResponses = [], segmentSizes = [], window, control = 'product', receiptsByClient = {} } = {}) {
  const segments = new Map();
  const asksByReason = {};
  for (const [tag, asks] of Object.entries(asksByClient)) {
    if (!asks || !Array.isArray(asks.records) || !finite(asks.wallOffsetMs)) return { value: null, reason: 'ask-evidence-unavailable', tag };
    if (asks.evicted > 0 || asks.gaps > 0) return { value: null, reason: 'ask-evidence-evicted', tag };
    for (const ask of asks.records) {
      if (ask.reason === 'control-8b' && control !== '8b') throw new Error(`host ask reason control-8b under the product control: ${tag}`);
      if (!inside(ask.atMs - asks.wallOffsetMs, window)) continue;
      const path = pathOf(ask.path);
      if (!segments.has(path)) segments.set(path, []);
      segments.get(path).push({ tag, reason: ask.reason, rank: ask.rank });
      asksByReason[ask.reason] = (asksByReason[ask.reason] ?? 0) + 1;
    }
  }
  const whole = (path, bytes, aborted) => aborted !== true && finite(bytes) && bytes === segmentSizes[segmentIndex(path)];
  const responsesByPath = new Map();
  const wholeIds = new Set();
  const cohortIds = new Set();
  for (const response of hostResponses) {
    const path = pathOf(response.urlPath);
    cohortIds.add(response.originResponseId);
    if (!whole(path, response.delivered, response.aborted)) continue;
    wholeIds.add(response.originResponseId);
    responsesByPath.set(path, (responsesByPath.get(path) ?? 0) + 1);
  }
  // Two-sided: a whole body a viewer received from a response of this cohort is one the host delivered whole.
  for (const [tag, receipts] of Object.entries(receiptsByClient)) {
    for (const receipt of receipts ?? []) {
      if (receipt.finished === true && cohortIds.has(receipt.originResponseId) && !wholeIds.has(receipt.originResponseId)
        && whole(receipt.url, receipt.bodyBytes, false)) {
        throw new RangeError(`${tag} received a whole body of ${pathOf(receipt.url)} the host did not deliver whole`);
      }
    }
  }
  const perSegment = [...segments.entries()].map(([path, asks]) => ({ path, copies: responsesByPath.get(path) ?? 0, asks }));
  const counts = {};
  for (const entry of perSegment) counts[entry.copies] = (counts[entry.copies] ?? 0) + 1;
  return { segments: perSegment.length,
    meanCopies: perSegment.length ? perSegment.reduce((sum, entry) => sum + entry.copies, 0) / perSegment.length : null,
    distribution: counts, asksByReason, perSegment };
}

/**
 * The wait of a prefetch request made at the edge: receipts from the host that
 * are neither urgent nor near, for a media segment, begun inside the window
 * while that viewer's last poll held below `edgeMsBelow`.
 */
export function prefetchWait({ receiptsByClient = {}, viewerPolls = {}, window, edgeMsBelow, wallOffsetMsByClient = {} } = {}) {
  const answers = [];
  const durations = [];
  let count = 0;
  let unanswered = 0;
  for (const [tag, receipts] of Object.entries(receiptsByClient)) {
    const offset = wallOffsetMsByClient[tag] ?? 0;
    for (const receipt of receipts ?? []) {
      if (receipt.urgent === true || receipt.near === true || segmentIndex(receipt.url) === null) continue;
      const startMs = receipt.startMs - offset;
      if (!inside(startMs, window)) continue;
      const held = heldAheadAt(viewerPolls, [tag], startMs)[tag];
      if (held === null || !(held < edgeMsBelow)) continue;
      count += 1;
      const answerMs = finite(receipt.headMs) ? receipt.headMs - receipt.startMs : null;
      const durationMs = finite(receipt.endMs) ? receipt.endMs - receipt.startMs : null;
      if ((answerMs !== null && answerMs < 0) || (durationMs !== null && durationMs < 0)) {
        throw new RangeError(`${tag} holds a receipt answered or ended before it began: ${receipt.requestId ?? receipt.url}`);
      }
      if (answerMs === null) unanswered += 1; else answers.push(answerMs);
      if (durationMs !== null) durations.push(durationMs);
    }
  }
  return { count, unanswered, maxAnswerMs: answers.length ? Math.max(...answers) : null,
    maxDurationMs: durations.length ? Math.max(...durations) : null,
    answerMsDistribution: distribution(answers), durationMsDistribution: distribution(durations) };
}

function positionAt(records, instant) {
  const left = records.filter((record) => record.displaySharedMs <= instant).at(-1);
  const right = records.find((record) => record.displaySharedMs >= instant);
  if (!left || !right) return null;
  if (right.displaySharedMs === left.displaySharedMs) return left.mediaMs;
  return left.mediaMs + (right.mediaMs - left.mediaMs) * (instant - left.displaySharedMs) / (right.displaySharedMs - left.displaySharedMs);
}

function roomAt(hostPoll, sharedMs) {
  const state = hostPoll.filter((poll) => poll.state && finite(poll.sharedMs) && poll.sharedMs <= sharedMs).at(-1)?.state;
  if (!state || !finite(state.positionMs)) return null;
  return state.playing === true && state.held !== true ? state.positionMs + (sharedMs - state.atSharedMs) : state.positionMs;
}

/**
 * Each viewer's median distance behind the room over the window, once a
 * second, from its drift records and the host's published state; and the
 * median spread between the furthest and the nearest viewer.
 */
export function roomPosition({ clients = {}, tags = Object.keys(clients), hostPoll = [], window, offsetMs = 0, scatteredSpreadMsAbove } = {}) {
  const drift = Object.fromEntries(tags.map((tag) => [tag, (clients[tag]?.records ?? [])
    .filter((record) => finite(record?.displaySharedMs) && finite(record?.mediaMs)).sort((a, b) => a.displaySharedMs - b.displaySharedMs)]));
  const behind = Object.fromEntries(tags.map((tag) => [tag, []]));
  const spreads = [];
  for (let at = window.startMs; at < window.endMs; at += 1_000) {
    const sharedMs = at + offsetMs;
    const room = roomAt(hostPoll, sharedMs);
    const positions = tags.map((tag) => positionAt(drift[tag], sharedMs));
    tags.forEach((tag, index) => { if (room !== null && positions[index] !== null) behind[tag].push(room - positions[index]); });
    if (tags.length > 0 && positions.every((position) => position !== null)) spreads.push(Math.max(...positions) - Math.min(...positions));
  }
  const spreadMs = spreads.length ? median(sorted(spreads)) : null;
  return { behindMsMedianByClient: Object.fromEntries(tags.map((tag) => [tag, behind[tag].length ? median(sorted(behind[tag])) : null])),
    spreadMs, secondsUsed: spreads.length,
    roomScattered: spreadMs === null || !finite(scatteredSpreadMsAbove) ? null : spreadMs > scatteredSpreadMsAbove };
}

/** Segments finished in the window, as media time, over the stretch played. Published beside the byte ratio, never tested. */
export function mediaTimeRatio(figures = {}, tags = [], segmentSeconds) {
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  return Object.fromEntries(tags.map((tag) => {
    const played = figures.playedMediaMsByClient?.[tag];
    const stretchMs = played ? played.end - played.start : null;
    const segments = figures.completedSegmentsByClient?.[tag];
    return [tag, finite(segments) && stretchMs > 0 ? segments * segmentSeconds * 1000 / stretchMs : null];
  }));
}

/** Whether every viewer held above the figure at the end of the earliest span from which the room read recovered. */
export function aheadWhenRecovered({ recovery, viewerPolls = {}, tags = [], aheadMsMin } = {}) {
  const result = recovery?.result;
  const fromMs = result?.recovered === true ? (result.recoveryMs ?? result.recoveryAtMostMs) : null;
  const spanMs = recovery?.spans?.length ? recovery.spans[0].window.endMs - recovery.spans[0].window.startMs : null;
  const span = finite(fromMs) && spanMs > 0 ? recovery.spans[Math.min(fromMs / spanMs, recovery.spans.length - 1)] : null;
  if (!span) return null;
  const heldAheadMsByClient = heldAheadAt(viewerPolls, tags, span.window.endMs);
  return { atMs: span.window.endMs, heldAheadMsByClient,
    ahead: tags.length > 0 && tags.every((tag) => heldAheadMsByClient[tag] !== null && heldAheadMsByClient[tag] > aheadMsMin) };
}

/** A slow viewer's exit: the asks that left a slow holder, per viewer, and the slow viewer's upload over the window. */
export function slowExit({ asksByClient = {}, window, slowTags = [], uploadBytesByClient = {} } = {}) {
  if (!slowTags.length) return null;
  const asks = Object.fromEntries(Object.entries(asksByClient).map(([tag, value]) => [tag, (value?.records ?? [])
    .filter((ask) => ask.reason === 'fallback-slow-holder' && finite(value.wallOffsetMs) && inside(ask.atMs - value.wallOffsetMs, window)).length]));
  const total = Object.values(asks).reduce((sum, value) => sum + value, 0);
  return { slowTags, slowHolderAsksByClient: asks, slowHolderAsks: total,
    uploadBytesByClient: Object.fromEntries(slowTags.map((tag) => [tag, uploadBytesByClient[tag] ?? null])),
    slowExit: total > 0 ? 'exercised' : 'not-exercised' };
}
