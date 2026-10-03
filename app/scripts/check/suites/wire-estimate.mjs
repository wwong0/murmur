// T14 (design.md D2, reversed): the host's estimate read at the wire, formed at the
// first link-bound interval, lowered by a queue below the host, raised by a probe.

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin, PROBE_AFTER_INTERVALS } from '../../../public/lib/host-origin.mjs';
import { createWireMeter } from '../../../public/lib/wire-meter.mjs';
import { encodeControl } from '../../../public/lib/segment-protocol.mjs';

const BODY_BYTES = 200_000_000;

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

// A link below the channels: it carries at most `bytesPerMs` of what they handed it,
// and queues the rest, as the browser's transport does under `bufferedAmount`.
function modelledWire(clock, links, bytesPerMs) {
  let carried = 0;
  let atMs = clock.now();
  return {
    setRate(value) {
      this.read();
      bytesPerMs = value;
    },
    read() {
      const now = clock.now();
      carried = Math.min(handedOf(links), carried + bytesPerMs * (now - atMs));
      atMs = now;
      return carried;
    },
  };
}

async function host({ clock, drainBytesPerMs, fraction = 0.85, wireBytesPerMs = null }) {
  const bytes = new Uint8Array(BODY_BYTES);
  const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs: drainBytesPerMs, viewerDrainBytesPerMs: 1_000_000 }));
  const wire = wireBytesPerMs === null ? null : modelledWire(clock, links, wireBytesPerMs);
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

export default async function wireEstimateSuite() {
  await check('wire-estimate: the estimate forms at the first link-bound interval, and the pace binds from the next', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: 416.667 });
    try {
      clock.advance(1100);
      const first = origin.pace();
      assertEqual(first.intervals[0].linkBound, true, 'the first interval is link-bound');
      assert(near(first.estimate.bytesPerSecond, 1_250_000, 0.02), `the estimate formed at the wire's 1 250 000 B/s (got ${first.estimate.bytesPerSecond})`);
      clock.advance(900);
      assert(origin.pace().paceBytesPerSecond !== null, 'the pace is in force 2 s in');
      // Mutation probe, staged: capacity-estimate.mjs's read publishing null below
      // five rates. `npm run check` turned 'the estimate formed at the wire' red
      // (null), and every case after it. Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: the estimate reads the wire, not the channels draining into a queue above it', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await host({ clock, drainBytesPerMs: 5000, wireBytesPerMs: 1250 });
    try {
      clock.advance(4000);
      const read = origin.pace();
      assert(near(read.estimate.bytesPerSecond, 1_250_000, 0.02), `the estimate is the wire's 1 250 000 B/s (got ${read.estimate.bytesPerSecond})`);
      assert(read.intervals.some((interval) => interval.queued), 'a queue below the host was read as link-bound');
      // Mutation probe, staged: host-origin.mjs's finishInterval recording
      // `handedBytes` as the interval's bytes. `npm run check` turned 'the estimate
      // is the wire's' red (about 15 000 000 B/s). Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: a wire that falls under the pace lowers the estimate through the queue it grows', async () => {
    const clock = createFakeClock();
    const { origin, wire, cleanup } = await host({ clock, drainBytesPerMs: 5000, wireBytesPerMs: 1250 });
    try {
      clock.advance(6000);
      const before = origin.pace();
      assert(near(before.estimate.bytesPerSecond, 1_250_000, 0.02), `paced on a 1 250 000 B/s wire (got ${before.estimate.bytesPerSecond})`);
      assert(before.intervals.at(-1).reason === 'pace-bound', `the pace binds before the fall (${before.intervals.at(-1).reason})`);
      wire.setRate(500);
      clock.advance(10_000);
      const after = origin.pace();
      assert(near(after.estimate.bytesPerSecond, 500_000, 0.1), `the estimate fell to the wire's 500 000 B/s within 10 s (got ${after.estimate.bytesPerSecond})`);
      // Mutation probe, staged: capacity-estimate.mjs's queued clause removed.
      // `npm run check` turned 'the estimate fell' red (it stayed at 1 250 000:
      // every interval read pace-bound). Reverted; green again.
    } finally {
      cleanup();
    }
  });

  await check('wire-estimate: a paced host whose link grows raises its estimate by a probe after 10 pace-bound intervals', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await host({ clock, drainBytesPerMs: 200 });
    try {
      clock.advance(3000);
      const start = origin.pace();
      assert(near(start.estimate.bytesPerSecond, 600_000, 0.02), `formed at 600 000 B/s (got ${start.estimate.bytesPerSecond})`);
      for (const link of links) link.host.setDrainRate(600);
      clock.advance(40_000);
      const after = origin.pace(start.intervals.at(-1).seq);
      const probes = after.intervals.filter((interval) => interval.probe);
      assert(probes.length >= 3, `three or more probes in 40 s (got ${probes.length})`);
      assert(probes.every((probe) => probe.raised), 'each probe the bucket still bound raised the estimate');
      const gaps = probes.slice(1).map((probe, index) => probe.seq - probes[index].seq);
      assert(gaps.every((gap) => gap === PROBE_AFTER_INTERVALS + 1), `a probe every ${PROBE_AFTER_INTERVALS + 1} intervals (${gaps.join(', ')})`);
      assert(after.estimate.bytesPerSecond > 1.25 * 600_000, `the estimate rose past 750 000 B/s (got ${after.estimate.bytesPerSecond})`);
      // Mutation probe, staged: host-origin.mjs's finishInterval with the raise
      // call removed. `npm run check` turned 'the estimate rose past 750 000 B/s'
      // red (600 000). Reverted; green again.
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
