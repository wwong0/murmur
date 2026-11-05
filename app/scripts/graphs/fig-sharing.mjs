import { SHARING } from './sources.mjs';
import {
  C,
  ledgerOrder,
  median,
  pct,
  run,
  same,
  select,
  setupLines,
  table,
  vertical,
} from './public-common.mjs';
export const ID = 'sharing', KIND = 'headline', TITLE = 'Does sharing cut how much the sharer uploads?';
export function data(inputs) {
  const bars = Object.entries(SHARING).map(([key, names]) => {
    const rows = select(inputs, names), label = key === 'with' ? 'with sharing' : 'without sharing';
    const runs = rows.map((row) => run(row, row.entry.figures?.hostUploadMultiplier ?? null, label));
    return { label, runs, value: median(runs.map((r) => r.value)), rows };
  });
  const rows = bars.flatMap((bar) => bar.rows);
  same(rows, ['hostCapMbps', 'viewers'], ID);
  if (!bars.every((b) => Number.isFinite(b.value)) || !(bars[1].value < bars[0].value)) {
    throw new Error('takeaway-unsupported:sharing');
  }
  return {
    bars: bars.map(({ rows: _, ...bar }) => bar),
    runs: ledgerOrder(inputs, bars.flatMap((b) => b.runs)),
    regimes: rows.map((r) => ({ label: bLabel(r), regime: r.regime })),
  };
}
const bLabel = (row) => {
  return SHARING.with.includes(row.entry.condition) ? 'with sharing' : 'without sharing';
};
export const takeaway = (d) => {
  return `With ${
    d.regimes[0].regime.viewers
  } viewers on the same connection, the person sharing the video uploaded ${
    pct(d.bars[0].value)
  } of what one viewer watched when everyone downloaded from them, and ${
    pct(d.bars[1].value)
  } when viewers passed the video on to each other.`;
};
export const svg = (d) => {
  return vertical({
    title: TITLE,
    bars: d.bars.map((b, i) => ({ ...b, fill: i ? C.blue : C.gray })),
    top: 6,
    ticks: [0, 1, 2, 3, 4, 5, 6],
    width: 520,
    height: 400,
    right: 480,
    yBottom: 330,
    axis: "sharer's upload, as % of the video one viewer watched",
  });
};
export function notes(d) {
  const commits = d.bars[0].runs.map((r) => r.commit);
  return `**In one sentence.** ${takeaway(d)}\n\n` +
    '**What the chart shows.** The middle amount uploaded by the sharer, ' +
    'as a percentage of the video one viewer watched.\n\n' +
    `**How it was tested.** ${setupLines(d.regimes).join(' ')}\n\n` +
    `**Every test.**\n\n${table(d.runs)}\n\n` +
    `The tests without sharing came from two test batches; the builds for each test were ${
      commits.join(', ')
    } ` +
    `(${new Set(commits).size === 1 ? 'the same build' : 'different builds'}). ` +
    'The flagged runs were flagged only because a test without sharing has no viewer-to-viewer records ' +
    "to check, which a later batch's rule allowed; the sharer's upload was counted normally. " +
    "The no-sharing tests on a slower connection are in the connection figure's notes.";
}
