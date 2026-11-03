import { column, document, gridX, gridY, hbar, linearScale, refLine, STYLE as C, swatch, text } from './svg.mjs';
import { ONE_REFRESH_TOLERANCE_MS } from './rules.mjs';

export const TITLES = {
  sharing: 'Does sharing cut what the host uploads?',
  'room-size': 'Does the host upload more as the room grows?',
  sync: 'How closely in step do the screens stay?',
};
const surface = (width, height) => `<rect width="${width}" height="${height}" fill="${C.surface}"/>`;
const values = (runs) => {
  const result = runs.map((run) => run.value);
  if (!result.length || result.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('missing plotted value');
  return result;
};
const range = (runs) => {
  const numbers = values(runs), low = Math.min(...numbers).toFixed(2), high = Math.max(...numbers).toFixed(2);
  return low === high ? low : `${low}–${high}`;
};
export function sharingBars(d) {
  return d.bars.map((bar) => ({
    label: bar.label === 'without sharing' ? 'no sharing' : bar.label,
    runs: bar.label === 'without sharing' ? bar.runs.filter((run) => run.directory.startsWith('13e-b2-nop2p-20')) : bar.runs,
  }));
}
export function sharingSvg(d) {
  const bars = sharingBars(d), L = 70, R = 470, B = 280, T = 40;
  const top = Math.max(6, ...bars.flatMap((bar) => values(bar.runs).map(Math.ceil)));
  const y = linearScale([0, top], [B, T]);
  let body = surface(520, 340) + gridY(y, Array.from({ length: top + 1 }, (_, i) => i), L, R);
  bars.forEach((bar, i) => {
    const x = L + (R - L) * (i + 0.5) / bars.length, hi = Math.max(...values(bar.runs)), label = range(bar.runs);
    body += column({ x: x - 24, w: 48, yTop: y(hi), yBase: B, fill: i ? C.blue : C.gray, title: `${bar.label}: ${label} copies` });
    body += text(x, y(hi) - 14, label, { anchor: 'middle', size: 18, fill: C.ink, weight: 600 });
    body += text(x, B + 26, bar.label, { anchor: 'middle', size: 14, fill: C.ink });
  });
  body += text(20, 22, 'copies of the video the host uploaded', { size: 13, fill: C.muted });
  return document({ width: 520, height: 340, title: TITLES.sharing, body });
}
export function roomSizeSvg(d) {
  const L = 70, R = 500, B = 300, T = 40;
  const top = Math.max(10, ...d.bars.map((bar) => bar.viewers), ...d.bars.flatMap((bar) => values(bar.runs)));
  const y = linearScale([0, top], [B, T]);
  let body = surface(580, 360) + gridY(y, Array.from({ length: 6 }, (_, i) => top * i / 5), L, R);
  d.bars.forEach((bar, i) => {
    const x = L + (R - L) * (i + 0.5) / d.bars.length, hi = Math.max(...values(bar.runs)), label = range(bar.runs);
    body += column({ x: x - 26, w: 24, yTop: y(bar.viewers), yBase: B, fill: C.gray, outline: true, title: `no sharing: ${bar.viewers} copies` });
    body += column({ x: x + 2, w: 24, yTop: y(hi), yBase: B, fill: C.blue, title: `${bar.viewers} viewers: ${label} copies` });
    body += text(x + 14, y(hi) - 8, label, { anchor: 'middle', size: 13, fill: C.ink, weight: 600 });
    body += text(x, B + 22, bar.viewers, { anchor: 'middle', size: 14, fill: C.ink });
  });
  body += swatch(78, 52, C.gray, 'no sharing: one copy per viewer', true);
  body += swatch(78, 74, C.blue, 'with sharing, measured');
  body += text((L + R) / 2, B + 46, 'viewers in the room', { anchor: 'middle', size: 13, fill: C.muted });
  body += text(20, 22, 'copies of the video the host uploaded', { size: 13, fill: C.muted });
  return document({ width: 580, height: 360, title: TITLES['room-size'], body });
}
const condition = (label) => label.replace('everyone 25 ms delayed', 'every link 25 ms delayed').replaceAll('%', ' percent');
export function syncSvg(d) {
  const L = 210, R = 500, T = 50, row = 52, bottom = T + row * d.bars.length;
  const top = Math.max(50, Math.ceil(Math.max(...d.bars.flatMap((bar) => values(bar.runs))) / 10) * 10);
  const x = linearScale([0, top], [L, R]);
  let body = surface(560, bottom + 42) + gridX(x, Array.from({ length: 6 }, (_, i) => top * i / 5), T - 10, bottom);
  d.bars.forEach((bar, i) => {
    const numbers = values(bar.runs), hi = Math.max(...numbers), cy = T + row * i + row / 2;
    const within = numbers.every((value) => value <= d.floor + ONE_REFRESH_TOLERANCE_MS);
    const label = within ? 'within one frame' : `${numbers.map(Math.round).join(' and ')} ms`;
    const name = condition(bar.label);
    body += hbar({ x0: L, x1: x(hi), y: cy - 10, h: 20, fill: within ? C.blue : C.gray, title: `${name}: ${label}` });
    body += text(L - 12, cy + 5, name, { anchor: 'end', size: 14, fill: C.ink });
    body += text(x(hi) + 12, cy + 5, label, { size: 13, fill: C.ink, weight: 600 });
  });
  body += refLine({ x1: x(d.floor), x2: x(d.floor), y1: T - 14, y2: bottom, dashed: true,
    label: `one frame, ${d.floor.toFixed(1)} ms`, labelX: x(d.floor), labelY: T - 20, anchor: 'middle' });
  body += text((L + R) / 2, bottom + 32, "99th-percentile gap between viewers' screens, ms (reconstructed lab time)",
    { anchor: 'middle', fill: C.muted, size: 12 });
  return document({ width: 560, height: bottom + 42, title: TITLES.sync, body });
}
