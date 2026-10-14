import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { seekWithPolledHold } from './figures/seek-hold.mjs';
import { appliedSeekEvidence } from './figures/seek-evidence.mjs';
import { summarizeRefusalReasons } from './harness/refusals.mjs';
import { evidenceRefusals } from './harness/control-evidence.mjs';
import { REFUSAL_SCOPE } from './harness/arms.mjs';
import { decideFinalization } from './harness-run.mjs';
import { readRunDirectory, recomputeRunDirectory } from './harness-figures.mjs';
import {
  appPath, argument, finalizationOf, isMain, readJson, registryEntries, registeredDirectory,
  runMain, runPath,
} from './registered-runs.mjs';

const DEFAULT_OUTPUT = 'results/11a2-seek-hold-reread.json';
const REPLACED_REASONS = new Set(['seek-hold-unobserved', 'seek-landed-on-held-media', 'seek-not-applied']);
const RULE = 'A post-result reader uses the first retained polled held seek state that matches the declaration, lineage, and newer version.';

function ruleCommit() {
  return execFileSync('git', ['log', '-1', '--format=%H', '--', 'scripts/figures/seek-hold.mjs'], {
    cwd: appPath('.'), encoding: 'utf8',
  }).trim() || null;
}

function seekReasonInput(retained, seek) {
  const condition = retained.input.condition ?? {};
  const control = evidenceRefusals({
    hostPace: retained.input.hostPace,
    resumes: retained.input.resumes,
    hostPoll: retained.input.hostPoll,
    seek,
    peerExchange: condition.peerExchange === true,
  });
  const reasons = control.filter((entry) => entry.reason === 'seek-hold-unobserved')
    .map((entry) => ({ reason: entry.reason, scope: [...REFUSAL_SCOPE.control], ...(entry.detail ?? {}) }));
  const tags = retained.input.declaredClientTags ?? Object.keys(retained.input.clients ?? {});
  if (!seek?.host) {
    for (const tag of tags) reasons.push({ reason: 'seek-not-applied', scope: [...REFUSAL_SCOPE.seek], tag,
      lastReading: seek?.lastReadings?.[tag] ?? seek?.viewers?.[tag]?.reading ?? null });
    return reasons;
  }
  const landing = appliedSeekEvidence({
    host: seek.host,
    viewers: seek.viewers,
    peerRecords: Object.fromEntries(tags.map((tag) => [tag, retained.input.clients?.[tag]?.peerRecords ?? []])),
    declaredClientTags: tags,
    segmentSeconds: retained.input.segmentSeconds,
    highDemandTimeWindowMs: seek.highDemandTimeWindowMs
      ?? Number(condition.engineWindows?.highDemandTimeWindow ?? 15) * 1000,
  });
  for (const entry of landing.notApplied ?? []) {
    reasons.push({ reason: 'seek-not-applied', scope: [...REFUSAL_SCOPE.seek], ...entry,
      lastReading: seek.lastReadings?.[entry.tag] ?? entry.lastReading ?? null });
  }
  for (const entry of landing.landedOnHeldMedia ?? []) {
    reasons.push({ reason: 'seek-landed-on-held-media', scope: [...REFUSAL_SCOPE.seek], ...entry });
  }
  return reasons;
}

function repairedEvaluation(reasons, original) {
  const summary = summarizeRefusalReasons(reasons);
  return {
    ...summary,
    reasons,
    excused: original?.excused ?? [],
  };
}

function rereadRun(entry) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  const seekPath = path.join(runDir, 'seek.json');
  if (!fs.existsSync(seekPath)) return null;
  const retained = readRunDirectory(runDir);
  const originalSeek = readJson(seekPath);
  const repairedSeek = seekWithPolledHold(originalSeek, {
    hostPoll: retained.input.hostPoll,
    viewerPolls: retained.input.viewerPolls,
  });
  if (repairedSeek === originalSeek) return { directory, status: 'unchanged' };

  const report = readJson(path.join(runDir, 'refusal-report.json'));
  const originalRefusal = report?.refusal ?? {};
  const originalReasons = Array.isArray(originalRefusal.reasons) ? originalRefusal.reasons : [];
  const repairedReasons = originalReasons.filter((entry) => !REPLACED_REASONS.has(entry.reason));
  repairedReasons.push(...seekReasonInput(retained, repairedSeek));
  const recomputed = recomputeRunDirectory(runDir);
  const evaluation = repairedEvaluation(repairedReasons, originalRefusal);
  const repairedFinalization = decideFinalization({
    evaluation,
    recomputed,
    figureKinds: retained.manifest.condition?.figureKinds,
  });
  return {
    directory,
    status: 'repaired',
    originalReasons,
    repairedReasons,
    originalFinalization: report?.finalization ?? finalizationOf(runDir),
    repairedFinalization,
    heldState: repairedSeek.host,
    loopHost: repairedSeek.loopHost,
    recomputed,
    figureKinds: retained.manifest.condition?.figureKinds ?? null,
  };
}

export function buildSeekHoldRereadReport({ registerPath } = {}) {
  if (!registerPath) throw new Error('registry path is required');
  return {
    writtenBy: 'scripts/seek-hold-reread.mjs',
    rule: RULE,
    ruleCommit: ruleCommit(),
    registry: registerPath,
    runs: registryEntries(registerPath).map(rereadRun).filter(Boolean),
  };
}

export function main(argv = process.argv.slice(2)) {
  const registry = argument('registry', argv);
  if (!registry) throw new Error('usage: node scripts/seek-hold-reread.mjs --registry=<file> [--out=<file>]');
  const outputPath = appPath(argument('out', argv) ?? DEFAULT_OUTPUT);
  const report = buildSeekHoldRereadReport({ registerPath: appPath(registry) });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ written: outputPath, runs: report.runs.map(({ directory, status }) => ({ directory, status })) }, null, 2));
  return report;
}

if (isMain(import.meta.url)) runMain(main);
