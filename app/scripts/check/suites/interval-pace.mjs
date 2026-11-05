// Each interval record publishes the estimate after its close and the pace
// the sender held during it, set at the previous close.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { PROBE_FACTOR } from '../../../public/lib/host-pace.mjs';
import { host } from '../wire-queue.mjs';

const PACE_FRACTION = 0.85;
const LINK_BYTES_PER_MS = 200;
const FORMED_BYTES_PER_SECOND = 600_000;
const NON_PROBE_PACE_BYTES_PER_SECOND = 510_000;
const PROBE_PACE_BYTES_PER_SECOND = 660_000;

const near = (value, target, fraction) => Math.abs(value - target) <= fraction * target;

export default async function intervalPaceSuite() {
  await check('interval-pace: an interval carries the pace held during it and the estimate after its close', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await host({ clock, drainBytesPerMs: LINK_BYTES_PER_MS });
    try {
      clock.advance(4000);
      for (const link of links) link.host.setDrainRate(3 * LINK_BYTES_PER_MS);
      clock.advance(30_000);
      const { intervals } = origin.pace();
      assertEqual(intervals[0].paceBytesPerSecond, null, 'the first interval of a page held no pace');
      const held = intervals.find((interval) => interval.paceBytesPerSecond !== null && !interval.probe);
      assert(near(held.paceBytesPerSecond, NON_PROBE_PACE_BYTES_PER_SECOND, 0.02), `a non-probe interval held 0.85 × 600 000 = 510 000 bytes/s (got ${held.paceBytesPerSecond})`);
      assert(near(held.estimateBytesPerSecond, FORMED_BYTES_PER_SECOND, 0.02), `the estimate after its close is the formed 600 000 bytes/s (got ${held.estimateBytesPerSecond})`);
      const probe = intervals.find((interval) => interval.probe && interval.paceBytesPerSecond !== null);
      assert(near(probe.paceBytesPerSecond, PROBE_PACE_BYTES_PER_SECOND, 0.02), `a probe interval held 1.1 × 600 000 = 660 000 bytes/s (got ${probe.paceBytesPerSecond})`);
      const raisedAt = intervals.findIndex((interval) => interval.raised);
      assert(raisedAt > 0, 'a probe raised the estimate');
      const raised = intervals[raisedAt];
      assert(raised.estimateBytesPerSecond > intervals[raisedAt - 1].estimateBytesPerSecond, 'the raise is in the estimate its own record carries');
      assertEqual(raised.paceBytesPerSecond, (raised.probe ? PROBE_FACTOR : PACE_FRACTION) * intervals[raisedAt - 1].estimateBytesPerSecond, 'the interval of the raise held the pace of the estimate before it');
      const next = intervals[raisedAt + 1];
      assertEqual(next.paceBytesPerSecond, (next.probe ? PROBE_FACTOR : PACE_FRACTION) * raised.estimateBytesPerSecond, 'the next interval held the pace of the raised estimate');
      for (let index = 1; index < intervals.length; index += 1) {
        const { probe: isProbe, paceBytesPerSecond } = intervals[index];
        const previous = intervals[index - 1].estimateBytesPerSecond;
        assertEqual(paceBytesPerSecond, previous === null ? null : (isProbe ? PROBE_FACTOR : PACE_FRACTION) * previous, `interval ${intervals[index].seq} held the factor × the estimate its predecessor closed on`);
      }
    } finally {
      cleanup();
    }
  });

  await check('interval-pace: unpaced, no interval holds a pace and the estimate is still read', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: LINK_BYTES_PER_MS, fraction: 'unpaced' });
    try {
      clock.advance(8000);
      const { intervals } = origin.pace();
      assert(intervals.length >= 5, 'intervals closed');
      assert(intervals.every((interval) => interval.paceBytesPerSecond === null), 'no pace is held');
      assert(intervals.some((interval) => interval.estimateBytesPerSecond !== null), 'the estimate is published as it reads');
      assert(intervals.every((interval) => 'estimateBytesPerSecond' in interval), 'every record carries the field');
    } finally {
      cleanup();
    }
  });
}
