import fs from 'node:fs';

import { classifyTrapReading } from './figures/trap-reading.mjs';
import {
  appPath, argument, CONDITIONS_PATH, isMain, readJson, recomputeRegisteredRun, registryEntries, runMain,
} from './registered-runs.mjs';

const STARVED_RECOMPUTE_OUTPUT = 'results/8a-starved-recompute.json';

function readingFromConditions(entries, conditions) {
  const trapEntries = entries.filter((entry) => conditions[entry.condition]?.reading?.kind === 'trap');
  const blocks = trapEntries.map((entry) => conditions[entry.condition].reading);
  if (!blocks.length) throw new Error('trap-reading-block-unavailable');
  const encoded = JSON.stringify(blocks[0]);
  if (blocks.some((block) => JSON.stringify(block) !== encoded)) {
    throw new Error('trap-reading-thresholds-disagree');
  }
  return blocks[0];
}

export function buildTrapReadingReport({ registerPath, conditionsPath = CONDITIONS_PATH,
  diagnosticPath = STARVED_RECOMPUTE_OUTPUT } = {}) {
  const registered = registryEntries(registerPath);
  const conditions = readJson(conditionsPath);
  const reading = readingFromConditions(registered, conditions);
  // Only the trap arms and their control are read; the registry lists every run of the
  // change, and a goodput directory has no manifest to recompute.
  const runs = registered.filter((entry) => conditions[entry.condition]?.reading?.kind === 'trap'
    || entry.condition === reading.control.condition).map(recomputeRegisteredRun);
  const report = classifyTrapReading({ runs, reading });
  return {
    ...report,
    d8: { outputPath: diagnosticPath, label: 'diagnostic-of-refused-runs' },
  };
}

export function main(argv = process.argv.slice(2)) {
  const register = argument('register', argv);
  const output = argument('out', argv);
  if (!register || !output) {
    throw new Error('usage: node scripts/trap-reading.mjs --register=<file> --out=<file>');
  }
  const outputPath = appPath(output);
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const report = buildTrapReadingReport({ registerPath: appPath(register) });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMain(import.meta.url)) runMain(main);
