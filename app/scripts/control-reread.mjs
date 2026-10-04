import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  confirmation, labelFaults, registeredDifferences, remainingRefusals, rereadAcceptance, rulesOf,
} from './figures/control-reread.mjs';
import {
  buildControlReadingReport, conditionByName, recomputeControlRun, sweepPositions, trapClassForRun,
} from './control-reading.mjs';
import { classifyControlReading, classifyControlRun } from './figures/control-reading.mjs';
import { figureOf } from './figures/regimes-reading.mjs';
import {
  appPath, argument, CONDITIONS_PATH, isMain, readJson, recomputeRegisteredRun, registryEntries,
  runMain,
} from './registered-runs.mjs';

// 8b3's offline re-read (design.md D1, D4, D5): the registered runs of 8b2 read
// again under a committed post-result rule set, published beside 8b2's reading and
// never over it. It reads run directories and writes its one output file.
const DEFAULT_OUTPUT = 'results/8b3-control-reread.json';
const RESPONSE_CHECK = 'response-agreement';
const UNPACED = 'sweep-unpaced';

// D1: the rule set is committed before anything is computed under it.
function ruleSetCommitOf(rulePath) {
  const cwd = path.dirname(rulePath);
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain', '--', rulePath])) throw new Error('rule-set-not-committed:working tree differs');
  const commit = git(['log', '-1', '--format=%H', '--', rulePath]);
  if (!commit) throw new Error('rule-set-not-committed:no commit');
  return commit;
}

function excusedReceipts(report) {
  const check = (report?.figures?.peerChecks ?? []).find((entry) => entry?.check === RESPONSE_CHECK);
  const value = check?.excusedByteless;
  if (!value || !Number.isFinite(value.count)) return { count: null, byClient: null, reason: 'excusal-count-unavailable' };
  return { count: value.count, byClient: value.byClient };
}

function spanProjection(span) {
  return {
    window: span?.window ?? null,
    uplinkUtilisationMean: span?.uplinkUtilisationMean ?? null,
    standingQueueDelayMsP50NearestRank: span?.standingQueueDelayMsP50NearestRank ?? null,
    standingQueueDelayMsP99: span?.standingQueueDelayMsP99 ?? null,
    clockHalfWidthMsByClient: span?.clockHalfWidthMsByClient ?? null,
    drift: span?.drift ?? null,
  };
}

function fullUplinkClock(records, labels) {
  const runs = records.filter((record) => record.condition === UNPACED && record.acceptance.acceptedUnderReread)
    .map((record) => ({ directory: record.directory,
      spans: (figureOf(record.reread).control?.sweep ?? []).map(spanProjection), labels }));
  return { condition: UNPACED, acceptedCount: runs.length, runs,
    standing: runs.length === 0 ? 'no accepted run'
      : `${runs.length} runs accepted under the re-read; not criterion 1`,
    labels };
}

function criterionResult(reading, classification, name) {
  if (!reading?.criteria?.[name]) return 'not-registered-for-this-arm';
  return classification?.criteria?.[name]?.result ?? null;
}

// 8a's classifier publishes registered acceptance as `accepted`. The run entry
// already carries both acceptance values by name (design.md D4), so it is dropped.
function rereadTrapClass(entry, condition, trapReading) {
  const { accepted: _asRegistered, ...trapClass } = trapClassForRun(entry, condition, trapReading);
  return trapClass;
}

function outputRun(record, registeredRuns, trapReading, labels) {
  const { conditionEntry: condition, acceptance, classification } = record;
  const figures = figureOf(record.reread);
  const steadyState = classification && !condition.seek ? figures.steadyState ?? null : null;
  return {
    directory: record.directory,
    condition: record.condition,
    ...acceptance,
    excusedReceipts: excusedReceipts(record.reread.report),
    registered: { classification: registeredRuns.get(record.directory)?.classification ?? null },
    reread: {
      classification,
      steadyState,
      recovery: classification?.recovery ?? null,
      wait: classification?.wait ?? null,
      trapClass: classification && condition.seek ? rereadTrapClass(record.reread, condition, trapReading) : null,
    },
    descriptive: {
      label: 'descriptive, not a verdict',
      steady: steadyState?.steady ?? null,
      criterion2: criterionResult(condition.reading, classification, 'multiplier'),
      criterion3: criterionResult(condition.reading, classification, 'peerFraction'),
    },
    labels,
  };
}

function statementOf(confirms) {
  if (confirms.confirmed) {
    return 'Under the re-read, criterion 2 is met at five and at ten viewers and criterion 3 is met at five.';
  }
  const named = confirms.reasons.map((name) => `${name} reads ${confirms[name]}`).join('; ');
  return `Under the re-read, criteria 2 and 3 are not confirmed: ${named}.`;
}

