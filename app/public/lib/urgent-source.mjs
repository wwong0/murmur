// The source choice for one urgent segment. It is pure at the decision seam;
// the page supplies the room context and the engine supplies peer status.

export const PEER_WAIT_LIMIT_MS = 3_000;
// design.md D8 (m): nobody is watching a held room, so it waits longer on a loader.
export const PEER_WAIT_HELD_LIMIT_MS = 6_000;
export const PEER_WAIT_MARGIN_MS = 1_500;
export const URGENT_DELAY_MAX_MS = 500;

const suppliedDelayMs = globalThis.__waUrgentDelayMs;
const fixedDelayMs = Number.isFinite(suppliedDelayMs)
  && suppliedDelayMs >= 0
  && suppliedDelayMs <= URGENT_DELAY_MAX_MS
  ? suppliedDelayMs
  : null;

let randomSource = Math.random;
let context = { held: false, roomMediaMs: 0 };

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

export function setUrgentContext({ held = false, roomMediaMs = 0 } = {}) {
  context = { held: held === true, roomMediaMs: finiteNonNegative(roomMediaMs, 'roomMediaMs') };
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
