// The source choice for one urgent segment. It is pure at the decision seam;
// the page supplies the room context and the engine supplies peer status.

export const PEER_WAIT_LIMIT_MS = 3_000;
// design.md D8 (m): nobody is watching a held room, so it waits longer on a loader.
export const PEER_WAIT_HELD_LIMIT_MS = 6_000;
export const PEER_WAIT_MARGIN_MS = 1_500;
export const URGENT_DELAY_MAX_MS = 500;
export const EDGE_STEP_MS = 250;
export const EDGE_RECHECK_MS = 500;
export const SLOW_RATE_BYTES_PER_S = 160_000;
export const SLOW_WINDOW_MS = 2_000;
export const SLOW_MIN_AGE_MS = 2_000;
export const HOST_ASK_CAPACITY = 1_024;

const HOST_ASK_REASONS = new Set([
  'first',
  'fallback-no-announcement',
  'fallback-no-holder',
  'fallback-slow-holder',
  'fallback-peer-failed',
  'control-8b',
]);

const suppliedDelayMs = globalThis.__waUrgentDelayMs;
const fixedDelayMs = Number.isFinite(suppliedDelayMs)
  && suppliedDelayMs >= 0
  && suppliedDelayMs <= URGENT_DELAY_MAX_MS
  ? suppliedDelayMs
  : null;

let randomSource = Math.random;
let context = { held: false, roomMediaMs: 0, ownMediaMs: 0, viewerIds: Object.freeze([]), selfId: null };
let latestHostAskSeq = 0;
let evictedHostAsks = 0;
const hostAsks = [];

function hostAskField(record, name) {
  if (!Object.prototype.hasOwnProperty.call(record, name)) {
    throw new TypeError(`host ask ${name} is required`);
  }
  return record[name];
}

function validateHostAsk(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('host ask must be an object');
  }
  const index = hostAskField(record, 'index');
  const path = hostAskField(record, 'path');
  const startMs = hostAskField(record, 'startMs');
  const reason = hostAskField(record, 'reason');
  const rank = hostAskField(record, 'rank');
  const atMs = hostAskField(record, 'atMs');
  if (!Number.isSafeInteger(index)) throw new TypeError('host ask index must be an integer');
  if (typeof path !== 'string') throw new TypeError('host ask path must be a string');
  if (!Number.isFinite(startMs) || startMs < 0) throw new TypeError('host ask startMs must be finite and non-negative');
  if (!HOST_ASK_REASONS.has(reason)) throw new TypeError('host ask reason is invalid');
  if (!Number.isSafeInteger(rank) || rank < 0) throw new TypeError('host ask rank must be a non-negative integer');
  if (!Number.isFinite(atMs) || atMs < 0) throw new TypeError('host ask atMs must be finite and non-negative');
  return { index, path, startMs, reason, rank, atMs };
}

export function noteHostAsk(record) {
  const validated = validateHostAsk(record);
  const entry = { seq: ++latestHostAskSeq, ...validated };
  hostAsks.push(entry);
  if (hostAsks.length > HOST_ASK_CAPACITY) {
    hostAsks.shift();
    evictedHostAsks += 1;
  }
}

export function readHostAsks(afterSeq = 0) {
  return {
    records: hostAsks.filter((record) => record.seq > afterSeq).map((record) => ({ ...record })),
    evicted: evictedHostAsks,
    latestSeq: latestHostAskSeq,
  };
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  return value;
}

export function setUrgentRandom(source = Math.random) {
  if (typeof source !== 'function') throw new TypeError('urgent random source must be a function');
  randomSource = source;
}

export function urgentDelay() {
  return { fixedMs: fixedDelayMs };
}

export function drawUrgentDelay() {
  if (fixedDelayMs !== null) return fixedDelayMs;
  const draw = Number(randomSource()) * URGENT_DELAY_MAX_MS;
  if (!Number.isFinite(draw)) throw new TypeError('urgent random source must return a finite number');
  return Math.min(URGENT_DELAY_MAX_MS, Math.max(0, draw));
}

