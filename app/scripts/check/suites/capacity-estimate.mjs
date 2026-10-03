// T2 (design.md D2; tasks.md 2.2): the host's uplink capacity estimate, over
// constructed intervals read at the wire. Pure module — no server, no clock.

import { assert, assertEqual, check } from '../harness.mjs';
import { classifyInterval, createCapacityEstimate, MAX_SAMPLE_GAP_MS } from '../../../public/lib/capacity-estimate.mjs';

// One sample every 20 ms from +20 to +1000 of an interval starting at 0, as the host polls.
function samplesOf(count = 50, { inProgress = true, waitingBodyBytes = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({ atMs: (index + 1) * 20, channels: [{ inProgress, waitingBodyBytes }] }));
}

// The canonical link-bound base: every sample has one in-progress channel with bytes
// waiting, no pace-bound time, bytes on the wire and no queue below the host.
const QUEUE_GROWTH = 262_112;

function baseFixture() {
  return {
    samples: samplesOf(),
    startMs: 0,
    wireBytes: 1000,
    handedBytes: 1000,
    queueGrowthBytes: QUEUE_GROWTH,
    durationMs: 1000,
    paceBoundMs: 0,
  };
}

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
      const { linkBound, reason } = classifyInterval({
        samples: samplesOf(), startMs: 0, wireBytes, handedBytes: wireBytes, queueGrowthBytes: QUEUE_GROWTH, durationMs: 1000, paceBoundMs: 0,
      });
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

  await check('capacity-estimate: the estimate forms at the first link-bound interval, and its window fills to five', async () => {
    // D2 reversed (owner, 2026-10-03): the pace starts a second into the start's fill.
    const estimate = createCapacityEstimate({ window: 5 });
    estimate.record({ wireBytes: 1_000_000, durationMs: 1000, linkBound: true });
    const afterOne = estimate.read();
    assertEqual(afterOne.bytesPerSecond, 1_000_000, 'one link-bound interval forms the estimate');
    assertEqual(afterOne.intervalsBehind, 1, 'one interval is behind it');
    // Mutation probe, staged: `read` publishing null below five rates, as before the
    // reversal. `npm run check` turned 'one link-bound interval forms the estimate' red
    // (null), and wire-estimate's first-interval case with it. Reverted; check green.
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

  await check('capacity-estimate: a queue grown below the host is link-bound, whatever the pace and the channels', async () => {
    const base = baseFixture();
    const queued = { ...base, paceBoundMs: 400, wireBytes: 500_000, handedBytes: 500_000 + QUEUE_GROWTH + 1,
      samples: withOneSample(base.samples, 10, { channels: [{ inProgress: true, waitingBodyBytes: 0 }] }) };
    const result = classifyInterval(queued);
    assertEqual(result.linkBound, true, 'more handed than the wire carried, past the bucket burst, is link-bound');
    assertEqual(result.queued, true, 'and says it was a queue');
    const atBurst = { ...queued, handedBytes: 500_000 + QUEUE_GROWTH };
    assertEqual(classifyInterval(atBurst).reason, 'channel-idle', 'a growth of exactly the burst is not a queue');
    // Mutation probe, staged: the queued clause removed. `npm run check` turned
    // 'more handed than the wire carried' red (channel-idle), and wire-estimate's
    // fall under the pace with it. Reverted; check green again.
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

    const channelIdle = { ...base, samples: withOneSample(base.samples, 10, { channels: [{ inProgress: true, waitingBodyBytes: 0 }] }) };
    assertEqual(classifyInterval(channelIdle).reason, 'channel-idle', 'a waiting-less in-progress channel is channel-idle');

    const paceBound = { ...base, paceBoundMs: 1 };
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
