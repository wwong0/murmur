import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recomputeRunDirectory } from './harness-figures.mjs';
import {
  baselineTable,
  classifyControlReading,
  classifyControlRun,
} from './figures/control-reading.mjs';
import { accepted } from './figures/regimes-reading.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');
const DEFAULT_OUTPUT = 'results/8b2-control-reading.json';
const GOODPUT_CONDITION = 'shakedown/cap10';

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

function conditionByName(conditions, name) {
  if (conditions && conditions[name]) return conditions[name];
  for (const value of Object.values(conditions ?? {})) {
    if (!value || typeof value !== 'object') continue;
    if (value.name === name) return value;
    const nested = conditionByName(value, name);
    if (nested) return nested;
  }
  return null;
}

function conditionEntries(conditions) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string') found.set(value.name, value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(conditions);
  return found;
}

function registryEntries(filePath) {
  const register = readJson(filePath);
  if (!Array.isArray(register.runs)) throw new Error(`${filePath}: runs is not an array`);
  return { register, runs: register.runs };
}

function goodputRun(entry, runDir) {
  const filePath = path.join(runDir, 'arm-cap10.json');
  let measured = null;
  if (fs.existsSync(filePath)) measured = readJson(filePath)?.measured?.goodput?.mbps ?? null;
  const bar = 9.5;
  return {
    ...entry,
    condition: entry.condition ?? GOODPUT_CONDITION,
    goodput: { valueMbps: Number.isFinite(measured) ? measured : null, barMbps: bar,
      pass: Number.isFinite(measured) && measured >= bar, source: 'arm-cap10.json',
      ...(measured === null ? { reason: 'goodput-reading-missing' } : {}) },
  };
}

export function recomputeRegisteredRun(entry) {
  if (typeof entry?.directory !== 'string' || entry.directory.length === 0) {
    throw new Error('registered run has no directory');
  }
  const directory = entry.directory;
  const runDir = runPath(directory);
  if (!fs.existsSync(runDir)) throw new Error(`registered run directory missing:${directory}`);
  const condition = entry.condition ?? null;
  if (condition === GOODPUT_CONDITION) return goodputRun(entry, runDir);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  const refusal = fs.existsSync(path.join(runDir, 'refusal-report.json'))
    ? readJson(path.join(runDir, 'refusal-report.json')) : null;
  const finalization = refusal?.finalization ?? null;
  const registered = { ...entry, directory, condition: condition ?? manifest.condition?.name,
    manifest, finalization };
  try {
    return { ...registered, report: recomputeRunDirectory(runDir) };
  } catch (error) {
    if (finalization?.writeByte === true) throw error;
    return { ...registered, recomputeError: error.message };
  }
}

function outputRun(entry, conditions) {
  const condition = conditionByName(conditions, entry.condition);
  const reading = condition?.reading?.kind === 'control' ? condition.reading : null;
  return {
    directory: entry.directory,
    condition: entry.condition,
    outcome: entry.outcome ?? null,
    publishes: entry.publishes ?? null,
    accepted: accepted(entry),
    ...(entry.goodput ? { goodput: entry.goodput } : {}),
    ...(entry.recomputeError ? { recomputeError: entry.recomputeError } : {}),
    ...(entry.report ? {
      figures: entry.report.figures ?? null,
      publishedByte: entry.report.publishedByte ?? null,
      ...(reading ? { classification: classifyControlRun(entry, reading) } : {}),
    } : {}),
  };
}

function controlArms(entries, conditions) {
  const result = {};
  for (const [name, condition] of conditionEntries(conditions)) {
    if (condition.reading?.kind !== 'control') continue;
    const classified = classifyControlReading({ runs: entries, reading: condition.reading, armNames: [name] });
    result[name] = classified.arms[name];
  }
  return result;
}

export function buildControlReadingReport({ registerPath, conditionsPath = CONDITIONS_PATH } = {}) {
  if (!registerPath) throw new Error('registry path is required');
  const { register, runs: rawEntries } = registryEntries(registerPath);
  const conditions = readJson(conditionsPath);
  const entries = rawEntries.map(recomputeRegisteredRun);
  const runs = entries.map((entry) => outputRun(entry, conditions));
  const arms = controlArms(entries, conditions);
  const controlRuns = Object.fromEntries(['control-five', 'control-ten'].map((condition) => [condition,
    entries.find((entry) => accepted(entry) && entry.condition === condition) ?? null]));
  return {
    change: '8b2',
    registry: registerPath,
    writtenBy: 'scripts/control-reading.mjs',
    runs,
    arms,
    goodput: runs.find((entry) => entry.condition === GOODPUT_CONDITION)?.goodput ?? null,
    baseline: baselineTable({ runs: entries, controlRuns }),
  };
}

export function main(argv = process.argv.slice(2)) {
  const register = argument('registry', argv);
  const output = argument('out', argv) ?? DEFAULT_OUTPUT;
  if (!register) throw new Error('usage: node scripts/control-reading.mjs --registry=<file> [--out=<file>]');
  const outputPath = appPath(output);
  const report = buildControlReadingReport({ registerPath: appPath(register) });
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