export function setUrgentContext({ held = false, roomMediaMs = 0, ownMediaMs = roomMediaMs, viewerIds = [], selfId = null } = {}) {
  const room = finiteNonNegative(roomMediaMs, 'roomMediaMs');
  const own = finiteNonNegative(ownMediaMs, 'ownMediaMs');
  if (!Array.isArray(viewerIds)) throw new TypeError('viewerIds must be an array');
  context = {
    held: held === true,
    roomMediaMs: room,
    ownMediaMs: own,
    viewerIds: Object.freeze([...viewerIds]),
    selfId,
  };
}

export function urgentContext() {
  return { ...context };
}

export function urgentPeerWaitMs({ held, segmentStartMs, roomMediaMs } = {}) {
  finiteNonNegative(segmentStartMs, 'segmentStartMs');
  finiteNonNegative(roomMediaMs, 'roomMediaMs');
  if (held === true) return PEER_WAIT_HELD_LIMIT_MS;
  return Math.max(0, Math.min(
    PEER_WAIT_LIMIT_MS,
    segmentStartMs - roomMediaMs - PEER_WAIT_MARGIN_MS,
  ));
}

// The patched queue calls this for every urgent segment. A segment without a
// start time goes to the host at once, as stock does, rather than throw there.
export function urgentBudgetMs(segmentStartMs) {
  if (!Number.isFinite(segmentStartMs) || segmentStartMs < 0) return 0;
  return urgentPeerWaitMs({ ...context, segmentStartMs });
}

export function urgentSource({
  nowMs,
  p2pLoading = false,
  holders = 0,
  loaders = 0,
  p2pFailed = false,
  held = false,
  waitStartMs,
  p2pStartMs = waitStartMs,
  delayMs,
  budgetMs,
} = {}) {
  finiteNonNegative(nowMs, 'nowMs');
  finiteNonNegative(waitStartMs, 'waitStartMs');
  finiteNonNegative(p2pStartMs, 'p2pStartMs');
  finiteNonNegative(delayMs, 'delayMs');
  finiteNonNegative(budgetMs, 'budgetMs');
  const spentAt = waitStartMs + budgetMs;
  // design.md D8 (l): a transfer under way in a held room is left to finish or to
  // the engine's own no-bytes timeout, and so is one from a peer that holds the
  // segment, whatever the budget. Otherwise its budget runs from its start, and
  // `wakeMs` is that budget's end while it is still ahead.
  if (p2pLoading) {
    const endsAt = p2pStartMs + budgetMs;
    if (held === true) return { source: 'p2p' };
    if (nowMs < endsAt) return { source: 'p2p', wakeMs: endsAt };
    return holders > 0 ? { source: 'p2p' } : { source: 'http' };
  }
  if (p2pFailed) return { source: 'http' };
  if (holders > 0) return { source: 'p2p' };
  if (loaders > 0) return nowMs < spentAt
    ? { source: 'wait', untilMs: spentAt }
    : { source: 'http' };
  const untilMs = waitStartMs + Math.min(delayMs, budgetMs);
  return nowMs < untilMs ? { source: 'wait', untilMs } : { source: 'http' };
}

function episodeInstant(value, name) {
  if (value === null) return null;
  return finiteNonNegative(value, name);
}

export function nextEdgeEpisode(prev, {
  nowMs,
  holders = 0,
  loaders = 0,
  withinRunway = false,
  slow = false,
} = {}) {
  finiteNonNegative(nowMs, 'nowMs');
  const previous = prev ?? {
    needMs: nowMs,
    quietSinceMs: nowMs,
    announced: false,
    loaderSinceMs: null,
    runwaySinceMs: null,
    holders: 0,
    holdersRoseMs: null,
    slowSinceMs: null,
  };
  const needMs = finiteNonNegative(previous.needMs, 'needMs');
  const quietSinceMs = episodeInstant(previous.quietSinceMs, 'quietSinceMs');
  const loaderSinceMs = episodeInstant(previous.loaderSinceMs, 'loaderSinceMs');
  const runwaySinceMs = episodeInstant(previous.runwaySinceMs, 'runwaySinceMs');
  const holdersRoseMs = episodeInstant(previous.holdersRoseMs, 'holdersRoseMs');
  const slowSinceMs = episodeInstant(previous.slowSinceMs, 'slowSinceMs');
  const announced = holders + loaders > 0;
  const loaderStage = loaders > 0 && holders === 0;
  const wasLoaderStage = loaderSinceMs !== null;
  const nextQuietSinceMs = previous.announced && !announced ? nowMs : quietSinceMs ?? nowMs;
  return {
    needMs,
    quietSinceMs: nextQuietSinceMs,
    announced,
    loaderSinceMs: loaderStage
      ? wasLoaderStage ? loaderSinceMs : nowMs
      : null,
    runwaySinceMs: withinRunway ? runwaySinceMs ?? nowMs : null,
    holders,
    holdersRoseMs: holders === 0
      ? null
      : holders > previous.holders ? nowMs : holdersRoseMs,
    slowSinceMs: slow ? slowSinceMs ?? nowMs : null,
  };
}

