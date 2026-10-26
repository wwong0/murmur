// Where each viewer is at a lab instant, shared by R1, R4 and R5 (design D2).
import { median } from './stats.mjs';

const finite = (value) => Number.isFinite(value);

/** A frame older than this many frame steps reads as missing: a frozen viewer drops out, never reads in sync. */
export const STALE_STEPS = 1.5;

export function labInstant(record) {
  return finite(record?.displaySharedMs) && finite(record?.clock?.offsetMs)
    ? record.displaySharedMs - record.clock.offsetMs : null;
}

export function frameStep(evidence) {
  const rate = evidence?.manifest?.content?.frameRate ?? evidence?.content?.frameRate;
  return finite(rate) && rate > 0 ? 1000 / rate : null;
}

/** One viewer's records by lab instant; `a` is the room-aligned position, `mediaMs` less the declared offset. */
export function labRecords(evidence, tag) {
  const declared = evidence?.condition?.positionOffsetMsByClient?.[tag] ?? 0;
  return (evidence?.clients?.[tag]?.drift ?? [])
    .map((record) => ({ record, L: labInstant(record), a: finite(record?.mediaMs) ? record.mediaMs - declared : null }))
    .filter((entry) => finite(entry.L) && finite(entry.a)).sort((left, right) => left.L - right.L);
}

/**
 * The frame on screen at `atMs`, projected to it. `mediaMs` moves in whole frames, so comparing it
 * unprojected reads two in-sync viewers a frame apart by vsync phase (13c `d1-findings.md` F1).
 */
export function positionAt(rows, atMs, step) {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].L <= atMs) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  if (found < 0 || atMs - rows[found].L > STALE_STEPS * step) return null;
  const entry = rows[found];
  return { entry, a: entry.a + (atMs - entry.L), mediaMs: entry.record.mediaMs + (atMs - entry.L) };
}

/** Grid instants at `step` from `anchorMs`, covering [fromMs, toMs]. */
export function gridInstants(fromMs, toMs, step, anchorMs = fromMs) {
  const instants = [];
  if (!finite(fromMs) || !finite(toMs) || !(step > 0)) return instants;
  for (let atMs = anchorMs + Math.ceil((fromMs - anchorMs) / step) * step; atMs <= toMs + step / 1000; atMs += step) instants.push(atMs);
  return instants;
}

/** Grid rows on which every named viewer has a position; `null` when the frame rate is unknown. */
export function gridRows(evidence, tags, fromMs, toMs) {
  const step = frameStep(evidence);
  if (step === null) return null;
  const records = Object.fromEntries(tags.map((tag) => [tag, labRecords(evidence, tag)]));
  const anchorMs = evidence.manifest?.window?.startMs ?? 0;
  return gridInstants(fromMs, toMs, step, anchorMs).flatMap((L) => {
    const at = Object.fromEntries(tags.map((tag) => [tag, positionAt(records[tag], L, step)]));
    return tags.every((tag) => at[tag]) ? [{ L, at, step }] : [];
  });
}

/** One viewer's gap to the median of the others, on `gridRows`. */
export function gapToOthers(rows, tag, others) {
  return rows.map((row) => ({ L: row.L, step: row.step, g: row.at[tag].a - median(others.map((other) => row.at[other].a)) }));
}

/**
 * The first row from which `|g| ≤ 40` holds for 5 s: every row in [L, L + 5000] within it, and rows
 * present at 90% of that span's grid points (`executor-spec.md` §1, the hold rule).
 */
export function holdFrom(rows, fromMs, thresholdMs = 40, holdMs = 5_000) {
  if (!rows?.length) return null;
  const expected = Math.floor(holdMs / rows[0].step) + 1;
  for (let start = 0; start < rows.length; start += 1) {
    if (rows[start].L < fromMs) continue;
    let end = start;
    let held = true;
    while (end < rows.length && rows[end].L <= rows[start].L + holdMs) {
      if (Math.abs(rows[end].g) > thresholdMs) { held = false; break; }
      end += 1;
    }
    if (held && end - start >= Math.ceil(expected * 0.9)) return rows[start].L;
  }
  return null;
}

/** Frame gaps over 250 ms on the shared clock, the stall definition (`executor-spec.md` §1). */
export function frameGaps(records) {
  const values = (records ?? []).map((record) => record?.displaySharedMs).filter(finite).sort((a, b) => a - b);
  return values.slice(0, -1).map((startMs, index) => ({ startMs, gapMs: values[index + 1] - startMs }))
    .filter((gap) => gap.gapMs > 250);
}
