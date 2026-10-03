import { csvCell, requirePublished } from './publication.mjs';

const finite = (value) => Number.isFinite(value);
const numberText = (value) => Number(value).toFixed(3);

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function intervalOf(published) {
  const frameRate = published.content?.frameRate;
  if (!(finite(frameRate) && frameRate > 0)) throw new Error('drift plot requires a positive content frame rate');
  return 1000 / frameRate;
}

function seriesOf(published) {
  const series = published.driftSeriesByClient;
  if (!series || typeof series !== 'object') throw new Error('drift plot requires driftSeriesByClient');
  return series;
}

export function driftSeriesCsv(published) {
  requirePublished(published);
  const series = seriesOf(published);
  const tags = Object.keys(series);
  const length = Math.max(0, ...tags.map((tag) => Array.isArray(series[tag]) ? series[tag].length : 0));
  const intervalMs = intervalOf(published);
  const startMs = published.window.startMs;
  const rows = [['gridIndex', 'gridMs', ...tags]];
  for (let index = 0; index < length; index += 1) {
    rows.push([index, startMs + index * intervalMs, ...tags.map((tag) => series[tag]?.[index] ?? null)]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function driftSvg(published) {
  requirePublished(published);
  const series = seriesOf(published);
  const tags = Object.keys(series);
  const intervalMs = intervalOf(published);
  const startMs = published.window.startMs;
  const targetMs = published.criterionVerdict?.targetMs ?? published.condition?.criterion?.targetMs;
  // A peer arm publishes drift with no criterion (`not-drawn`): the plot then
  // carries the series and no target lines, never a target it was not given.
  const notDrawn = published.criterionVerdict?.verdict === 'not-drawn' && targetMs === undefined;
  if (!notDrawn && (!finite(targetMs) || targetMs < 0)) throw new Error('drift plot requires a non-negative criterion target');
  const targets = notDrawn ? [] : [targetMs, -targetMs];
  const points = tags.flatMap((tag) => (Array.isArray(series[tag]) ? series[tag] : []).filter(finite));
  const extent = Math.max(...targets, ...points.map((value) => Math.abs(value)), 1);
  const width = 900;
  const height = 480;
  const left = 82;
  const right = 24;
  const top = 28;
  const bottom = 64;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const length = Math.max(1, ...tags.map((tag) => Array.isArray(series[tag]) ? series[tag].length : 0));
  const xAt = (index) => left + (length <= 1 ? 0 : (index * intervalMs / ((length - 1) * intervalMs)) * plotWidth);
  const yAt = (value) => top + ((extent - value) / (2 * extent)) * plotHeight;
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img">`);
  lines.push(`<title>Drift by client relative to window start</title>`);
  lines.push(`<line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}"/>`);
  lines.push(`<line class="axis" x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}"/>`);
  for (const value of targets) {
    const y = numberText(yAt(value));
    lines.push(`<line class="criterion" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"/>`);
    lines.push(`<text class="criterion-label" x="${left + plotWidth - 4}" y="${numberText(Number(y) - 4)}" text-anchor="end">${numberText(value)} ms</text>`);
  }
  tags.forEach((tag, tagIndex) => {
    const values = Array.isArray(series[tag]) ? series[tag] : [];
    const pointsText = values.map((value, index) => finite(value)
      ? `${numberText(xAt(index))},${numberText(yAt(value))}` : null).filter(Boolean).join(' ');
    lines.push(`<polyline data-tag="${escapeXml(tag)}" class="series series-${tagIndex}" fill="none" points="${pointsText}"/>`);
  });
  lines.push(`<text class="axis-label" x="${numberText(left + plotWidth / 2)}" y="${height - 18}" text-anchor="middle">time from window start (ms)</text>`);
  lines.push(`<text class="axis-label" transform="translate(18 ${numberText(top + plotHeight / 2)}) rotate(-90)" text-anchor="middle">drift (ms)</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}
