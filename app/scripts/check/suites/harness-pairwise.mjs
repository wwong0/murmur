// Constructed D2 cases keep floor arithmetic visible (6b design.md D2).

import { pairwiseDrift } from '../../figures/pairwise-drift.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

const TAGS = ['c01', 'c02', 'c03'];
const WINDOW = { startMs: 0, endMs: 1_000 };
const PRESENT = { c01: 5, c02: 5, c03: 5 };

function record(index, drift, { epoch = 1, delay = 2, age = 3, seq = index + 1, displaySharedMs } = {}) {
  return {
    seq,
    epochMs: epoch,
    mediaMs: index,
    displaySharedMs: displaySharedMs ?? index * 250,
    driftMs: drift,
    clock: { halfWidthMs: delay + age, delayTermMs: delay, ageTermMs: age },
  };
}

function clientsFrom(drifts, options = {}) {
  return Object.fromEntries(Object.entries(drifts).map(([tag, values]) => [tag, {
    records: values.map((drift, index) => record(index, drift, {
      ...(options[tag]?.[index] ?? {}),
    })),
  }]));
}

function run(clients, extra = {}) {
  return pairwiseDrift({
    clients,
    tags: Object.keys(clients),
    window: WINDOW,
    frameRate: 4,
    presentIntervalMsByClient: { ...PRESENT, ...Object.fromEntries(Object.keys(clients).map((tag) => [tag, 0])) },
    ...extra,
  });
}