export function buildControlRereadReport({ rulesPath } = {}) {
  if (!rulesPath) throw new Error('rules path is required');
  const ruleSetCommit = ruleSetCommitOf(rulesPath);
  const ruleSet = readJson(rulesPath);
  const rules = rulesOf(ruleSet);
  const labels = ruleSet.labels;
  const conditions = readJson(CONDITIONS_PATH);
  const trapReading = conditionByName(conditions, 'trap-seek')?.reading;
  if (!trapReading) throw new Error('trap-reading-condition-unavailable');

  // The registered side, as scripts/control-reading.mjs computes it, checked
  // against 8b2's published file before anything is read under the new rules.
  const registryPath = appPath(ruleSet.registry);
  const raw = registryEntries(registryPath);
  const registered = raw.map(recomputeControlRun);
  const registeredReport = buildControlReadingReport({ registerPath: registryPath, entries: registered });
  const differences = registeredDifferences(readJson(appPath(ruleSet.registeredReading)), registeredReport);
  if (differences.length) {
    console.error(JSON.stringify({ registeredDifferences: differences }, null, 2));
    throw new Error(`registered-side-differs-from-${ruleSet.registeredReading}:${differences.length}`);
  }
  const registeredRuns = new Map(registeredReport.runs.map((run) => [run.directory, run]));

  const records = [];
  const armEntries = [];
  for (const [index, entry] of registered.entries()) {
    if (ruleSet.readAsRegistered.includes(entry.condition)) armEntries.push(entry);
    if (!ruleSet.conditions.includes(entry.condition)) continue;
    const condition = conditionByName(conditions, entry.condition);
    if (condition?.reading?.kind !== 'control') throw new Error(`control-reading-undeclared:${entry.condition}`);
    const reread = recomputeRegisteredRun(raw[index], { rules });
    const acceptance = rereadAcceptance({ entry, liveReasons: entry.manifest?.refusalReasons ?? [],
      registeredReport: entry.report, rereadReport: reread.report });
    const remaining = remainingRefusals(reread.report);
    if (acceptance.acceptedAsRegistered && remaining.length) {
      throw new Error(`registered-accepted-run-refused-under-reread:${entry.directory}:${JSON.stringify(remaining)}`);
    }
    records.push({ directory: entry.directory, condition: entry.condition, conditionEntry: condition,
      reread, acceptance });
    armEntries.push(reread);
  }
  const underReread = new Map(records.map((record) => [record.directory, record.acceptance.acceptedUnderReread]));
  const isAccepted = (entry) => underReread.get(entry?.directory) === true;
  for (const record of records) {
    record.classification = record.acceptance.acceptedUnderReread
      ? classifyControlRun(record.reread, record.conditionEntry.reading, isAccepted) : null;
  }

  const rereadArms = Object.fromEntries(ruleSet.conditions.map((name) => [name, classifyControlReading({
    runs: armEntries, reading: conditionByName(conditions, name).reading, armNames: [name], isAccepted,
  }).arms[name]]));
  const confirms = confirmation(rereadArms);
  const views = records.map((record) => ({ directory: record.directory, condition: record.condition,
    classification: record.classification, figures: figureOf(record.reread) }));
  const positions = sweepPositions(views, conditions).map((position) => ({ ...position,
    runs: position.runs.map(({ accepted: _underReread, ...run }) => {
      const { acceptance } = records.find((record) => record.directory === run.directory);
      return { ...run, acceptedAsRegistered: acceptance.acceptedAsRegistered,
        acceptedUnderReread: acceptance.acceptedUnderReread };
    }),
    labels }));

  return {
    change: ruleSet.change,
    writtenBy: 'scripts/control-reread.mjs',
    ruleSet,
    ruleSetCommit,
    registry: ruleSet.registry,
    registeredReading: ruleSet.registeredReading,
    labels,
    outOfReach: ruleSet.outOfReach,
    runs: records.map((record) => outputRun(record, registeredRuns, trapReading, labels)),
    arms: Object.fromEntries(ruleSet.conditions.map((name) => [name,
      { registered: registeredReport.arms?.[name] ?? null, reread: rereadArms[name], labels }])),
    confirms: { ...confirms, statement: statementOf(confirms), labels },
    sweep: { positions },
    fullUplinkClock: fullUplinkClock(records, labels),
  };
}

export function main(argv = process.argv.slice(2)) {
  const rules = argument('rules', argv);
  if (!rules) throw new Error('usage: node scripts/control-reread.mjs --rules=<file> [--out=<file>] [--overwrite]');
  const outputPath = appPath(argument('out', argv) ?? DEFAULT_OUTPUT);
  if (fs.existsSync(outputPath) && !argv.includes('--overwrite')) {
    throw new Error(`output exists, pass --overwrite to replace it:${outputPath}`);
  }
  const report = buildControlRereadReport({ rulesPath: appPath(rules) });
  const faults = labelFaults(report);
  if (faults.length) throw new Error(`labels-missing:${faults.join(',')}`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ written: outputPath, ruleSetCommit: report.ruleSetCommit, confirms: report.confirms }, null, 2));
  return report;
}

if (isMain(import.meta.url)) runMain(main);
