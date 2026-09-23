// Pairwise drift arithmetic. Grid matching and floor terms follow 6b design.md D2.

import { median, percentile } from '../../public/lib/frame-drift.mjs';

const finite = (value) => Number.isFinite(value);
const ascending = (a, b) => a - b;

function ordered(values) {
  return [...values].sort(ascending);
}

function statistic(values, name) {
  const sorted = ordered(values);
  return name === 'median' ? median(sorted) : percentile(sorted, 0.99);
}

function pairKey(a, b) {
  return `${a}|${b}`;
}

function inWindowRecords(client, window) {
  const records = Array.isArray(client?.records) ? client.records : [];
  return records.filter((record) => finite(record?.displaySharedMs)
    && finite(window?.startMs) && finite(window?.endMs)
    && record.displaySharedMs >= window.startMs && record.displaySharedMs <= window.endMs);
}

function nearestRecord(records, gridMs, intervalMs) {
  let selected;
  let selectedDistance = Infinity;
  let selectedSeq = Infinity;
  for (const record of records) {
    const distance = Math.abs(record.displaySharedMs - gridMs);
    if (distance > intervalMs / 2) continue;
    const seq = finite(record.seq) ? record.seq : Infinity;
    if (distance < selectedDistance || (distance === selectedDistance && seq < selectedSeq)) {
      selected = record;
      selectedDistance = distance;
      selectedSeq = seq;
    }
  }
  return selected;
}

function gridFor(window, intervalMs) {
  if (!finite(window?.startMs) || !finite(window?.endMs) || window.endMs < window.startMs) return [];
  const count = Math.floor((window.endMs - window.startMs) / intervalMs + 1e-12);
  return Array.from({ length: count + 1 }, (_, index) => window.startMs + index * intervalMs);
}

function pairVerdict({ lower, upper, delay, age, present, targets }) {
  if (!targets || !finite(targets.targetMs) || !['median', 'p99'].includes(targets.statistic)) return undefined;
  const statisticName = targets.statistic;
  const lowerValue = statistic(lower, statisticName);
  const upperValue = statistic(upper, statisticName);
  const termValues = [
    ['delay', statistic(delay, statisticName)],
    ['age', statistic(age, statisticName)],
    ['present', statistic(present, statisticName)],
  ];
  const largest = termValues.reduce((best, current) => current[1] > best[1] ? current : best);
  return {
    statistic: statisticName,
    targetMs: targets.targetMs,
    verdict: upperValue <= targets.targetMs ? 'met' : lowerValue > targets.targetMs ? 'failed' : 'undecidable',
    statisticOfLowerEnds: lowerValue,
    statisticOfUpperEnds: upperValue,
    largestFloorTerm: largest[0],
  };
}

