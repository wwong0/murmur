// What every reading script does before it reads: resolve paths against app/, load a
// run registry, and recompute a registered run from its retained directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recomputeRunDirectory } from './harness-figures.mjs';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = path.join(APP_DIR, 'results');
export const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');

export function argument(name, argv) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function appPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(APP_DIR, value);
}

export function runPath(directory) {
  return path.isAbsolute(directory) ? directory : path.join(RESULTS_DIR, directory);
}

export function registryEntries(filePath) {
  const register = readJson(filePath);
  if (!Array.isArray(register.runs)) throw new Error(`${filePath}: runs is not an array`);
  return register.runs;
}

export function registeredDirectory(entry) {
  if (typeof entry?.directory !== 'string' || entry.directory.length === 0) {
    throw new Error('registered run has no directory');
  }
  return entry.directory;
}

export function finalizationOf(runDir) {
  const refusalReport = path.join(runDir, 'refusal-report.json');
  return fs.existsSync(refusalReport) ? readJson(refusalReport).finalization ?? null : null;
}

// A run whose byte figure the harness refused may have nothing to recompute; it is
// listed with the error. One the harness finalised must recompute.
export function recomputeRegisteredRun(entry) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const finalization = finalizationOf(runDir);
  const registered = { ...entry, directory, condition: entry.condition ?? manifest.condition?.name,
    manifest, finalization };
  try {
    return { ...registered, report: recomputeRunDirectory(runDir) };
  } catch (error) {
    if (finalization?.writeByte === true) throw error;
    return { ...registered, recomputeError: error.message };
  }
}

export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(moduleUrl));
}

export function runMain(main) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
