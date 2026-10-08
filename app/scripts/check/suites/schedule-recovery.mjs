// 9b design.md D5: recovery counted from the rise's read-back, with the
// held-ahead leg on every span, and no verdict for a run that was not exercised.

import { assert, assertEqual, check } from '../harness.mjs';
import { scheduleRecovery } from '../../figures/schedule-recovery.mjs';
import { computeControlFigures } from '../../figures/control-figures.mjs';
import { heldAheadAt } from '../../figures/poll-coverage.mjs';

const TAGS = ['c01', 'c02'];
const RISE_AT_MS = 400_000;
const step = (rate, at, inForce = true) => ({ declared: { params: { rate, burst: '32kbit', latency: '400ms' } },
  readBack: {}, appliedAtMs: at - 50, readBackAtMs: at, inForce });
const schedule = (overrides = {}) => ({ drop: step('2mbit', 120_000), rise: step('10mbit', RISE_AT_MS),
  edge: { reached: true, atMs: 399_900, heldAheadMsByClient: { c01: 9_000, c02: 14_000 } }, exercised: true, ...overrides });

// One poll per viewer 100 ms before each span's end, at `aheadAt(tag, spanIndex)`.
function input(aheadAt = () => 20_000, earlyMs = 100) {
  const viewerPolls = Object.fromEntries(TAGS.map((tag) => [tag, [0, 1, 2, 3, 4].map((index) => ({
    harnessAfterMs: RISE_AT_MS + (index + 1) * 60_000 - earlyMs, heldAhead: { heldAheadMs: aheadAt(tag, index) } }))]));
  return { declaredClientTags: TAGS, viewerPolls,
    condition: { reading: { aheadMsMin: 15_000 }, capacitySchedule: { recordAfterRiseMs: 300_000 } } };
}

// The steady legs' verdicts are constructed; the span windows are the ones asked for.
const steadySpans = (verdicts, seen = {}) => ({ transition, recordingEnd, spanMs, capacityBitsPerSecond }) => {
  Object.assign(seen, { transition, recordingEnd, capacityBitsPerSecond });
  return { trailingMs: 0, spans: verdicts.map((pass, index) => ({ window: { startMs: transition + index * spanMs, endMs: transition + (index + 1) * spanMs },
    legs: { utilisation: { pass } }, incomplete: false, pass, failedLegs: pass ? [] : ['utilisation'] })) };
};

