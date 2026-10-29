import { SYNC } from './sources.mjs';
import {
  C,
  document,
  gridX,
  hbar,
  ledgerOrder,
  linearScale,
  median,
  pct,
  run,
  select,
  setupLines,
  text,
  named,
} from './public-common.mjs';
import { conditionWords } from './plain.mjs';
import { driftLabel, driftShown, ONE_REFRESH_TOLERANCE_MS } from './rules.mjs';
import { refLine } from './svg.mjs';
import { min } from './common.mjs';
import { records } from './common.mjs';
function playingWeighted(viewers, field) {
  if (!viewers.length || viewers.some((v) => !Number.isFinite(v.playingMs) || !Number.isFinite(v[field]))) {
    return null;
  }
  const total = viewers.reduce((sum, v) => sum + v.playingMs, 0);
  return total > 0 ? viewers.reduce((sum, v) => sum + v[field] * v.playingMs, 0) / total : null;
}
export const ID = 'sync', KIND = 'headline', TITLE = 'How closely in step do the screens stay?';
export function data(inputs) {
  const gaps = new Map(records(inputs).filter((row) => row.readings['gap-count']).map((row) => {
    const viewers = Object.values(row.readings['gap-count'].viewers ?? {});
    return [row.entry.directory, {
      above40PerHour: playingWeighted(viewers, 'secondsAbove40PerHour'),
      above100PerHour: playingWeighted(viewers, 'secondsAbove100PerHour'),
    }];
  }));
  const bars = SYNC.filter(({ condition }) => select(inputs, condition).length).map(
    ({ condition, oneRefresh }) => {
      const rows = select(inputs, condition), label = conditionWords(rows[0].regime);
      const runs = rows.map((row) => {
        const lab = row.readings['lab-drift'],
          pair = lab.pairs.find((p) => `${p.left}|${p.right}` === lab.overall.worstPair),
          figures = row.entry.figures;
        return {
          ...run(row, lab.overall.absP99Ms, label),
          median: lab.overall.absMedianMs,
          floor: Math.max(...lab.pairs.map((p) => p.floorMs)),
          lower: pair?.lowerMs ?? null,
          upper: pair?.upperMs ?? null,
          uplink: figures?.uplinkUtilisationMean ?? null,
          coverage: min(figures?.coverageRatioByClient),
          above40: gaps.get(row.entry.directory)?.above40PerHour ?? null,
          above100: gaps.get(row.entry.directory)?.above100PerHour ?? null,
        };
      });
      const values = runs.map((r) => r.value).filter(Number.isFinite);
      return {
        label,
        oneRefresh,
        runs,
        worst: values.length ? Math.max(...values) : null,
        above40: median(runs.map((r) => r.above40)),
        above100: median(runs.map((r) => r.above100)),
        rows,
      };
    },
  );
  const floor = Math.max(...bars.flatMap((b) => b.runs.map((r) => r.floor)));
  if (
    bars.some((b) =>
      !Number.isFinite(b.worst) || (b.oneRefresh && b.worst > floor + ONE_REFRESH_TOLERANCE_MS)
    )
  ) {
    throw new Error('takeaway-unsupported:sync');
  }
  return {
    floor,
    bars: bars.map(({ rows: _, ...b }) => ({ ...b, shown: driftShown(b.worst, floor) })),
    runs: ledgerOrder(inputs, bars.flatMap((b) => b.runs)),
    regimes: bars.flatMap((b) => b.rows.map((r) => ({ label: b.label, regime: r.regime }))),
  };
}
export const takeaway = (d) => {
  return `99% of the time, viewers' screens were within ${
    Math.round(Math.max(...d.bars.filter((b) => b.oneRefresh).map((b) => b.worst)))
  } ms of each other, about one screen refresh, ${
    d.bars.filter((b) => b.oneRefresh).map((b) => `with ${b.label}`).join(', ').replace(/, ([^,]*)$/, ' and $1')
  }; with ${d.bars.find((b) => !b.oneRefresh).label} than the rest, within ` +
    `${Math.round(d.bars.find((b) => !b.oneRefresh).worst)} ms.`;
};
export function svg(d) {
  const L = 230,
    R = 640,
    T = 50,
    rowH = 56,
    bottom = T + rowH * d.bars.length,
    top = Math.max(50, ...d.bars.map((b) => b.shown)),
    x = linearScale([0, top], [L, R]);
  let body = gridX(x, Array.from({ length: 6 }, (_, i) => top * i / 5), T - 10, bottom);
  d.bars.forEach((b, i) => {
    const y = T + i * rowH + 8, label = driftLabel(b.worst, d.floor);
    body += hbar({ x0: L, x1: x(b.shown), y, h: 24, fill: C.blue, title: `${b.label}: ${label}` });
    body += text(L - 12, y + 17, b.label, { anchor: 'end', fill: C.ink });
    body += text(x(b.shown) + 8, y + 17, label, { size: 14, fill: C.ink, weight: 600 });
  });
  body += refLine({
    x1: x(d.floor),
    x2: x(d.floor),
    y1: T - 22,
    y2: bottom,
    label: `about one screen refresh (${d.floor.toFixed(1)} ms)`,
    labelX: x(d.floor) + 6,
    labelY: T - 26,
    anchor: 'start',
  });
  body += text(L, bottom + 44, 'milliseconds apart, 99% of the time (worst test run)', {
    size: 14,
    fill: C.muted,
  });
  return document({ width: 680, height: bottom + 60, title: TITLE, body });
}
export function notes(d) {
  const rows = named(d.runs).map((r) =>
    `| ${r.name} | ${driftLabel(r.median, r.floor)} | ${driftLabel(r.value, r.floor)} | ${
      driftLabel(r.lower, r.floor)
    }–${driftLabel(r.upper, r.floor)} | ${r.uplink == null ? 'unrecorded' : pct(r.uplink)} | ${
      r.coverage == null ? 'unrecorded' : pct(r.coverage)
    } | ${r.stalls ?? 'unrecorded'} | ${r.status} |`
  );
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    "**What the chart shows.** How far apart two viewers' pictures were, " +
    'at the moment 99 of every 100 frames were closer.\n\n' +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')}\n\n` +
    '**Every test.**\n\n' +
    '| Test | Typical gap | 99% gap | Uncertainty | Connection use | Frames recorded | Freezes | Status |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- |\n' +
    `${rows.join('\n')}\n\n` +
    `${
      d.bars.map((b) =>
        `${b.label}: ${b.above40?.toFixed(1) ?? 'unrecorded'} seconds above 40 ms and ${
          b.above100?.toFixed(1) ?? 'unrecorded'
        } seconds above 100 ms per hour of playing.`
      ).join(' ')
    } ` +
    "The times are reconstructed from the test computer's clock, not filmed on a screen, " +
    'and a gap smaller than one screen refresh cannot be told apart from zero.';
}
