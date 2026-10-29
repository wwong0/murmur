import { records } from './common.mjs';
function weighted(viewers, field) {
  if (!viewers.length || viewers.some((v) => !Number.isFinite(v.playingMs) || !Number.isFinite(v[field]))) {
    return null;
  }
  const total = viewers.reduce((sum, v) => sum + v.playingMs, 0);
  return total > 0 ? viewers.reduce((sum, v) => sum + v[field] * v.playingMs, 0) / total : null;
}
export function g5Data(inputs, { with8b }) {
  const rows = records(inputs).filter((row) =>
    row.readings['gap-count'] && (with8b || row.run.manifest?.condition?.assignmentControl !== '8b')
  );
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.className ?? 'unrecorded'}|${row.label}`;
    if (!groups.has(key)) {
      groups.set(key, { className: row.className ?? null, label: row.label, runs: [] });
    }
    const viewers = Object.values(row.readings['gap-count'].viewers ?? {});
    groups.get(key).runs.push({
      directory: row.entry.directory,
      condition: row.entry.condition,
      valid: row.entry.valid,
      reasons: row.entry.reasons,
      above40PerHour: weighted(viewers, 'secondsAbove40PerHour'),
      above100PerHour: weighted(viewers, 'secondsAbove100PerHour'),
    });
  }
  return { with8b, panels: [...groups.values()] };
}
