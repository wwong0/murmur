import { records, sum } from './common.mjs';
import { regimeOf } from './caption.mjs';
import { median } from '../measure/stats.mjs';
import { reasonText, setupLines } from './plain.mjs';
import { pct } from './rules.mjs';
import { column, document, gridX, gridY, hbar, linearScale, STYLE as C, text } from './svg.mjs';

export { C, column, document, gridX, gridY, hbar, linearScale, median, pct, setupLines, text };
const byLedger = (inputs, directoryOf) => {
  const order = Object.values(inputs.batches).flatMap((batch) => batch.ledger.runs.map((entry) => entry.directory));
  return (a, b) => order.indexOf(directoryOf(a)) - order.indexOf(directoryOf(b));
};
export function select(inputs, conditions) {
  const wanted = Array.isArray(conditions) ? conditions : [conditions];
  const rows = records(inputs).filter((row) => wanted.includes(row.entry.condition));
  rows.sort(byLedger(inputs, (row) => row.entry.directory));
  return rows.map((row) => ({ ...row, regime: regimeOf(row.run, row.ledger, row.entry.figures) }));
}
export const statusOf = (row, value) => reasonText({ ...row.entry, status: row.ledger.outcome }, value);
export function run(row, value, label) {
  return {
    directory: row.entry.directory,
    value: value ?? null,
    valid: row.entry.valid,
    status: statusOf(row, value),
    stalls: sum(row.entry.figures?.stallCountByClient),
    label,
    commit: row.ledger.commit ?? 'unrecorded',
    regime: row.regime,
  };
}
export function ledgerOrder(inputs, runs) {
  return [...runs].sort(byLedger(inputs, (run) => run.directory));
}
export function same(rows, fields, id) {
  if (fields.some((field) => rows.some((row) => row.regime[field] !== rows[0].regime[field]))) {
    throw new Error(`mixed-regime:${id}`);
  }
}
export function named(rows, labelOf = (r) => r.label) {
  const groups = [...new Set(rows.map(labelOf))], seen = {};
  return groups.flatMap((g) => rows.filter((r) => labelOf(r) === g)).map((r) => {
    seen[labelOf(r)] = (seen[labelOf(r)] ?? 0) + 1;
    return { ...r, name: `${labelOf(r)} ${seen[labelOf(r)]}` };
  });
}
export const table = (rows, render = (v) => v == null ? 'no value' : pct(v)) => {
  return [
    '| Test | Value | Freezes | Status |',
    '| --- | --- | --- | --- |',
    ...named(rows).map((r) =>
      `| ${r.name} | ${render(r.value)} | ${r.stalls ?? 'unrecorded'} | ${r.status} |`
    ),
  ].join('\n');
};
export function vertical(
  {
    title,
    bars,
    top,
    ticks,
    width = 620,
    height = 420,
    yBottom = 350,
    yTop = 30,
    left = 70,
    right = 590,
    axis = '',
    legend = '',
  },
) {
  const y = linearScale([0, top], [yBottom, yTop]), step = (right - left) / bars.length;
  let body = gridY(y, ticks, left, right, (v) => `${Math.round(v * 100)}%`);
  bars.forEach((bar, i) => {
    const x = left + step * (i + 0.5), w = 48;
    body += column({
      x: x - w / 2,
      w,
      yTop: y(bar.value),
      yBase: y(0),
      fill: bar.fill ?? C.blue,
      title: `${bar.label}: ${bar.value * 100}%`,
      outline: bar.outline,
    });
    body += text(x, y(bar.value) - 10, pct(bar.value), {
      anchor: 'middle',
      size: 18,
      fill: C.ink,
      weight: 600,
    });
    body += text(x, yBottom + 28, bar.label, { anchor: 'middle', fill: C.ink });
  });
  body += text(left - 60, yTop - 12, axis, { size: 14, fill: C.muted });
  body += legend;
  return document({ width, height, title, body });
}
