// T14, T15 (design.md D2): the host's estimate read at the wire over two queued
// intervals, the queue seen by the echo round trip, lowered by a standing queue and
// raised by a probe the round trip stayed flat through.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { PROBE_AFTER_INTERVALS } from '../../../public/lib/host-pace.mjs';
import { createWireMeter } from '../../../public/lib/wire-meter.mjs';
import { encodeControl } from '../../../public/lib/segment-protocol.mjs';

const BODY_BYTES = 400_000_000;

async function flush(turns = 20) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function handedOf(links) {
  let total = 0;
  for (const link of links) {
    for (const entry of link.host.ledger) total += entry.bytes;
    total -= link.host.bufferedAmount;
  }
  return total;
}

// A link below the channels, shared by them all: it carries at most `bytesPerMs` of
// what they handed it and queues the rest, and whatever is queued delays every
// channel's delivery, the echo's included. `counts: 'carried'` reads the wire after
// the queue; `'handed'` reads it before, as `bytesSent` does over a kernel qdisc.
function sharedQueue(clock, links, bytesPerMs, { counts = 'carried' } = {}) {
  let carried = 0;
  let atMs = clock.now();
  const advance = () => {
    const now = clock.now();
    carried = Math.min(handedOf(links), carried + bytesPerMs * (now - atMs));
    atMs = now;
  };
  for (const link of links) link.host.setBelowDelay(() => { advance(); return (handedOf(links) - carried) / bytesPerMs; });
  return {
    setRate(value) {
      advance();
      bytesPerMs = value;
    },
    read() {
      advance();
      return counts === 'carried' ? carried : handedOf(links);
    },
    queueMs() {
      advance();
      return (handedOf(links) - carried) / bytesPerMs;
    },
  };
}

async function host({ clock, drainBytesPerMs, fraction = 0.85, queueBytesPerMs = null, counts }) {
  const bytes = new Uint8Array(BODY_BYTES);
  const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs: drainBytesPerMs, viewerDrainBytesPerMs: 1_000_000 }));
  const wire = queueBytesPerMs === null ? null : sharedQueue(clock, links, queueBytesPerMs, { counts });
  const origin = createHostOrigin({ readSource: async () => ({ status: 200, bytes }), clock, pace: { fraction }, wire });
  const detaches = links.map((link) => origin.attach(link.host));
  links.forEach((link, index) => link.viewer.send(encodeControl({ t: 'req', id: index + 1, path: '/media/big.m4s', range: null })));
  clock.advance(1);
  await flush();
  return {
    origin,
    links,
    wire,
    cleanup() {
      detaches.forEach((detach) => detach());
      links.forEach((link) => link.closeBoth());
    },
  };
}

const near = (value, target, fraction) => Math.abs(value - target) <= fraction * target;
const readings = (intervals) => intervals.map((interval) => interval.readingBytesPerSecond).filter((rate) => rate !== null);

