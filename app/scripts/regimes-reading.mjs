// Recompute the registered 7c runs and publish the D6 reading.

import fs from 'node:fs';
import path from 'node:path';

import { recomputeRunDirectory } from './harness-figures.mjs';
import {
  appPath, argument, CONDITIONS_PATH, finalizationOf, isMain, readJson, registeredDirectory,
  registryEntries, RESULTS_DIR, runMain, runPath,
} from './registered-runs.mjs';
import { classifyRegimesReading, computeViewerUploadRates, median } from './figures/regimes-reading.mjs';

// A run the harness aborted has no figures to recompute; it is listed, not classified.
function recomputeRegisteredRun(entry) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const finalization = finalizationOf(runDir);
  let report;
  try {
    report = recomputeRunDirectory(runDir);
  } catch (error) {
    if (entry.outcome !== 'aborted') throw error;
    return { ...entry, directory, manifest, finalization, recomputeError: error.message };
  }
  const uploadRates = entry.condition?.startsWith('regimes-')
    ? computeViewerUploadRates({
      manifest,
      boundaryStart: readJson(path.join(runDir, 'peer-boundary-start.json')),
      boundaryEnd: readJson(path.join(runDir, 'peer-boundary-end.json')),
    })
    : null;
  return { ...entry, directory, manifest, report, finalization, ...(uploadRates ? { uploadRates } : {}) };
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
  const selected = entries.find((entry) => entry.condition === 'regimes-default-shaped' && accepted(entry)
    && entry.finalization?.writeByte === true);
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

if (isMain(import.meta.url)) runMain(main);