export function edgeSource({
  nowMs,
  rank,
  viewers,
  held = false,
  p2pLoading = false,
  p2pFailed = false,
  slow = false,
  holders = 0,
  otherHolders = 0,
  loaders = 0,
  episode,
} = {}) {
  finiteNonNegative(nowMs, 'nowMs');
  if (p2pLoading && !slow) return { source: 'p2p' };
  if (p2pLoading && slow && otherHolders > 0) return { source: 'move' };
  if (p2pLoading && slow && otherHolders === 0 && held) return { source: 'p2p' };
  if (p2pLoading && slow && otherHolders === 0) {
    const slowSinceMs = finiteNonNegative(episode?.slowSinceMs, 'slowSinceMs');
    const at = slowSinceMs + rank * EDGE_STEP_MS;
    return nowMs < at
      ? { source: 'p2p', wakeMs: at }
      : { source: 'http', reason: 'fallback-slow-holder' };
  }
  if (p2pFailed) return { source: 'http', reason: 'fallback-peer-failed' };
  if (holders > 0) return { source: 'p2p' };
  if (loaders > 0) {
    const effective = rank === 0 ? Math.max(1, viewers) : rank;
    if (episode?.runwaySinceMs === null) return { source: 'wait', untilMs: nowMs + EDGE_RECHECK_MS };
    const loaderSinceMs = finiteNonNegative(episode?.loaderSinceMs, 'loaderSinceMs');
    const runwaySinceMs = finiteNonNegative(episode?.runwaySinceMs, 'runwaySinceMs');
    const waitLimit = held ? PEER_WAIT_HELD_LIMIT_MS : PEER_WAIT_LIMIT_MS;
    const at = Math.max(loaderSinceMs, runwaySinceMs) + effective * waitLimit;
    return nowMs < at
      ? { source: 'wait', untilMs: at }
      : { source: 'http', reason: 'fallback-no-holder' };
  }
  if (rank === 0) return { source: 'http', reason: 'first' };
  const at = finiteNonNegative(episode?.quietSinceMs, 'quietSinceMs') + rank * EDGE_STEP_MS;
  return nowMs < at
    ? { source: 'wait', untilMs: at }
    : { source: 'http', reason: 'fallback-no-announcement' };
}

export function transferIsSlow({ nowMs, startedMs, samples = [] } = {}) {
  if (nowMs - startedMs < SLOW_MIN_AGE_MS || samples.length === 0) return false;
  const cutoffMs = nowMs - SLOW_WINDOW_MS;
  let from = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].atMs <= cutoffMs) {
      from = samples[index];
      break;
    }
  }
  if (from === null) return false;
  const to = samples[samples.length - 1];
  if (to.atMs <= from.atMs) return false;
  return (to.bytes - from.bytes) * 1000 / (to.atMs - from.atMs) < SLOW_RATE_BYTES_PER_S;
}

// A host load in the high-demand window is one the room was told of by an ask:
// cancelling it for an earlier segment asks the host for the same bytes twice.
export function hostSlotVictim(later = []) {
  for (let index = later.length - 1; index >= 0; index -= 1) {
    if (later[index].loadingFromHost && !later[index].highDemand) return index;
  }
  return -1;
}
