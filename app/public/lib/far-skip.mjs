// public/lib/far-skip.mjs
//
// Pure dwell and repeat gate for D4. The entry supplies page-clock readings.

export function createFarSkip({ dwellMs, repeatIntervalMs } = {}) {
  for (const [name, value] of [['dwellMs', dwellMs], ['repeatIntervalMs', repeatIntervalMs]]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  }

  let namedSince = null;
  let lastSkipAt = null;

  function state() {
    return { namedSince, lastSkipAt };
  }

  function evaluate({ nowMs, named = false, estimateMs = null, eligible = false } = {}) {
    if (!Number.isFinite(nowMs) || named !== true || eligible !== true) {
      namedSince = null;
      return { skip: false, abandonedDriftMs: null };
    }
    if (namedSince === null) namedSince = nowMs;
    const dwellSatisfied = nowMs - namedSince >= dwellMs;
    const repeatSatisfied = lastSkipAt === null || nowMs - lastSkipAt >= repeatIntervalMs;
    if (!dwellSatisfied || !repeatSatisfied) return { skip: false, abandonedDriftMs: null };
    lastSkipAt = nowMs;
    namedSince = null;
    return { skip: true, abandonedDriftMs: Number.isFinite(estimateMs) ? estimateMs : null };
  }

  return { evaluate, state };
}
