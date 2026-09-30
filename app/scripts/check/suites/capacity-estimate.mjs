// T2 (design.md D2; tasks.md 2.2): the host's uplink capacity estimate, over
// constructed drain intervals. Pure module — no server, no clock.

import { assert, assertEqual, check } from '../harness.mjs';
import { classifyInterval, createCapacityEstimate, MIN_LINK_BOUND_SAMPLES } from '../../../public/lib/capacity-estimate.mjs';

function samplesOf(count, { inProgress = true, waitingBodyBytes = 1 } = {}) {
  return Array.from({ length: count }, () => ({ channels: [{ inProgress, waitingBodyBytes }] }));
}

// The canonical link-bound base: every one of MIN_LINK_BOUND_SAMPLES samples has one
// in-progress channel with bytes waiting, no pace-bound time, and a real drain.
function baseFixture() {
  return {
    samples: samplesOf(MIN_LINK_BOUND_SAMPLES),
    drainedBodyBytes: 1000,
    durationMs: 1000,
    paceBoundMs: 0,
  };
}

function withOneSample(samples, index, sample) {
  const copy = samples.map((entry) => entry);
  copy[index] = sample;
  return copy;
}

export default async function capacityEstimateSuite() {
  await check('capacity-estimate: the median of five link-bound intervals', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    const drained = [1_000_000, 1_100_000, 900_000, 1_200_000, 1_000_000];
    for (const drainedBodyBytes of drained) {
      const { linkBound, reason } = classifyInterval({
        samples: samplesOf(MIN_LINK_BOUND_SAMPLES), drainedBodyBytes, durationMs: 1000, paceBoundMs: 0,
      });
      assert(linkBound, `interval at ${drainedBodyBytes} B is link-bound`);
      assertEqual(reason, null, 'a link-bound interval names no reason');
      estimate.record({ drainedBodyBytes, durationMs: 1000, linkBound });
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

  await check('capacity-estimate: an idle channel is not link-bound', async () => {
    const base = baseFixture();
    const idle = { ...base, samples: withOneSample(base.samples, 25, { channels: [{ inProgress: true, waitingBodyBytes: 0 }] }) };
    const idleResult = classifyInterval(idle);
    assertEqual(idleResult.linkBound, false, 'a channel in progress with nothing waiting is not link-bound');
    assertEqual(idleResult.reason, 'channel-idle', 'the reason names the idle channel');
    // The paired fixture differs in that one sample's waitingBodyBytes only.
    const waiting = { ...base, samples: withOneSample(base.samples, 25, { channels: [{ inProgress: true, waitingBodyBytes: 7 }] }) };
    const waitingResult = classifyInterval(waiting);
    assertEqual(waitingResult.linkBound, true, 'the same sample, with bytes waiting, is link-bound');
    assertEqual(waitingResult.reason, null, 'a link-bound interval names no reason');
    // Mutation probe: staged, then the `waitingBodyBytes > 0` clause dropped from
    // `classifyInterval`'s channel-idle loop. `npm run check` turned the `linkBound`
    // assertion on the idle fixture red (it read `true` against the expected `false`),
    // and turned the 'reason names each failing condition once' check red too.
    // Reverted; check green again.
  });

  await check('capacity-estimate: fewer than five link-bound intervals publish null and intervalsBehind', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    for (let index = 0; index < 4; index += 1) {
      estimate.record({ drainedBodyBytes: 1_000_000, durationMs: 1000, linkBound: true });
    }
    const afterFour = estimate.read();
    assertEqual(afterFour.bytesPerSecond, null, 'four link-bound intervals publish no estimate yet');
    assertEqual(afterFour.intervalsBehind, 4, 'four intervals are behind the estimate');
    // Mutation probe: staged, then the `window` comparison in `read` changed to the
    // literal `4`. `npm run check` turned the `bytesPerSecond` assertion above red (a
    // number, 1,000,000, against the expected `null`). Reverted; check green again.
    estimate.record({ drainedBodyBytes: 1_000_000, durationMs: 1000, linkBound: true });
    const afterFive = estimate.read();
    assert(typeof afterFive.bytesPerSecond === 'number', 'a fifth link-bound interval publishes a number');
    assertEqual(afterFive.bytesPerSecond, 1_000_000, 'the fifth interval completes the window at 1,000,000 B/s');
  });

  await check('capacity-estimate: falling capacity is read from the last window, not the whole history', async () => {
    const estimate = createCapacityEstimate({ window: 5 });
    for (let index = 0; index < 5; index += 1) estimate.record({ drainedBodyBytes: 1_250_000, durationMs: 1000, linkBound: true });
    for (let index = 0; index < 5; index += 1) estimate.record({ drainedBodyBytes: 600_000, durationMs: 1000, linkBound: true });
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
    for (let index = 0; index < 5; index += 1) estimate.record({ drainedBodyBytes: 1_000_000, durationMs: 1000, linkBound: true });
    const before = estimate.read();
    estimate.record({ drainedBodyBytes: 50, durationMs: 1000, linkBound: false });
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

    const fewSamples = { ...base, samples: base.samples.slice(0, MIN_LINK_BOUND_SAMPLES - 1) };
    assertEqual(classifyInterval(fewSamples).reason, 'few-samples', 'one sample short of the floor is few-samples');

    const noRequest = { ...base, samples: withOneSample(base.samples, 10, { channels: [{ inProgress: false, waitingBodyBytes: 1 }] }) };
    assertEqual(classifyInterval(noRequest).reason, 'no-request', 'a sample with no in-progress channel is no-request');

    const channelIdle = { ...base, samples: withOneSample(base.samples, 10, { channels: [{ inProgress: true, waitingBodyBytes: 0 }] }) };
    assertEqual(classifyInterval(channelIdle).reason, 'channel-idle', 'a waiting-less in-progress channel is channel-idle');

    const paceBound = { ...base, paceBoundMs: 1 };
    assertEqual(classifyInterval(paceBound).reason, 'pace-bound', 'a nonzero pace-bound time is pace-bound');

    const noDrain = { ...base, drainedBodyBytes: 0 };
    assertEqual(classifyInterval(noDrain).reason, 'no-drain', 'zero drained bytes is no-drain');
  });

  await check('capacity-estimate: impossible interval values throw, in both classifyInterval and record', async () => {
    const base = baseFixture();
    for (const durationMs of [0, -1]) {
      let threw = false;
      try { classifyInterval({ ...base, durationMs }); } catch { threw = true; }
      assert(threw, `classifyInterval throws for durationMs = ${durationMs}`);
    }
    let negativeThrew = false;
    try { classifyInterval({ ...base, drainedBodyBytes: -1 }); } catch { negativeThrew = true; }
    assert(negativeThrew, 'classifyInterval throws for a negative drainedBodyBytes');

    const estimate = createCapacityEstimate({ window: 5 });
    for (const durationMs of [0, -1]) {
      let threw = false;
      try { estimate.record({ drainedBodyBytes: 1000, durationMs, linkBound: true }); } catch { threw = true; }
      assert(threw, `record throws for durationMs = ${durationMs}`);
    }
    let recordNegativeThrew = false;
    try { estimate.record({ drainedBodyBytes: -1, durationMs: 1000, linkBound: true }); } catch { recordNegativeThrew = true; }
    assert(recordNegativeThrew, 'record throws for a negative drainedBodyBytes');
  });
}
