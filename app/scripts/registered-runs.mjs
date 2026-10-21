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
export function recomputeRegisteredRun(entry, options) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const finalization = finalizationOf(runDir);
  const registered = { ...entry, directory, condition: entry.condition ?? manifest.condition?.name,
    manifest, finalization };
  try {
    return { ...registered, report: recomputeRunDirectory(runDir, options) };
  } catch (error) {
    if (finalization?.writeByte === true) throw error;
    return { ...registered, recomputeError: error.message };
  }
}

// A change's run-set reading: read every registered run, refuse a matching run
// directory the registry does not list, and write the reading once.
export function writeRunSetReading({ registry, output, runDirectory, readRun, read, summary = () => '' }) {
  const registryPath = appPath(argument('registry', process.argv) ?? registry);
  const outputPath = appPath(argument('out', process.argv) ?? output);
  const entries = registryEntries(registryPath);
  const registered = new Set(entries.map((entry) => entry.directory));
  const unregisteredDirectories = fs.readdirSync(RESULTS_DIR).filter((name) => runDirectory.test(name) && !registered.has(name));
  const reading = read({ runs: entries.map(readRun), unregisteredDirectories,
    generatedFrom: path.relative(APP_DIR, registryPath).split(path.sep).join('/') });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(reading, null, 2)}\n`);
  console.log(`${reading.status}${reading.reason ? `: ${reading.reason}` : summary(reading)} → ${outputPath}`);
  if (reading.status !== 'read') process.exitCode = 1;
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
