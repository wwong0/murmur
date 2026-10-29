import { ROOM_SIZES } from './sources.mjs';
import {
  C,
  column,
  document,
  gridY,
  ledgerOrder,
  linearScale,
  median,
  pct,
  run,
  same,
  select,
  setupLines,
  table,
  text,
} from './public-common.mjs';
import { swatch } from './svg.mjs';
export const ID = 'room-size', KIND = 'headline', TITLE = 'Does the sharer upload more as more people watch?';
export function data(inputs) {
  const bars = ROOM_SIZES.filter((name) => select(inputs, name).length).map((name) => {
    const rows = select(inputs, name), n = rows[0]?.regime.viewers;
    const runs = rows.map((row) => run(row, row.entry.figures?.hostUploadMultiplier ?? null, `${n} viewers`));
    return { viewers: n, outline: n, measured: median(runs.map((r) => r.value)), runs, rows };
  });
  const rows = bars.flatMap((b) => b.rows);
  same(rows, ['hostCapMbps'], ID);
  if (bars.some((b) => !Number.isFinite(b.measured) || !(b.measured < b.outline))) {
    throw new Error('takeaway-unsupported:room-size');
  }
  return {
    bars: bars.map(({ rows: _, ...b }) => b),
    runs: ledgerOrder(inputs, bars.flatMap((b) => b.runs)),
    regimes: rows.map((r) => ({ label: `${r.regime.viewers} viewers`, regime: r.regime })),
  };
}
export function takeaway(d) {
  const values = d.bars.map((b) => b.measured);
  return `As the room grew from ${d.bars[0].viewers} to ${
    d.bars.at(-1).viewers
  } viewers, the sharer's upload stayed between ${pct(Math.min(...values))} and ${
    pct(Math.max(...values))
  } of what one viewer watched; without sharing it would grow to ${pct(d.bars.at(-1).outline)}.`;
}
export function svg(d) {
  const L = 70,
    R = 590,
    T = 30,
    B = 350,
    top = Math.max(...d.bars.map((b) => b.outline)),
    y = linearScale([0, top], [B, T]);
  let body = gridY(y, Array.from({ length: 6 }, (_, i) => top * i / 5), L, R, (v) => pct(v));
  d.bars.forEach((b, i) => {
    const x = L + (R - L) * (i + 0.5) / d.bars.length, w = 24;
    body += column({
      x: x - w - 2,
      w,
      yTop: y(b.outline),
      yBase: y(0),
      fill: C.gray,
      outline: true,
      title: `${b.viewers} viewers, if each got their own copy: ${pct(b.outline)}, worked out`,
    });
    body += column({
      x: x + 2,
      w,
      yTop: y(b.measured),
      yBase: y(0),
      fill: C.blue,
      title: `${b.viewers} viewers, measured: ${b.measured * 100}%`,
    });
    body += text(x - w / 2 - 2, y(b.outline) - 8, pct(b.outline), { anchor: 'middle', size: 13 });
    body += text(x + w / 2 + 2, y(b.measured) - 8, pct(b.measured), {
      anchor: 'middle',
      size: 13,
      fill: C.ink,
      weight: 600,
    });
    body += text(x, B + 28, `${b.viewers} viewers`, { anchor: 'middle', fill: C.ink });
  });
  body += swatch(L, 392, C.gray, 'if each viewer got their own copy', true);
  body += swatch(L + 280, 392, C.blue, 'measured, with sharing');
  body += text(10, 18, "sharer's upload, as % of the video one viewer watched", { size: 14, fill: C.muted });
  return document({ width: 620, height: 420, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    '**What the chart shows.** The outlined amount is worked out; ' +
    'the blue amount is the middle measured upload.\n\n' +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')}\n\n` +
    `**Every test.**\n\n${table(d.runs)}\n\n` +
    '**What it means.** Viewers passed pieces to each other, reducing what the sharer sent. ' +
    'These are small tests on one computer.';
};
