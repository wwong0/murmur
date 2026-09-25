import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recomputeRunDirectory } from './harness-figures.mjs';
import { naiveMeasurement } from './figures/p2p-measurement.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = '7b2-naive-measurement.json';

function valueFor(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length) ?? null;
}

function runInput(directory) {
  const runDir = path.resolve(APP_DIR, 'results', directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  return { report: recomputeRunDirectory(runDir), manifest };
}

export function main(argv = process.argv.slice(2)) {
  // A later measurement is written beside the one it supersedes, never over it.
  const output = path.join(APP_DIR, 'results', path.basename(valueFor('out', argv) ?? DEFAULT_OUTPUT));
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
  const controlName = valueFor('control', argv);
  const naiveNames = valueFor('naive', argv)?.split(',').filter(Boolean) ?? [];
  if (!controlName || naiveNames.length !== 3) {
    throw new Error('usage: node scripts/p2p-measurement.mjs --control=<dir> --naive=<d1>,<d2>,<d3> [--out=<file>]');
  }
  const measurement = naiveMeasurement({
    control: runInput(controlName),
    naive: naiveNames.map(runInput),
  });
  fs.writeFileSync(output, `${JSON.stringify(measurement, null, 2)}\n`);
  if (!measurement.published) process.exitCode = 1;
  return measurement;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
