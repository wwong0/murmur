// Recompute the registered 7c runs and publish the D6 reading.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recomputeRunDirectory } from './harness-figures.mjs';
import { classifyRegimesReading, computeViewerUploadRates, median } from './figures/regimes-reading.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');

function argument(name, argv) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function appPath(value, fallbackDir = APP_DIR) {
  return path.isAbsolute(value) ? value : path.resolve(fallbackDir, value);
}

function runPath(directory) {
  return path.isAbsolute(directory) ? directory : path.join(RESULTS_DIR, directory);
}

function registryEntries(filePath) {
  const register = readJson(filePath);
  if (!Array.isArray(register.runs)) throw new Error(`${filePath}: runs is not an array`);
  return register.runs;
}

// A run the harness aborted has no figures to recompute; it is listed, not classified.
function recomputeRegisteredRun(entry) {
  const directory = entry.directory;
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('registered run has no directory');
  const runDir = runPath(directory);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  let report;
  try {
    report = recomputeRunDirectory(runDir);
  } catch (error) {
    if (entry.outcome !== 'aborted') throw error;
    return { ...entry, directory, manifest, recomputeError: error.message };
  }
  const uploadRates = entry.condition?.startsWith('regimes-')
    ? computeViewerUploadRates({
      manifest,
      boundaryStart: readJson(path.join(runDir, 'peer-boundary-start.json')),
      boundaryEnd: readJson(path.join(runDir, 'peer-boundary-end.json')),
    })
    : null;
  return { ...entry, directory, manifest, report, ...(uploadRates ? { uploadRates } : {}) };
}

function ratioOf(report, directory) {
  const media = report.figures?.mediaBytesDeliveredInWindow;
  const oneViewing = report.figures?.oneViewingBytesInWindow;
  if (!Number.isFinite(media) || !Number.isFinite(oneViewing) || oneViewing <= 0) {
    throw new Error(`${directory}: one-viewing diagnostic is unavailable`);
  }
  return media / oneViewing;
}

function accepted(entry) {
  return entry.outcome === 'complete' && entry.publishes === true;
}

function qCReport(entries) {
  const selected = entries.find((entry) => entry.condition === 'regimes-default-shaped' && accepted(entry));
  if (!selected) return { diagnostic: true, condition: 'regimes-default-shaped', status: 'unavailable' };
  const figures = selected.report.figures;
  return {
    diagnostic: true,
    condition: 'regimes-default-shaped',
    status: 'available',
    peerFractionAggregate: figures.peerFractionAggregate ?? null,
    steady: figures.steadyState?.steady ?? false,
    steadyLabel: figures.steadyState?.steady === true ? 'steady' : 'not steady',
    mediaBytesPerOneViewing: ratioOf(selected.report, selected.directory),
    label: 'diagnostic, not a multiplier',
    directory: selected.directory,
  };
}

function qCComparison() {
  const registerPath = path.join(RESULTS_DIR, 'RUNS-7b2.json');
  const entries = registryEntries(registerPath)
    .filter((entry) => entry.condition === 'p2p-naive' && accepted(entry))
    .map(recomputeRegisteredRun);
  const values = entries.map((entry) => ({ directory: entry.directory, mediaBytesPerOneViewing: ratioOf(entry.report, entry.directory) }));
  if (values.length !== 6) throw new Error(`expected six accepted 7b2 naive runs, got ${values.length}`);
  return { figure: 'mediaBytesDeliveredInWindow / oneViewingBytesInWindow', median: median(values.map((entry) => entry.mediaBytesPerOneViewing)), values };
}

export function buildReadingReport({ registerPath, qaPath }) {
  const conditions = readJson(CONDITIONS_PATH);
  const read = conditions['regimes-limited-shaped']?.reading;
  const entries = registryEntries(registerPath)
    .filter((entry) => entry.condition?.startsWith('regimes-') || entry.condition === read?.control?.condition)
    .map(recomputeRegisteredRun);
  const classification = classifyRegimesReading({
    runs: entries,
    reading: read,
  });
  const qa = readJson(qaPath);
  const qC = qCReport(entries);
  const comparison = qCComparison();
  return {
    ...classification,
    qC: { ...qC, sevenB2AcceptedNaive: comparison },
    qA: { outcome: qa.outcome ?? null },
  };
}

export function main(argv = process.argv.slice(2)) {
  const register = argument('register', argv);
  const qa = argument('qa', argv);
  const output = argument('out', argv);
  if (!register || !qa || !output) {
    throw new Error('usage: node scripts/regimes-reading.mjs --register=<file> --qa=<file> --out=<file>');
  }
  const outputPath = appPath(output);
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const report = buildReadingReport({ registerPath: appPath(register), qaPath: appPath(qa) });
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
