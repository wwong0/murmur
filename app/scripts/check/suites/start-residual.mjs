// scripts/check/suites/start-residual.mjs
//
// The scheduled-start residual over constructed records. Pure. The bar is a
// 40ms interval and the population 24, off the 41.67ms content interval, so a
// constant bar cannot pass.

import { check, assertEqual } from '../harness.mjs';
import { startResidual } from '../../start-residual.mjs';

const START = Object.freeze({ attemptId: 3, afterSeq: 100, startAtSharedMs: 5000, playAtSharedMs: 5004, latenessMs: 4, positionMs: 250 });
const BAR = 40;

/** `count` records from seq 101, alternating `a`/`b` drift so the median is their mean. */
function records(count, { a, b = a, epochMs = 7000, edit = () => ({}) } = {}) {
  return Array.from({ length: count }, (_, i) => ({ seq: 101 + i, driftMs: i % 2 === 0 ? a : b, epochMs, ...edit(i) }));
}

const residual = (overrides) => startResidual({ records: records(24, { a: 10 }), start: START, nextAfterSeq: Infinity, frameIntervalMs: BAR, population: 24, ...overrides });

export default async function startResidualSuite() {
  await check('start residual: the median is judged against one frame interval, both signs, inclusive', async () => {
    const atBar = residual({ records: records(24, { a: BAR }) });
    assertEqual(atBar.status, 'met', 'median exactly at the bar is met');
    assertEqual(atBar.medianMs, BAR, 'and reports it');
    assertEqual(atBar.count, 24, 'over the population');
    assertEqual(atBar.firstSeq, 101, 'first record after the start');
    assertEqual(atBar.lastSeq, 124, 'last record of the population');
    assertEqual(residual({ records: records(24, { a: BAR + 0.001 }) }).status, 'missed', 'bar + 0.001 is missed');
    assertEqual(residual({ records: records(24, { a: -BAR }) }).status, 'met', 'negative median at the bar is met');
    assertEqual(residual({ records: records(24, { a: -BAR - 0.001 }) }).status, 'missed', 'negative bar - 0.001 is missed');
    // Even population: the mean of the middle two, not the upper one.
    assertEqual(residual({ records: records(24, { a: 30, b: 50 }) }).medianMs, 40, 'even count takes the mean of the middle two');
  });

  await check('start residual: only records after the start, in seq order, first 24', async () => {
    const before = [{ seq: 100, driftMs: 999, epochMs: 7000 }, { seq: 99, driftMs: 999, epochMs: 7000 }];
    const shuffled = [...records(30, { a: 10, edit: (i) => (i >= 24 ? { driftMs: 999 } : {}) })].reverse();
    const result = residual({ records: [...before, ...shuffled, { seq: 131, driftMs: Number.NaN, epochMs: 7000 }] });
    assertEqual(result.status, 'met', 'records at or before afterSeq, beyond 24, and non-finite are ignored');
    assertEqual(result.medianMs, 10, 'the median is of the first 24 after the start');
  });

  await check('start residual: short, mixed and absent are their own outcomes', async () => {
    assertEqual(residual({ records: records(23, { a: 10 }) }).status, 'short', '23 records is short');
    assertEqual(residual({ records: records(23, { a: 10 }) }).count, 23, 'and counts what it had');
    assertEqual(residual({ nextAfterSeq: 123 }).status, 'mixed', 'a record from the next seam among the 24 is mixed');
    assertEqual(residual({ nextAfterSeq: 124 }).status, 'met', 'the next seam just after the 24th is not');
    assertEqual(residual({ records: records(24, { a: 10, edit: (i) => (i === 12 ? { epochMs: 7001 } : {}) }) }).status, 'mixed', 'an epoch change is mixed');
    for (const [name, overrides] of [
      ['null start', { start: null }],
      ['start without afterSeq', { start: { ...START, afterSeq: undefined } }],
      ['fractional afterSeq', { start: { ...START, afterSeq: 100.5 } }],
      ['records not an array', { records: null }],
      ['no frame interval', { frameIntervalMs: Number.NaN }],
    ]) {
      assertEqual(residual(overrides).status, 'absent', `${name} is absent`);
    }
  });
}
