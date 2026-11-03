import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs, outputArgs } from './measure-graphs.mjs';
import * as sharing from './graphs/fig-sharing.mjs';
import * as roomSize from './graphs/fig-room-size.mjs';
import * as sync from './graphs/fig-sync.mjs';
import { sharingBars, sharingSvg, roomSizeSvg, syncSvg, TITLES } from './graphs/writeup.mjs';

export function buildFigures(inputs, sourcesOf) {
  return [
    { id: 'sharing', data: sharing.data(inputs), render: sharingSvg, bars: sharingBars },
    { id: 'room-size', data: roomSize.data(inputs), render: roomSizeSvg, bars: (data) => data.bars },
    { id: 'sync', data: sync.data(inputs), render: syncSvg, bars: (data) => data.bars },
  ].map((chart) => {
    const bars = chart.bars(chart.data).map((bar) => ({
      label: bar.label ?? `${bar.viewers} viewers`,
      runs: bar.runs.map(({ directory, value }) => ({ directory, value })),
    }));
    return { id: chart.id, title: TITLES[chart.id], bars, sources: sourcesOf(chart.id, bars), svg: chart.render(chart.data) };
  });
}
export async function runCommand(argv = process.argv) {
  const args = outputArgs(argv, 'writeup-figures.mjs');
  if (!args) return 2;
  const { out, root } = args;
  const { inputs, sourcesOf } = await loadInputs(root);
  const charts = buildFigures(inputs, sourcesOf);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out);
  for (const chart of charts) fs.writeFileSync(path.join(out, `fig-${chart.id}.svg`), chart.svg);
  fs.writeFileSync(path.join(out, 'figures.json'), `${JSON.stringify(charts.map(({ svg: _, ...chart }) => chart), null, 2)}\n`);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runCommand(); } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
