// T2 (design.md D2; tasks.md 2.2): the host's uplink capacity estimate, over
// constructed intervals read at the wire. Pure module — no server, no clock.

import { assert, assertEqual, check } from '../harness.mjs';
import { classifyInterval, createCapacityEstimate, createProbePlan, createQueuedRun, MAX_SAMPLE_GAP_MS } from '../../../public/lib/capacity-estimate.mjs';

// One sample every 20 ms from +20 to +1000 of an interval starting at 0, as the host polls.
function samplesOf(count = 50, { inProgress = true, waitingBodyBytes = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({ atMs: (index + 1) * 20, channels: [{ inProgress, waitingBodyBytes }] }));
}

// The canonical link-bound base: every sample has one in-progress channel, bytes on
// the wire, and the echo round trip one millisecond past the margin above its floor.
const MARGIN_MS = 30;

function baseFixture() {
  return {
    samples: samplesOf(),
    startMs: 0,
    wireBytes: 1000,
    handedBytes: 1000,
    queueMs: MARGIN_MS + 1,
    marginMs: MARGIN_MS,
    durationMs: 1000,
    paceBoundMs: 0,
  };
}

const probeInterval = (overrides = {}) => ({ probe: false, linkBound: false, reason: 'pace-bound', rate: 1000, headQueueMs: 0, tailQueueMs: 0, ...overrides });

function withOneSample(samples, index, sample) {
  const copy = samples.map((entry) => entry);
  copy[index] = { ...samples[index], ...sample };
  return copy;
}

