import { WEAKER, WEAKER_NOTES_ONLY, WITH_SHARING_10 } from './sources.mjs';
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
import { refLine } from './svg.mjs';
import { reasonText } from './plain.mjs';
export const ID = 'weaker', KIND = 'supporting', TITLE = 'Does sharing still work on weaker connections?';
export function data(inputs) {
  const mainRows = select(inputs, WITH_SHARING_10),
    main = mainRows[0].regime,
    reference = median(mainRows.map((r) => r.entry.figures?.peerFractionAggregate));
  const bars = WEAKER.map((condition) => {
    const rows = select(inputs, condition), r = rows[0].regime;
    let label;
    if (r.hostCapMbps < main.hostCapMbps && r.viewerCaps === main.viewerCaps) {
      label = `sharer uploads at ${r.hostCapMbps} Mbit/s`;
    } else {
      const caps = [...r.viewerCaps.matchAll(/(?:^|, )c\d+ ([\d.]+) Mbit\/s/g)].map((m) => Number(m[1]));
      const mainCap = Number(/every viewer ([\d.]+)/.exec(main.viewerCaps)?.[1]);
      const lower = caps.filter((cap) => cap < mainCap);
      if (r.hostCapMbps !== main.hostCapMbps || lower.length !== 1 || caps.some((cap) => cap > mainCap)) {
        throw new Error('unknown-weaker-regime');
      }
      label = `one viewer uploads at ${lower[0]} Mbit/s`;
    }
    const runs = rows.map((row) => ({
      ...run(row, row.entry.figures?.peerFractionAggregate, label),
      upload: row.entry.figures?.hostUploadMultiplier ?? null,
      uploadReason: reasonText(
        { ...row.entry, status: row.ledger.outcome },
        row.entry.figures?.hostUploadMultiplier ?? null,
      ),
    }));
    return { label, value: median(runs.map((v) => v.value)), runs, rows };
  });
  if (
    bars.some((b) => !Number.isFinite(b.value) || b.runs.some((r) => r.stalls !== 0)) ||
    !Number.isFinite(reference)
  ) {
    throw new Error('takeaway-unsupported:weaker');
  }
  const extra = select(inputs, WEAKER_NOTES_ONLY).map((row) => ({
    ...run(row, row.entry.figures?.peerFractionAggregate, 'every viewer'),
    upload: row.entry.figures?.hostUploadMultiplier ?? null,
    uploadReason: reasonText(
      { ...row.entry, status: row.ledger.outcome },
      row.entry.figures?.hostUploadMultiplier ?? null,
    ),
  }));
  return {
    bars: bars.map(({ rows: _, ...b }) => b),
    reference,
    referenceRuns: mainRows.map((r) => run(r, r.entry.figures?.peerFractionAggregate, 'main setup')),
    runs: ledgerOrder(inputs, bars.flatMap((b) => b.runs)),
    extra,
    regimes: [
      ...bars.flatMap((b) => b.rows.map((r) => ({ label: b.label, regime: r.regime }))),
      ...mainRows.map((r) => ({ label: 'main setup', regime: r.regime })),
    ],
  };
}
export const takeaway = (d) => {
  return `When the ${d.bars[0].label}, viewers still got ${
    pct(d.bars[0].value)
  } of the video from each other, and when ${d.bars[1].label}, ${
    pct(d.bars[1].value)
  }; nobody froze in these tests.`;
};
export function svg(d) {
  const L = 260, R = 660, T = 50, bottom = T + 56 * d.bars.length, x = linearScale([0, 1], [L, R]);
  let body = gridX(x, [0, 0.25, 0.5, 0.75, 1], T - 10, bottom, pct);
  d.bars.forEach((b, i) => {
    const y = T + i * 56 + 8;
    body += hbar({
      x0: L,
      x1: x(b.value),
      y,
      h: 24,
      fill: C.blue,
      title: `${b.label}: ${b.value * 100}% from other viewers`,
    });
    body += text(L - 12, y + 17, b.label, { anchor: 'end', fill: C.ink });
    body += text(x(b.value) + 8, y + 17, pct(b.value), { size: 14, fill: C.ink, weight: 600 });
  });
  body += refLine({
    x1: x(d.reference),
    x2: x(d.reference),
    y1: T - 22,
    y2: bottom,
    label: `main setup, another day (${pct(d.reference)})`,
    labelX: x(d.reference) - 6,
    labelY: T - 26,
    dashed: true,
  });
  body += text(L, bottom + 44, 'share of the video viewers got from each other', { size: 14, fill: C.muted });
  return document({ width: 700, height: bottom + 60, title: TITLE, body });
}
export const notes = (d) => {
  return `**In one sentence.** ${
    takeaway(d)
  }\n\n**What the chart shows.** The middle share of video passed between viewers.\n\n**How it was tested.** ${
    setupLines(d.regimes).join(' ')
  }\n\n**Every test.**\n\n| Test | Share | Sharer upload | Freezes | Status |\n| --- | --- | --- | --- | --- |\n${
    named([...d.runs, ...d.extra], (r) =>
      r.label === 'every viewer' ? r.regime.viewerCaps.replace('every viewer', 'every viewer uploads at') : r.label
    ).map((r) =>
      `| ${r.name} | ${r.value == null ? 'no value' : pct(r.value)} | ${
        r.upload == null ? r.uploadReason : pct(r.upload)
      } | ${r.stalls ?? 'unrecorded'} | ${r.status} |`
    ).join('\n')
  }\n\n${
    d.bars.map((b) =>
      `${b.label}: the two shares differ by ${
        (Math.abs(b.runs[0].value - b.runs[1].value) * 100).toFixed(1)
      } percentage points.`
    ).join(' ')
  }`;
};
