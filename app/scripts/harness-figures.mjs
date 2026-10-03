// Offline retained-directory entry point for the section-6 figures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFigures, guardRegimes } from './figures/harness-figures.mjs';
import { pairwiseDrift } from './figures/pairwise-drift.mjs';
import { driftContext, driftFigure } from './figures/drift-context.mjs';
import { computeControlFigures, timebaseJoin } from './figures/control-figures.mjs';
import { startResiduals, stepFits, maxRateEvidence, maxRateCompletion } from './figures/start-requalification.mjs';
import { bytesByClientCsv, publish, utilisationCsv } from './figures/publication.mjs';
import { evaluateMachineTest } from './figures/machine-test.mjs';
import { driftSeriesCsv, driftSvg } from './figures/drift-plot.mjs';
import { armFor } from './harness/arms.mjs';
import { parseRate } from '../harness/apply-qdisc.mjs';

function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function readNdjson(filePath) {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function counterFrom(value) {
  return value === undefined || value === null ? undefined : (value.counters ?? value);
}

export function capacityBitsForManifest(manifest = {}) {
  return manifest.condition?.capacityStep
    ? parseRate(manifest.condition.capacityStep.params?.rate)
    : (manifest.condition?.capacityBitsPerSecond ?? (manifest.condition?.capacityMbps * 1_000_000));
}

function clientStreams(runDir, manifest) {
  return armFor(manifest.condition).clientStreams(runDir, manifest, {
    names: fs.readdirSync(runDir),
    readNdjson,
    join: path.join,
  });
}

export function readRunDirectory(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'), {});
  const arm = armFor(manifest.condition);
  const originStart = counterFrom(readJson(path.join(runDir, 'origin-counters-start.json')));
  const originEnd = counterFrom(readJson(path.join(runDir, 'origin-counters-end.json')));
  const originSettled = counterFrom(readJson(path.join(runDir, 'origin-counters-settled.json')));
  const window = manifest.window;
  const context = manifest.context ?? manifest;
  const tags = manifest.declaredClientTags ?? manifest.clientTags ?? manifest.condition?.clientTags
    ?? Object.keys(manifest.clients ?? {});
  const hostPoll = readNdjson(path.join(runDir, 'host-control-poll.ndjson')) ?? [];
  const hostPaceRecords = readNdjson(path.join(runDir, 'host-pace.ndjson')) ?? [];
  const resumes = readNdjson(path.join(runDir, 'host-resumes.ndjson')) ?? [];
  const hostPaceFinal = readJson(path.join(runDir, 'host-pace-final.json'));
  const viewerPolls = Object.fromEntries([...new Set(tags)].map((tag) => [tag,
    readNdjson(path.join(runDir, `viewer-control-${tag}.ndjson`)) ?? []]));
  const controlAvailable = hostPoll.length > 0;
  const timebase = controlAvailable ? timebaseJoin(hostPoll) : null;
  const capacityBeforeReadings = (manifest.topology?.qdiscs ?? [])
    .find((entry) => entry.containerRole === 'origin')?.readBack?.readings ?? null;
  const input = {
    byteAccountingMethod: arm.recomputeAccountingMethod(manifest),
    window,
    originStart,
    originEnd,
    originSettled,
    clients: clientStreams(runDir, manifest),
    declaredClientTags: manifest.declaredClientTags ?? manifest.clientTags,
    content: arm.recomputeContent(manifest),
    segmentSeconds: arm.recomputeSegmentSeconds(manifest),
    multiplierDenominator: manifest.multiplierDenominator ?? 'distinct-completed',
    seek: manifest.seek ?? null,
    capacityStep: manifest.capacityStep ?? null,
    condition: manifest.condition,
    disturbance: manifest.disturbance ?? null,
    context,
    capacityBitsPerSecond: capacityBitsForManifest(manifest),
    capacityBeforeReadings,
    linkSamples: readNdjson(path.join(runDir, 'origin-link.ndjson')),
    cpuSamples: readNdjson(path.join(runDir, 'cpu-samples.ndjson')),
    cpuSampleFile: 'cpu-samples.ndjson',
    clockJoin: Object.fromEntries([...new Set(tags)].map((tag) => [tag,
      readJson(path.join(runDir, `client-${tag}.clock-join.json`))])),
    hostPoll,
    viewerPolls,
    hostPace: hostPaceFinal ? { ...hostPaceFinal, intervals: hostPaceRecords,
      evicted: hostPaceFinal.evicted ?? 0 } : null,
    hostPaceFinal,
    resumes: { records: resumes, evicted: hostPaceFinal?.resumeEvicted ?? 0 },
    timebase,
    wallOffsetMs: timebase?.wallOffsetMs ?? null,
    // The steady test's pace leg applies on the host's published fraction.
    headroom: readJson(path.join(runDir, 'host-headroom.json'), null),
    controlAvailable,
    // Peer checks and host waste exclude the qualification's response by its ids.
    ...arm.recomputeInputExtras(manifest),
  };
  return { manifest, input };
}

export function recomputeRunDirectory(runDir, options = {}) {
  const retained = readRunDirectory(runDir);
  const arm = armFor(retained.input.condition);
  let figures = computeFigures(retained.input);
  if (arm.byteAccountingMethod === 'peer-attempt-cohort-v1') {
    const control = retained.input.controlAvailable
      ? computeControlFigures({ ...retained.input, figures }, { manifest: retained.manifest }) : null;
    figures = { ...figures, control };
  }
  if (retained.input.condition?.machineTest) {
    const refusalReport = options.refusalReport
      ?? readJson(path.join(runDir, 'refusal-report.json'))?.refusal
      ?? null;
    const attemptHistory = options.attemptHistory ?? retained.manifest.attemptHistory ?? [];
    const machineTest = evaluateMachineTest({
      recompute: {
        figures,
        clients: retained.input.clients,
        condition: retained.input.condition,
        window: retained.input.window,
        cpuSamples: retained.input.cpuSamples,
        cpuSampleFile: retained.input.cpuSampleFile,
      },
      refusalReport,
      attemptHistory,
    });
    figures = { ...figures, diagnostic: 'ten-peer-machine-test', machineTest };
  }
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
    const pairwiseForPublication = arm.driftCriterionWhenUndeclared
      && !retained.input.condition?.criterion
      ? { ...pairwise, criterionVerdict: arm.driftCriterionWhenUndeclared }
      : pairwise;
    // The context is the drift fields alone: the manifest's lifecycle keys are
    // written after this recompute, so a figure carrying them could not equal a
    // later one. Publication reads the assembled figure (d1-findings.md F1).
    const drift = driftFigure({
      figures,
      pairwise: pairwiseForPublication,
      context: {
        ...contextFields,
        ...arm.driftContextExtras(retained.manifest),
      },
      condition: retained.input.condition,
      window: retained.input.window,
      content: retained.input.content,
    });
    const publishedDrift = publish('drift', drift, {
      declaredClientTags: retained.input.declaredClientTags,
      clients: retained.input.clients,
    });
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
