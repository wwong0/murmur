// The host's pace, against the fake clock and
// fake channels. The shared bucket and the capacity estimate are exercised
// through `createHostOrigin`, not directly — this suite proves what the host
// publishes and delivers, not the bucket's own arithmetic (that is send-pace.mjs).

import { assert, assertEqual, check } from '../harness.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { PACE_CAP_BYTES } from '../../../public/lib/host-pace.mjs';
import { HEADROOM_DEFAULT } from '../../../public/lib/send-pace.mjs';
import { encodeControl, parseControl } from '../../../public/lib/segment-protocol.mjs';

const BIG_BODY_BYTES = 20_000_000;
const SMALL_BODY_BYTES = 5_000_000;

function sendRequest(link, id, path) {
  link.viewer.send(encodeControl({ t: 'req', id, path, range: null }));
}

async function flush(turns = 20) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function settle(clock, ms = 1) {
  clock.advance(ms);
  await flush();
  clock.advance(ms);
}

function headsFor(link, id) {
  return link.host.ledger.filter((entry) => typeof entry.data === 'string'
    && parseControl(entry.data)?.t === 'head' && parseControl(entry.data).id === id);
}

// Three channels, each serving a body far larger than any run in this suite, so
// every sample finds bytes waiting and no response ever settles.
async function buildLinkBoundHost({ clock, fraction, hostDrainBytesPerMs, bodyBytes }) {
  const bytes = new Uint8Array(bodyBytes);
  const origin = createHostOrigin({ readSource: async () => ({ status: 200, bytes }), clock, pace: { fraction } });
  const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs, viewerDrainBytesPerMs: 1_000_000 }));
  const detaches = links.map((link) => origin.attach(link.host));
  links.forEach((link, index) => sendRequest(link, index + 1, '/media/big.m4s'));
  clock.advance(1); // deliver the queued req controls, short of the sampler's first tick
  await flush();    // let the source read resolve and admission begin, before any sample is taken
  return {
    origin,
    links,
    cleanup() {
      detaches.forEach((detach) => detach());
      links.forEach((link) => link.closeBoth());
    },
  };
}

