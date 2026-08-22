// scripts/check/suites/clock-sync.mjs
//
// The driver and the websocket probe: scheduling, lifecycle, and the one place
// the four timestamps are wired from a real exchange into the filter.
//
// Split from suites/clock.mjs on purpose. That file is the filter, and its
// checks cost no wall-clock time at all; these ones run timers and sockets, and
// CLAUDE.md's rule is not to grow a suite past a few hundred lines.
//
// §3 proves the arithmetic on a manufactured path and the ordering assertion
// proves four ordered numbers come out of a real one. NEITHER OF THOSE CATCHES
// A SWAPPED OR SIGN-FLIPPED STAMP between them, which is what the
// estimate-against-zero check below is for.

import { check, assert, assertEqual, sleep, waitEvent } from '../harness.mjs';
import { createFakeProbe } from '../fake-probe.mjs';
import { createClockFilter } from '../../../public/lib/clock-filter.mjs';
import { createClockSync, websocketProbe } from '../../../public/lib/clock-sync.mjs';

/**
 * A fake probe whose samples are stamped in the SAME TIMEBASE the driver reads
 * the estimate in.
 *
 * The driver's default `now` is `performance.timeOrigin + performance.now()` —
 * epoch milliseconds — while `createFakeProbe` starts its own clock at 1,000,000
 * by default. A sample built there is about twenty years old the moment it
 * arrives, so the age term alone reports a half-width near 71,000,000ms and
 * EVERY CONTAINMENT ASSERTION IN THIS FILE PASSES FOR ANY OFFSET WHATSOEVER.
 * Found in the session D review, 2026-08-22; the assertions that pair with a
 * containment check now also bound the half-width, so an interval wide enough to
 * hide an error fails as readily as one too narrow.
 *
 * `intervalMs` is small for the same reason: the fake clock must not run so far
 * ahead of the real one that the age term is pinned at zero instead.
 */
function realTimebaseProbe(spec) {
  return createFakeProbe({ startMs: Date.now(), intervalMs: 10, ...spec });
}

/** room-client's `joined` event, without a room-client. */
function joinedHub() {
  const subscribers = new Set();
  return {
    on: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit: () => {
      for (const fn of subscribers) fn({});
    },
  };
}

