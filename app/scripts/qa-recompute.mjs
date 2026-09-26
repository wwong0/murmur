import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRunDirectory } from './harness-figures.mjs';
import { recomputeQaReport } from './figures/qa-recompute.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const DEFAULT_REGISTRY = 'RUNS-7b2.json';
const DEFAULT_OUTPUT = '7c-qa-recompute.json';

function valueFor(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function acceptedRuns(registryName) {
  const registry = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, registryName), 'utf8'));
  const runs = registry.runs.filter((run) => run.condition === 'p2p-naive'
    && run.publishes === true && run.outcome === 'complete');
  if (runs.length !== 6) throw new Error(`expected six accepted p2p-naive runs, found ${runs.length}`);
  return runs;
}

export function main(argv = process.argv.slice(2)) {
  const output = path.join(RESULTS_DIR, path.basename(valueFor('out', argv) ?? DEFAULT_OUTPUT));
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
  const registryName = path.basename(valueFor('registry', argv) ?? DEFAULT_REGISTRY);
  const runs = acceptedRuns(registryName).map(({ directory }) => ({
    directory,
    input: readRunDirectory(path.join(RESULTS_DIR, directory)).input,
  }));
  const report = recomputeQaReport(runs);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
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
