import { records } from './common.mjs';
import { G4_ARMS } from './sources.mjs';
export function g4Data(inputs) {
  const rows = records(inputs).filter((row) => G4_ARMS.includes(row.entry.condition)),
    join = [],
    landings = [],
    cuts = [];
  for (const row of rows) {
    const clock = row.readings['event-clocks'];
    if (row.entry.condition === '13d-j-join') {
      join.push({ directory: row.entry.directory, ...clock?.join });
    }
    if (row.entry.condition.endsWith('-product')) {
      landings.push({
        directory: row.entry.directory,
        start: row.readings.landings?.start?.waitMs ?? null,
        seek: row.readings.landings?.seek?.waitMs ?? null,
      });
    }
    if (row.entry.condition === '13d-j-cut') {
      const cut = clock?.supplierCut, stalls = Object.values(cut?.stalls ?? {});
      cuts.push({
        directory: row.entry.directory,
        stalled: stalls.length && stalls.every((s) => Number.isFinite(s.count))
          ? stalls.filter((s) => s.count > 0).length
          : null,
        of: stalls.length || null,
      });
    }
  }
  return { panels: { join, landings, cuts } };
}
