import { median, percentile } from './stats.mjs';

const finite = (value) => Number.isFinite(value);
const EPSILON = 1e-6;

function declaredOffset(evidence, tag) { return evidence.condition?.positionOffsetMsByClient?.[tag] ?? 0; }
export function labRecords(evidence, tag) {
  return (evidence.clients?.[tag]?.drift ?? []).map((record) => ({ record,
    L: finite(record?.displaySharedMs) && finite(record?.clock?.offsetMs) ? record.displaySharedMs - record.clock.offsetMs : null,
    a: finite(record?.mediaMs) ? record.mediaMs - declaredOffset(evidence, tag) : null }))
    .filter((entry) => finite(entry.L) && finite(entry.a)).sort((a, b) => a.L - b.L);
}
function nearest(records, atMs, step) {
  let found = null;
  for (const entry of records) {
    const distance = Math.abs(entry.L - atMs);
    if (distance > step / 2) continue;
    if (!found || distance < found.distance || (distance === found.distance && entry.L < found.entry.L)) found = { entry, distance };
  }
  return found?.entry ?? null;
}
function frameRate(evidence) { return evidence.manifest?.content?.frameRate ?? evidence.content?.frameRate; }
function grid(fromMs, toMs, step, anchorMs = 0) {
  const rows = [];
  if (!finite(fromMs) || !finite(toMs) || !(step > 0)) return rows;
  for (let atMs = anchorMs + Math.ceil((fromMs - anchorMs) / step) * step; atMs <= toMs + step / 1000; atMs += step) rows.push(atMs);
  return rows;
}
export function gridRows(evidence, tags, fromMs, toMs) {
  const rate = frameRate(evidence);
  if (!finite(rate) || rate <= 0) return null;
  const step = 1000 / rate;
  const records = Object.fromEntries(tags.map((tag) => [tag, labRecords(evidence, tag)]));
  const anchorMs = evidence.manifest?.window?.startMs ?? 0;
  return grid(fromMs, toMs, step, anchorMs).flatMap((L) => {
    const matches = Object.fromEntries(tags.map((tag) => [tag, nearest(records[tag], L, step)]));
    return tags.every((tag) => matches[tag]) ? [{ L, matches, step }] : [];
  });
}
function gapRows(evidence, disturbed, others, fromMs, toMs) {
  const rows = gridRows(evidence, [disturbed, ...others], fromMs, toMs);
  if (!rows) return null;
  return rows.map((row) => ({ L: row.L, step: row.step, g: row.matches[disturbed].a - median(others.map((tag) => row.matches[tag].a)), row }));
}
export function frameGaps(records) {
  const values = (records ?? []).map((record) => record?.displaySharedMs).filter(finite).sort((a, b) => a - b);
  return values.slice(0, -1).map((startMs, index) => ({ startMs, gapMs: values[index + 1] - startMs }))
    .filter((gap) => gap.gapMs > 250);
}
function holdAt(rows, fromMs, threshold = 40, holdMs = 5_000) {
  if (!rows?.length) return null;
  for (const candidate of rows.filter((row) => row.L >= fromMs)) {
    const end = candidate.L + holdMs;
    const span = rows.filter((row) => row.L >= candidate.L && row.L <= end);
    const expected = Math.floor(holdMs / (rows[0].step ?? 1)) + 1;
    if (span.length >= Math.ceil(expected * 0.9) && span.every((row) => Math.abs(row.g) <= threshold)) return candidate.L;
  }
  return null;
}
function pollAt(poll) { return finite(poll?.atMs) ? poll.atMs : null; }
function disturbancePolls(evidence, tag, t0, endMs) {
  return (evidence.clients?.[tag]?.polls ?? []).map((poll) => ({ poll, atMs: pollAt(poll) }))
    .filter((entry) => finite(entry.atMs) && entry.atMs >= t0 && entry.atMs <= endMs).sort((a, b) => a.atMs - b.atMs);
}
function pollDelta(values, field) {
  const counts = values.map(({ poll }) => field.split('.').reduce((value, key) => value?.[key], poll)).filter(Number.isSafeInteger);
  return counts.length ? counts.at(-1) - counts[0] : null;
}
function rateFigure(values, t0, endMs) {
  const trace = values.map(({ poll, atMs }) => [atMs - t0, poll?.controller?.rate ?? null]);
  let offUnityMs = 0;
  let maxDeviation = null;
  for (let index = 0; index < values.length; index += 1) {
    const rate = values[index].poll?.controller?.rate;
    if (!finite(rate)) continue;
    const deviation = Math.abs(rate - 1);
    maxDeviation = maxDeviation === null ? deviation : Math.max(maxDeviation, deviation);
    const next = values[index + 1]?.atMs ?? endMs;
    if (deviation > EPSILON) offUnityMs += Math.max(0, Math.min(next, endMs) - values[index].atMs);
  }
  return { offUnityMs, maxDeviation, trace };
}
function stallFigure(evidence, tag, fromMs, toMs) {
  const rows = frameGaps(evidence.clients?.[tag]?.drift).filter((gap) => gap.startMs >= fromMs && gap.startMs <= toMs);
  return { count: rows.length, totalMs: rows.reduce((sum, row) => sum + row.gapMs, 0) };
}
function pairMovement(evidence, tags, fromMs, toMs) {
  const values = [];
  for (let left = 0; left < tags.length; left += 1) {
    for (let right = left + 1; right < tags.length; right += 1) {
      const rows = gridRows(evidence, [tags[left], tags[right]], fromMs, toMs) ?? [];
      values.push(...rows.map((row) => Math.abs(row.matches[tags[left]].a - row.matches[tags[right]].a)));
    }
  }
  return median(values);
}
function refused(evidence, reason, detail) {
  return { reader: 'catch-up', version: 1, run: evidence.run ?? null, refused: true, reason, ...(detail ? { detail } : {}) };
}

