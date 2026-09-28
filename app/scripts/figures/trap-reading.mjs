import { median as medianOfSorted } from '../../public/lib/frame-drift.mjs';
import { accepted, sameBuild } from './regimes-reading.mjs';

const finite = (value) => Number.isFinite(value);

function conditionOf(entry) {
  return entry?.condition ?? entry?.manifest?.condition?.name ?? null;
}

function figuresOf(entry) {
  return entry?.report?.figures ?? entry?.figures ?? {};
}

function buildIdsOf(entry) {
  const clients = entry?.manifest?.clients ?? entry?.clients ?? {};
  return Object.fromEntries(Object.entries(clients)
    .filter(([, client]) => client?.role !== 'host')
    .map(([tag, client]) => [tag, client?.buildId ?? null])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function imagesOf(entry) {
  return entry?.manifest?.topology?.regime?.images ?? null;
}

function thresholds(reading) {
  const values = [reading?.behindHeldAheadMsBelow, reading?.reproducedPeerFractionMax,
    reading?.notReproducedPeerFractionMin, reading?.scatteredSpreadMsAbove,
    reading?.control?.peerFractionMin];
  if (reading?.kind !== 'trap' || values.some((value) => !finite(value))
    || !Number.isInteger(reading.acceptedRunsMin) || !Number.isInteger(reading.attemptsMax)
    || reading.acceptedRunsMin < 1 || reading.attemptsMax < reading.acceptedRunsMin
    || typeof reading.control?.condition !== 'string') {
    throw new Error('trap-reading-thresholds-invalid');
  }
  return reading;
}

function valueOf(figures, name, directory) {
  if (!finite(figures[name])) throw new Error(`trap-reading-value-invalid:${directory}:${name}`);
  return figures[name];
}

export function classifyTrapRun(entry, reading) {
  const config = thresholds(reading);
  const figures = figuresOf(entry);
  const directory = entry?.directory ?? null;
  const peerFractionAggregate = valueOf(figures, 'peerFractionAggregate', directory);
  const heldAheadMsRoomMedian = valueOf(figures, 'heldAheadMsRoomMedian', directory);
  const positionSpreadMsMedian = valueOf(figures, 'positionSpreadMsMedian', directory);
  const behind = heldAheadMsRoomMedian < config.behindHeldAheadMsBelow;
  let className;
  let key;
  let label = null;
  if (behind && peerFractionAggregate <= config.reproducedPeerFractionMax) {
    className = 'reproduced';
    key = 'T1';
  } else if (behind && peerFractionAggregate < config.notReproducedPeerFractionMin) {
    className = 'partial';
    key = 'T2';
  } else {
    className = 'not reproduced';
    key = 'T3';
    label = !behind ? 'escaped'
      : positionSpreadMsMedian > config.scatteredSpreadMsAbove ? 'scattered' : 'synchronized';
  }
  return {
    directory,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    peerFractionAggregate,
    heldAheadMsRoomMedian,
    positionSpreadMsMedian,
    behind,
    class: className,
    classKey: key,
    label,
    buildIds: buildIdsOf(entry),
    images: imagesOf(entry),
  };
}

function runSummary(entry, reading) {
  const summary = {
    directory: entry?.directory ?? null,
    condition: conditionOf(entry),
    accepted: accepted(entry),
    outcome: entry?.outcome ?? null,
    publishes: entry?.publishes ?? null,
    finalization: entry?.finalization ?? null,
    buildIds: buildIdsOf(entry),
    images: imagesOf(entry),
  };
  if (entry?.recomputeError) return { ...summary, recomputeError: entry.recomputeError };
  if (!summary.accepted) return summary;
  return { ...summary, ...classifyTrapRun(entry, reading) };
}

function controlSummary(entries, config, acceptedRuns) {
  const candidates = entries.filter((entry) => accepted(entry) && conditionOf(entry) === config.control.condition)
    .map((entry) => {
      const figures = figuresOf(entry);
      const peerFractionAggregate = finite(figures.peerFractionAggregate)
        ? figures.peerFractionAggregate : null;
      const sameBuildAsArm = acceptedRuns.every((run) => sameBuild(entry, run));
      return {
        directory: entry?.directory ?? null,
        condition: conditionOf(entry),
        accepted: true,
        peerFractionAggregate,
        buildIds: buildIdsOf(entry),
        images: imagesOf(entry),
        qualifies: peerFractionAggregate !== null
          && peerFractionAggregate >= config.control.peerFractionMin && sameBuildAsArm,
        sameBuildAsArm,
      };
    });
  const selected = candidates.find((candidate) => candidate.qualifies);
  return selected ?? candidates;
}

function median(values) {
  const ordered = values.slice().sort((left, right) => left - right);
  return medianOfSorted(ordered);
}

function majority(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  return ordered.length && ordered[0][1] * 2 > values.length ? ordered[0][0] : null;
}

function armReading(summaries, config) {
  const acceptedRuns = summaries.filter((entry) => entry.accepted);
  const reading = {
    reading: 'No reading',
    readingKey: 'none',
    class: null,
    runs: summaries,
    acceptedCount: acceptedRuns.length,
    medians: acceptedRuns.length ? {
      peerFractionAggregate: median(acceptedRuns.map((entry) => entry.peerFractionAggregate)),
      heldAheadMsRoomMedian: median(acceptedRuns.map((entry) => entry.heldAheadMsRoomMedian)),
      positionSpreadMsMedian: median(acceptedRuns.map((entry) => entry.positionSpreadMsMedian)),
    } : null,
    reasons: [],
  };
  if (acceptedRuns.length < config.acceptedRunsMin) {
    reading.reasons.push(`accepted-run-count:${acceptedRuns.length}`);
    return reading;
  }
  const className = majority(acceptedRuns.map((entry) => entry.classKey));
  if (!className) {
    reading.reading = 'split';
    reading.readingKey = 'split';
    reading.classes = acceptedRuns.map((entry) => ({ directory: entry.directory, class: entry.class, classKey: entry.classKey }));
    return reading;
  }
  reading.readingKey = className.toLowerCase();
  reading.class = acceptedRuns.find((entry) => entry.classKey === className)?.class ?? null;
  reading.reading = reading.class;
  if (className === 'T3') {
    const labels = acceptedRuns.filter((entry) => entry.classKey === 'T3').map((entry) => entry.label);
    const label = majority(labels);
    reading.labels = acceptedRuns.filter((entry) => entry.classKey === 'T3')
      .map((entry) => ({ directory: entry.directory, label: entry.label }));
    reading.label = label ?? 'scattered';
    reading.consequence = reading.label;
  }
  return reading;
}

function armName(entry) {
  return conditionOf(entry);
}

export function classifyTrapReading({ runs = [], reading } = {}) {
  const config = thresholds(reading);
  const entries = Array.isArray(runs) ? runs : [];
  const trapEntries = entries.filter((entry) => entry?.condition && entry.condition !== config.control.condition);
  const conditions = [...new Set(trapEntries.map(armName))];
  const arms = Object.fromEntries(conditions.map((condition) => {
    const armEntries = entries.filter((entry) => conditionOf(entry) === condition);
    const summaries = armEntries.map((entry) => runSummary(entry, config));
    const acceptedEntries = armEntries.filter((entry) => accepted(entry));
    const control = controlSummary(entries, config, acceptedEntries);
    const result = armReading(summaries, config);
    const hasControl = !Array.isArray(control) && control?.qualifies === true;
    if (result.acceptedCount >= config.acceptedRunsMin && !hasControl) {
      result.reading = 'No reading';
      result.readingKey = 'none';
      result.class = null;
      result.reasons.push('control-unavailable');
    }
    return [condition, { ...result, control }];
  }));
  const votes = Object.values(arms).filter((arm) => arm.readingKey !== 'none');
  const rank = { t1: 0, split: 1, t2: 2, t3: 3 };
  const chosen = votes.sort((left, right) => rank[left.readingKey] - rank[right.readingKey])[0];
  const result = {
    diagnostic: false,
    criterion: true,
    thresholds: config,
    runs: entries.map((entry) => runSummary(entry, config)),
    arms,
    reading: chosen?.reading ?? 'not reproduced within budget',
    readingKey: chosen?.readingKey ?? 'not-reproduced-within-budget',
    reasons: chosen ? [] : ['no-arm-reading'],
  };
  return result;
}

export { thresholds as validateTrapReading };
