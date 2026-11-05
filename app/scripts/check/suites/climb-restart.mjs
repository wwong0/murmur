// A probe that raises the estimate restarts the climb, so a link that falls
// and rises is followed up. The plan alone, then the host on the fake wire, then the
// replay a retained run takes.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { createProbePlan } from '../../../public/lib/capacity-estimate.mjs';
import { PROBE_AFTER_INTERVALS, PROBE_FACTOR } from '../../../public/lib/host-pace.mjs';
import { capUsed } from '../../figures/cap-used.mjs';
import { host } from '../wire-queue.mjs';

const MARGIN_MS = 50;
const PACE_FRACTION = 0.85;
const LOW_WIRE_BYTES_PER_MS = 250;
const HIGH_WIRE_BYTES_PER_MS = 1250;
const CHANNEL_DRAIN_BYTES_PER_MS = 5000;

const interval = (over = {}) => ({
  probe: false, linkBound: false, reason: 'pace-bound', rate: 1000, headQueueMs: 0, tailQueueMs: 0, ...over,
});

function planAfterQueuedProbe() {
  const plan = createProbePlan({ after: PROBE_AFTER_INTERVALS, factor: PROBE_FACTOR, marginMs: MARGIN_MS });
  plan.close(interval({ probe: true, rate: 1080 }), 1000);
  return plan;
}

async function settledAtLowWire(clock, origin) {
  for (let seconds = 0; seconds < 120; seconds += 1) {
    clock.advance(1000);
    const read = origin.pace();
    const last = read.intervals.at(-1);
    if (read.estimate.bytesPerSecond !== null && last && last.climbing === false) return read;
  }
  return origin.pace();
}

export default async function climbRestartSuite() {
  await check('climb-restart: a link that falls and rises is followed up', async () => {
    const clock = createFakeClock();
    const { origin, wire, cleanup } = await host({ clock, drainBytesPerMs: CHANNEL_DRAIN_BYTES_PER_MS, queueBytesPerMs: LOW_WIRE_BYTES_PER_MS });
    try {
      const settled = await settledAtLowWire(clock, origin);
      const estimateBefore = settled.estimate.bytesPerSecond;
      assert(estimateBefore !== null && Math.abs(estimateBefore - 250_000) <= 25_000, `precondition not reached: estimate within 250 000 ± 25 000 bytes/s (got ${estimateBefore})`);
      assertEqual(settled.intervals.at(-1).climbing, false, 'precondition not reached: a probe met a queue');
      const paceBeforeBytesPerSecond = settled.paceBytesPerSecond;
      wire.setRate(HIGH_WIRE_BYTES_PER_MS);
      clock.advance(30_000);
      const after = origin.pace();
      assert(after.paceBytesPerSecond >= 2 * paceBeforeBytesPerSecond, `the pace at least doubled in 30 000 ms (${paceBeforeBytesPerSecond} → ${after.paceBytesPerSecond} bytes/s)`);
      const ceilingBytesPerSecond = PACE_FRACTION * HIGH_WIRE_BYTES_PER_MS * 1000 * PROBE_FACTOR;
      assert(after.paceBytesPerSecond <= ceilingBytesPerSecond, `and not above the new link's paced share (${after.paceBytesPerSecond} > ${ceilingBytesPerSecond} bytes/s)`);
    } finally {
      cleanup();
    }
  });

  await check('climb-restart: a raised estimate climbs again', async () => {
    const plan = createProbePlan({ after: PROBE_AFTER_INTERVALS, factor: PROBE_FACTOR, marginMs: MARGIN_MS });
    plan.close(interval({ probe: true, rate: 1000 }), 1000);
    assertEqual(plan.close(interval({ linkBound: true, reason: null, tailQueueMs: MARGIN_MS + 1 }), 1000).climbing, false, 'a queued probe ended the climb');
    for (let index = 0; index < PROBE_AFTER_INTERVALS; index += 1) plan.close(interval(), 1000);
    plan.close(interval({ probe: true, rate: 1080 }), 1000);
    const raised = plan.close(interval({ rate: 1100 }), 1000);
    assert(raised.raiseTo !== null, 'the flat probe raised the estimate');
    assertEqual(raised.climbing, true, 'and restarted the climb');
    assertEqual(plan.close(interval(), 1080).probeNext, true, 'so the next pace-bound close probes');
  });

  await check('climb-restart: a probe that meets a queue ends the climb, and a flat one raises by at most 1.1 ×', async () => {
    const plan = planAfterQueuedProbe();
    assertEqual(plan.close(interval(), 1000).raiseTo, 1080, 'the flat probe raised to its wire rate, under 1.1 ×');
    plan.close(interval({ probe: true, rate: 1180, tailQueueMs: MARGIN_MS + 30 }), 1080);
    let close = plan.close(interval(), 1080);
    assertEqual(close.climbing, false, 'the queued probe ended the climb');
    for (let index = 0; index < PROBE_AFTER_INTERVALS - 2; index += 1) {
      assertEqual(close.probeNext, false, `pace-bound close ${index + 1} of ${PROBE_AFTER_INTERVALS}: no probe`);
      close = plan.close(interval(), 1080);
    }
    assertEqual(close.probeNext, false, `${PROBE_AFTER_INTERVALS - 1} pace-bound closes: not yet`);
    assertEqual(plan.close(interval(), 1080).probeNext, true, `${PROBE_AFTER_INTERVALS}: probe`);
    const capped = createProbePlan({ after: PROBE_AFTER_INTERVALS, factor: PROBE_FACTOR, marginMs: MARGIN_MS });
    capped.close(interval({ probe: true, rate: 5000 }), 1000);
    assert(capped.close(interval(), 1000).raiseTo <= PROBE_FACTOR * 1000, 'a flat probe raises by at most 1.1 ×');
  });

  await check('climb-restart: a retained run replays under the rule it was recorded by', async () => {
    const fixture = (withEstimate, climbingAfterRaise) => {
      const base = { durationMs: 1000, handedBytes: 100, wireBytes: 100, readingBytesPerSecond: null, linkBound: false, reason: 'pace-bound', headQueueMs: 0, tailQueueMs: 0, probe: false, raised: false, climbing: false };
      const rows = [
        { ...base, linkBound: true, reason: null, readingBytesPerSecond: 1000, climbing: true },
        { ...base, probe: true, wireBytes: 1000, tailQueueMs: 10_000, climbing: true },
        { ...base, wireBytes: 1000, tailQueueMs: 10_000 },
        { ...base, probe: true, wireBytes: 1100 },
        { ...base, wireBytes: 1100, raised: true, climbing: climbingAfterRaise },
      ];
      return rows.map((row, index) => ({ ...row, seq: index + 1, endWallMs: (index + 1) * 1000, ...(withEstimate ? { estimateBytesPerSecond: 1000, paceBytesPerSecond: 850 } : {}) }));
    };
    const window = { startMs: 0, endMs: 5000 };
    const read = (intervals) => capUsed({ intervals, window, wallOffsetMs: 0, fraction: PACE_FRACTION });
    assert(read(fixture(false, false)).reason !== 'pace-replay-mismatch', 'a run without the field replays as the earlier rule recorded it');
    assert(read(fixture(true, true)).reason !== 'pace-replay-mismatch', 'a run with the field replays the restart');
    assertEqual(read(fixture(true, false)).reason, 'pace-replay-mismatch', 'a run with the field that recorded no restart is a mismatch');
  });
}