export default async function capacityEstimateSuite() {
  await check('capacity-estimate: the median of five link-bound intervals', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    const drained = [1_000_000, 1_100_000, 900_000, 1_200_000, 1_000_000];
    for (const wireBytes of drained) {
      const { linkBound, reason } = classifyInterval({ ...baseFixture(), wireBytes });
      assert(linkBound, `interval at ${wireBytes} B is link-bound`);
      assertEqual(reason, null, 'a link-bound interval names no reason');
      estimate.record({ wireBytes, durationMs: 1000, linkBound });
    }
    const read = estimate.read();
    assertEqual(read.bytesPerSecond, 1_000_000, 'the estimate is the median of the five rates, not their mean (1,040,000)');
    assertEqual(read.intervalsBehind, 5, 'five link-bound intervals are behind the estimate');
    assertEqual(read.linkBoundTotal, 5, 'five link-bound intervals recorded');
    // Mutation probe: staged, then `createCapacityEstimate`'s `read` changed from the
    // sorted middle value to the arithmetic mean (1,040,000). `npm run check` turned
    // the `bytesPerSecond` assertion above red (1,040,000 against the expected
    // 1,000,000). Reverted; check green again.
  });

  await check('capacity-estimate: a round trip at its floor is not link-bound, whatever waits on the channels', async () => {
    // The attempt-3 stall (design.md D2, remedy investigation): bytes waiting on every
    // channel throughout, a trickle on the wire, nothing handed down, no echo answered.
    const unanswered = { ...baseFixture(), wireBytes: 37_000, queueMs: null };
    const unansweredResult = classifyInterval(unanswered);
    assertEqual(unansweredResult.linkBound, false, 'an interval with no echo answered is not link-bound');
    assertEqual(unansweredResult.reason, 'no-queue', 'and says no queue was seen');
    // The paired fixture differs in queueMs only.
    assertEqual(classifyInterval({ ...unanswered, queueMs: MARGIN_MS + 1 }).linkBound, true, 'the same interval with the round trip past its margin is link-bound');
    assertEqual(classifyInterval({ ...unanswered, queueMs: MARGIN_MS }).linkBound, false, 'a round trip at exactly the margin is not a queue');
    // An echo sent before the stall and answered late reads as a queue; the channels
    // handing nothing down is what says stall. The pair differs in handedBytes only.
    const late = { ...baseFixture(), wireBytes: 37_000, queueMs: 2_000, handedBytes: 0 };
    assertEqual(classifyInterval(late).reason, 'stalled', 'a late answer with nothing handed down is a stall, not a link');
    assertEqual(classifyInterval({ ...late, handedBytes: 1 }).linkBound, true, 'the same interval with bytes handed down is link-bound');
    // Mutation probe, staged: the waiting clause restored as T14 had it (link-bound
    // when every in-progress channel has bytes waiting and no pace). `npm run check`
    // turned 'an interval with no echo answered is not link-bound' red (true).
    // Reverted; green. Second probe, staged: the `stalled` return removed. Turned 'a
    // late answer with nothing handed down' red (null), and wire-estimate's stall
    // case with it. Reverted; check green again.
  });

  await check('capacity-estimate: a reading is the wire rate over two consecutive link-bound intervals', async () => {
    const run = createQueuedRun();
    const stood = { linkBound: true, headQueueMs: 400, tailQueueMs: 400 };
    // Attempt 3's intervals 1 and 2: one count 40 % off, the two together the link.
    assertEqual(run.add({ wireBytes: 1_750_000, durationMs: 1000, ...stood }), null, 'one link-bound interval is not a reading');
    const reading = run.add({ wireBytes: 790_000, durationMs: 1000, ...stood });
    assertEqual(reading.wireBytes, 2_540_000, 'the reading sums the pair’s wire bytes');
    assertEqual(reading.durationMs, 2000, 'over the pair’s duration');
    assertEqual(run.add({ wireBytes: 1_000_000, durationMs: 1000, ...stood }), null, 'a third interval starts the next pair');
    assertEqual(run.add({ wireBytes: 5, durationMs: 1000, linkBound: false }), null, 'an interval that is not link-bound ends the run');
    assertEqual(run.add({ wireBytes: 1_000_000, durationMs: 1000, ...stood }), null, 'and the next link-bound interval is alone again');
    assertEqual(run.add({ wireBytes: 1_200_000, durationMs: 1000, ...stood }).wireBytes, 2_200_000, 'the broken run’s lone interval is not in the next reading');
    // Mutation probe, staged: createQueuedRun's default set to one interval. `npm run
    // check` turned 'one link-bound interval is not a reading' red. Reverted; green.
    // Second probe, staged: the reset on a non-link-bound interval removed. Turned
    // 'and the next link-bound interval is alone again' red. Reverted; green.
  });

  await check('capacity-estimate: a pair across which the round trip rose gives no reading', async () => {
    const run = createQueuedRun({ marginMs: MARGIN_MS, chunkBytes: 65_528 });
    const pair = (wireBytes, [startMs, midMs], [nextMs, endMs]) => {
      run.add({ wireBytes, durationMs: 1000, linkBound: true, headQueueMs: startMs, tailQueueMs: midMs });
      return run.add({ wireBytes, durationMs: 1000, linkBound: true, headQueueMs: nextMs, tailQueueMs: endMs });
    };
    // Attempt 4's intervals 3 and 4 (design.md D2, start-hold repair): the echo read
    // 65 ms, then 498 ms, and the pair's wire count read 1.43 x the 1.25 MB/s link.
    assertEqual(pair(1_793_765, [65, 65], [498, 498]), null, 'a pair the queue filled across is not the link');
    assertEqual(pair(1_250_000, [498, 500], [500, 498]).wireBytes, 2_500_000, 'the next pair, on a standing queue, is');
    // One chunk takes 52 ms at 1.25 MB/s, and an echo may wait behind one more.
    assertEqual(pair(1_250_000, [400, 400], [440, 482]).wireBytes, 2_500_000, 'a rise of the margin and one chunk’s time is not a fill');
    assertEqual(pair(1_250_000, [400, 400], [440, 483]), null, 'a millisecond more is');
    assertEqual(pair(1_250_000, [900, 700], [500, 300]).wireBytes, 2_500_000, 'a falling queue still reads');
    assertEqual(pair(1_250_000, [null, 400], [400, null]).wireBytes, 2_500_000, 'a silent half takes the pair’s other half');
    assertEqual(pair(1_250_000, [null, null], [400, 400]), null, 'a first interval with no answer cannot say the queue stood');
    assertEqual(pair(1_250_000, [400, 400], [null, null]), null, 'nor a last one');
    // Mutation probe, staged: createQueuedRun's `stood` set true. `npm run check`
    // turned 'a pair the queue filled across is not the link' red (a reading of
    // 3 587 530 bytes). Reverted; green again.
  });

  await check('capacity-estimate: a probe raises the estimate only if the round trip stayed flat through it and the next interval', async () => {
    const plan = () => createProbePlan({ after: 10, factor: 1.1, marginMs: MARGIN_MS });
    const flat = plan();
    assertEqual(flat.close(probeInterval({ probe: true, rate: 1080 }), 1000).raiseTo, null, 'a probe is not judged until the next interval closes');
    assertEqual(flat.close(probeInterval(), 1000).raiseTo, 1080, 'flat through both: raised to the probe’s wire rate');
    const capped = plan();
    capped.close(probeInterval({ probe: true, rate: 1500 }), 1000);
    assertEqual(capped.close(probeInterval(), 1000).raiseTo, 1100, 'one interval’s wire count cannot raise past the probed 1.1 ×');
    // Attempt 3's probe 197: the bucket bound it, the wire read 1.21 × the link, and
    // the queue it grew shows in its second half. The pair differs in tailQueueMs only.
    const queuedTail = plan();
    queuedTail.close(probeInterval({ probe: true, rate: 1080, tailQueueMs: MARGIN_MS + 1 }), 1000);
    const afterTail = queuedTail.close(probeInterval(), 1000);
    assertEqual(afterTail.raiseTo, null, 'a queue in the probe’s second half refuses the raise');
    assertEqual(afterTail.climbing, false, 'and ends the climb');
    const queuedNext = plan();
    queuedNext.close(probeInterval({ probe: true, rate: 1080 }), 1000);
    assertEqual(queuedNext.close(probeInterval({ headQueueMs: MARGIN_MS + 1 }), 1000).raiseTo, null, 'a queue in the next interval’s first half refuses the raise');
    const unanswered = plan();
    unanswered.close(probeInterval({ probe: true, rate: 1080, tailQueueMs: null }), 1000);
    const afterUnanswered = unanswered.close(probeInterval(), 1000);
    assertEqual(afterUnanswered.raiseTo, null, 'no echo answered in the probe’s second half is not flat');
    assertEqual(afterUnanswered.climbing, true, 'but it is not a queue seen, so the climb goes on');
    const unbound = plan();
    unbound.close(probeInterval({ probe: true, rate: 1080, reason: 'no-queue' }), 1000);
    assertEqual(unbound.close(probeInterval(), 1000).raiseTo, null, 'a probe the bucket did not bind proved nothing');
    // Mutation probe, staged: the `seen(pending.tailQueueMs)` term and the
    // `flat(pending.tailQueueMs)` term removed from createProbePlan. `npm run check`
    // turned 'a queue in the probe's second half refuses the raise' red (1080).
    // Reverted; green. Second probe, staged:
    // the `Math.min` cap removed. Turned 'cannot raise past the probed 1.1 ×' red
    // (1500). Reverted; green.
  });

  await check('capacity-estimate: the host climbs after every pace-bound interval until a probe meets a queue, then after ten', async () => {
    const plan = createProbePlan({ after: 10, factor: 1.1, marginMs: MARGIN_MS });
    assertEqual(plan.close(probeInterval({ reason: 'no-queue' }), null).probeNext, false, 'no probe before the pace binds');
    assertEqual(plan.close(probeInterval(), 1000).probeNext, true, 'climbing: a probe follows one pace-bound interval');
    assertEqual(plan.close(probeInterval({ probe: true, rate: 1080 }), 1000).probeNext, false, 'no probe straight after a probe');
    const second = plan.close(probeInterval(), 1000);
    assertEqual(second.raiseTo, 1080, 'the first probe raised');
    assertEqual(second.probeNext, true, 'and the next follows at once: 10 % every 2 s');
    plan.close(probeInterval({ probe: true, rate: 1180, tailQueueMs: 80 }), 1080);
    let after = plan.close(probeInterval(), 1080);
    assertEqual(after.climbing, false, 'the probe that met a queue ended the climb');
    assertEqual(after.probeNext, false, 'one pace-bound interval is no longer enough');
    for (let index = 0; index < 8; index += 1) after = plan.close(probeInterval(), 1080);
    assertEqual(after.probeNext, false, 'nine pace-bound intervals: not yet');
    assertEqual(plan.close(probeInterval(), 1080).probeNext, true, 'ten: probe');
    plan.close(probeInterval({ probe: true }), 1080);
    assertEqual(plan.close(probeInterval({ linkBound: true, reason: null }), 1080).probeNext, false, 'a link-bound interval restarts the count');
    // Mutation probe, staged: `climbing` initialised false. `npm run check` turned
    // 'climbing: a probe follows one pace-bound interval' red. Reverted; green.
  });

  await check('capacity-estimate: the estimate forms at the first reading, and its window fills to five', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    estimate.record({ wireBytes: 1_000_000, durationMs: 1000, linkBound: true });
    const afterOne = estimate.read();
    assertEqual(afterOne.bytesPerSecond, 1_000_000, 'one reading forms the estimate');
    assertEqual(afterOne.intervalsBehind, 1, 'one reading is behind it');
    // Mutation probe, staged (T14): `read` publishing null below five rates, as before
    // the reversal. `npm run check` turned this assertion red (null). Reverted; green.
    for (const wireBytes of [400_000, 1_200_000, 1_100_000, 900_000, 1_300_000]) estimate.record({ wireBytes, durationMs: 1000, linkBound: true });
    assertEqual(estimate.read().intervalsBehind, 5, 'the window holds five');
    assertEqual(estimate.read().bytesPerSecond, 1_100_000, 'the median of the last five, the first gone');
  });

  await check('capacity-estimate: a raise replaces every rate behind the estimate', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    for (let index = 0; index < 5; index += 1) estimate.record({ wireBytes: 600_000, durationMs: 1000, linkBound: true });
    estimate.raise(700_000);
    assertEqual(estimate.read().bytesPerSecond, 700_000, 'the raised rate is the estimate at once');
    assertEqual(estimate.read().intervalsBehind, 1, 'one rate is behind it');
    estimate.record({ wireBytes: 650_000, durationMs: 1000, linkBound: true });
    assertEqual(estimate.read().bytesPerSecond, 700_000, 'later rates join the raised one, not the old window');
    let threw = false;
    try { estimate.raise(0); } catch { threw = true; }
    assert(threw, 'a raise to zero throws');
  });

  await check('capacity-estimate: a round trip past its margin is link-bound, whatever the pace and the channels', async () => {
    const base = baseFixture();
    const queued = { ...base, paceBoundMs: 400, wireBytes: 500_000,
      samples: withOneSample(base.samples, 10, { channels: [{ inProgress: true, waitingBodyBytes: 0 }] }) };
    assertEqual(classifyInterval(queued).linkBound, true, 'a queue seen under the pace is link-bound');
    assertEqual(classifyInterval({ ...queued, queueMs: 0 }).reason, 'pace-bound', 'the same interval with a flat round trip is pace-bound');
    // Mutation probe, staged: the queue clause moved below the pace-bound return.
    // `npm run check` turned 'a queue seen under the pace is link-bound' red, and
    // wire-estimate's fall under the pace with it. Reverted; check green again.
  });

  await check('capacity-estimate: falling capacity is read from the last window, not the whole history', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    for (let index = 0; index < 5; index += 1) estimate.record({ wireBytes: 1_250_000, durationMs: 1000, linkBound: true });
    for (let index = 0; index < 5; index += 1) estimate.record({ wireBytes: 600_000, durationMs: 1000, linkBound: true });
    const read = estimate.read();
    assertEqual(read.bytesPerSecond, 600_000, 'the estimate follows the last five intervals, not the median over all ten');
    assertEqual(read.linkBoundTotal, 10, 'ten link-bound intervals were recorded in total');
    // Mutation probe: staged, then `record` changed to keep every rate (no `shift`
    // once past `window`) and `read` changed to take the median over the whole
    // history. `npm run check` turned the `bytesPerSecond` assertion above red
    // (925,000 — the median of all ten rates — against the expected 600,000).
    // Reverted; check green again.
  });

  await check('capacity-estimate: a non-link-bound interval changes nothing in the estimate', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    for (let index = 0; index < 5; index += 1) estimate.record({ wireBytes: 1_000_000, durationMs: 1000, linkBound: true });
    const before = estimate.read();
    estimate.record({ wireBytes: 50, durationMs: 1000, linkBound: false });
    const after = estimate.read();
    assertEqual(after.bytesPerSecond, before.bytesPerSecond, 'a non-link-bound interval does not move the estimate');
    assertEqual(after.linkBoundTotal, before.linkBoundTotal, 'a non-link-bound interval is not counted');
  });

  await check('capacity-estimate: before any interval, the estimate is null with zero intervals', async () => {
    const read = createCapacityEstimate({ window: 5 }).read();
    assertEqual(read.bytesPerSecond, null, 'no interval yet: no estimate');
    assertEqual(read.intervalsBehind, 0, 'no interval yet: zero behind');
    assertEqual(read.linkBoundTotal, 0, 'no interval yet: zero total');
  });

  await check('capacity-estimate: reason names each failing condition once, on fixtures that differ in that condition only', async () => {
    const base = baseFixture();
    assertEqual(classifyInterval(base).reason, null, 'the base fixture is link-bound');

    const gap = { ...base, samples: base.samples.filter((_, index) => index < 20 || index > 22) };
    assertEqual(classifyInterval(gap).reason, 'sample-gap', 'three missing polls, an 80 ms gap, is sample-gap');

    const noRequest = { ...base, samples: withOneSample(base.samples, 10, { channels: [{ inProgress: false, waitingBodyBytes: 1 }] }) };
    assertEqual(classifyInterval(noRequest).reason, 'no-request', 'a sample with no in-progress channel is no-request');

    assertEqual(classifyInterval({ ...base, queueMs: 0 }).reason, 'no-queue', 'a flat round trip with no pace is no-queue');

    const paceBound = { ...base, queueMs: 0, paceBoundMs: 1 };
    assertEqual(classifyInterval(paceBound).reason, 'pace-bound', 'a nonzero pace-bound time is pace-bound');

    const noWire = { ...base, wireBytes: 0, handedBytes: 0 };
    assertEqual(classifyInterval(noWire).reason, 'no-wire', 'zero wire bytes is no-wire');
    assertEqual(classifyInterval({ ...base, wireBytes: null }).reason, 'no-wire', 'a missing wire reading is no-wire');
  });

  await check('capacity-estimate: coverage is judged by the largest gap, its edges included, not by a count', async () => {
    // 40 samples 25 ms apart, a loaded page's slower timer: fewer than the old floor
    // of 48, and every gap well inside the bound.
    const slow = Array.from({ length: 40 }, (_, index) => ({ atMs: (index + 1) * 25, channels: [{ inProgress: true, waitingBodyBytes: 1 }] }));
    assertEqual(classifyInterval({ ...baseFixture(), samples: slow }).linkBound, true, 'a 25 ms timer is link-bound');
    const edge = MAX_SAMPLE_GAP_MS + 1;
    const lateStart = samplesOf().filter(({ atMs }) => atMs >= edge);
    assertEqual(classifyInterval({ ...baseFixture(), samples: lateStart }).reason, 'sample-gap', 'an unsampled start is a gap');
    const earlyEnd = samplesOf().filter(({ atMs }) => atMs <= 1000 - edge);
    assertEqual(classifyInterval({ ...baseFixture(), samples: earlyEnd }).reason, 'sample-gap', 'an unsampled end is a gap');
    const atBound = samplesOf().filter(({ atMs }) => atMs !== 500 && atMs !== 520);
    assertEqual(classifyInterval({ ...baseFixture(), samples: atBound }).linkBound, true, 'a gap of exactly the bound is covered');
    const unstamped = samplesOf().map(({ channels }) => ({ channels }));
    assertEqual(classifyInterval({ ...baseFixture(), samples: unstamped }).reason, 'sample-gap', 'samples without instants fail closed');
    // Mutation probe, staged: largestGapMs's final `endMs - previous` term dropped.
    // `npm run check` turned 'an unsampled end is a gap' red. Reverted; check green.
  });

  await check('capacity-estimate: impossible interval values throw, in both classifyInterval and record', async () => {
    const base = baseFixture();
    for (const durationMs of [0, -1]) {
      let threw = false;
      try { classifyInterval({ ...base, durationMs }); } catch { threw = true; }
      assert(threw, `classifyInterval throws for durationMs = ${durationMs}`);
    }
    let negativeThrew = false;
    try { classifyInterval({ ...base, wireBytes: -1 }); } catch { negativeThrew = true; }
    assert(negativeThrew, 'classifyInterval throws for a negative wireBytes');
    let queueThrew = false;
    try { classifyInterval({ ...base, queueMs: -1 }); } catch { queueThrew = true; }
    assert(queueThrew, 'classifyInterval throws for a round trip below its floor');

    const estimate = createCapacityEstimate({ window: 5 });
    for (const durationMs of [0, -1]) {
      let threw = false;
      try { estimate.record({ wireBytes: 1000, durationMs, linkBound: true }); } catch { threw = true; }
      assert(threw, `record throws for durationMs = ${durationMs}`);
    }
    let recordNegativeThrew = false;
    try { estimate.record({ wireBytes: -1, durationMs: 1000, linkBound: true }); } catch { recordNegativeThrew = true; }
    assert(recordNegativeThrew, 'record throws for a negative wireBytes');
  });
}
