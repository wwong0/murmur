// Pace-bound time over a declared harness-clock window. Pure: all clocks and
// interval evidence are supplied by the caller.

export const MAX_PACE_EVIDENCE_GAP_MS = 2_000;

const finite = (value) => Number.isFinite(value);

function invalidWindow(window) {
  return !window || !finite(window.startMs) || !finite(window.endMs) || window.endMs <= window.startMs;
}

function validateInterval(interval, previousSeq, wallOffsetMs) {
  const seq = interval?.seq;
  const endWallMs = interval?.endWallMs;
  const durationMs = interval?.durationMs;
  const paceBoundMs = interval?.paceBoundMs;
  if (!finite(seq) || (previousSeq !== null && seq <= previousSeq)) {
    throw new RangeError('pace-bound: interval seq must increase');
  }
  if (!finite(endWallMs)) throw new RangeError('pace-bound: endWallMs must be finite');
  if (!(durationMs > 0) || !finite(durationMs)) {
    throw new RangeError('pace-bound: durationMs must be greater than 0');
  }
  if (!finite(paceBoundMs) || paceBoundMs < 0 || paceBoundMs > durationMs) {
    throw new RangeError('pace-bound: paceBoundMs must be within durationMs');
  }
  const endMs = endWallMs - wallOffsetMs;
  return { seq, startMs: endMs - durationMs, endMs, durationMs, paceBoundMs };
}

function incomplete({ pacedMs, coveredMs, windowMs }) {
  return { value: null, pacedMs, coveredMs, windowMs, reason: 'pace-evidence-incomplete' };
}

export function paceBoundFraction({ intervals, window, wallOffsetMs } = {}) {
  if (!Array.isArray(intervals)) throw new TypeError('pace-bound: intervals must be an array');
  if (!finite(wallOffsetMs)) throw new RangeError('pace-bound: wallOffsetMs must be finite');
  if (invalidWindow(window)) throw new RangeError('pace-bound: window must have a positive span');
  const windowMs = window.endMs - window.startMs;
  let previousSeq = null;
  const spans = intervals.map((interval) => {
    const span = validateInterval(interval, previousSeq, wallOffsetMs);
    previousSeq = span.seq;
    return span;
  }).sort((left, right) => left.startMs - right.startMs);
  if (spans.length === 0) return incomplete({ pacedMs: 0, coveredMs: 0, windowMs });

  const firstStartMs = Math.min(...spans.map((span) => span.startMs));
  const lastEndMs = Math.max(...spans.map((span) => span.endMs));
  if (firstStartMs > window.startMs || lastEndMs < window.endMs) {
    return incomplete({ pacedMs: 0, coveredMs: 0, windowMs });
  }

  let pacedMs = 0;
  let coveredMs = 0;
  let coveredEndMs = window.startMs;
  for (const span of spans) {
    const overlapStartMs = Math.max(span.startMs, window.startMs);
    const overlapEndMs = Math.min(span.endMs, window.endMs);
    if (overlapEndMs <= overlapStartMs) continue;
    if (overlapStartMs - coveredEndMs > MAX_PACE_EVIDENCE_GAP_MS) {
      return incomplete({ pacedMs, coveredMs, windowMs });
    }
    const overlapMs = overlapEndMs - overlapStartMs;
    pacedMs += span.paceBoundMs * overlapMs / span.durationMs;
    const newlyCoveredStartMs = Math.max(overlapStartMs, coveredEndMs);
    if (overlapEndMs > coveredEndMs) {
      coveredMs += overlapEndMs - newlyCoveredStartMs;
      coveredEndMs = overlapEndMs;
    }
  }
  if (window.endMs - coveredEndMs > MAX_PACE_EVIDENCE_GAP_MS) {
    return incomplete({ pacedMs, coveredMs, windowMs });
  }
  return { value: pacedMs / windowMs, pacedMs, coveredMs, windowMs, reason: null };
}