export function pairwiseDrift({
  clients = {},
  tags = Object.keys(clients),
  window,
  frameRate,
  presentIntervalMsByClient = {},
  targets,
} = {}) {
  const intervalMs = finite(frameRate) && frameRate > 0 ? 1000 / frameRate : NaN;
  const grid = gridFor(window, intervalMs);
  if (!grid.length) return { refused: true, reason: 'pairwise-no-points' };

  const recordsByClient = Object.fromEntries(tags.map((tag) => [tag, inWindowRecords(clients[tag], window)]));
  const matchesByClient = Object.fromEntries(tags.map((tag) => [
    tag,
    grid.map((gridMs) => nearestRecord(recordsByClient[tag], gridMs, intervalMs)),
  ]));
  const driftSeriesByClient = Object.fromEntries(tags.map((tag) => [
    tag,
    matchesByClient[tag].map((record) => finite(record?.driftMs) ? record.driftMs : null),
  ]));
  const epochsByClient = Object.fromEntries(tags.map((tag) => [
    tag,
    [...new Set(recordsByClient[tag].map((record) => record.epochMs).filter(finite))].sort(ascending),
  ]));

  const absolute = [];
  const lower = [];
  const upper = [];
  const floor = [];
  const delayTerms = [];
  const ageTerms = [];
  const presentTerms = [];
  const pairwiseDriftAbsMsMedianByPair = {};
  const pairwiseDriftPointsUsedByPair = {};
  const excludedMissingRecordByPair = {};
  const excludedEpochMismatchByPair = {};
  const pairsWithoutFigure = [];

  for (let left = 0; left < tags.length; left += 1) {
    for (let right = left + 1; right < tags.length; right += 1) {
      const aTag = tags[left];
      const bTag = tags[right];
      const key = pairKey(aTag, bTag);
      const pairAbsolute = [];
      let missing = 0;
      let epochMismatch = 0;
      for (let index = 0; index < grid.length; index += 1) {
        const a = matchesByClient[aTag][index];
        const b = matchesByClient[bTag][index];
        if (!a || !b || !finite(a.driftMs) || !finite(b.driftMs)
          || !finite(a.epochMs) || !finite(b.epochMs)) {
          missing += 1;
          continue;
        }
        if (a.epochMs !== b.epochMs) {
          epochMismatch += 1;
          continue;
        }
        const delay = a.clock?.delayTermMs + b.clock?.delayTermMs;
        const age = a.clock?.ageTermMs + b.clock?.ageTermMs;
        const present = Math.max(presentIntervalMsByClient[aTag], presentIntervalMsByClient[bTag]);
        if (!finite(delay) || !finite(age) || !finite(present)) {
          missing += 1;
          continue;
        }
        const aHalfWidth = a.clock?.halfWidthMs;
        const bHalfWidth = b.clock?.halfWidthMs;
        if (!finite(aHalfWidth) || !finite(bHalfWidth)
          || Math.abs(aHalfWidth - (a.clock.delayTermMs + a.clock.ageTermMs)) > 1e-9
          || Math.abs(bHalfWidth - (b.clock.delayTermMs + b.clock.ageTermMs)) > 1e-9) {
          return { refused: true, reason: 'halfwidth-terms-disagree' };
        }
        const value = Math.abs(a.driftMs - b.driftMs);
        const pointFloor = delay + age + present;
        absolute.push(value);
        lower.push(Math.max(0, value - pointFloor));
        upper.push(value + pointFloor);
        floor.push(pointFloor);
        delayTerms.push(delay);
        ageTerms.push(age);
        presentTerms.push(present);
        pairAbsolute.push(value);
      }
      pairwiseDriftPointsUsedByPair[key] = pairAbsolute.length;
      excludedMissingRecordByPair[key] = missing;
      excludedEpochMismatchByPair[key] = epochMismatch;
      if (pairAbsolute.length) pairwiseDriftAbsMsMedianByPair[key] = median(ordered(pairAbsolute));
      else pairsWithoutFigure.push(key);
    }
  }

  if (!absolute.length) return { refused: true, reason: 'pairwise-no-points' };

  const floorPresentIntervalMs = presentTerms.every((value) => value === presentTerms[0])
    ? presentTerms[0]
    : { P50: statistic(presentTerms, 'median'), P99: statistic(presentTerms, 'p99') };
  const result = {
    driftSeriesByClient,
    epochsByClient,
    pairwiseDriftAbsMsMedian: statistic(absolute, 'median'),
    pairwiseDriftAbsMsP99: statistic(absolute, 'p99'),
    pairwiseDriftAbsMsMedianLowerEnd: statistic(lower, 'median'),
    pairwiseDriftAbsMsP99LowerEnd: statistic(lower, 'p99'),
    pairwiseDriftAbsMsMedianUpperEnd: statistic(upper, 'median'),
    pairwiseDriftAbsMsP99UpperEnd: statistic(upper, 'p99'),
    instrumentFloorMsP50: statistic(floor, 'median'),
    instrumentFloorMsP99: statistic(floor, 'p99'),
    floorDelayTermMsP50: statistic(delayTerms, 'median'),
    floorDelayTermMsP99: statistic(delayTerms, 'p99'),
    floorAgeTermMsP50: statistic(ageTerms, 'median'),
    floorAgeTermMsP99: statistic(ageTerms, 'p99'),
    floorPresentIntervalMs,
    pairwiseDriftPointsUsed: absolute.length,
    excludedMissingRecord: Object.values(excludedMissingRecordByPair).reduce((sum, value) => sum + value, 0),
    excludedEpochMismatch: Object.values(excludedEpochMismatchByPair).reduce((sum, value) => sum + value, 0),
    pairwiseDriftAbsMsMedianByPair,
    pairwiseDriftPointsUsedByPair,
    excludedMissingRecordByPair,
    excludedEpochMismatchByPair,
    pairsWithoutFigure,
    criterionVerdict: pairVerdict({ lower, upper, delay: delayTerms, age: ageTerms, present: presentTerms, targets }),
    p99Verdict: pairVerdict({
      lower,
      upper,
      delay: delayTerms,
      age: ageTerms,
      present: presentTerms,
      targets: { statistic: 'p99', targetMs: 100 },
    }),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

