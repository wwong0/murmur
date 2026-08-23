// scripts/check/suites/drift.mjs
//
// What is built ON the room timeline: the per-frame drift record and its
// refusals, the bounded log, and the sampler driven by a manufactured frame
// source. The timeline itself is checked in room-timeline.mjs, which shares
// nothing with this file.
//
// NOTHING IN HERE OPENS A SOCKET, TOUCHES A BROWSER OR WAITS FOR TIME. The
// three modules read no clock and hold no timer of their own — the caller
// supplies every instant and the frame callback is injected (design.md D7) — so
// every branch is reachable synchronously. If a check in this file ever has to
// wait for something, one of those modules has grown a timer it must not have.
//
// fake-frames.mjs is the instrument this one is measured with. It runs FORWARDS
// from a configured regime to metadata where the derivation runs BACKWARDS from
// metadata to a drift, and §3 compares the two against the generator's own
// `truthDriftMs` rather than against a number written down here — CONSTRAINTS.md
// → *Measurement*, an uninstrumented rig reports the builder's expectation.

import { check, assert, assertEqual } from '../harness.mjs';
import {
  createFakeClock,
  createFakeFrames,
  createFrameBinding,
  DEFAULT_CALLBACK_LEAD_MS,
  DEFAULT_TIME_ORIGIN_MS,
} from '../fake-frames.mjs';
import { createRoomTimeline } from '../../../public/lib/room-timeline.mjs';
import { createDriftLog, deriveDriftRecord, DISPLAY_WINDOW_MS } from '../../../public/lib/frame-drift.mjs';
import { createFrameSampler } from '../../../public/lib/frame-sampler.mjs';

/**
 * The generator's own numbers, so a frame hand-built here and a frame it
 * manufactures sit on one timebase and carry the same callback lead. The epoch
 * mirrors its default: a minute into the page's life, so `expectedDisplayTime`
 * is the few-second number a real callback carries.
 */
const TIME_ORIGIN_MS = DEFAULT_TIME_ORIGIN_MS;
const EPOCH_MS = TIME_ORIGIN_MS + 60_000;

/**
 * A millisecond-since-epoch double resolves to about 2^-12 ms, so a value that
 * has been through the local/shared conversion can differ in its last bit from
 * the one that was manufactured. This is that bit, not slack — every assertion
 * whose inputs are whole milliseconds below compares exactly.
 */
const ULP_MS = 1e-3;

function assertNear(actual, expected, toleranceMs, message) {
  assert(
    Math.abs(actual - expected) <= toleranceMs,
    `${message}: expected ${expected} within ${toleranceMs}, got ${actual}`
  );
}

const timelineAt = (epochMs = EPOCH_MS) => {
  const timeline = createRoomTimeline();
  // Only the join time matters to a fixture; room-timeline.mjs is where the
  // rest of a roster entry is the subject.
  timeline.observeRoster([{ clientId: 'a', joinedAt: epochMs }]);
  return timeline;
};

/**
 * One frame, built from where the room says it should be. `mediaSeconds` stays a
 * whole second and the DISPLAY INSTANT moves, so the drift is an exact integer
 * of milliseconds rather than a binary fraction of a second.
 */
function frameAt({ scheduledMediaMs, mediaSeconds = 10, offsetMs = 0, presentedFrames = 1, epochMs = EPOCH_MS }) {
  const displayLocalMs = epochMs + scheduledMediaMs - offsetMs;
  return {
    metadata: {
      mediaTime: mediaSeconds,
      expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
      presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
      presentedFrames,
    },
    displayLocalMs,
    localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
  };
}

/** The derivation, wired the way the sampler wires it. */
function derive(frame, { timeline = timelineAt(), clock = createFakeClock(), ...rest } = {}) {
  return {
    clock,
    timeline,
    outcome: deriveDriftRecord({
      metadata: frame.metadata,
      timeOriginMs: TIME_ORIGIN_MS,
      localNowMs: frame.localNowMs,
      clock,
      timeline,
      ...rest,
    }),
  };
}

