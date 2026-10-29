import { NO_SHARING_10, OFF_THE_SHELF, WITH_SHARING_10 } from './sources.mjs';
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
import { driftLabel, ONE_REFRESH_TOLERANCE_MS } from './rules.mjs';
import { refLine, swatch } from './svg.mjs';
export const ID = 'connection', KIND = 'engineering', TITLE = "How full does the sharer's connection get?";
export function data(inputs) {
  const app = select(inputs, WITH_SHARING_10),
    defaults = select(inputs, OFF_THE_SHELF),
    noShare = select(inputs, NO_SHARING_10),
    rows = [...defaults, ...app];
  same(rows, ['hostCapMbps', 'viewers', 'bitrateMbps'], ID);
  const convert = (r, label) => {
    const lab = r.readings['lab-drift'];
    return {
      ...run(r, r.entry.figures?.uplinkUtilisationMean, label),
      p99: lab?.overall?.absP99Ms ?? null,
      floor: lab?.pairs?.length ? Math.max(...lab.pairs.map((p) => p.floorMs)) : null,
      queue: r.entry.figures?.standingQueueDelayMsP50NearestRank ?? null,
    };
  };
  const appRuns = app.map((r) => convert(r, 'this app')),
    defaultRuns = defaults.map((r) => convert(r, 'off-the-shelf sharing settings'));
  const main = app[0].regime,
    bars = [{
      label: 'no sharing',
      value: main.viewers * Number(main.bitrateMbps) / main.hostCapMbps,
      outline: true,
    }, {
      label: 'off-the-shelf sharing settings',
      value: median(defaultRuns.map((r) => r.value)),
      runs: defaultRuns,
    }, { label: 'this app', value: median(appRuns.map((r) => r.value)), runs: appRuns }];
  if (
    !bars.every((b) => Number.isFinite(b.value)) ||
    !(bars[2].value < bars[1].value && bars[1].value < 1 && bars[0].value >= 1 &&
      [...appRuns, ...defaultRuns].every((r) =>
        r.stalls === 0 && Number.isFinite(r.p99) && r.p99 <= r.floor + ONE_REFRESH_TOLERANCE_MS
      ))
  ) {
    throw new Error('takeaway-unsupported:connection');
  }
  return {
    bars,
    runs: ledgerOrder(inputs, [...defaultRuns, ...appRuns]),
    noShare: noShare.map((r) =>
      run(r, r.entry.figures?.hostUploadMultiplier ?? null, 'no sharing at this speed')
    ),
    queueDifference: median(defaultRuns.map((r) => r.queue)) - median(appRuns.map((r) => r.queue)),
    regimes: rows.map((r) => ({
      label: r.entry.condition === OFF_THE_SHELF ? 'off-the-shelf sharing settings' : 'this app',
      regime: r.regime,
    })),
  };
}
export const takeaway = (d) => {
  return `With ${d.regimes[0].regime.viewers} viewers on a ${
    d.regimes[0].regime.hostCapMbps
  } Mbit/s connection, sending everyone their own copy would need ${
    pct(d.bars[0].value)
  } of it, more than it has; off-the-shelf sharing settings kept it ${
    pct(d.bars[1].value)
  } full, and this app used ${pct(d.bars[2].value)}, with the same smooth, in-step playback.`;
};
export function svg(d) {
  const L = 70, R = 590, T = 40, B = 340, y = linearScale([0, 1.5], [B, T]);
  let body = gridY(y, [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5], L, R, pct);
  body += refLine({ x1: L, x2: R, y1: y(1), y2: y(1), label: 'the connection is full' });
  d.bars.forEach((b, i) => {
    const x = L + (R - L) * (i + 0.5) / d.bars.length, fill = i === 2 ? C.blue : C.gray;
    body += column({
      x: x - 28,
      w: 56,
      yTop: y(b.value),
      yBase: y(0),
      fill,
      outline: b.outline,
      title: `${b.label}: ${pct(b.value)}`,
    });
    body += text(x, y(b.value) - 10, pct(b.value), { anchor: 'middle', size: 18, fill: C.ink, weight: 600 });
    const labels = i === 0
      ? ['no sharing', 'everyone downloads', 'from the sharer']
      : i === 1
      ? ['off-the-shelf', 'sharing settings']
      : ['this app'];
    labels.forEach((s, k) => {
      body += text(x, B + 24 + k * 18, s, { anchor: 'middle', fill: C.ink });
    });
  });
  body += swatch(L, 426, C.gray, 'worked out, not measured', true);
  body += text(10, 26, "share of the sharer's upload connection in use", { size: 14, fill: C.muted });
  return document({ width: 620, height: 450, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    "**What the chart shows.** The sharing library's own default settings, " +
    "with this app's pacing switched off, are called off-the-shelf sharing settings.\n\n" +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')}\n\n` +
    `**Every test.**\n\n${table(d.runs)}\n\n` +
    `${
      d.runs.map((r) => `${r.label}: 99% gap ${driftLabel(r.p99, r.floor)}, build ${r.commit}.`).join(' ')
    } ` +
    "The two sides ran on different days' builds. " +
    'With off-the-shelf settings, anything else the sharer sent waited about ' +
    `${Math.round(d.queueDifference)} ms longer. The no-sharing tests at this speed were not drawn: ` +
    `${d.noShare.map((r) => `${r.status}; ${r.stalls ?? 'unrecorded'} freezes`).join('; ')}. ` +
    "The times are reconstructed from the test computer's clock, not filmed on a screen.";
};
