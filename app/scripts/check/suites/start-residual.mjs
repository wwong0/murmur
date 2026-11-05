// scripts/check/suites/start-residual.mjs
//
// The scheduled-start residual over constructed records. Pure. The bar is a
// 40ms interval and the population 24, off the 41.67ms content interval, so a
// constant bar cannot pass.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { seamEpochAgreement, startLead, startResidual } from '../../start-residual.mjs';

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

  // `startLead` is a separate export and asks a different question: after the
  // residual population has gone by, is the start running AHEAD of the room?
  // The residual reducer above is frozen and nothing here touches it.
  await check('start lead: one-sided against U, over the records after the residual population', async () => {
    const U = 30;
    // The first 24 are wildly ahead and must not count; only the tail does.
    const tailed = (count, tailMs) => Array.from({ length: count }, (_, i) => ({ seq: 101 + i, driftMs: i < 24 ? 9999 : tailMs, epochMs: 7000 }));
    const lead = (overrides) => startLead({ records: tailed(48, 0), start: START, nextAfterSeq: Infinity, skip: 24, minCount: 24, uncertaintyMs: U, ...overrides });

    const skipped = lead({});
    assertEqual(skipped.status, 'held', 'a start whose tail sits on the room is held');
    assertEqual(skipped.medianMs, 0, 'and the first 24 records, however far ahead, are not in the median');
    assertEqual(skipped.count, 24, 'the population is what is left after the skip');
    assertEqual(skipped.uncertaintyMs, U, 'and it reports the tolerance it judged against');
    assertEqual(lead({ records: tailed(48, U) }).status, 'held', 'a median exactly at +U is held');
    assertEqual(lead({ records: tailed(48, U) }).medianMs, U, 'and reports it');
    assertEqual(lead({ records: tailed(48, U + 0.001) }).status, 'lead', 'U + 0.001 ahead is a lead');
    // One-sided on purpose: behind the room is the residual's question, not this one.
    assertEqual(lead({ records: tailed(48, -U) }).status, 'held', 'the same magnitude behind the room is held');
    assertEqual(lead({ records: tailed(48, -9999) }).status, 'held', 'and so is far behind it');
  });

  await check('start lead: short, the next seam, and absent are their own outcomes — never a pass', async () => {
    const U = 30;
    const tailed = (count, tailMs, lateMs = tailMs) => Array.from({ length: count }, (_, i) => ({
      seq: 101 + i, driftMs: i < 24 ? 9999 : (i < 48 ? tailMs : lateMs), epochMs: 7000,
    }));
    const lead = (overrides) => startLead({ records: tailed(48, 0), start: START, nextAfterSeq: Infinity, skip: 24, minCount: 24, uncertaintyMs: U, ...overrides });

    assertEqual(lead({ records: tailed(47, 0) }).status, 'short', '23 records after the skip is short');
    assertEqual(lead({ records: tailed(47, 0) }).count, 23, 'and counts what it had');
    // The pair differs in the seam alone: the same 72 records, judged with
    // and without the 24 that belong to the next start.
    const acrossSeam = tailed(72, 0, 999);
    assertEqual(lead({ records: acrossSeam }).status, 'lead', 'records from the next seam drag the median over the bar');
    assertEqual(lead({ records: acrossSeam, nextAfterSeq: 148 }).status, 'held', 'bounded at the next seam, the same start is held');
    assertEqual(lead({ records: acrossSeam, nextAfterSeq: 148 }).count, 24, 'over the records that belong to it');

    for (const [name, overrides] of [
      ['null start', { start: null }],
      ['start without afterSeq', { start: { ...START, afterSeq: undefined } }],
      ['fractional afterSeq', { start: { ...START, afterSeq: 100.5 } }],
      ['records not an array', { records: null }],
      ['no tolerance', { uncertaintyMs: undefined }],
      ['non-finite tolerance', { uncertaintyMs: Number.NaN }],
      ['infinite tolerance', { uncertaintyMs: Infinity }],
      ['negative skip', { skip: -1 }],
    ]) {
      const result = lead(overrides);
      assertEqual(result.status, 'absent', `${name} is absent`);
      assert(result.status !== 'held', `${name} is not read as a pass`);
    }
  });

  // §15 item 4. The park is advanced, so `S - positionMs` and `S -
  // scheduledPositionMs` differ by exactly the advance: a seam that derived its
  // epoch from the physical park is off by one content frame, and nothing else
  // in the run would notice, because the controller drops its window by seq.
  await check('seam epoch: the room mapping epoch, not S minus the advanced park', async () => {
    const ADVANCE = 1000 / 24;
    const SCHEDULED = 250;
    const S = 5000;
    const ROOM_EPOCH = S - SCHEDULED;
    const seam = (epochMs) => ({ afterSeq: 100, startAtSharedMs: S, scheduledPositionMs: SCHEDULED, positionMs: SCHEDULED + ADVANCE, advanceMs: ADVANCE, epochMs });
    const at = (epochMs) => records(24, { a: 0, epochMs });
    const agreement = (overrides) => seamEpochAgreement({ start: seam(ROOM_EPOCH), records: at(ROOM_EPOCH), ...overrides });

    const held = agreement({});
    assertEqual(held.status, 'agrees', 'a seam carrying the room mapping epoch agrees');
    assertEqual(held.fromRoomMs, ROOM_EPOCH, 'and the room figure is S minus the ROOM position');
    assertEqual(held.deltaMs, 0, 'with no gap between them');
    assertEqual(held.recordEpochMs, ROOM_EPOCH, 'and the first accepted record carries the same epoch');

    // This pair differs in the seam epoch alone.
    const derived = agreement({ start: seam(S - (SCHEDULED + ADVANCE)) });
    assertEqual(derived.status, 'derived', 'a seam that derived its epoch from the advanced park is caught');
    assertNear(derived.deltaMs, -ADVANCE, 0.001, 'and the gap it reports is exactly the advance');

    // The seam can agree with the room and still disagree with what the
    // timeline gave the records; both halves are load-bearing.
    assertEqual(agreement({ records: at(ROOM_EPOCH - ADVANCE) }).status, 'derived', 'a seam whose records carry a different epoch is caught too');
    assertEqual(agreement({ start: { ...seam(ROOM_EPOCH), advanceMs: 0, positionMs: SCHEDULED } }).status, 'agrees', 'and an untreated start, where the two terms coincide, still agrees');

    for (const [name, overrides] of [
      ['null start', { start: null }],
      ['no epoch', { start: { ...seam(ROOM_EPOCH), epochMs: undefined } }],
      ['non-finite epoch', { start: { ...seam(ROOM_EPOCH), epochMs: Number.NaN } }],
      ['no scheduled position', { start: { ...seam(ROOM_EPOCH), scheduledPositionMs: undefined } }],
      ['no S', { start: { ...seam(ROOM_EPOCH), startAtSharedMs: Infinity } }],
      ['records not an array', { records: null }],
      ['no records after the seam', { records: [] }],
      ['records without an epoch', { records: records(24, { a: 0, epochMs: Number.NaN }) }],
    ]) {
      const result = seamEpochAgreement({ start: seam(ROOM_EPOCH), records: at(ROOM_EPOCH), ...overrides });
      assertEqual(result.status, 'absent', `${name} is absent`);
      assert(result.status !== 'agrees', `${name} is not read as a pass`);
    }
  });
}
