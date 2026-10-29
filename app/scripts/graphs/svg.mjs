export const STYLE = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  blue: '#2a78d6',
  gray: '#a9a79f',
  band: '#efeee9',
  font: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  sizes: { label: 15, tick: 14, value: 18, small: 13 },
};
export const escapeXml = (s) => {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(
    '"',
    '&quot;',
  )
    .replaceAll("'", '&apos;');
};
const f = (n) => {
  return Number(n).toFixed(2);
};
export const linearScale = ([a, b], [c, d]) => {
  return (v) => {
    return c + (v - a) / (b - a) * (d - c);
  };
};
export const text = (x, y, value, o = {}) => {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${f(o.size ?? 15)}" fill="${
    o.fill ?? STYLE.ink2
  }" text-anchor="${o.anchor ?? 'start'}"${o.weight ? ` font-weight="${f(o.weight)}"` : ''}>${
    escapeXml(value)
  }</text>`;
};
const line = (x1, y1, x2, y2, color = STYLE.grid, width = 1, dash = false, title = null) => {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${
    f(width)
  }"${dash ? ' stroke-dasharray="4.00 3.00"' : ''}>${
    title == null ? '' : `<title>${escapeXml(title)}</title>`
  }</line>`;
};
export const gridY = (scale, ticks, x0, x1, fmt = String) => {
  return ticks.map((t) =>
    line(x0, scale(t), x1, scale(t), t === 0 ? STYLE.axis : STYLE.grid) +
    text(x0 - 10, scale(t) + 5, fmt(t), { anchor: 'end', fill: STYLE.muted, size: 14 })
  ).join('');
};
export const gridX = (scale, ticks, y0, y1, fmt = String) => {
  return ticks.map((t) =>
    line(scale(t), y0, scale(t), y1, t === 0 ? STYLE.axis : STYLE.grid) +
    text(scale(t), y1 + 20, fmt(t), { anchor: 'middle', fill: STYLE.muted, size: 14 })
  ).join('');
};
export function column({ x, w, yTop, yBase, fill, title, outline = false }) {
  const r = Math.max(0, Math.min(4, (yBase - yTop) / 2));
  return `<path d="M${f(x)},${f(yBase)} V${f(yTop + r)} Q${f(x)},${f(yTop)} ${f(x + r)},${f(yTop)} H${
    f(x + w - r)
  } Q${f(x + w)},${f(yTop)} ${f(x + w)},${f(yTop + r)} V${f(yBase)}${outline ? '' : ' Z'}" fill="${
    outline ? 'none' : fill
  }" stroke="${outline ? fill : 'none'}" stroke-width="${f(outline ? 2 : 0)}"><title>${
    escapeXml(title)
  }</title></path>`;
}
export function hbar({ x0, x1, y, h, fill, title }) {
  const r = Math.max(0, Math.min(4, (x1 - x0) / 2));
  return `<path d="M${f(x0)},${f(y)} H${f(x1 - r)} Q${f(x1)},${f(y)} ${f(x1)},${f(y + r)} V${f(y + h - r)} Q${
    f(x1)
  },${f(y + h)} ${f(x1 - r)},${f(y + h)} H${f(x0)} Z" fill="${fill}"><title>${
    escapeXml(title)
  }</title></path>`;
}
export const stackedColumn = ({ x, y, width, height, fill, title }) => {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(width)}" height="${f(height)}" fill="${fill}"><title>${
    escapeXml(title)
  }</title></rect>`;
};
export const refLine = (
  { x1, y1, x2, y2, label, labelX = x2, labelY = y1 - 6, anchor = 'end', dashed = false },
) => {
  return line(x1, y1, x2, y2, STYLE.ink2, 1.5, dashed, label) +
    text(labelX, labelY, label, { size: 13, anchor });
};
export const swatch = (x, y, color, label, outline = false) => {
  return `<rect x="${f(x)}" y="${f(y)}" width="12.00" height="12.00" rx="2.00" fill="${
    outline ? 'none' : color
  }" stroke="${outline ? color : 'none'}" stroke-width="2.00"><title>${escapeXml(label)}</title></rect>` +
    text(x + 18, y + 11, label, { size: 14 });
};
export const document = ({ width, height, title, body }) => {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.00 0.00 ${f(width)} ${
    f(height)
  }" role="img" aria-label="${escapeXml(title)}" font-family="${escapeXml(STYLE.font)}"><title>${
    escapeXml(title)
  }</title>${body}</svg>`;
};
