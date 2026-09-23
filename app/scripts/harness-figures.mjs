// Offline retained-directory entry point for the section-6 figures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFigures, guardRegimes } from './figures/harness-figures.mjs';
import { pairwiseDrift } from './figures/pairwise-drift.mjs';
import { driftContext, driftFigure } from './figures/drift-context.mjs';
import { startResiduals, stepFits, maxRateEvidence, maxRateCompletion } from './figures/start-requalification.mjs';
import { bytesByClientCsv, publish, utilisationCsv } from './figures/publication.mjs';
import { driftSeriesCsv, driftSvg } from './figures/drift-plot.mjs';

function readJson(filePath, fallback = undefined) {
  if (!filePath) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readNdjson(filePath) {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function firstFile(runDir, names) {
  const name = names.find((candidate) => fs.existsSync(path.join(runDir, candidate)));
  return name ? path.join(runDir, name) : undefined;
}

function counterFrom(value) {
  return value === undefined || value === null ? undefined : (value.counters ?? value);
}

function clientStreams(runDir, manifest) {
  const files = fs.readdirSync(runDir);
  const tags = manifest.declaredClientTags ?? manifest.clientTags ?? manifest.condition?.clientTags
    ?? files.map((name) => name.match(/^client-(.+)\.(?:drift|poll|requests|echo)\.ndjson$/)?.[1]).filter(Boolean);
  return Object.fromEntries([...new Set(tags)].map((tag) => {
    const safe = tag;
    const recordsFile = path.join(runDir, `client-${safe}.drift.ndjson`);
    const pollFile = path.join(runDir, `client-${safe}.poll.ndjson`);
    const requestFile = path.join(runDir, `client-${safe}.requests.ndjson`);
    const echoFile = path.join(runDir, `client-${safe}.echo.ndjson`);
    const declaration = manifest.clients?.[tag] ?? {};
    return [tag, {
      ...declaration,
      starts: declaration.boundaries?.end?.playback?.starts ?? [],
      records: readNdjson(recordsFile),
      polls: readNdjson(pollFile),
      requests: readNdjson(requestFile),
      echoRecords: readNdjson(echoFile),
    }];
  }));
}

export function readRunDirectory(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'), {});
  const originStart = counterFrom(readJson(path.join(runDir, 'origin-counters-start.json')));
  const originEnd = counterFrom(readJson(path.join(runDir, 'origin-counters-end.json')));
  const window = manifest.window ?? manifest.measureWindow;
  const context = manifest.context ?? manifest;
  const tags = manifest.declaredClientTags ?? manifest.clientTags ?? manifest.condition?.clientTags
    ?? Object.keys(manifest.clients ?? {});
  const input = {
    byteAccountingMethod: manifest.byteAccountingMethod,
    window,
    originStart,
    originEnd,
    clients: clientStreams(runDir, manifest),
    declaredClientTags: manifest.declaredClientTags ?? manifest.clientTags,
    content: manifest.content,
    condition: manifest.condition,
    disturbance: manifest.disturbance ?? null,
    context,
    capacityBitsPerSecond: manifest.condition?.capacityBitsPerSecond ?? (manifest.condition?.capacityMbps * 1_000_000),
    linkSamples: readNdjson(path.join(runDir, 'origin-link.ndjson')),
    clockJoin: Object.fromEntries([...new Set(tags)].map((tag) => [tag,
      readJson(path.join(runDir, `client-${tag}.clock-join.json`))])),
  };
  return { manifest, input, storedFigures: readJson(firstFile(runDir, ['published-figures.json', 'figures.json']), undefined) };
}

export function recomputeRunDirectory(runDir) {
  const retained = readRunDirectory(runDir);
  const figures = computeFigures(retained.input);
  const context = { ...retained.input.context, ...retained.manifest, ...figures };
  const publishedByte = publish('byte', figures, context);
  const csv = publishedByte.published === false ? null : {
    bytesByClient: bytesByClientCsv(publishedByte),
    utilisation: utilisationCsv(publishedByte),
  };
  const report = {
    figures, publishedByte, csv,
    accountingMethod: figures.byteAccountingMethod ?? 'legacy-origin-close-vs-client-receipt',
    regime: guardRegimes([{ ...retained.input, name: retained.manifest.condition?.name }]),
  };
  const figureKinds = retained.manifest.condition?.figureKinds;
  if (Array.isArray(figureKinds) && figureKinds.includes('drift')) {
    const contextFields = driftContext({
      clients: retained.input.clients,
      tags: retained.input.declaredClientTags,
      window: retained.input.window,
      manifest: retained.manifest,
      clockJoin: retained.input.clockJoin,
    });
    const pairwise = pairwiseDrift({
      clients: retained.input.clients,
      tags: retained.input.declaredClientTags,
      window: retained.input.window,
      frameRate: retained.input.content?.frameRate,
      presentIntervalMsByClient: contextFields.presentIntervalMsByClient,
      targets: retained.input.condition?.criterion,
    });
    const drift = driftFigure({
      figures,
      pairwise,
      context: { ...context, ...contextFields },
      condition: retained.input.condition,
      window: retained.input.window,
      content: retained.input.content,
    });
    const publishedDrift = publish('drift', drift, { ...context, ...contextFields });
    report.publishedDrift = publishedDrift;
    if (publishedDrift.published !== false) {
      report.driftCsv = driftSeriesCsv(publishedDrift);
      report.driftSvg = driftSvg(publishedDrift);
    }
  }
  if (Array.isArray(figureKinds)) {
    const clients = retained.input.clients;
    const tags = retained.input.declaredClientTags;
    const starts = startResiduals({ clients, tags, content: retained.input.content });
    const fits = stepFits({ clients, tags, content: retained.input.content });
    const requalification = { startResiduals: starts, stepFits: fits };
    const disturbance = retained.input.disturbance;
    if (disturbance?.results && typeof disturbance.results === 'object') {
      const evidence = Object.fromEntries(Object.entries(disturbance.results).map(([tag, result]) => [tag,
        maxRateEvidence({
          records: clients[tag]?.records,
          polls: clients[tag]?.polls,
          disturbance: { ...result, observationMs: disturbance.observationMs },
          driftLogMissed: clients[tag]?.driftLogMissed,
          bars: retained.input.condition?.bars,
        })
      ]));
      requalification.maxRateEvidence = evidence;
      requalification.maxRateCompletion = maxRateCompletion(evidence);
    }
    report.requalification = requalification;
  }
  return report;
}

function main() {
  const argument = process.argv.find((value) => value.startsWith('--run-dir='));
  if (!argument) throw new Error('usage: node scripts/harness-figures.mjs --run-dir=<dir>');
  const report = recomputeRunDirectory(path.resolve(argument.slice('--run-dir='.length)));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
