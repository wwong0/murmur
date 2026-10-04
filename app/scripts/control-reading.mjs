import fs from 'node:fs';
import path from 'node:path';

import {
  baselineTable,
  classifyControlReading,
  classifyControlRun,
} from './figures/control-reading.mjs';
import { accepted } from './figures/regimes-reading.mjs';
import {
  appPath, argument, CONDITIONS_PATH, isMain, readJson, recomputeRegisteredRun, registeredDirectory,
  registryEntries, runMain, runPath,
} from './registered-runs.mjs';

const DEFAULT_OUTPUT = 'results/8b2-control-reading.json';
const GOODPUT_CONDITION = 'shakedown/cap10';

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

// The goodput directory is an arm reading, not a harness run: it has no manifest.
function recomputeControlRun(entry) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  if (!fs.existsSync(runDir)) throw new Error(`registered run directory missing:${directory}`);
  if (entry.condition === GOODPUT_CONDITION) return goodputRun(entry, runDir);
  return recomputeRegisteredRun(entry);
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
  const conditions = readJson(conditionsPath);
  const entries = registryEntries(registerPath).map(recomputeControlRun);
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

if (isMain(import.meta.url)) runMain(main);
