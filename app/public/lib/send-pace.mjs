// The shared token bucket and the pace it derives. Pure: every
// instant is supplied by the caller; no timer, no clock read.

export const HEADROOM_DEFAULT = 0.85;

// A finite number in (0, 1], or exactly 'unpaced', is valid.
export function validateHeadroomFraction(value) {
  if (value === 'unpaced') return { fraction: 'unpaced', error: null };
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1) {
    return { fraction: value, error: null };
  }
  return { fraction: null, error: 'headroom-fraction-must-be-in-(0,1]-or-unpaced' };
}

// createSendPace: a continuously-refilling bucket, capped at capBytes, plus the
// pace-bound time it accumulates while empty and something is waiting on it.
//
// The bucket's level between calls is never read by a timer: every method takes
// `nowMs` and the module advances its own state to that instant first, so a caller
// can feed it constructed instants out of a fixture with no wall-clock cost.
export function createSendPace({ capBytes }) {
  if (!(Number.isFinite(capBytes) && capBytes > 0)) throw new RangeError('createSendPace: capBytes must be a positive finite number');
  let rate = null; // bytes per ms, or null: no bucket
  let level = 0;
  let atMs = null;
  let waitingCount = 0;
  let paceBoundMs = 0;

  // Advance the model to nowMs: accrue pace-bound time over the passive span since
  // the last call (splitting at the level's analytic zero-crossing), then refill
  // the level to what it would be at nowMs. Every public method calls this first,
  // so a change of rate or waiting count is applied only after the old regime has
  // been accounted for up to the instant it changed.
  function advance(nowMs) {
    if (atMs === null) { atMs = nowMs; return; }
    const elapsed = nowMs - atMs;
    if (elapsed > 0) {
      if (rate !== null && waitingCount > 0 && level < 0) {
        const zeroCrossMs = atMs + (-level) / rate;
        const boundEnd = Math.min(nowMs, zeroCrossMs);
        if (boundEnd > atMs) paceBoundMs += boundEnd - atMs;
      }
      if (rate !== null) level = Math.min(capBytes, level + rate * elapsed);
    }
    atMs = nowMs;
  }

  return Object.freeze({
    setRate(bytesPerMs, nowMs) {
      advance(nowMs);
      const wasNull = rate === null;
      rate = bytesPerMs === null ? null : bytesPerMs;
      if (wasNull && rate !== null) level = capBytes;
    },
    available(nowMs) {
      advance(nowMs);
      if (rate === null || level > 0) return { ok: true };
      return { ok: false, waitMs: Math.max(1, Math.ceil(-level / rate)) };
    },
    take(bytes, nowMs) {
      advance(nowMs);
      level -= bytes;
    },
    setWaiting(count, nowMs) {
      advance(nowMs);
      waitingCount = count;
    },
    closeInterval(nowMs) {
      advance(nowMs);
      const elapsed = paceBoundMs;
      paceBoundMs = 0;
      return elapsed;
    },
  });
}