export function catchUp(evidence) {
  const disturbance = evidence.disturbance;
  const tag = disturbance?.clients?.[0];
  if (!tag) return refused(evidence, 'disturbance-missing');
  const result = disturbance.results?.[tag];
  if (result?.injected !== true) return refused(evidence, 'not-injected', tag);
  const pause = result.pauseCallLocalMs;
  const t0 = result.playResolvedLocalMs;
  if (!finite(pause) || !finite(t0)) return refused(evidence, 'pause-unavailable', tag);
  const observationMs = disturbance.observationMs;
  if (!finite(observationMs) || observationMs < 0) return refused(evidence, 'observation-unavailable');
  const others = (evidence.tags ?? []).filter((other) => other !== tag);
  const requestedEnd = t0 + observationMs;
  const allLast = [tag, ...others].flatMap((viewer) => labRecords(evidence, viewer).map((row) => row.L)).filter(finite);
  const observationEnd = allLast.length ? Math.min(requestedEnd, Math.max(...allLast)) : requestedEnd;
  const rows = gapRows(evidence, tag, others, pause - 10_000, observationEnd);
  if (!rows) return refused(evidence, 'frame-rate-unavailable');
  const before = rows.filter((row) => row.L >= pause - 5_000 && row.L < pause).map((row) => row.g);
  const after = rows.filter((row) => row.L >= t0 && row.L <= t0 + 2_000);
  const largestAfter = after.slice().sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || a.L - b.L)[0];
  const settled = holdAt(rows, t0);
  const polls = disturbancePolls(evidence, tag, t0, observationEnd);
  const rate = rateFigure(polls, t0, observationEnd);
  const othersBefore = pairMovement(evidence, others, pause - 10_000, pause);
  const othersAfter = pairMovement(evidence, others, t0, Math.min(t0 + 10_000, observationEnd));
  const gaps = stallFigure(evidence, tag, t0, observationEnd);
  return { reader: 'catch-up', version: 1, run: evidence.run ?? null, disturbed: tag,
    measuredPauseMs: t0 - pause, t0, observationMs, observationEndMs: observationEnd,
    observationTruncated: observationEnd < requestedEnd, gapBeforeMs: median(before), gapAfterMs: largestAfter?.g ?? null,
    timeInto40Ms: finite(settled) ? settled - t0 : null,
    ...(finite(settled) ? {} : { timeInto40Reason: 'not-within-observation' }), rate,
    skipsDelta: pollDelta(polls, 'playback.skips'), stallCountDelta: pollDelta(polls, 'stalls.count'),
    frameGaps: gaps.count, frameGapMs: gaps.totalMs, frameGapTotalMs: gaps.totalMs,
    othersMovedMs: { beforeMs: othersBefore, afterMs: othersAfter,
      differenceMs: finite(othersBefore) && finite(othersAfter) ? othersAfter - othersBefore : null },
    resolvedBy: (pollDelta(polls, 'playback.skips') ?? 0) > 0 ? 'far-skip' : finite(settled) ? 'rate' : 'unresolved' };
}
