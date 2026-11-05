import { RECOVERY } from './sources.mjs';
import {
  C,
  column,
  document,
  gridY,
  ledgerOrder,
  linearScale,
  run,
  select,
  setupLines,
  text,
} from './public-common.mjs';
import { sum } from './common.mjs';
import { swatch } from './svg.mjs';
export const ID = 'recovery',
  KIND = 'engineering',
  TITLE =
    "After the sharer's connection drops, do viewers keep freezing? This app against its own earlier version";
export function data(inputs) {
  const rows = select(inputs, [RECOVERY.current, RECOVERY.earlier]),
    byDirectory = new Map(rows.map((r) => [r.entry.directory, r]));
  const bars = inputs.batches['13e'].verdicts.tests.Q.pairs.map((p) => {
    const current = byDirectory.get(p.product.directory), earlier = byDirectory.get(p.control.directory);
    if ([current, earlier].some((r) => r.run.manifest.window.opensAt !== 'capacity-schedule-rise')) {
      throw new Error('wrong-window:recovery');
    }
    const schedule = current.run.schedule;
    const currentRun = {
      ...run(current, sum(p.product.figures.stallCountByClient), 'current version'),
      perViewer: Object.values(p.product.figures.stallCountByClient),
    };
    const earlierRun = {
      ...run(earlier, sum(p.control.figures.stallCountByClient), 'earlier version'),
      perViewer: Object.values(p.control.figures.stallCountByClient),
    };
    return {
      current: currentRun.value,
      earlier: earlierRun.value,
      currentRun,
      earlierRun,
      runs: [currentRun, earlierRun],
      drop: schedule.drop.readBack.rate.got,
      rise: schedule.rise.readBack.rate.got,
      duration: schedule.rise.appliedAtMs - schedule.drop.appliedAtMs,
    };
  });
  if (bars.some((b) => !(b.current < b.earlier))) {
    throw new Error('takeaway-unsupported:recovery');
  }
  return {
    bars,
    runs: ledgerOrder(inputs, bars.flatMap((b) => [b.currentRun, b.earlierRun])),
    regimes: rows.map((r) => ({
      label: r.entry.condition === RECOVERY.current ? 'current version' : 'earlier version',
      regime: r.regime,
    })),
  };
}
export function takeaway(d) {
  const b = d.bars[0],
    minutes = (r) => Math.round(r.duration / 60000),
    same = d.bars.every((r) => r.drop === b.drop && r.rise === b.rise && minutes(r) === minutes(b));
  return `After the sharer's connection dropped${
    same
      ? ` from ${b.rise / 1e6} to ${b.drop / 1e6} Mbit/s for about ${minutes(b)} minutes and came back`
      : ''
  }, viewers froze ${d.bars.map((r) => r.current).join(', ')} times with this app's current version and ${
    d.bars.map((r) => r.earlier).join(', ')
  } times with its earlier version in side-by-side tests.`;
}
export function svg(d) {
  const L = 70,
    R = 590,
    T = 40,
    B = 340,
    top = Math.max(1, Math.ceil(Math.max(...d.bars.map((b) => b.earlier)) / 20) * 20),
    y = linearScale([0, top], [B, T]);
  let body = gridY(y, Array.from({ length: 6 }, (_, i) => top * i / 5), L, R);
  d.bars.forEach((b, i) => {
    const x = L + (R - L) * (i + 0.5) / d.bars.length;
    for (
      const [offset, value, color, label] of [[-32, b.earlier, C.gray, 'earlier version'], [
        2,
        b.current,
        C.blue,
        'current version',
      ]]
    ) {
      body += column({
        x: x + offset,
        w: 30,
        yTop: Math.min(y(value), B - 2),
        yBase: B,
        fill: color,
        title: `test ${i + 1}, ${label}: ${value} freezes`,
      });
      body += text(x + offset + 15, y(value) - 8, value, { anchor: 'middle', size: 14, fill: C.ink });
    }
    body += text(x, B + 26, `test ${i + 1}`, { anchor: 'middle', fill: C.ink });
  });
  body += swatch(L, 392, C.gray, 'this app, earlier version');
  body += swatch(L + 220, 392, C.blue, 'this app, current version');
  body += text(10, 26, 'freezes after the connection returned', { size: 14, fill: C.muted });
  return document({ width: 620, height: 420, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    '**What the chart shows.** When viewers are about to run out, the current version has one viewer ' +
    'fetch each upcoming piece from the sharer and the others take it from that viewer. ' +
    'The earlier version let every viewer fetch it from the sharer itself. ' +
    'Both ran the same build of this app; only this rule differed.\n\n' +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')} ` +
    'The tests ran side by side the same batch, in alternating order.\n\n' +
    '**Every test.**\n\n| Test | Freezes per viewer | Status |\n| --- | --- | --- |\n' +
    `${
      d.bars.flatMap((b, i) => [
        `| Test ${i + 1}, current version | ${b.currentRun.perViewer.join(', ')} | ${b.currentRun.status} |`,
        `| Test ${i + 1}, earlier version | ${b.earlierRun.perViewer.join(', ')} | ${b.earlierRun.status} |`,
      ]).join('\n')
    }\n\n` +
    `${
      d.bars.map((b, i) =>
        `Test ${i + 1}: the connection dropped from ${b.rise / 1e6} to ${b.drop / 1e6} Mbit/s for ${
          (b.duration / 60000).toFixed(1)
        } minutes.`
      ).join(' ')
    } Freezes during the drop itself are not counted.`;
};
