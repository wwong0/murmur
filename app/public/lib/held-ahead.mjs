// public/lib/held-ahead.mjs
//
// T7 (design.md D5): a held viewer's own runway, from its own finished
// segments and its own held position — never from `video.currentTime`
// (docs/constraints/playback.md). Pure: no clock, no engine, no timer.

// Absorbs float seconds x 1000 (hlsjs reports segment.startTime/endTime in
// seconds); a real gap between segments is at least one segment, ~4000 ms.
const CONTIGUITY_TOLERANCE_MS = 1;

/**
 * The held-ahead runway from `positionMs`, over the viewer's own finished
 * segments `{ mediaStartMs, mediaEndMs }`. The run starts at the finished
 * segment bracketing `positionMs` and extends through every finished segment
 * whose start is within the contiguity tolerance of the run's current end.
 */
export function heldAheadMs({ positionMs, segments }) {
  if (!Number.isFinite(positionMs) || positionMs < 0) {
    throw new TypeError('positionMs must be a finite non-negative number');
  }
  const start = segments.find((segment) => segment.mediaStartMs <= positionMs && positionMs < segment.mediaEndMs);
  if (!start) return 0;
  let runEnd = start.mediaEndMs;
  let extended = true;
  while (extended) {
    extended = false;
    for (const segment of segments) {
      if (segment.mediaEndMs > runEnd && Math.abs(segment.mediaStartMs - runEnd) <= CONTIGUITY_TOLERANCE_MS) {
        runEnd = segment.mediaEndMs;
        extended = true;
      }
    }
  }
  return Math.floor(runEnd - positionMs);
}

export function aheadReportDue({
  nowMs, lastSentMs, lastSentKey, lastSentReady, key,
  heldAheadMs: aheadMs, readyMs, intervalMs,
}) {
  if (lastSentMs === null) return true;
  if (nowMs - lastSentMs >= intervalMs) return true;
  return aheadMs >= readyMs && !(lastSentKey === key && lastSentReady);
}
