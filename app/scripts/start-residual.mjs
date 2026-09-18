// scripts/start-residual.mjs
//
// How far from the room a scheduled start landed: the median signed drift over
// the first records after its `play()` (change 5 design.md D11), against one
// content frame interval. Pure — records and the start entry are arguments.

import { median } from './lead-measurement.mjs';

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

/**
 * Whether a start that has settled is running AHEAD of the room, over the
 * records AFTER the residual population — a separate export, because D11's
 * residual is frozen and this asks a different question (executor-spec.md §12).
 *
 * One-sided by construction: a start behind the room is what D11 judges, and a
 * compensated start that overshoots is what this exists to catch. `absent` on a
 * malformed start or a non-finite tolerance, never a pass.
 *
 * @param {{records: object[], start: object, nextAfterSeq?: number, skip?: number, minCount?: number, uncertaintyMs: number}} input
 * @returns {{status: 'held'|'lead'|'short'|'absent', medianMs: number|null, count: number, uncertaintyMs: number|null}}
 */
export function startLead({ records, start, nextAfterSeq = Infinity, skip = 24, minCount = 24, uncertaintyMs }) {
  const empty = { medianMs: null, count: 0, uncertaintyMs: Number.isFinite(uncertaintyMs) ? uncertaintyMs : null };
  if (!start || typeof start !== 'object' || !Number.isSafeInteger(start.afterSeq) || start.afterSeq < 0
    || !Array.isArray(records) || !Number.isFinite(uncertaintyMs)
    || !Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(minCount) || minCount < 1) {
    return { status: 'absent', ...empty };
  }
  const taken = records
    .filter((record) => record && Number.isSafeInteger(record.seq) && record.seq > start.afterSeq
      && record.seq <= nextAfterSeq && Number.isFinite(record.driftMs))
    .sort((a, b) => a.seq - b.seq)
    .slice(skip);
  const figures = {
    medianMs: taken.length > 0 ? median(taken.map((record) => record.driftMs)) : null,
    count: taken.length,
    uncertaintyMs,
  };
  if (taken.length < minCount) return { status: 'short', ...figures };
  return { status: figures.medianMs <= uncertaintyMs ? 'held' : 'lead', ...figures };
}

/**
 * Whether a start's seam epoch is the ROOM's mapping epoch, or a derivation
 * from the park the advance has moved (executor-spec.md §15 item 4).
 *
 * Three figures must agree: the seam's own `epochMs`, `startAtSharedMs −
 * scheduledPositionMs`, and the epoch on the first accepted record. With a zero
 * advance the middle term equals `S − positionMs` and the check cannot
 * discriminate; with a nonzero advance the two differ by exactly the advance,
 * which is what makes this label worth printing.
 *
 * `absent` on anything malformed or non-finite, never a pass (R8).
 *
 * @param {{start: object, records: object[], toleranceMs?: number}} input
 * @returns {{status: 'agrees'|'derived'|'absent', epochMs: number|null, fromRoomMs: number|null, recordEpochMs: number|null, deltaMs: number|null}}
 */
export function seamEpochAgreement({ start, records, toleranceMs = 0.001 }) {
  const empty = { epochMs: null, fromRoomMs: null, recordEpochMs: null, deltaMs: null };
  if (!start || typeof start !== 'object' || !Array.isArray(records)
    || !(Number.isFinite(toleranceMs) && toleranceMs >= 0)
    || !Number.isSafeInteger(start.afterSeq) || start.afterSeq < 0) return { status: 'absent', ...empty };
  const { epochMs, startAtSharedMs, scheduledPositionMs } = start;
  if (![epochMs, startAtSharedMs, scheduledPositionMs].every(Number.isFinite)) return { status: 'absent', ...empty };
  const first = records
    .filter((record) => record && Number.isSafeInteger(record.seq) && record.seq > start.afterSeq && Number.isFinite(record.epochMs))
    .sort((a, b) => a.seq - b.seq)[0] ?? null;
  if (!first) return { status: 'absent', ...empty, epochMs, fromRoomMs: startAtSharedMs - scheduledPositionMs };
  const figures = {
    epochMs,
    fromRoomMs: startAtSharedMs - scheduledPositionMs,
    recordEpochMs: first.epochMs,
    deltaMs: epochMs - (startAtSharedMs - scheduledPositionMs),
  };
  const agrees = Math.abs(figures.deltaMs) <= toleranceMs
    && Math.abs(epochMs - first.epochMs) <= toleranceMs;
  return { status: agrees ? 'agrees' : 'derived', ...figures };
}