/**
 * The whole path from a manufactured frame source: binding, timeline, clock,
 * log and sampler, with no browser and no elapsed time anywhere in it. The
 * clock's offset and the frames' are the same number by construction — a rig
 * whose two halves disagree measures its own wiring.
 */
function rig({ clockPresent = true, offsetMs = 0, ...spec } = {}) {
  const fake = createFakeFrames({ timeOriginMs: TIME_ORIGIN_MS, offsetMs, ...spec });
  const binding = createFrameBinding(fake);
  const clock = createFakeClock({ offsetMs, present: clockPresent });
  const log = createDriftLog();
  const sampler = createFrameSampler({
    timeline: timelineAt(fake.epochMs),
    clock,
    log,
    requestFrame: binding.requestFrame,
    cancelFrame: binding.cancelFrame,
    now: binding.now,
    timeOriginMs: fake.timeOriginMs,
  });
  return { fake, binding, clock, log, sampler };
}

export default async function driftSuite() {
  // -------------------------------------------------------------------------
  // 1. The drift derivation
  // -------------------------------------------------------------------------

  await check('frame-drift: a late frame is behind the room and an early one is ahead, exactly', async () => {
    // The sign convention change 4 is built on: POSITIVE MEANS AHEAD OF THE
    // ROOM, so a positive error is corrected by slowing down. Media stays at a
    // whole 10.000s and the display instant moves, so all three are exact.
    const onTime = derive(frameAt({ scheduledMediaMs: 10000 })).outcome;
    assert(onTime.ok, 'a frame at the scheduled position is a record');
    assertEqual(onTime.record.driftMs, 0, 'a frame displayed where the room says it should be has no drift');
    assertEqual(onTime.record.mediaMs, 10000, 'the media timestamp is carried in milliseconds');
    assertEqual(onTime.record.scheduledMediaMs, 10000, 'and the timeline’s answer beside it');

    const late = derive(frameAt({ scheduledMediaMs: 10040 })).outcome;
    assertEqual(late.record.driftMs, -40, 'a frame displayed 40ms late is 40ms behind the room');

    const early = derive(frameAt({ scheduledMediaMs: 9960 })).outcome;
    assertEqual(early.record.driftMs, 40, 'a frame displayed 40ms early is 40ms ahead of it');

    // The offset is applied, and applied in the right direction: the same frame
    // measured on a client whose clock sits 500ms from the room's is the same
    // drift, not a 500ms one.
    const offsetMs = 500;
    const shifted = derive(frameAt({ scheduledMediaMs: 10040, offsetMs }), { clock: createFakeClock({ offsetMs }) }).outcome;
    assertEqual(shifted.record.driftMs, -40, 'the clock offset converts the display instant, and cancels out of the drift');
    assertEqual(shifted.record.displaySharedMs, EPOCH_MS + 10040, 'the record carries the display instant in the ROOM’s timebase');
  });

  await check('frame-drift: the clock is read at the frame’s display instant, not at now', async () => {
    // D5: the age term has to describe the clock as it was when the frame was
    // shown. The callback fires before the frame is displayed, so reading at
    // `now` reports the estimate of a different instant — 8ms here, and a whole
    // frame interval on a slow compositor.
    const frame = frameAt({ scheduledMediaMs: 10000 });
    // The rig's two instants have to differ, or the assertion below passes
    // whichever of them the derivation read.
    assertEqual(frame.displayLocalMs - frame.localNowMs, DEFAULT_CALLBACK_LEAD_MS, 'the rig puts the callback ahead of the display');
    const { clock } = derive(frame);
    assertEqual(clock.reads.length, 1, 'the estimate was read once for the frame');
    assertEqual(clock.reads[0], frame.displayLocalMs, 'and at the instant the frame was displayed, not the instant the callback ran');
  });

  await check('frame-drift: every input a record needs is refused by its own name', async () => {
    const log = createDriftLog();
    const good = frameAt({ scheduledMediaMs: 10000 });

    // Both broken frames come from the generator rather than from a metadata
    // object edited here: two ways to spell the same corruption is how one of
    // them stops matching what a user agent actually hands back.
    const broken = createFakeFrames({
      count: 2,
      nonFiniteAt: { 0: 'mediaTime', 1: 'expectedDisplayTime' },
      timeOriginMs: TIME_ORIGIN_MS,
    });
    const brokenTimeline = timelineAt(broken.epochMs);
    const asFrame = (i) => ({ metadata: broken.frames[i].metadata, localNowMs: broken.frames[i].nowLocalMs });

    log.add(derive(asFrame(0), { timeline: brokenTimeline }).outcome);
    log.add(derive(asFrame(1), { timeline: brokenTimeline }).outcome);
    log.add(derive(good, { clock: createFakeClock({ present: false }) }).outcome);
    log.add(derive(good, { timeline: createRoomTimeline() }).outcome);
    log.add(derive(good).outcome);

    const { counters, records } = log.read();
    assertEqual(records.length, 1, 'only the frame with every input produced a record');
    assertEqual(counters.framesOffered, 5, 'and every frame offered is visible as a frame');
    assertEqual(counters.mediaTimeNotFinite, 1, 'a frame with no media timestamp is refused by name');
    assertEqual(counters.displayTimeNotFinite, 1, 'so is one with no display timestamp');
    assertEqual(counters.noClock, 1, 'so is one with no clock estimate');
    assertEqual(counters.noEpoch, 1, 'so is one the timeline has no reference point for');
    // A single `refused` total would pass a check that says nothing about which
    // input was missing, and these four have completely different causes.
    assertEqual(counters.displayTimeForeign, 0, 'and no other reason was charged for any of them');
  });

  await check('frame-drift: a frame with more than one thing wrong is charged to the first, not the last', async () => {
    // D4's ORDER IS A RULE, NOT AN ACCIDENT, and nothing else here reaches it:
    // every other refusal check breaks exactly one input, so an implementation
    // that tested the context before the frame passes all of them. The
    // co-occurrence is the ordinary case, not a corner — a page at load has
    // neither a clock nor an epoch, and charging that to `noEpoch` would leave
    // change 3b's load-gate alarm reading zero through the fault it watches for.
    const noClockNoEpoch = derive(frameAt({ scheduledMediaMs: 10000 }), {
      clock: createFakeClock({ present: false }),
      timeline: createRoomTimeline(),
    }).outcome;
    assertEqual(noClockNoEpoch.reason, 'noClock', 'no clock and no epoch is charged to the clock, which is tested first');

    // A defect in the frame itself outranks anything wrong with the context it
    // would have been measured against.
    const foreign = frameAt({ scheduledMediaMs: 10000 });
    foreign.metadata.expectedDisplayTime += 1500;
    assertEqual(
      derive(foreign, { clock: createFakeClock({ present: false }), timeline: createRoomTimeline() }).outcome.reason,
      'displayTimeForeign',
      'a display timestamp from another timebase is charged before either of them'
    );

    const bothTimestamps = frameAt({ scheduledMediaMs: 10000 });
    bothTimestamps.metadata.mediaTime = NaN;
    bothTimestamps.metadata.expectedDisplayTime = Infinity;
    assertEqual(derive(bothTimestamps).outcome.reason, 'mediaTimeNotFinite', 'and the media timestamp before the display timestamp');

    const log = createDriftLog();
    log.add(noClockNoEpoch);
    const { counters } = log.read();
    assertEqual(counters.noClock, 1, 'exactly one counter rises for the frame');
    assertEqual(counters.noEpoch, 0, 'and not also the reason it never reached');
  });

  await check('frame-drift: a display timestamp from another clock domain is refused, from either side of the window', async () => {
    const log = createDriftLog();

    const future = frameAt({ scheduledMediaMs: 10000 });
    future.metadata.expectedDisplayTime += 1500;
    const past = frameAt({ scheduledMediaMs: 10000 });
    past.metadata.expectedDisplayTime -= 1500;

    log.add(derive(future).outcome);
    log.add(derive(past).outcome);
    // Two frames into the future is what an honest callback looks like.
    log.add(derive(frameAt({ scheduledMediaMs: 10000 })).outcome);
    assertEqual(log.read().counters.displayTimeForeign, 2, 'both sides of the window are refused — the guard is two-sided');
    assertEqual(log.read().records.length, 1, 'and the honest frame in the same run is not');

    // Changing the lever and watching it move, rather than a window that looks
    // about right: the same frame is refused at a 100ms window and accepted at
    // the shipped one.
    const nearFuture = frameAt({ scheduledMediaMs: 10000 });
    nearFuture.metadata.expectedDisplayTime += 150;
    assertEqual(derive(nearFuture, { displayWindowMs: 100 }).outcome.reason, 'displayTimeForeign', 'refused at a 100ms window');
    assert(derive(nearFuture).outcome.ok, `and accepted at the ${DISPLAY_WINDOW_MS}ms window the module ships`);

    // The regime this guard exists for: a user agent reporting an absolute
    // instant where the specification says a `performance.now()` one. Nothing
    // about the metadata looks wrong, and the drift would be out by 55 years.
    const fake = createFakeFrames({ count: 1, foreignTimebaseAt: { 0: true }, timeOriginMs: TIME_ORIGIN_MS });
    const domainError = deriveDriftRecord({
      metadata: fake.frames[0].metadata,
      timeOriginMs: fake.timeOriginMs,
      localNowMs: fake.frames[0].nowLocalMs,
      clock: createFakeClock(),
      timeline: timelineAt(fake.epochMs),
    });
    assertEqual(domainError.ok, false, `${fake.describe()}: an epoch-domain display timestamp produces no record`);
    assertEqual(domainError.reason, 'displayTimeForeign', 'and is refused as what it is');

    // The OTHER half of the guard, and the reason it tests for a finite reading
    // rather than relying on the comparison: `Math.abs(NaN) > w` is FALSE, so
    // written as a bare `>` this frame would be accepted and its display
    // timestamp never judged at all. Reachable the moment a caller injects its
    // own `now` — change 3b and change 6 both do.
    const unreadable = frameAt({ scheduledMediaMs: 10000 });
    unreadable.localNowMs = NaN;
    assertEqual(derive(unreadable).outcome.reason, 'displayTimeForeign', 'a display timestamp that cannot be judged is refused, not waved through');
  });

  await check('frame-drift: every record carries its epoch and both parts of the clock’s half-width', async () => {
    const clock = createFakeClock({ offsetMs: -120, delayTermMs: 7.5, ageTermMs: 2.25, sampleCount: 6 });
    const { record } = derive(frameAt({ scheduledMediaMs: 10040, offsetMs: -120 }), { clock }).outcome;

    assertEqual(record.epochMs, EPOCH_MS, 'the epoch the drift was measured against');
    assertEqual(record.presentedFrames, 1, 'and the displayed-frame count the binding reported');
    assertEqual(record.clock.offsetMs, -120, 'the estimate used');
    assertEqual(record.clock.delayTermMs, 7.5, 'its delay term');
    assertEqual(record.clock.ageTermMs, 2.25, 'its age term');
    assertEqual(record.clock.sampleCount, 6, 'and the sample count behind it');
    // THIS PROVES THE PARTS SURVIVED THE COPY from change 2's estimate — that no
    // field was dropped or crossed on the way onto the record. It says nothing
    // about the clock being right; the clock suite proves that (D5). A review
    // that reads this as clock verification stops looking.
    assertEqual(record.clock.delayTermMs + record.clock.ageTermMs, record.clock.halfWidthMs, 'and the half-width is still the sum of them');
  });

  // -------------------------------------------------------------------------
  // 2. The log
  // -------------------------------------------------------------------------

  await check('drift-log: a reader is given only what it has not seen, in order', async () => {
    const log = createDriftLog({ capacity: 16 });
    const feed = (n, from) => {
      for (let i = 0; i < n; i++) log.add(derive(frameAt({ scheduledMediaMs: 10000 + from + i })).outcome);
    };

    feed(3, 0);
    const first = log.read();
    assertEqual(first.records.map((r) => r.seq).join(','), '1,2,3', 'the first read gets everything');
    assertEqual(first.missed, 0, 'and missed nothing');

    feed(2, 3);
    const second = log.read({ afterSeq: first.latestSeq });
    assertEqual(second.records.map((r) => r.seq).join(','), '4,5', 'the next read gets only what arrived since');
    assertEqual(second.records[0].driftMs, -3, 'and they are the records that were produced, in order');
    assertEqual(log.read({ afterSeq: second.latestSeq }).records.length, 0, 'a caught-up reader gets nothing rather than the series again');
  });

  await check('drift-log: reading leaves the store unchanged for the reader after it', async () => {
    // There are two readers — change 3b's read-out line and change 6's harness —
    // and a destructive read makes the number on the page change whenever the
    // harness happens to poll.
    const log = createDriftLog({ capacity: 16 });
    for (let i = 0; i < 5; i++) log.add(derive(frameAt({ scheduledMediaMs: 10000 + i })).outcome);

    const before = JSON.stringify(log.summary());
    const one = log.read({ afterSeq: 1 });
    const two = log.read({ afterSeq: 1 });
    assertEqual(JSON.stringify(one.records), JSON.stringify(two.records), 'two readers making the same request see the same records');
    assertEqual(JSON.stringify(log.summary()), before, 'and the summary is untouched by either of them');
  });

  await check('drift-log: records displaced by newer ones are counted, and the count follows the capacity', async () => {
    // Pinned to the SETTING, not to a constant: the expected value is computed
    // from the capacity in force, so the same assertion is correct at the
    // default. Shown to discriminate by running it at two capacities and
    // watching the expected number move with the lever.
    const overflow = 7;
    for (const capacity of [8, 20]) {
      const log = createDriftLog({ capacity });
      const produced = capacity + overflow;
      for (let i = 0; i < produced; i++) log.add(derive(frameAt({ scheduledMediaMs: 10000 + i })).outcome);

      const read = log.read();
      assertEqual(read.missed, produced - capacity, `at capacity ${capacity}, the reader is told how many it will never see`);
      assertEqual(read.records.length, capacity, 'and gets exactly what the ring still holds');
      assertEqual(read.records[0].seq, overflow + 1, 'the oldest record held is the first that was not displaced');
      assertEqual(read.latestSeq, produced, 'sequence numbers keep counting past the ring — they are never reused');
      // A reader that is up to date has missed nothing, however much fell out
      // of the ring before it started reading.
      assertEqual(log.read({ afterSeq: produced }).missed, 0, 'and a caught-up reader is told it missed nothing');
    }
  });

  await check('drift-log: the summary describes the records held, and a silent source is not zero drift', async () => {
    // Driven from a started sampler whose binding never fires, which is the
    // shape a silent frame source actually has — an armed callback the user
    // agent never calls, not a log nobody wrote to.
    const idle = rig({ count: 4 });
    idle.sampler.start();
    assertEqual(idle.sampler.callbacks, 0, 'a source that never fired delivered no callbacks');
    const nothing = idle.log.summary();
    assertEqual(nothing.framesHeld, 0, 'a source that delivered nothing recorded nothing');
    assertEqual(nothing.framesOffered, 0, 'and offered nothing');
    // The distinction D4 exists for: a run that logs nothing and a run that logs
    // zeros are the same rig, and only one of them says so.
    assertEqual(nothing.medianDriftMs, null, 'so there is no median, rather than a median of zero');
    assertEqual(nothing.maxAbsDriftMs, null, 'and no maximum');

    // A known series, straddling zero: drifts of +50, +49, ... -49, whose
    // statistics are exact.
    const log = createDriftLog({ capacity: 100 });
    for (let i = 0; i < 100; i++) log.add(derive(frameAt({ scheduledMediaMs: 10000 + i - 50 })).outcome);
    const summary = log.summary();
    assertEqual(summary.framesHeld, 100, 'the count is of the records HELD — a rolling window, not the run');
    assertEqual(summary.medianDriftMs, 0.5, 'the median of the hundred held');
    // SIGNED, and the ahead-of-the-room end of the series: a client that is
    // uniformly behind reports a p99 nearer zero than its typical drift, which
    // is why the magnitude question is `maxAbsDriftMs` and not this.
    assertEqual(summary.p99DriftMs, 49, 'the 99th percentile, by nearest rank, is a value that was measured');
    assertEqual(summary.maxAbsDriftMs, 50, 'and the largest absolute drift is the far end of the other side');

    // The window rolls: once the ring turns over the summary describes what is
    // left, which is why it must never be reported as the run's median.
    for (let i = 100; i < 150; i++) log.add(derive(frameAt({ scheduledMediaMs: 10000 + i - 50 })).outcome);
    assertEqual(log.summary().framesHeld, 100, 'still a hundred held');
    assertEqual(log.summary().medianDriftMs, -49.5, 'over the last hundred, not the hundred and fifty produced');
    assertEqual(log.read().counters.framesOffered, 150, 'while the frames offered keep counting');
  });

  // -------------------------------------------------------------------------
  // 3. The sampler, driven by a manufactured frame source
  // -------------------------------------------------------------------------

  await check('frame-sampler: a manufactured binding drives the whole path, and the drift it reports is the drift that was built in', async () => {
    // Exact 1x playback: the media clock and the room timeline advance
    // together, so every frame should report no drift at all.
    const steady = rig({ count: 30 });
    steady.sampler.start();
    steady.binding.deliver(30);

    const { records } = steady.log.read();
    assertEqual(records.length, 30, `${steady.fake.describe()}: every frame the binding delivered produced a record`);
    assertEqual(steady.sampler.callbacks, 30, 'and the sampler counted every callback');
    for (const [i, record] of records.entries()) {
      assertNear(record.driftMs, steady.fake.frames[i].truthDriftMs, ULP_MS, `frame ${i} reports the drift it was built with`);
      assertNear(record.driftMs, 0, ULP_MS, `frame ${i} of exact 1x playback has no drift`);
      assertEqual(record.epochMs, steady.fake.epochMs, `frame ${i} carries the epoch it was measured against`);
      assertEqual(record.presentedFrames, i + 1, `frame ${i} carries the displayed-frame count the binding reported`);
    }

    // A player running 5% fast is AHEAD of the room, and the sign says so.
    const fast = rig({ count: 30, rate: 1.05 });
    fast.sampler.start();
    fast.binding.deliver(30);
    const fastRecords = fast.log.read().records;
    const last = fastRecords[fastRecords.length - 1];
    assertNear(last.driftMs, fast.fake.frames[29].truthDriftMs, ULP_MS, `${fast.fake.describe()}: the rate error is reported`);
    assert(last.driftMs > 40, `a 5% rate error over 30 frames is ${last.driftMs.toFixed(1)}ms ahead of the room`);
    assert(fastRecords[0].driftMs < last.driftMs, 'and it grew, rather than being a constant offset');

    // A stall: the media clock freezes for ten frames while the room's does not,
    // and the deficit stays after playback resumes. Nothing corrects it — this
    // change measures and never touches `playbackRate` (change 4).
    const stalled = rig({ count: 30, stallAt: 10, stallFrames: 10 });
    stalled.sampler.start();
    stalled.binding.deliver(30);
    const stalledRecords = stalled.log.read().records;
    assertNear(stalledRecords[9].driftMs, 0, ULP_MS, 'before the stall the client is with the room');
    assertNear(stalledRecords[19].driftMs, -10 * stalled.fake.intervalMs, ULP_MS, 'through the stall it falls behind by exactly the frames it did not advance');
    assertNear(stalledRecords[29].driftMs, stalledRecords[19].driftMs, ULP_MS, 'and after resuming it stays behind by the same amount');
  });

  await check('frame-sampler: a repeated frame is recorded, and says it was a repeat', async () => {
    // D4: every frame that passes is recorded, a re-presented one included, and
    // `presentedFrames` is what lets a consumer tell them apart. This module
    // does not decide what a repeat means.
    const repeated = rig({ count: 4, repeatAt: { 2: true } });
    repeated.sampler.start();
    repeated.binding.deliver(4);

    const { records } = repeated.log.read();
    assertEqual(records.length, 4, 'four frames delivered, four records');
    assertEqual(records[2].mediaMs, records[1].mediaMs, 'the repeat shows the same media timestamp as the frame before it');
    assertEqual(records[2].presentedFrames, records[1].presentedFrames, 'and the same displayed-frame count');
    assert(records[2].driftMs < records[1].driftMs, 'so it has fallen further behind the room, which is what a held frame does');
    assertEqual(records[3].presentedFrames, records[2].presentedFrames + 1, 'and the frame after it advances again');
  });

  await check('frame-sampler: stopping ends recording even if a callback still arrives, and starting again resumes', async () => {
    const { sampler, binding, log } = rig({ count: 6 });
    sampler.start();
    binding.deliver(2);
    assertEqual(log.read().records.length, 2, 'two frames, two records');

    // The callback that was in flight when stop() ran. Cancellation is
    // best-effort — a user agent may dispatch it anyway — so the sampler's own
    // guard is the only thing between this frame and a record.
    const inFlight = binding.hold();
    sampler.stop();
    assertEqual(sampler.running, false, 'the sampler reports itself stopped');
    binding.deliverStale(inFlight);
    assertEqual(log.read().records.length, 2, 'a callback delivered after stop produces no record');
    assertEqual(log.read().counters.framesOffered, 2, 'and is not even offered to the log');
    assertEqual(sampler.callbacks, 2, 'nor counted as a callback');

    sampler.start();
    // THE CASE THE GENERATION COUNTER EXISTS FOR: the same stale callback,
    // arriving after a restart. `running` is true again, so nothing but the
    // generation tells it from a live one — and it belongs to a run that ended.
    binding.deliverStale(inFlight);
    assertEqual(log.read().records.length, 2, 'a callback armed before the stop produces no record after the restart either');
    assertEqual(sampler.callbacks, 2, 'and is still not a callback of this run');

    binding.deliver(1);
    assertEqual(log.read().records.length, 3, 'while a live one records again — stop() cleared the scheduling state');
  });

  await check('frame-sampler: with no clock estimate it refuses every frame and records none, then records the first frame after one arrives', async () => {
    // READ DURING THE TRANSIENT, not only at the end (`CONSTRAINTS.md` →
    // *Verification*, change 2's lesson): a steady state reached from a bad one
    // looks identical to a steady state that was never bad.
    const { sampler, binding, log, clock } = rig({ count: 5, clockPresent: false });
    sampler.start();
    binding.deliver(3);

    const during = log.read();
    assertEqual(during.records.length, 0, 'no record is produced while there is no estimate');
    assertEqual(during.counters.noClock, 3, 'every frame offered is refused for the missing clock');
    assertEqual(during.counters.framesOffered, 3, 'and none of them is refused for anything else');
    assertEqual(sampler.callbacks, 3, 'the frames arrived — the instrument is not silent, the clock is missing');
    assertEqual(log.summary().medianDriftMs, null, 'and there is no drift figure, rather than a drift of zero');

    clock.state.present = true;
    binding.deliver(1);
    const after = log.read();
    assertEqual(after.records.length, 1, 'the first frame after an estimate arrives produces a record');
    assertEqual(after.counters.noClock, 3, 'and the refusals before it stay counted');
  });
}
