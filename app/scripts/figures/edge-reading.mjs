// 9b design.md D3, D4, D8: what the control reading gains for an arm registered
// under 9b. A leaf: the control reading calls it and hands it its own verdicts.

import { figureOf } from './regimes-reading.mjs';

const finite = (value) => Number.isFinite(value);
const MEASURES = { answer: 'maxAnswerMs', duration: 'maxDurationMs' };

export const EDGE_CRITERIA = ['dropRecovery', 'prefetchWait'];
export const NOT_ESTABLISHED = 'not-established-against-the-control';

export const edgeReading = (reading) => reading?.hostPollCoverage === true;

/** The fields 9b adds to a control reading block. Absent is valid; present and malformed is not. */
export function edgeThresholds(reading) {
  const invalid = (name) => { throw new Error(`control-reading-field-invalid:${name}`); };
  if ('controlArm' in reading && (typeof reading.controlArm !== 'string' || !reading.controlArm)) invalid('controlArm');
  if ('hostPollCoverage' in reading && typeof reading.hostPollCoverage !== 'boolean') invalid('hostPollCoverage');
  for (const name of ['aheadMsMin', 'scatteredSpreadMsAbove', 'behindHeldAheadMsBelow']) {
    if (name in reading && !(finite(reading[name]) && reading[name] >= 0)) invalid(name);
  }
  const prefetch = reading.criteria?.prefetchWait;
  if (prefetch && !MEASURES[prefetch.of]) invalid('prefetchWait.of');
  return reading;
}

/** A drop run whose deep phase ended at the ceiling has no verdict and does not vote. */
export function dropNotExercised(entry, reading) {
  return Boolean(reading?.criteria?.dropRecovery) && figureOf(entry).edge?.dropRecovery?.notExercised === true;
}

function dropRecovery(name, entry, bar, { result, recoveryVerdict }) {
  const drop = figureOf(entry).edge?.dropRecovery;
  if (!drop) return result(name, null, bar.maxMs, 'unestablished', 'drop-recovery-unavailable');
  if (drop.notExercised === true) return result(name, null, bar.maxMs, 'not-classified', 'drop-not-exercised', { edge: drop.edge ?? null });
  if (drop.notInForce === true) return result(name, null, bar.maxMs, 'unestablished', 'capacity-schedule-not-in-force');
  return { ...recoveryVerdict(name, drop.result, bar, 'drop-recovery-unavailable'), edge: drop.edge ?? null };
}

// The longest wait of a prefetch made at the edge, by the instant the bar names.
function prefetchWait(name, entry, bar, { result }) {
  const wait = figureOf(entry).edge?.prefetchWait;
  const extra = { of: bar.of, count: wait?.count ?? null, unanswered: wait?.unanswered ?? null };
  if (!wait) return result(name, null, bar.maxMs, 'unestablished', 'prefetch-wait-unavailable', extra);
  const value = wait[MEASURES[bar.of]];
  if (!finite(value)) return result(name, null, bar.maxMs, 'unestablished', 'no-edge-prefetch', extra);
  if (value < 0) throw new RangeError(`prefetch wait below zero: ${entry?.directory ?? null}`);
  return result(name, value, bar.maxMs, value <= bar.maxMs ? 'met' : 'failed', value <= bar.maxMs ? null : 'threshold:wait', extra);
}

export function edgeCriterion(name, entry, bar, verdicts) {
  return name === 'dropRecovery' ? dropRecovery(name, entry, bar, verdicts) : prefetchWait(name, entry, bar, verdicts);
}

function copies(value) {
  if (!value || value.value === null) return value ?? null;
  const { perSegment, ...summary } = value;
  return summary;
}

/** What an accepted 9b run publishes beside its criteria. None of it votes. */
export function publishedEdge(entry) {
  const figures = figureOf(entry);
  const edge = figures.edge ?? null;
  const control = figures.control ?? null;
  return {
    hostCopies: copies(edge?.hostCopies),
    prefetchWait: edge?.prefetchWait ?? null,
    roomPosition: edge?.roomPosition ?? null,
    aheadWhenRecovered: edge?.aheadWhenRecovered ?? null,
    dropRecovery: edge?.dropRecovery ? { notInForce: edge.dropRecovery.notInForce ?? false,
      notExercised: edge.dropRecovery.notExercised ?? null, edge: edge.dropRecovery.edge ?? null,
      result: edge.dropRecovery.result ?? null } : null,
    slowExit: edge?.slowExit ?? null,
    askHealth: edge?.askHealth ?? null,
    hostStats: edge?.hostStats ?? null,
    assignmentControl: edge?.assignmentControl ?? null,
    seekWaitByViewer: control?.holds?.seek?.viewers ?? null,
    timebase: control?.timebase ? { halfWidthMs: control.timebase.halfWidthMs ?? null,
      bracketHalfWidthMedianMs: control.timebase.bracketHalfWidthMedianMs ?? null,
      bracketHalfWidthMaxMs: control.timebase.bracketHalfWidthMaxMs ?? null } : null,
    pollGaps: control?.pollGaps ?? null,
    pace: figures.steadyState?.pace ?? null,
  };
}

function side(arm, name) {
  return {
    result: arm?.criteria?.[name]?.result ?? null,
    runs: (arm?.runs ?? []).filter((run) => run.accepted && run.classification?.criteria?.[name])
      .map((run) => ({ directory: run.directory, result: run.classification.criteria[name].result,
        value: run.classification.criteria[name].value ?? null })),
  };
}

/**
 * Each arm that names a control arm, beside it, per criterion both declare.
 * It reads the two arms and returns a new object: the named arm's own result
 * is the one its runs gave, whatever the control arm reads.
 */
export function gain({ arms = {} } = {}) {
  const out = {};
  for (const [name, arm] of Object.entries(arms)) {
    if (typeof arm?.controlArm !== 'string') continue;
    const control = arms[arm.controlArm] ?? null;
    const shared = (arm.declaredCriteria ?? []).filter((criterion) => (control?.declaredCriteria ?? []).includes(criterion));
    out[name] = { controlArm: arm.controlArm, criteria: shared.map((criterion) => {
      const own = side(arm, criterion);
      const other = side(control, criterion);
      const established = other.result !== null && other.result !== 'split';
      return { criterion, arm: own, control: other,
        comparison: established ? { arm: own.result, control: other.result } : NOT_ESTABLISHED };
    }) };
  }
  return out;
}