const recovered = (verdicts, options = {}) => scheduleRecovery({ input: input(options.aheadAt, options.earlyMs), schedule: schedule(),
  recordingEnd: 705_000, spansOf: steadySpans(verdicts, options.seen) });

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function scheduleRecoverySuite() {
  await check('schedule recovery: spans run from the rise\'s read-back at the risen capacity', async () => {
    const seen = {};
    const result = recovered([true, true, true, true, true], { seen });
    assertEqual(seen.transition, 400_000, 'the spans begin at the rise\'s read-back');
    assertEqual(seen.recordingEnd, 700_000, 'and end 300 000 ms after it, not at the recording\'s end');
    assertEqual(seen.capacityBitsPerSecond, 10_000_000, 'at the rise\'s 10 Mbit/s');
    assertEqual(result.result.recoveryMs, 0, 'five passing spans: recovered at 0 ms');
    assertEqual(recovered([false, false, false, false, true]).result.recoveryMs, 240_000, 'four failing then one passing: 240 000 ms');
    const never = recovered([false, false, false, false, false]).result;
    assertEqual(`${never.recovered}/${never.recoveryMs}`, 'false/null', 'five failing: not recovered');
  });

  await check('schedule recovery: a viewer at 9 000 ms at a span\'s end fails that span on the held-ahead leg', async () => {
    // The pair differs only in c02's held-ahead at the end of the third span.
    const ahead = recovered([true, true, true, true, true]);
    const atEdge = recovered([true, true, true, true, true], { aheadAt: (tag, index) => (tag === 'c02' && index === 2 ? 9_000 : 20_000) });
    assertEqual(ahead.spans[2].pass, true, 'with every viewer 20 000 ms ahead the span passes');
    assertEqual(atEdge.spans[2].pass, false, 'with one at 9 000 ms it does not');
    assertEqual(atEdge.spans[2].failedLegs.join(','), 'heldAhead', 'on the held-ahead leg alone');
    assertEqual(atEdge.spans[2].legs.heldAhead.byClient.c02, 9_000, 'which names the viewer\'s 9 000 ms');
    assertEqual(atEdge.spans[2].legs.heldAhead.bar, 15_000, 'against the declared 15 000 ms');
    assertEqual(atEdge.result.recoveryMs, 180_000, 'and recovery is counted from the span after it');
    const exactly = recovered([true, true, true, true, true], { aheadAt: () => 15_000 });
    assertEqual(exactly.spans[0].pass, false, 'holding exactly 15 000 ms is not more than it');
    const early = recovered([true, true, true, true, true], { earlyMs: 1_800 });
    assertEqual(early.spans[0].legs.heldAhead.byClient.c01, null, 'a poll 1 800 ms before the span\'s end is no value');
    assertEqual(early.spans[0].pass, false, 'and no value does not pass');
    assertEqual(heldAheadAt(input().viewerPolls, TAGS, 460_000).c01, 20_000, 'a poll 100 ms before it is one');
  });

  await check('schedule recovery: a run that did not reach its edge has no recovery result', async () => {
    const edge = { reached: false, atMs: 360_000, heldAheadMsByClient: { c01: 9_000, c02: 22_000 } };
    const result = scheduleRecovery({ input: input(), schedule: schedule({ edge, exercised: false }), recordingEnd: 705_000,
      spansOf: steadySpans([true, true, true, true, true]) });
    assertEqual(result.notExercised, true, 'not exercised');
    assertEqual(result.edge.heldAheadMsByClient.c02, 22_000, 'naming the viewer and its 22 000 ms');
    assert(!('spans' in result) && !('result' in result), 'with no spans and no verdict');
    assertEqual(scheduleRecovery({ input: input(), schedule: null, recordingEnd: 705_000 }), null, 'a run with no schedule has no reading');
    const notInForce = scheduleRecovery({ input: input(), schedule: schedule({ drop: step('2mbit', 120_000, false), rise: null }), recordingEnd: 705_000 });
    assertEqual(notInForce.notInForce, true, 'a schedule not in force reads as that, not as a recovery');
    const backwards = await thrownBy(async () => scheduleRecovery({ input: input(), schedule: schedule({ rise: step('10mbit', 100_000) }), recordingEnd: 705_000 }));
    assert(backwards instanceof RangeError, 'a rise recorded before its drop is a hard error');
  });

  await check('schedule recovery: a start hold\'s spans stop at the drop', async () => {
    const poll = (at, held) => ({ harnessBeforeMs: at - 10, harnessAfterMs: at, pageWallMs: at + 1_000, sharedMs: at, clock: { halfWidthMs: 2 },
      state: { held, lineage: 'l', version: held ? 1 : 2, atSharedMs: held ? 0 : 2_000 } });
    const base = { condition: { peerExchange: true, bars: {} }, declaredClientTags: ['c01'], clients: { c01: { records: [], polls: [] } },
      hostPoll: [poll(0, true), poll(2_000, false), poll(700_000, false)], viewerPolls: { c01: [] },
      clockJoin: { c01: { joined: [{ cdpMs: 1, recvSharedMs: 1_000 }] } },
      resumes: { records: [{ seq: 1, identity: { lineage: 'l', version: 1 }, cause: 'ready', issuedAtSharedMs: 1_500, holdMs: 500 }] } };
    const without = computeControlFigures(base);
    const withDrop = computeControlFigures({ ...base, capacitySchedule: schedule() });
    assertEqual(without.recovery.start.spans.length, 11, 'with no schedule the start\'s spans run to the recording\'s end');
    assertEqual(withDrop.recovery.start.spans.length, 1, 'with a drop applied at 119 950 ms, one whole span fits before it');
  });
}
