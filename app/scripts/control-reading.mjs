import fs from 'node:fs';
import path from 'node:path';

import { HEADROOM_DEFAULT } from '../public/lib/send-pace.mjs';
import {
  baselineTable,
  classifyControlReading,
  classifyControlRun,
} from './figures/control-reading.mjs';
import { edgeReading, gain } from './figures/edge-reading.mjs';
import { classifyTrapRun } from './figures/trap-reading.mjs';
import { accepted } from './figures/regimes-reading.mjs';
import {
  appPath, argument, CONDITIONS_PATH, isMain, readJson, recomputeRegisteredRun, registeredDirectory,
  registryEntries, runMain, runPath,
} from './registered-runs.mjs';

const EDGE_CHANGE = '9b';
const GOODPUT_CONDITION = 'shakedown/cap10';
const TRAP_RESULT = 'results/8a-trap-reading-d9.json';
const TRAP_BAR_KEYS = ['behindHeldAheadMsBelow', 'reproducedPeerFractionMax',
  'notReproducedPeerFractionMin', 'scatteredSpreadMsAbove'];

export function conditionByName(conditions, name) {
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
export function recomputeControlRun(entry) {
  const directory = registeredDirectory(entry);
  const runDir = runPath(directory);
  if (!fs.existsSync(runDir)) throw new Error(`registered run directory missing:${directory}`);
  if (entry.condition === GOODPUT_CONDITION) return goodputRun(entry, runDir);
  return recomputeRegisteredRun(entry);
}

export function trapClassForRun(entry, condition, trapReading) {
  const ownReading = condition?.reading;
  for (const key of TRAP_BAR_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ownReading ?? {}, key)
      && ownReading[key] !== trapReading?.[key]) {
      throw new Error(`trap-bars-mismatch:${condition?.name ?? entry?.condition ?? null}`);
    }
  }
  const figures = entry?.report?.figures ?? entry?.figures;
  if (!figures || typeof figures !== 'object') return { key: null, reason: 'figures-unavailable' };
  try {
    // Each value once: the run entry already carries its directory, build and images.
    const { classKey, class: className, label, accepted: isAccepted, behind, peerFractionAggregate,
      heldAheadMsRoomMedian, positionSpreadMsMedian } = classifyTrapRun(entry, trapReading);
    return { key: classKey, class: className, label, accepted: isAccepted, behind, peerFractionAggregate,
      heldAheadMsRoomMedian, positionSpreadMsMedian };
  } catch (error) {
    return { key: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

// A register reads the arms of its own change: 9b's are the ones declaring the
// host's poll coverage, so 8b2's reading does not gain an empty arm per 9b condition.
function armsOf(conditions, change) {
  return [...conditionEntries(conditions).values()].filter((condition) => condition?.reading?.kind === 'control'
    && edgeReading(condition.reading) === (change === EDGE_CHANGE));
}

export function sweepPositions(runs, conditions, change = null) {
  const entries = armsOf(conditions, change).filter((condition) => {
    const declared = Object.prototype.hasOwnProperty.call(condition, 'headroomFraction');
    // The product's own position is the seek arm's, not its control arm's.
    return condition.reading.sweep === true || (condition.seek && !declared && !condition.assignmentControl);
  });
  const positions = entries.map((condition) => {
    const declared = Object.prototype.hasOwnProperty.call(condition, 'headroomFraction');
    const fraction = declared ? condition.headroomFraction : HEADROOM_DEFAULT;
    return {
      fraction,
      condition: condition.name,
      runs: (runs ?? []).filter((entry) => entry?.condition === condition.name && entry?.classification)
        .map((entry) => ({
          directory: entry.directory ?? null,
          accepted: entry.classification.accepted ?? null,
          sweep: entry.figures?.control?.sweep ?? null,
          wait: entry.classification.wait ?? null,
          recovery: entry.classification.recovery ?? null,
        })),
    };
  });
  return positions.sort((left, right) => {
    const leftNumeric = Number.isFinite(left.fraction);
    const rightNumeric = Number.isFinite(right.fraction);
    if (leftNumeric && rightNumeric) return left.fraction - right.fraction;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (left.fraction === 'unpaced' && right.fraction !== 'unpaced') return 1;
    if (right.fraction === 'unpaced' && left.fraction !== 'unpaced') return -1;
    return 0;
  });
}

function outputRun(entry, conditions, trapReading) {
  const condition = conditionByName(conditions, entry.condition);
  const reading = condition?.reading?.kind === 'control' ? condition.reading : null;
  const output = {
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
  if (condition?.seek && reading) output.trapClass = trapClassForRun(entry, condition, trapReading);
  return output;
}

function controlArms(entries, conditions, change) {
  const result = {};
  for (const condition of armsOf(conditions, change)) {
    const name = condition.name;
    const classified = classifyControlReading({ runs: entries, reading: condition.reading, armNames: [name] });
    result[name] = classified.arms[name];
  }
  return result;
}

export function buildControlReadingReport({ registerPath, conditionsPath = CONDITIONS_PATH, entries: recomputed } = {}) {
  if (!registerPath) throw new Error('registry path is required');
  const conditions = readJson(conditionsPath);
  const trapCondition = conditionByName(conditions, 'trap-seek');
  if (!trapCondition?.reading || typeof trapCondition.reading !== 'object') {
    throw new Error('trap-reading-condition-unavailable');
  }
  const trapResult = readJson(appPath(TRAP_RESULT));
  const trapArm = trapResult?.arms?.['trap-seek'];
  if (!trapArm || typeof trapArm !== 'object') throw new Error('trap-reading-result-unavailable');
  for (const key of ['reading', 'readingKey', 'class']) {
    if (!Object.prototype.hasOwnProperty.call(trapArm, key)) {
      throw new Error(`trap-reading-result-missing:${key}`);
    }
  }
  const change = readJson(registerPath).change ?? '8b2';
  const edge = change === EDGE_CHANGE;
  const entries = recomputed ?? registryEntries(registerPath).map(recomputeControlRun);
  const runs = entries.map((entry) => outputRun(entry, conditions, trapCondition.reading));
  const arms = controlArms(entries, conditions, change);
  const controlRuns = Object.fromEntries((edge ? Object.keys(arms) : ['control-five', 'control-ten']).map((condition) => [condition,
    entries.find((entry) => accepted(entry) && entry.condition === condition) ?? null]));
  return {
    change,
    registry: registerPath,
    writtenBy: 'scripts/control-reading.mjs',
    runs,
    arms,
    goodput: runs.find((entry) => entry.condition === GOODPUT_CONDITION)?.goodput ?? null,
    baseline: baselineTable({ runs: entries, controlRuns }),
    trapReading: { file: TRAP_RESULT, arm: 'trap-seek', reading: trapArm.reading,
      readingKey: trapArm.readingKey, class: trapArm.class },
    sweep: { positions: sweepPositions(runs, conditions, change) },
    ...(edge ? { gain: gain({ arms }) } : {}),
  };
}

export function main(argv = process.argv.slice(2)) {
  const register = argument('registry', argv);
  if (!register) throw new Error('usage: node scripts/control-reading.mjs --registry=<file> [--out=<file>]');
  const report = buildControlReadingReport({ registerPath: appPath(register) });
  const outputPath = appPath(argument('out', argv) ?? `results/${report.change}-control-reading.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMain(import.meta.url)) runMain(main);
