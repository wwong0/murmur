import fs from 'node:fs';
import path from 'node:path';

import { readRunDirectory } from './harness-figures.mjs';
import { recomputeStarvedReport } from './figures/starved-recompute.mjs';
import { appPath, isMain, runMain, runPath } from './registered-runs.mjs';

const DEFAULT_RUNS = [
  '7c-regimes-starved-2026-09-26T11-02-48.140Z',
  '7c-regimes-starved-2026-09-26T11-11-24.494Z',
];

function values(name, argv) {
  const prefix = `--${name}=`;
  return argv.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}

export function buildStarvedReport({ runDirectories = DEFAULT_RUNS } = {}) {
  const runs = runDirectories.map((directory) => {
    const resolved = runPath(directory);
    const retained = readRunDirectory(resolved);
    return { input: retained.input, directory: path.basename(resolved) };
  });
  return recomputeStarvedReport(runs);
}

export function main(argv = process.argv.slice(2)) {
  const requestedRuns = values('run-dir', argv);
  const output = values('out', argv)[0] ?? 'results/8a-starved-recompute.json';
  const outputPath = appPath(output);
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const report = buildStarvedReport({ runDirectories: requestedRuns.length ? requestedRuns : DEFAULT_RUNS });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMain(import.meta.url)) runMain(main);
