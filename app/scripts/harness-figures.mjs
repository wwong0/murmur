// Offline retained-directory entry point for the section-6 figures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFigures, guardRegimes } from './figures/harness-figures.mjs';
import { bytesByClientCsv, publish, utilisationCsv } from './figures/publication.mjs';

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
  const input = {
    window,
    originStart,
    originEnd,
    clients: clientStreams(runDir, manifest),
    declaredClientTags: manifest.declaredClientTags ?? manifest.clientTags,
    content: manifest.content,
    condition: manifest.condition,
    context,
    capacityBitsPerSecond: manifest.condition?.capacityBitsPerSecond ?? (manifest.condition?.capacityMbps * 1_000_000),
    linkSamples: readNdjson(path.join(runDir, 'origin-link.ndjson')),
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
  return { figures, publishedByte, csv, regime: guardRegimes([{ ...retained.input, name: retained.manifest.condition?.name }]) };
}

function main() {
  const argument = process.argv.find((value) => value.startsWith('--run-dir='));
  if (!argument) throw new Error('usage: node scripts/harness-figures.mjs --run-dir=<dir>');
  const report = recomputeRunDirectory(path.resolve(argument.slice('--run-dir='.length)));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
