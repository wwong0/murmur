import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRunDirectory } from './harness-figures.mjs';
import { recomputeStarvedReport } from './figures/starved-recompute.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const DEFAULT_RUNS = [
  '7c-regimes-starved-2026-09-26T11-02-48.140Z',
  '7c-regimes-starved-2026-09-26T11-11-24.494Z',
];

function values(name, argv) {
  const prefix = `--${name}=`;
  return argv.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}

function appPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(APP_DIR, value);
}

export function buildStarvedReport({ runDirectories = DEFAULT_RUNS } = {}) {
  const runs = runDirectories.map((directory) => {
    const resolved = path.isAbsolute(directory) ? directory : path.join(RESULTS_DIR, directory);
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