export default async function harnessPairwiseSuite() {
  await check('harness pairwise: pooled and per-pair statistics are hand-computable', async () => {
    const clients = clientsFrom({
      c01: [0, 10, 20, 30, 40],
      c02: [1, 12, 23, 34, 41],
      c03: [3, 13, 23, 33, 43],
    }, { c02: { 4: { epoch: 2 } } });
    const result = run(clients);
    // Pooled sorted values have 13 points: median 3 and nearest-rank p99 4.
    assertEqual(result.pairwiseDriftAbsMsMedian, 3, 'pooled absolute median is 3 ms');
    assertEqual(result.pairwiseDriftAbsMsP99, 4, 'pooled absolute p99 is 4 ms');
    // c01|c02 has [1,2,3,4]: even n gives (2+3)/2 = 2.5 ms.
    assertEqual(result.pairwiseDriftAbsMsMedianByPair['c01|c02'], 2.5, 'even-n pair median is interpolated');
    assertEqual(result.pairwiseDriftAbsMsMedianByPair['c02|c03'], 1, 'c02|c03 median is 1 ms');
    assertEqual(result.pairwiseDriftAbsMsMedianByPair['c01|c03'], 3, 'c01|c03 median is 3 ms');
    assertEqual(result.instrumentFloorMsP50, 10, 'floor is delay 4 plus age 6 plus present 0');
  });

  await check('harness pairwise: one missing record counts once per affected pair', async () => {
    const clients = clientsFrom({
      c01: [0, 10, 20, 30, 40],
      c02: [1, 11, 21, 31, 41],
      c03: [3, 13, 23, 33, 43],
    });
    clients.c02.records.splice(2, 1);
    const result = run(clients);
    const pairSet = new Set(Object.keys(result.pairwiseDriftPointsUsedByPair));
    assertEqual(JSON.stringify([...pairSet]), JSON.stringify(['c01|c02', 'c01|c03', 'c02|c03']), 'all unordered pairs retain counters');
    assertEqual(result.excludedMissingRecord, 2, 'the missing c02 point affects two pairs');
    assertEqual(result.excludedMissingRecordByPair['c01|c03'], 0, 'the unaffected pair has no missing point');
    assertEqual(result.pairwiseDriftPointsUsedByPair['c01|c03'], 5, 'the unaffected pair keeps all five points');
  });

  await check('harness pairwise: epoch mismatch is excluded rather than differenced', async () => {
    const base = clientsFrom({
      c01: [0, 10, 20, 30, 40],
      c02: [1, 11, 21, 31, 41],
      c03: [3, 13, 23, 33, 43],
    });
    const changed = clientsFrom({
      c01: [0, 10, 20, 30, 40],
      c02: [1, 11, 21, 31, 41],
      c03: [3, 13, 23, 33, 43],
    }, { c02: { 2: { epoch: 2 } } });
    const commonFields = ['seq', 'epochMs', 'mediaMs', 'displaySharedMs', 'driftMs', 'clock'];
    const fixtureComparisons = [];
    for (const tag of TAGS) for (let index = 0; index < 5; index += 1) {
      fixtureComparisons.push({
        tag,
        index,
        same: commonFields.filter((field) => field !== 'epochMs').every((field) => JSON.stringify(base[tag].records[index][field]) === JSON.stringify(changed[tag].records[index][field])),
      });
    }
    for (const comparison of fixtureComparisons) assert(comparison.same, `${comparison.tag}[${comparison.index}] keeps every non-epoch field`);
    const result = run(changed);
    assertEqual(result.excludedMissingRecord, 0, 'epoch mismatch is not counted as missing');
    assertEqual(result.excludedEpochMismatch, 2, 'one changed client epoch excludes its two affected pairs');
    assertEqual(result.excludedEpochMismatchByPair['c01|c02'], 1, 'the changed grid point is excluded from c01|c02');
    assertEqual(result.pairwiseDriftPointsUsed, 13, 'mismatched points never enter pooled values');
  });

  await check('harness pairwise: an epoch-split pair has no by-pair figure', async () => {
    const result = run(clientsFrom({
      c01: [0, 10, 20, 30, 40],
      c02: [1, 11, 21, 31, 41],
      c03: [2, 12, 22, 32, 42],
    }, {
      c02: { 0: { epoch: 2 }, 1: { epoch: 2 }, 2: { epoch: 2 }, 3: { epoch: 2 }, 4: { epoch: 2 } },
      c03: { 0: { epoch: 2 }, 1: { epoch: 2 }, 2: { epoch: 2 }, 3: { epoch: 2 }, 4: { epoch: 2 } },
    }));
    const without = new Set(result.pairsWithoutFigure);
    assert(without.has('c01|c02'), 'the c01|c02 epoch split is named');
    assertEqual(result.pairwiseDriftAbsMsMedianByPair['c01|c02'], undefined, 'the split pair has no median');
    assertEqual(result.pairwiseDriftAbsMsMedianByPair['c02|c03'], 1, 'the same-epoch pair still publishes');
  });

  await check('harness pairwise: both ends produce met, failed and undecidable verdicts', async () => {
    const verdictClients = (drift, terms) => clientsFrom({ c01: [0, 0, 0, 0, 0], c02: [drift, drift, drift, drift, drift] }, {
      c01: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [index, terms])),
      c02: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [index, terms])),
    });
    const met = run(verdictClients(39, { delay: 0, age: 0 }), { targets: { statistic: 'median', targetMs: 40 } });
    const failed = run(verdictClients(41, { delay: 0, age: 0 }), { targets: { statistic: 'median', targetMs: 40 } });
    const undecidable = run(verdictClients(35, { delay: 5, age: 5 }), { targets: { statistic: 'median', targetMs: 40 }, presentIntervalMsByClient: { c01: 10, c02: 10 } });
    const p99Undecidable = run(verdictClients(90, { delay: 5, age: 5 }), { targets: { statistic: 'p99', targetMs: 100 }, presentIntervalMsByClient: { c01: 0, c02: 0 } });
    assertEqual(met.criterionVerdict.verdict, 'met', 'upper median 39 is within 40 ms');
    assertEqual(met.criterionVerdict.statisticOfUpperEnds, 39, 'met upper median has zero floor');
    assertEqual(failed.criterionVerdict.verdict, 'failed', 'lower median 41 exceeds 40 ms');
    assertEqual(failed.criterionVerdict.statisticOfLowerEnds, 41, 'failed lower median has zero floor');
    assertEqual(undecidable.instrumentFloorMsP50, 30, 'undecidable floor is 10+10+10 ms');
    assertEqual(undecidable.criterionVerdict.statisticOfLowerEnds, 5, 'undecidable lower median is 35-30 ms');
    assertEqual(undecidable.criterionVerdict.statisticOfUpperEnds, 65, 'undecidable upper median is 35+30 ms');
    assertEqual(undecidable.criterionVerdict.verdict, 'undecidable', 'the median lies inside its floor');
    assertEqual(undecidable.criterionVerdict.largestFloorTerm, 'delay', 'ties choose delay before age and present');
    assertEqual(p99Undecidable.criterionVerdict.verdict, 'undecidable', 'p99 90 with a 20 ms floor is undecidable');
  });

  await check('harness pairwise: half-width disagreement refuses the figure', async () => {
    const clients = clientsFrom({ c01: [0, 0, 0, 0, 0], c02: [1, 1, 1, 1, 1] }, { c02: { 2: { delay: 5, age: 5, }, 3: { delay: 5, age: 5 } } });
    clients.c02.records[2].clock.halfWidthMs = 11;
    const result = run(clients);
    assertEqual(result.refused, true, 'changed record shape refuses publication');
    assertEqual(result.reason, 'halfwidth-terms-disagree', 'refusal names the shape disagreement');
  });

  await check('harness pairwise: half-interval is included and just beyond is absent', async () => {
    const exact = pairwiseDrift({
      clients: { c01: { records: [record(0, 1, { displaySharedMs: 50 })] }, c02: { records: [record(0, 2, { displaySharedMs: 50 })] } },
      tags: ['c01', 'c02'],
      window: { startMs: 0, endMs: 50 },
      frameRate: 10,
      presentIntervalMsByClient: { c01: 0, c02: 0 },
    });
    const beyond = pairwiseDrift({
      clients: { c01: { records: [record(0, 1, { displaySharedMs: 50.000001 })] }, c02: { records: [record(0, 2, { displaySharedMs: 50.000001 })] } },
      tags: ['c01', 'c02'],
      window: { startMs: 0, endMs: 50.000001 },
      frameRate: 10,
      presentIntervalMsByClient: { c01: 0, c02: 0 },
    });
    assertEqual(exact.pairwiseDriftPointsUsed, 1, 'exactly half an interval is included');
    assertEqual(beyond.reason, 'pairwise-no-points', 'a point beyond half an interval is absent');
  });
}