export default async function wireEstimateSuite() {
  await check('wire-estimate: the estimate forms from two consecutive queued intervals, at the wire’s rate', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: 416.667 });
    try {
      clock.advance(2100);
      const two = origin.pace();
      assertEqual(two.intervals[0].reason, 'no-queue', 'the first interval holds the echo that read the floor');
      assertEqual(two.intervals[1].linkBound, true, 'the second interval is queued');
      assertEqual(two.estimate.bytesPerSecond, null, 'one queued interval is not an estimate');
      clock.advance(1000);
      const three = origin.pace();
      assert(near(three.estimate.bytesPerSecond, 1_250_000, 0.02), `the estimate formed at the wire's 1 250 000 B/s (got ${three.estimate.bytesPerSecond})`);
      assert(three.paceBytesPerSecond !== null, 'the pace is in force from the third interval’s close');
      assert(three.intervals.every((interval) => interval.echoSamples > 0), 'every interval answered echoes');
      // Mutation probe, staged: capacity-estimate.mjs's READING_INTERVALS set to 1.
      // `npm run check` turned 'one queued interval is not an estimate' red
      // (1 250 001). Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: the estimate reads the wire, not the channels draining into a queue above it', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: 600, queueBytesPerMs: 1250 });
    try {
      // The cap (design.md D2) lets the queue fill for an interval and then stand,
      // so the first reading that stands closes with the fifth.
      clock.advance(6000);
      const read = origin.pace();
      assert(near(read.estimate.bytesPerSecond, 1_250_000, 0.01), `the estimate is the wire's 1 250 000 B/s (got ${read.estimate.bytesPerSecond})`);
      assert(read.intervals.some((interval) => interval.queueMs > 100), 'the queue below the channels delayed the echo');
      assert(read.intervals[0].handedBytes > 1.3 * read.intervals[0].wireBytes, 'the channels handed down well over what the wire carried');
      // Mutation probe, staged (T14): host-origin.mjs's finishInterval recording
      // `handedBytes` as the interval's bytes. `npm run check` turned 'the estimate
      // is the wire's' red (about 1 800 000 B/s; re-run under the cap, 1 230 912).
      // Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: a wire that falls under the pace lowers the estimate through the queue it grows', async () => {
    const clock = createFakeClock();
    const { origin, wire, cleanup } = await host({ clock, drainBytesPerMs: 600, queueBytesPerMs: 1250 });
    try {
      clock.advance(25_000);
      const before = origin.pace();
      assert(near(before.estimate.bytesPerSecond, 1_250_000, 0.02), `paced on a 1 250 000 B/s wire (got ${before.estimate.bytesPerSecond})`);
      assert(before.intervals.at(-1).reason === 'pace-bound', `the pace binds before the fall (${before.intervals.at(-1).reason})`);
      wire.setRate(500);
      clock.advance(10_000);
      const after = origin.pace();
      assert(near(after.estimate.bytesPerSecond, 500_000, 0.1), `the estimate fell to the wire's 500 000 B/s within 10 s (got ${after.estimate.bytesPerSecond})`);
      // Mutation probe, staged: capacity-estimate.mjs's queue clause moved below the
      // pace-bound return. `npm run check` turned 'the estimate fell' red (it stayed
      // at 1 250 000: every interval read pace-bound). Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: a stalled interval is not read as the link', async () => {
    // Attempt 3's intervals 3 and 4 (design.md D2, remedy investigation): the channels
    // hand nothing down for 2 s while the wire carries a trickle of what was queued.
    const clock = createFakeClock();
    const { origin, links, wire, cleanup } = await host({ clock, drainBytesPerMs: 600, queueBytesPerMs: 1250 });
    try {
      // The first reading closes with the fifth interval; the stall starts inside the sixth.
      clock.advance(5100);
      const formed = origin.pace();
      assert(near(formed.estimate.bytesPerSecond, 1_250_000, 0.02), `formed at the wire's 1 250 000 B/s (got ${formed.estimate.bytesPerSecond})`);
      for (const link of links) link.host.setDrainRate(0);
      wire.setRate(40);
      clock.advance(4000);
      const stalled = origin.pace(formed.intervals.at(-1).seq).intervals.filter((interval) => interval.handedBytes === 0);
      assert(stalled.length >= 3, `three or more intervals handed nothing down (got ${stalled.length})`);
      for (const interval of stalled) {
        assert(interval.wireBytes > 0, `interval ${interval.seq}: a trickle on the wire (${interval.wireBytes})`);
        assertEqual(interval.reason, 'stalled', `interval ${interval.seq} is a stall`);
      }
      for (const link of links) link.host.setDrainRate(600);
      wire.setRate(1250);
      clock.advance(6000);
      const after = origin.pace();
      const rates = readings(after.intervals);
      const afterStall = readings(after.intervals.filter((interval) => interval.seq > stalled.at(-1).seq));
      assert(afterStall.length >= 1, `a reading closed after the stall (${afterStall.length})`);
      assert(rates.every((rate) => near(rate, 1_250_000, 0.02)), `no reading is the stall's trickle (${rates.map(Math.round).join(', ')})`);
      // Mutation probe, staged: capacity-estimate.mjs's `stalled` return removed.
      // `npm run check` turned 'interval 7 is a stall' red (no-queue). Reverted;
      // green. Second probe, staged: READING_INTERVALS set to 1. Turned 'no reading
      // is the stall's trickle' red (a reading of 162 210). Reverted; green. Both
      // re-run under the cap, which leaves no late answer in a stalled interval here:
      // capacity-estimate's suite holds that term.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: a probe into a queue the wire count cannot see does not raise the estimate', async () => {
    // Attempt 3's probe 197: `bytesSent` counts a byte as it enters the kernel's queue,
    // so the probe read 1.21 x the link. The echo crosses that queue.
    const clock = createFakeClock();
    const { origin, links, cleanup } = await host({ clock, drainBytesPerMs: 416.667, queueBytesPerMs: 1250, counts: 'handed' });
    try {
      clock.advance(6000);
      assert(near(origin.pace().estimate.bytesPerSecond, 1_250_000, 0.02), `formed at the link's 1 250 000 B/s (got ${origin.pace().estimate.bytesPerSecond})`);
      for (const link of links) link.host.setDrainRate(2500);
      clock.advance(60_000);
      const read = origin.pace();
      const probes = read.intervals.filter((interval) => interval.probe);
      const over = probes.filter((probe) => probe.wireBytes * 1000 / probe.durationMs > 1.05 * 1_250_000);
      assert(over.length >= 3, `three or more probes whose wire count read above the link in 60 s (got ${over.length})`);
      assert(over.every((probe) => probe.tailQueueMs > 30), `each one's second half saw the queue (${over.map((probe) => Math.round(probe.tailQueueMs)).join(', ')})`);
      assertEqual(read.intervals.filter((interval) => interval.raised).length, 0, 'no probe raised the estimate');
      // The faster drain moves what the channels held to below the wire count once;
      // the median takes that reading out.
      assert(read.estimate.bytesPerSecond <= 1.03 * 1_250_000, `the estimate stayed at the link (got ${read.estimate.bytesPerSecond})`);
      assertEqual(read.intervals.at(-1).climbing, false, 'the first refused probe ended the climb');
      // Mutation probe, staged: createProbePlan's four queue terms removed, so a
      // pace-bound probe raises whatever the round trip read. `npm run check` turned
      // 'no probe raised the estimate' red (2). Reverted; green again.
      // The second-half terms alone do not turn this case: the next interval's first
      // half sees the same queue. capacity-estimate's suite holds each term apart.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: before an estimate, the host holds a channel at what its echo answers confirmed, and the queue below stands', async () => {
    // Attempt 4's start (design.md D2, start-hold repair): channels that empty at
    // once into a queue the host cannot see, and a wire count taken above it. Unheld,
    // the host handed 13.73 MB in nine intervals to a link that carried 11.12 MB.
    const clock = createFakeClock();
    const { origin, wire, cleanup } = await host({ clock, drainBytesPerMs: 2000, queueBytesPerMs: 1250, counts: 'handed' });
    try {
      let deepestMs = 0;
      for (let ms = 0; ms < 9000; ms += 100) {
        clock.advance(100);
        deepestMs = Math.max(deepestMs, wire.queueMs());
      }
      const start = origin.pace();
      const handed = start.intervals.reduce((total, interval) => total + interval.handedBytes, 0);
      // 500 ms of the link, one chunk a channel past it, and what three floors add.
      assert(deepestMs < 800, `the queue below the host stayed under 0.8 s (deepest ${Math.round(deepestMs)} ms)`);
      assert(handed < 9 * 1_250_000 + 0.8 * 1_250_000, `nine intervals handed the link's nine and the standing queue (got ${handed})`);
      assert(start.intervals.slice(1, 4).every((interval) => interval.heldSamples > 0 && interval.linkBound), 'held, the queue stands: each early interval is link-bound');
      const rates = readings(start.intervals);
      assert(rates.length >= 2 && rates[0] < 1.05 * 1_250_000, `the first reading is the link, not the fill (${rates.map(Math.round).join(', ')})`);
      assert(near(start.estimate.bytesPerSecond, 1_250_000, 0.05), `the estimate formed near the link (got ${start.estimate.bytesPerSecond})`);
      assert(wire.queueMs() < 100, `paced, the queue has drained (${Math.round(wire.queueMs())} ms)`);
      // Mutation probe, staged: host-origin.mjs's channelHeld returning false. `npm
      // run check` turned 'the queue below the host stayed under 0.8 s' red (deepest
      // 34 200 ms), and three cases above that then form no estimate. Reverted; green.
      // Second probe, staged: segment-protocol.mjs's `onChunk` call removed. Turned
      // 'paced, the queue has drained' red (302 ms) and eight other cases. Reverted;
      // check green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: an estimate below the link climbs by a probe every other interval, then probes every eleventh', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await host({ clock, drainBytesPerMs: 200 });
    try {
      clock.advance(4000);
      const start = origin.pace();
      assert(near(start.estimate.bytesPerSecond, 600_000, 0.02), `formed at 600 000 B/s (got ${start.estimate.bytesPerSecond})`);
      for (const link of links) link.host.setDrainRate(600);
      clock.advance(30_000);
      const climbed = origin.pace(start.intervals.at(-1).seq);
      // 10 % per 11 s, the rate T14 probed at, reaches 1.33 x in 30 s; the climb
      // reaches the 1 800 000 B/s link.
      assert(climbed.estimate.bytesPerSecond > 0.9 * 1_800_000, `the estimate reached the link within 30 s (got ${climbed.estimate.bytesPerSecond})`);
      assert(climbed.estimate.bytesPerSecond < 1.1 * 1_800_000, `and did not pass it by a probe's step (got ${climbed.estimate.bytesPerSecond})`);
      const raises = climbed.intervals.filter((interval) => interval.raised);
      assert(raises.length >= 8, `eight or more raises in the climb (got ${raises.length})`);
      const climbProbes = climbed.intervals.filter((interval) => interval.probe && interval.climbing);
      const climbGaps = climbProbes.slice(1).map((probe, index) => probe.seq - climbProbes[index].seq);
      assert(climbGaps.length >= 8 && climbGaps.every((gap) => gap === 2), `a probe every other interval while climbing (${climbGaps.join(', ')})`);
      clock.advance(40_000);
      const steady = origin.pace(climbed.intervals.at(-1).seq);
      assertEqual(steady.intervals.at(-1).climbing, false, 'a probe met the link and the climb ended');
      const steadyProbes = steady.intervals.filter((interval) => interval.probe);
      const steadyGaps = steadyProbes.slice(1).map((probe, index) => probe.seq - steadyProbes[index].seq);
      assert(steadyGaps.length >= 2 && steadyGaps.every((gap) => gap === PROBE_AFTER_INTERVALS + 1), `then a probe every ${PROBE_AFTER_INTERVALS + 1} intervals (${steadyGaps.join(', ')})`);
      assert(steady.intervals.filter((interval) => interval.probe).every((interval) => interval.probe === true), 'each probe interval is published as one');
      // Mutation probe, staged: host-origin.mjs's finishInterval with the raise call
      // removed. `npm run check` turned 'the estimate reached the link within 30 s'
      // red (600 000). Reverted; green. Second probe, staged: createProbePlan's
      // `climbing` initialised false. Turned the same assertion red (705 160).
      // Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: unpaced, no interval is a probe', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: 200, fraction: 'unpaced' });
    try {
      clock.advance(25_000);
      const read = origin.pace();
      assertEqual(read.paceBytesPerSecond, null, 'unpaced publishes no pace');
      assertEqual(read.intervals.filter((interval) => interval.probe).length, 0, 'no probe');
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: the meter sums every candidate pair, keeps a switched pair and a closed connection, and survives a failed read', async () => {
    const stats = (pairs) => new Map(pairs.map((bytesSent, index) => [`p${index}`, { type: 'candidate-pair', bytesSent }])
      .concat([['t', { type: 'transport', bytesSent: 999_999 }]]));
    const a = { report: stats([100, 0]), getStats() { return Promise.resolve(this.report); } };
    const b = { report: stats([50]), getStats() { return this.fail ? Promise.reject(new Error('gone')) : Promise.resolve(this.report); } };
    let peers = [a, b];
    const meter = createWireMeter({ peers: () => peers });
    assertEqual(await meter.read(), 150, 'two connections, their pairs summed, the transport not counted twice');
    a.report = stats([107, 2000]);
    assertEqual(await meter.read(), 2157, 'the switched-to pair adds; the superseded pair keeps its count');
    b.fail = true;
    assertEqual(await meter.read(), 2157, 'a failed read keeps the last total');
    peers = [a];
    assertEqual(await meter.read(), 2157, 'a closed connection keeps its total');
    a.report = stats([0, 0]);
    assertEqual(await meter.read(), 2157, 'a reading never falls');
  });
}