export default async function clockSyncSuite() {
  await check('clock-sync: at most one probe is ever in flight', async () => {
    // Two concurrent probes share a queue, and over a websocket a TCP
    // connection as well — so the second one's t4 carries head-of-line blocking
    // behind the first. That is the one-directional delay the filter exists to
    // reject, manufactured by the driver itself.
    const source = createFakeProbe({ trueOffsetMs: 120, outMs: 5, backMs: 5 });
    const state = { outstanding: 0, max: 0, calls: 0 };
    const probe = async () => {
      state.calls += 1;
      state.outstanding += 1;
      state.max = Math.max(state.max, state.outstanding);
      await sleep(25);
      state.outstanding -= 1;
      return source.next().sample;
    };

    const sync = createClockSync({
      probe,
      schedule: { burstCount: 6, burstIntervalMs: 5, steadyIntervalMs: 400 },
    });
    sync.start();
    sync.burst();
    await sleep(300);
    sync.stop();

    assert(state.calls >= 4, `the driver kept probing (${state.calls} probes)`);
    assertEqual(state.max, 1, 'never more than one probe was outstanding');
  });

  // SERIAL, deliberately: this one bounds elapsed time from ABOVE against a
  // small multiple of the interval, and concurrency can inflate that.
  await check('clock-sync: a probe that never completes is abandoned, counted, and replaced on time', async () => {
    const STEADY_MS = 150;
    const issuedAt = [];
    const source = createFakeProbe({ trueOffsetMs: 0, outMs: 5, backMs: 5 });
    const probe = async () => {
      issuedAt.push(Date.now());
      // The first exchange never completes — the shape of a socket that has
      // gone quiet without closing.
      if (issuedAt.length === 1) return new Promise(() => {});
      return source.next().sample;
    };

    const sync = createClockSync({ probe, schedule: { burstCount: 0, burstIntervalMs: 20, steadyIntervalMs: STEADY_MS } });
    sync.start();
    await sleep(STEADY_MS * 2 + 60);
    sync.stop();

    assert(issuedAt.length >= 2, `a second probe was issued after the abandoned one (${issuedAt.length} probes)`);
    const gap = issuedAt[1] - issuedAt[0];
    // Bounded in units of the interval on BOTH sides, so the bound scales with
    // the setting instead of being a constant wearing an interval's clothes: it
    // must wait the timeout out, and must not wait appreciably longer.
    assert(gap >= STEADY_MS, `it waited the probe out before replacing it (${gap}ms >= ${STEADY_MS}ms)`);
    assert(gap < STEADY_MS * 2, `and replaced it within one further interval (${gap}ms < ${STEADY_MS * 2}ms)`);

    const record = sync.read();
    assertEqual(record.probes.abandoned, 1, 'the abandoned probe was counted as abandoned');
    assert(record.counters.lost >= 1, 'and reached the filter as a lost exchange');
    assertEqual(record.counters.impossible, 0, 'an abandoned probe is not an impossible sample');
  });

  await check('clock-sync: a rejoin bursts without discarding the window', async () => {
    // D8. The offset is a property of two timebases, not of a connection, and a
    // client that resets on every transient drop throws away a good estimate at
    // exactly the moment new samples are least trustworthy.
    const hub = joinedHub();
    const source = realTimebaseProbe({ trueOffsetMs: -400, outMs: 6, backMs: 6 });
    let connected = true;
    const probe = async () => (connected ? source.next().sample : null);

    const sync = createClockSync({
      probe,
      onJoined: hub.on,
      schedule: { burstCount: 4, burstIntervalMs: 8, steadyIntervalMs: 100 },
    });
    sync.start();
    hub.emit();
    await sleep(120);

    const before = sync.read();
    assert(before.sampleCount >= 2, `samples landed before the drop (${before.sampleCount})`);

    // Long enough that probes are ACTUALLY ISSUED AND LOST while disconnected.
    // At a 300ms cadence this window held no probe at all, so "the window
    // survived" was a statement about a driver that had not been asked to do
    // anything (session D, 2026-08-22).
    connected = false;
    await sleep(250);
    const during = sync.read();
    assert(during.counters.lost > before.counters.lost, `exchanges were attempted and lost while disconnected (${during.counters.lost})`);
    assertEqual(during.offsetMs, before.offsetMs, 'the estimate survives them');
    assertEqual(during.sampleCount, before.sampleCount, 'and so does the window');

    connected = true;
    hub.emit(); // a rejoin fires `joined` again — no new lifecycle event is needed
    await sleep(150);
    sync.stop();

    const after = sync.read();
    assertEqual(after.offsetMs !== null, true, 'the estimate is still reported immediately after the second join');
    assert(after.sampleCount > before.sampleCount, `the rejoin burst added samples rather than resetting (${before.sampleCount} -> ${after.sampleCount})`);
    assert(Math.abs(-400 - after.offsetMs) <= after.halfWidthMs, 'and the interval still contains the truth');
    // Two-sided, or the line above passes for any offset at all: on this path
    // the bound is half a 12ms round trip plus a fraction of a millisecond of
    // age.
    assert(after.halfWidthMs < 20, `and that interval is the derived one, not a wide one hiding an error (${after.halfWidthMs}ms)`);
  });

  await check('clock-sync: stopping while a probe is in flight does not leave the driver unable to restart', async () => {
    // `stop()` has to clear the state of the run it ends, not only its timer. A
    // driver whose `inFlight` survives the stop sees, on the next `start()`, a
    // probe in flight that only a superseded generation will ever resolve — so
    // `burst()` declines to arm a timer, nothing ever arms one again, and the
    // driver reports itself running while its clock quietly stops advancing.
    // That is D9's failure with the estimate merely going stale instead of
    // absent. Shown red before the fix: 0 probes after the restart.
    const source = realTimebaseProbe({ trueOffsetMs: 75, outMs: 5, backMs: 5 });
    let calls = 0;
    const probe = async () => {
      calls += 1;
      await sleep(40);
      return source.next().sample;
    };

    const sync = createClockSync({ probe, schedule: { burstCount: 2, burstIntervalMs: 15, steadyIntervalMs: 80 } });
    sync.start();
    await sleep(15); // inside the first probe's 40ms
    sync.stop();
    const atStop = calls;
    assertEqual(atStop, 1, 'exactly one probe had been issued, and it was still in flight at the stop');

    sync.start();
    await sleep(200);
    sync.stop();

    assert(calls > atStop, `the restarted driver issued further probes (${calls - atStop} after the restart)`);
    const record = sync.read();
    assert(Math.abs(75 - record.offsetMs) <= record.halfWidthMs, `and reached an estimate containing the truth (${record.offsetMs})`);
    assert(record.halfWidthMs < 20, `within a derived interval, not a wide one (${record.halfWidthMs}ms)`);
  });

  await check('clock-sync: no estimate and no shared time until a sample lands, then one sample is enough', async () => {
    // THE ASSERTION THAT STANDS BETWEEN CHANGE 3 AND A PLAUSIBLE DRIFT TRACE
    // FOR A CLIENT THAT WAS NEVER SYNCHRONISED. Zero is a claim, not an absence.
    const TRUE_OFFSET = 2500;
    const source = createFakeProbe({ trueOffsetMs: TRUE_OFFSET, outMs: 9, backMs: 9 });
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const probe = () => held;

    let clock = 5_000_000;
    const sync = createClockSync({
      probe,
      now: () => clock,
      schedule: { burstCount: 0, burstIntervalMs: 50, steadyIntervalMs: 4000 },
    });
    sync.start();
    await sleep(25);

    assertEqual(sync.read().offsetMs, null, 'the estimate is absent, not zero');
    assertEqual(sync.read().halfWidthMs, null, 'and so is its uncertainty');
    assertEqual(sync.sharedNow(), null, 'the shared clock reads absent rather than falling back to this client’s own');

    const first = source.next();
    release(first.sample);
    await sleep(25);
    sync.stop();

    // The burst NARROWS the clock; it does not enable it. Change 10's 2s resync
    // budget rests on one round trip being enough.
    const record = sync.read();
    assertEqual(record.sampleCount, 1, 'exactly one sample was accepted');
    assert(
      Math.abs(TRUE_OFFSET - record.offsetMs) <= record.halfWidthMs,
      `one sample is already an honest estimate (${record.offsetMs} ± ${record.halfWidthMs} against ${TRUE_OFFSET})`
    );
    assertEqual(sync.sharedNow(), clock + record.offsetMs, 'the shared reading is this client’s own plus the reported offset');
    clock += 90000;
    assertEqual(sync.sharedNow(), clock + sync.read().offsetMs, 'and it follows the client’s clock, at the instant it is read');
  });

  await check('clock-sync: a probe that throws is counted and does not stop the clock', async () => {
    // A probe is required to report a lost exchange rather than throw, so this
    // is a defect in the probe — but a defect that stops the clock for the life
    // of the page, silently, is the worse outcome.
    const source = createFakeProbe({ trueOffsetMs: 60, outMs: 4, backMs: 4 });
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls <= 2) throw new Error('probe is broken');
      return source.next().sample;
    };

    const sync = createClockSync({ probe, schedule: { burstCount: 5, burstIntervalMs: 10, steadyIntervalMs: 300 } });
    sync.start();
    sync.burst();
    await sleep(150);
    sync.stop();

    const record = sync.read();
    assertEqual(record.probes.errors, 2, 'both throws were counted as probe errors');
    assert(record.counters.lost >= 2, 'and each also reached the filter as an exchange that produced no sample');
    assert(record.lastProbeError !== null, 'and the reason is reported rather than swallowed');
    assert(record.sampleCount >= 1, 'the driver carried on and got samples afterwards');
    assertEqual(record.counters.impossible, 0, 'a throwing probe is not an impossible sample');
  });

  // -------------------------------------------------------------------------
  // The websocket probe, against a real server
  // -------------------------------------------------------------------------

  await check('websocket-probe: a real exchange yields four ordered timestamps', async ({ client }) => {
    const c = client('CLK-ORDER', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    const probe = websocketProbe(c);
    for (let i = 0; i < 5; i++) {
      const sample = await probe(2000);
      assert(sample !== null, 'the exchange completed');
      // THE FULL ORDERING IS CHECKABLE ONLY BECAUSE the check's servers run in
      // this process and share its performance.timeOrigin, so t2 and t3 are
      // comparable with t1 and t4. In production only `delay >= 0` holds — the
      // two timebases have no common origin, which is the entire reason the
      // offset has to be estimated at all.
      assert(sample.t1 <= sample.t2, `t1 <= t2 (${sample.t1} <= ${sample.t2})`);
      assert(sample.t2 <= sample.t3, `t2 <= t3 (${sample.t2} <= ${sample.t3})`);
      assert(sample.t3 <= sample.t4, `t3 <= t4 (${sample.t3} <= ${sample.t4})`);
    }
  });

  await check('websocket-probe: the estimate against a reference in this process is zero, within its own bound', async ({ client }) => {
    // THE CHECK THAT JOINS THE TWO HALVES OF THIS CHANGE. The fake probe proves
    // the arithmetic on a manufactured path; the ordering check proves four
    // numbers come out of a real one. A sign error or a swapped stamp passes
    // both. Here the true offset is ZERO BY CONSTRUCTION — both sides share
    // this process's performance.timeOrigin — so the estimate must lie within
    // its own half-width of zero.
    //
    // Possible only in the shared process. Do not try to reproduce it in a
    // browser, where there is no common origin to compare against.
    const c = client('CLK-ZERO', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    const filter = createClockFilter();
    const sync = createClockSync({
      probe: websocketProbe(c),
      filter,
      onJoined: (fn) => c.onEvent('joined', fn),
      schedule: { burstCount: 8, burstIntervalMs: 10, steadyIntervalMs: 500 },
    });
    sync.start();
    await sleep(250);
    sync.stop();

    const record = sync.read();
    assert(record.sampleCount >= 4, `real probes reached the filter (${record.sampleCount} samples)`);
    // No chosen number anywhere in this: on loopback the half-width is a
    // fraction of a millisecond, so the assertion tightens itself.
    assert(
      Math.abs(record.offsetMs) <= record.halfWidthMs,
      `the estimate is within its own half-width of zero (${record.offsetMs.toFixed(4)} ± ${record.halfWidthMs.toFixed(4)}ms)`
    );
    assert(record.halfWidthMs < 5, `and that half-width is a loopback figure, not a wide one hiding an error (${record.halfWidthMs.toFixed(4)}ms)`);
    // The cheapest available check that the timestamps are still taken where
    // change 1 put them. It goes red if a later change moves a stamp somewhere
    // more convenient.
    assertEqual(record.counters.impossible, 0, 'no real sample was physically impossible');
  });

  await check('websocket-probe: an exchange that cannot happen is lost, and the driver recovers on join', async ({ client }) => {
    const c = client('CLK-LOST', 'host');
    const sync = createClockSync({
      probe: websocketProbe(c),
      onJoined: (fn) => c.onEvent('joined', fn),
      schedule: { burstCount: 6, burstIntervalMs: 10, steadyIntervalMs: 250 },
    });

    // Started before the socket exists: every exchange is lost, reported rather
    // than thrown, and the driver keeps going.
    sync.start();
    await sleep(120);
    const beforeJoin = sync.read();
    assert(beforeJoin.counters.lost >= 1, `exchanges that could not happen were counted lost (${beforeJoin.counters.lost})`);
    assertEqual(beforeJoin.offsetMs, null, 'and produced no estimate');
    assertEqual(beforeJoin.probes.errors, 0, 'a lost exchange is not a probe error');

    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;
    await sleep(150);
    sync.stop();

    const after = sync.read();
    assert(after.sampleCount >= 2, `the join burst produced samples (${after.sampleCount})`);
    assert(Math.abs(after.offsetMs) <= after.halfWidthMs, 'and the estimate contains the truth again');
  });
}
