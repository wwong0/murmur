import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recomputeRunDirectory } from './harness-figures.mjs';
import { classifyTrapReading } from './figures/trap-reading.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');
const D8_OUTPUT = 'results/8a-starved-recompute.json';

function argument(name, argv) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function appPath(value, fallback = APP_DIR) {
  return path.isAbsolute(value) ? value : path.resolve(fallback, value);
}

function runPath(directory) {
  return path.isAbsolute(directory) ? directory : path.join(RESULTS_DIR, directory);
}

function registryEntries(filePath) {
  const register = readJson(filePath);
  if (!Array.isArray(register.runs)) throw new Error(`${filePath}: runs is not an array`);
  return register.runs;
}

function recomputeRegisteredRun(entry) {
  if (typeof entry?.directory !== 'string' || entry.directory.length === 0) {
    throw new Error('registered run has no directory');
  }
  const directory = entry.directory;
  const runDir = runPath(directory);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const refusal = fs.existsSync(path.join(runDir, 'refusal-report.json'))
    ? readJson(path.join(runDir, 'refusal-report.json')) : null;
  const finalization = refusal?.finalization ?? null;
  const registered = { ...entry, directory, condition: entry.condition ?? manifest.condition?.name,
    manifest, finalization };
  try {
    return { ...registered, report: recomputeRunDirectory(runDir) };
  } catch (error) {
    if (finalization?.writeByte === true) throw error;
    return { ...registered, recomputeError: error.message };
  }
}

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
  diagnosticPath = D8_OUTPUT } = {}) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
