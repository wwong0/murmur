// scripts/start-residual.mjs
//
// How far from the room a scheduled start landed: the median signed drift over
// the first records after its `play()` (change 5 design.md D11), against one
// content frame interval. Pure — records and the start entry are arguments.

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  // Even count: the mean of the middle two, frame-drift's summary definition.
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * @param {{records: object[], start: object, nextAfterSeq: number, frameIntervalMs: number, population?: number}} input
 * @returns {{status: 'met'|'missed'|'absent'|'short'|'mixed', medianMs: number|null, count: number, firstSeq: number|null, lastSeq: number|null}}
 */
export function startResidual({ records, start, nextAfterSeq = Infinity, frameIntervalMs, population = 24 }) {
  const empty = { medianMs: null, count: 0, firstSeq: null, lastSeq: null };
  if (!start || typeof start !== 'object' || !Number.isSafeInteger(start.afterSeq) || start.afterSeq < 0
    || !Array.isArray(records) || !(Number.isFinite(frameIntervalMs) && frameIntervalMs > 0)) {
    return { status: 'absent', ...empty };
  }
  const taken = records
    .filter((record) => record && Number.isSafeInteger(record.seq) && record.seq > start.afterSeq && Number.isFinite(record.driftMs))
    .sort((a, b) => a.seq - b.seq)
    .slice(0, population);
  const figures = {
    medianMs: taken.length > 0 ? median(taken.map((record) => record.driftMs)) : null,
    count: taken.length,
    firstSeq: taken[0]?.seq ?? null,
    lastSeq: taken.at(-1)?.seq ?? null,
  };
  if (taken.some((record) => record.seq > nextAfterSeq || record.epochMs !== taken[0].epochMs)) return { status: 'mixed', ...figures };
  if (taken.length < population) return { status: 'short', ...figures };
  return { status: Math.abs(figures.medianMs) <= frameIntervalMs ? 'met' : 'missed', ...figures };
}