export default async function hostPaceSuite() {
  await check('host-pace: the pace follows the estimate, and a shared bucket caps a faster link', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await buildLinkBoundHost({
      clock, fraction: HEADROOM_DEFAULT, hostDrainBytesPerMs: 416.667, bodyBytes: BIG_BODY_BYTES,
    });
    try {
      // The estimate forms, the buffers drain under the pace, and the first probe
      // meets the link, which ends the climb (T15): no probe falls in the window.
      clock.advance(12000);
      const buildup = origin.pace();
      assert(buildup.estimate.bytesPerSecond !== null, 'the estimate has formed');
      assertEqual(buildup.intervals.at(-1).climbing, false, 'a probe met the link, so the climb has ended');
      const buildupError = Math.abs(buildup.estimate.bytesPerSecond - 1_250_000) / 1_250_000;
      assert(buildupError <= 0.005, `estimate within 0.5% of 1,250,000 B/s (got ${buildup.estimate.bytesPerSecond})`);
      const seqAtBuildup = buildup.intervals.at(-1).seq;

      for (const link of links) link.host.setDrainRate(2500);
      clock.advance(2000); // the transition: pacing took hold before the links rose

      const sumBuffered = links.reduce((total, link) => total + link.host.bufferedAmount, 0);
      const seqAtWindowStart = origin.pace(seqAtBuildup).intervals.at(-1).seq;

      clock.advance(5000); // the measurement window
      const window = origin.pace(seqAtWindowStart);
      assertEqual(window.intervals.length, 5, 'the measurement window closed exactly five intervals');
      assertEqual(window.intervals.filter((interval) => interval.probe).length, 0, 'no probe ran in the window');
      const drained = window.intervals.reduce((total, interval) => total + interval.drainedBodyBytes, 0);

      const target = 1062.5 * 5000;
      const slack = PACE_CAP_BYTES + 65528 + sumBuffered;
      assert(Math.abs(drained - target) <= slack, `drained (${drained}) tracks the paced target (${target}) within slack (${slack})`);
      // Five chunks of bucket and overshoot are 6.2% of the target; 10% keeps the
      // unpaced 7.5 MB/s the mutation below reaches far outside it.
      assert(slack < 0.1 * target, `slack (${slack}) is under 10% of the target (${target})`);
      // Mutation probe, staged: `gate: sendPace` in host-origin.mjs's attach()
      // dropped to `gate: null`. `npm run check` turned the upper-side assertion
      // red — drained (bounded only by the raised 2 500 B/ms links) blew past
      // target + slack, unbounded by the shared bucket. Reverted; check green again.
    } finally {
      cleanup();
    }
  });

  await check('host-pace: headers are not paced, even while the shared bucket is exhausted', async () => {
    const clock = createFakeClock();
    const big = new Uint8Array(BIG_BODY_BYTES);
    let release = null;
    const readSource = (path) => {
      if (path === '/media/held.m4s') return new Promise((resolve) => { release = () => resolve({ status: 200, bytes: new Uint8Array(64) }); });
      return Promise.resolve({ status: 200, bytes: big });
    };
    const origin = createHostOrigin({ readSource, clock, pace: { fraction: HEADROOM_DEFAULT } });
    const links = [0, 1, 2].map(() => createFakeLink({ clock, hostDrainBytesPerMs: 416.667, viewerDrainBytesPerMs: 1_000_000 }));
    const detaches = links.map((link) => origin.attach(link.host));
    links.forEach((link, index) => sendRequest(link, index + 1, '/media/big.m4s'));
    clock.advance(1); // deliver the queued req controls, short of the sampler's first tick
    await flush();    // let the source read resolve and admission begin, before any sample is taken
    let fourth = null;
    let detachFourth = () => {};
    try {
      clock.advance(6000); // intervals 2 and 3 form the estimate; the rest run paced
      const evidence = origin.pace().intervals.at(-1);
      assert(evidence.paceBoundMs > 0, `the shared bucket was empty with a channel waiting for part of the interval (paceBoundMs=${evidence.paceBoundMs})`);

      // Attached once the pace binds: an idle channel on a link of its own reads no
      // queue, and the lowest channel decides whether the host's uplink is queued.
      fourth = createFakeLink({ clock, hostDrainBytesPerMs: 10_000, viewerDrainBytesPerMs: 10_000 });
      detachFourth = origin.attach(fourth.host);
      sendRequest(fourth, 99, '/media/held.m4s');
      await settle(clock, 1);
      assert(release !== null, 'the fourth channel’s source read is in flight');
      assertEqual(headsFor(fourth, 99).length, 0, 'no head before the source read resolves');
      const readAt = clock.now();
      release();
      await flush(10);
      assertEqual(headsFor(fourth, 99).length, 1, 'the head is handed to send in the turn its read resolves');
      assertEqual(headsFor(fourth, 99)[0].sentAt, readAt, 'no clock time passed before the head, though the bucket was exhausted');
      // Mutation probe, staged: `sendControl` in segment-protocol.mjs made to
      // consult `gate.available` before sending, same as a body chunk. `npm run
      // check` turned the head-instant assertion red — the head waited for the
      // exhausted bucket instead of going out the turn its read resolved.
      // Reverted; check green again.
    } finally {
      detachFourth();
      fourth?.closeBoth();
      detaches.forEach((detach) => detach());
      links.forEach((link) => link.closeBoth());
    }
  });

  await check('host-pace: an estimate formed on slow links paces at its fraction once the buffers drain', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await buildLinkBoundHost({
      clock, fraction: HEADROOM_DEFAULT, hostDrainBytesPerMs: 200, bodyBytes: SMALL_BODY_BYTES,
    });
    try {
      // Ten: the climb's first probe is the eighth interval, and the ninth holds its queue.
      clock.advance(10000);
      const result = origin.pace();
      assertEqual(result.intervals.length, 10, 'ten intervals closed');
      // T15: the first interval holds the echo that read the floor, so it is not
      // queued; the second and third are, and together they are the first reading.
      assertEqual(result.intervals[0].reason, 'no-queue', 'the first interval saw the round trip at its floor');
      assertEqual(result.intervals[1].linkBound, true, 'the second interval is link-bound');
      assertEqual(result.intervals[2].linkBound, true, 'the third interval is link-bound');
      assert(result.intervals[1].readingBytesPerSecond === null && result.intervals[2].readingBytesPerSecond !== null, 'the reading closes with the second queued interval');
      assertEqual(result.intervals.at(-1).reason, 'pace-bound', 'the pace binds once the channels\u2019 buffers have drained');
      const relError = Math.abs(result.estimate.bytesPerSecond - 600_000) / 600_000;
      assert(relError <= 0.005, `estimate within 0.5% of 600,000 B/s (got ${result.estimate.bytesPerSecond})`);
      assertEqual(result.paceBytesPerSecond, HEADROOM_DEFAULT * result.estimate.bytesPerSecond, 'pace is 0.85 × the estimate');
    } finally {
      cleanup();
    }
  });

  await check('host-pace: a paced host whose links fall lowers its estimate and its pace', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await buildLinkBoundHost({
      clock, fraction: HEADROOM_DEFAULT, hostDrainBytesPerMs: 416.667, bodyBytes: 2 * BIG_BODY_BYTES,
    });
    try {
      clock.advance(7000); // the estimate forms at 1.25 MB/s, and the buffers drain under the pace
      const before = origin.pace();
      assert(before.paceBytesPerSecond > 1_000_000, `paced near 1.06 MB/s before the fall (got ${before.paceBytesPerSecond})`);
      for (const link of links) link.host.setDrainRate(200);
      clock.advance(15000);
      const after = origin.pace(before.intervals.at(-1).seq);
      const relError = Math.abs(after.estimate.bytesPerSecond - 600_000) / 600_000;
      assert(relError <= 0.005, `estimate falls to within 0.5% of 600,000 B/s (got ${after.estimate.bytesPerSecond})`);
      assertEqual(after.paceBytesPerSecond, HEADROOM_DEFAULT * after.estimate.bytesPerSecond, 'pace is 0.85 × the fallen estimate');
      // The earlier probe here (PACE_CAP_BYTES back to one chunk) no longer turns this
      // case: the echo now reads the fall, not the bucket's burst. Re-run
      // 2026-10-03, it turned only 'no probe ran in the window' above.
    } finally {
      cleanup();
    }
  });

  await check('host-pace: unpaced publishes no rate and drains at the links’ own speed', async () => {
    const clock = createFakeClock();
    const { origin, links, cleanup } = await buildLinkBoundHost({
      clock, fraction: 'unpaced', hostDrainBytesPerMs: 416.667, bodyBytes: BIG_BODY_BYTES,
    });
    try {
      clock.advance(5000);
      const buildup = origin.pace();
      assertEqual(buildup.fraction, 'unpaced', 'fraction is published as unpaced');
      assertEqual(buildup.paceBytesPerSecond, null, 'no pace rate is published while unpaced');
      const seqAtBuildup = buildup.intervals.at(-1).seq;

      for (const link of links) link.host.setDrainRate(2500);
      clock.advance(2000);
      const seqAtWindowStart = origin.pace(seqAtBuildup).intervals.at(-1).seq;

      clock.advance(5000);
      const window = origin.pace(seqAtWindowStart);
      const drained = window.intervals.reduce((total, interval) => total + interval.drainedBodyBytes, 0);
      const threshold = 1.9 * 1062.5 * 5000;
      assert(drained > threshold, `unpaced drains well above the paced target (drained=${drained}, threshold=${threshold})`);
      assertEqual(origin.pace().paceBytesPerSecond, null, 'still no pace rate after the faster drain');
      // Mutation probe, staged: the `fraction !== 'unpaced'` guard in
      // host-origin.mjs's closeSamplerInterval dropped, so 'unpaced' set a rate
      // like any other fraction. `npm run check` turned the drained-total
      // assertion red — the links were throttled to the paced target instead of
      // draining at their own raised speed. Reverted; check green again.
    } finally {
      cleanup();
    }
  });

  await check('host-pace: every published interval keeps paceBoundMs and drainedBodyBytes within bounds', async () => {
    const clock = createFakeClock();
    const { origin, cleanup } = await buildLinkBoundHost({
      clock, fraction: HEADROOM_DEFAULT, hostDrainBytesPerMs: 416.667, bodyBytes: SMALL_BODY_BYTES,
    });
    try {
      clock.advance(6000);
      const { intervals } = origin.pace();
      assert(intervals.length >= 6, 'several intervals were collected, spanning the unpaced buildup and the paced interval after it');
      for (const interval of intervals) {
        assert(interval.paceBoundMs >= 0 && interval.paceBoundMs <= interval.durationMs,
          `interval seq ${interval.seq}: 0 <= paceBoundMs (${interval.paceBoundMs}) <= durationMs (${interval.durationMs})`);
        assert(interval.drainedBodyBytes >= 0, `interval seq ${interval.seq}: drainedBodyBytes is non-negative (${interval.drainedBodyBytes})`);
      }
      // The throw guards behind these bounds — host-origin.mjs's own two
      // RangeErrors, and classifyInterval's validateInterval underneath, which
      // closeSamplerInterval calls directly — are exercised by
      // capacity-estimate.mjs's "impossible values throw" mutation probe (T2);
      // no call reachable from this suite's public surface can construct the
      // invalid interval that would trip them.
    } finally {
      cleanup();
    }
  });
}
