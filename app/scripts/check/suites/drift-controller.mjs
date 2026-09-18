// This suite drives the pure controller with constructed records and time.
// Convergence itself is swept next door, in `drift-convergence.mjs`.
//
// Traps worth preserving:
//  - A rate-only authority check lets a controller that never corrects pass, so
//    each authority assertion also proves that a nonzero error leaves unity.
//  - The stale check uses a shorter silence than the estimate window; otherwise
//    an empty window could satisfy it without proving the stale rule acted.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { plant, recordRig, runUntil } from '../drift-plant.mjs';
import { createClockFilter } from '../../../public/lib/clock-filter.mjs';
import { createDriftLog, deriveDriftRecord } from '../../../public/lib/frame-drift.mjs';
import { createDriftController } from '../../../public/lib/drift-controller.mjs';

const MILLISECONDS_TOLERANCE = 0.05;
const RATE_TOLERANCE = 1e-12;

export default async function driftControllerSuite() {
  await check('drift-controller: both sides stay within rate authority and leave unity', async () => {
    const behind = plant({ standingError: -120 });
    for (let i = 0; i < 18; i++) behind.deliver();
    const ahead = plant({ standingError: 120 });
    for (let i = 0; i < 18; i++) ahead.deliver();
    for (const sim of [behind, ahead]) {
      const { settings } = sim.controller.state();
      assert(sim.applied.some((rate) => rate !== 1), 'a nonzero error leaves the unity rate');
      assert(sim.applied.every((rate) => Math.abs(rate - 1) <= settings.MAX_RATE_DEVIATION + RATE_TOLERANCE), 'every applied rate is within authority');
    }
  });

  await check('drift-controller: behind speeds up and ahead slows down', async () => {
    const behind = plant({ standingError: -120 });
    const ahead = plant({ standingError: 120 });
    for (let i = 0; i < 18; i++) {
      behind.deliver();
      ahead.deliver();
    }
    assert(behind.applied.some((rate) => rate > 1), 'a client behind the room speeds up');
    assert(ahead.applied.some((rate) => rate < 1), 'a client ahead of the room slows down');
  });

  await check('drift-controller: a wide clock holds unity, then a narrow clock corrects', async () => {
    const sim = plant({ standingError: -120, delayTermMs: 200, ageTermMs: 100 });
    for (let i = 0; i < 12; i++) sim.deliver();
    let state = sim.controller.state();
    assertEqual(state.rate, 1, 'the wide uncertainty band holds unity');
    assert(Math.abs(state.estimateMs) <= state.halfWidthMs, 'the estimate is inside the reported wide half-width');
    assert(state.halfWidthMs > state.settings.MAX_RATE_DEVIATION * state.settings.TIME_CONSTANT_MS, 'the test pins the outcome to the reported clock width');
    sim.clock.state.delayTermMs = 1;
    sim.clock.state.ageTermMs = 1;
    sim.deliver();
    state = sim.controller.state();
    assert(state.halfWidthMs < Math.abs(state.estimateMs), 'narrowing the fake clock removes that authority');
    assert(state.rate !== 1, 'the same drift now receives a correction');
  });

  await check('drift-controller: dispersion and clock width each supply the band', async () => {
    const loud = plant({ standingError: 4, refreshHz: 60, delayTermMs: 0.1, ageTermMs: 0.1 });
    for (let i = 0; i < 18; i++) loud.deliver();
    let state = loud.controller.state();
    assert(state.spreadMs > state.halfWidthMs, 'the low-refresh sawtooth supplies the wider band');
    assertEqual(state.rate, 1, 'dispersion alone holds unity');

    const quiet = plant({ standingError: 5, refreshHz: 180, delayTermMs: 10, ageTermMs: 10 });
    for (let i = 0; i < 18; i++) quiet.deliver();
    state = quiet.controller.state();
    assert(state.halfWidthMs > state.spreadMs, 'the quiet sawtooth leaves clock width as the wider band');
    assertEqual(state.rate, 1, 'clock width alone holds unity');
  });

  await check('drift-controller: a null clock waits and never claims zero offset', async () => {
    const sim = plant({ standingError: -180, clockPresent: false });
    for (let i = 0; i < 12; i++) sim.deliver();
    const state = sim.controller.state();
    assertEqual(state.rate, 1, 'no estimate leaves the rate at unity');
    assertEqual(state.mode, 'waiting', 'the mode names the missing clock');
    assertEqual(state.reason, 'no-clock', 'null is not treated as a zero offset');
    assertEqual(state.halfWidthMs, null, 'there is no clock width without an estimate');
    assertEqual(sim.applied.length, 0, 'no correction was handed to the player');
    assertEqual(state.polls, 12, 'every no-clock evaluation advances the published count');
    assertEqual(state.windowRecords, 0, 'the controller holds no records without a clock');
    assertEqual(sim.log.read().records.length, 0, 'the controller holds no records while the producer has no clock');
    assertEqual(sim.log.counters.noClock, 12, 'the producer names every refused no-clock frame');
  });

  await check('drift-controller: the real producer stays empty until its clock publishes', async () => {
    const filter = createClockFilter();
    const log = createDriftLog({ capacity: 8 });
    const epochMs = 0;
    const timeline = { epochMsAt: () => epochMs, mediaMsAt: (sharedMs) => sharedMs - epochMs };
    const clock = { read: (atMs) => filter.read(atMs) };
    let localNowMs = 1000;

    function offerFrame() {
      const displayLocalMs = localNowMs;
      log.add(deriveDriftRecord({
        metadata: {
          mediaTime: displayLocalMs / 1000,
          expectedDisplayTime: displayLocalMs,
          presentedFrames: 1,
        },
        timeOriginMs: 0,
        localNowMs: displayLocalMs,
        clock,
        timeline,
      }));
      localNowMs += 20;
    }

    for (let i = 0; i < 5; i++) offerFrame();
    const noClockRead = filter.read(localNowMs);
    assert(noClockRead && Object.hasOwn(noClockRead, 'offsetMs'), 'the no-clock read publishes its shape');
    assertEqual(noClockRead.offsetMs, null, 'the real filter has no offset before samples');
    assertEqual(log.read().records.length, 0, 'the real producer holds no records without an offset');
    assertEqual(log.counters.noClock, 5, 'the real producer counts every refused frame');

    filter.add({ t1: 90, t2: 95, t3: 95, t4: 100 });
    const firstPublished = filter.read(localNowMs);
    assert(firstPublished && Object.hasOwn(firstPublished, 'offsetMs'), 'the first published read keeps its shape');
    assert(Number.isFinite(firstPublished.offsetMs), 'the first published offset is finite');
    assert(firstPublished.sampleCount < 8, 'the turnover run starts below the filter window cap');

    const sampleCounts = [];
    for (let i = 0; i < 24; i++) {
      offerFrame();
      const atMs = localNowMs;
      filter.add({ t1: atMs - 10, t2: atMs - 5, t3: atMs - 5, t4: atMs });
      const published = filter.read(localNowMs);
      assert(published && Object.hasOwn(published, 'offsetMs'), 'the published read keeps its shape');
      assert(Number.isFinite(published.offsetMs), 'the published offset stays finite through window turnover');
      sampleCounts.push(published.sampleCount);
    }
    const firstAtCap = sampleCounts.findIndex((sampleCount) => sampleCount === 8);
    assert(firstAtCap > 0, 'the filter sample count rises to its window cap');
    assert(sampleCounts.slice(firstAtCap).every((sampleCount) => sampleCount === 8), 'the filter sample count stays pinned after count eviction');
    assertEqual(log.read().records.length, 8, 'the producer log evicts older records after its capacity');
  });

  await check('drift-controller: no-clock time does not seed staleness before its first record', async () => {
    const sim = plant({ clockPresent: false });
    const { STALE_AFTER_MS } = sim.controller.state().settings;
    for (let i = 0; i < 3; i++) {
      sim.deliver();
      sim.advance(STALE_AFTER_MS + 1);
    }
    assertEqual(sim.log.read().records.length, 0, 'the no-clock period leaves the log empty');
    sim.clock.state.present = true;
    const firstClockBearingPoll = sim.controller.poll();
    assertEqual(sim.log.read().records.length, 0, 'the first clock-bearing poll still reads no record');
    assertEqual(firstClockBearingPoll.mode, 'waiting', 'the first clock-bearing empty poll waits');
    assertEqual(firstClockBearingPoll.reason, 'too-few-records', 'the first clock-bearing empty poll reports too few records');
    assertEqual(firstClockBearingPoll.counters.drops.stale, 0, 'no-clock time never creates a stale drop');
  });

  await check('drift-controller: polls distinguish evaluations from rate writes', async () => {
    const quiet = recordRig({ halfWidthMs: 200 });
    for (let i = 0; i < 8; i++) quiet.add(80);
    const first = quiet.controller.poll();
    const beforeHold = quiet.controller.state();
    const second = quiet.controller.poll();
    assertEqual(beforeHold.polls, first.polls, 'reading state does not add an evaluation');
    assertEqual(second.polls, first.polls + 1, 'a second evaluation increments the count exactly once');
    assertEqual(second.estimateMs, first.estimateMs, 'the repeated evaluation has the same estimate');
    assertEqual(second.rate, first.rate, 'the repeated evaluation has the same applied rate');
    assertEqual(second.correctionsApplied, first.correctionsApplied, 'a held evaluation does not count a rate write');

    const stale = recordRig({ halfWidthMs: 200, settings: { STALE_AFTER_MS: 500 } });
    for (let i = 0; i < 8; i++) stale.add(80);
    const declining = stale.controller.poll();
    stale.advance(501);
    const staleState = stale.controller.poll();
    assertEqual(declining.mode, 'declining', 'the wide band makes the first evaluation a hold');
    assertEqual(staleState.mode, 'stale', 'the later evaluation enters stale without correction');
    assertEqual(staleState.polls, declining.polls + 1, 'the stale evaluation increments the count');
    assertEqual(staleState.correctionsApplied, declining.correctionsApplied, 'the stale hold does not count a rate write');
  });

  await check('drift-controller: startup waits for MIN_RECORDS', async () => {
    const sim = recordRig();
    sim.add(-200);
    const state = sim.controller.poll();
    assertEqual(state.mode, 'waiting', 'one record does not authorize correction');
    assertEqual(state.reason, 'too-few-records', 'startup identifies the qualification hold');
    assertEqual(state.rate, 1, 'one record leaves the applied rate at unity');
    assertEqual(state.estimateMs, -200, 'one record is still reported as the measured estimate');
  });

  await check('drift-controller: seam, re-anchor and stale each drop and rebuild the window', async () => {
    const seam = recordRig();
    for (let i = 0; i < 8; i++) seam.add(100);
    seam.controller.poll();
    const seamSeq = seam.log.latestSeq;
    seam.controller.markSeam({ afterSeq: seamSeq, epochMs: 1, positionMs: 2 });
    seam.controller.poll();
    assertEqual(seam.controller.state().lastDrop.reason, 'seam', 'the seam is reported as the drop reason');
    assertEqual(seam.controller.state().mode, 'waiting', 'a seam holds unity while rebuilding');
    for (let i = 0; i < 8; i++) seam.add(-100);
    seam.controller.poll();
    assert(seam.controller.state().estimateMs < 0, 'records before the seam never enter its rebuilt estimate');

    const reanchor = recordRig();
    for (let i = 0; i < 8; i++) reanchor.add(100);
    reanchor.controller.poll();
    // The batch STRADDLES the event: frames keep arriving in the poll gap and
    // the re-anchor lands mid-way through them, which is the only way it ever
    // happens in the page. The controller sees both sides at once, so the cut
    // has to reach everything produced rather than everything already read.
    for (let i = 0; i < 4; i++) reanchor.add(100);
    reanchor.clock.state.reanchors = 1;
    for (let i = 0; i < 4; i++) reanchor.add(-100);
    reanchor.controller.poll();
    assertEqual(reanchor.controller.state().lastDrop.reason, 'reanchor', 'the re-anchor is reported');
    assertEqual(reanchor.controller.state().estimateMs, null, 'a window straddling the re-anchor is dropped whole rather than averaged across it');
    for (let i = 0; i < 8; i++) reanchor.add(-100);
    reanchor.controller.poll();
    assert(reanchor.controller.state().estimateMs < 0, 'records before the re-anchor never enter the rebuilt estimate');
    assertNear(reanchor.controller.state().estimateMs, -100, MILLISECONDS_TOLERANCE, 'the rebuilt estimate is the post-re-anchor drift alone');

    const stale = recordRig({ settings: { STALE_AFTER_MS: 500, ESTIMATE_WINDOW_MS: 1000 } });
    for (let i = 0; i < 8; i++) stale.add(100);
    stale.controller.poll();
    stale.advance(501);
    stale.controller.poll();
    assertEqual(stale.controller.state().lastDrop.reason, 'stale', 'the stale gap is reported');
    assertEqual(stale.controller.state().mode, 'stale', 'the stale rule owns the mode');
    for (let i = 0; i < 8; i++) stale.add(-100);
    stale.controller.poll();
    assert(stale.controller.state().estimateMs < 0, 'records before the stale event never enter the rebuilt estimate');
  });

  await check('drift-controller: stale is distinct while its records still fill the window', async () => {
    const sim = recordRig({ settings: { STALE_AFTER_MS: 500, ESTIMATE_WINDOW_MS: 1000 } });
    for (let i = 0; i < 8; i++) sim.add(80);
    sim.controller.poll();
    sim.advance(501);
    const state = sim.controller.poll();
    assertEqual(state.mode, 'stale', 'silence enters stale mode before the estimate window empties');
    assertEqual(state.reason, 'no-records', 'stale names the absent new records');
    assert(state.windowRecords >= state.settings.MIN_RECORDS, 'the old records still fill the rolling window');
    assertEqual(state.controlRecords, 0, 'the stale cutoff leaves no records for control');
    assertEqual(state.rate, 1, 'staleness stops the correction');
  });

  await check('drift-controller: staleness is the newest frame\'s age, not the poll\'s luck', async () => {
    // A LATE POLL READING A BACKLOG is still a page that stopped producing
    // frames. Stamping freshness with the poll instant bought the correction
    // another STALE_AFTER_MS every time consumption lagged production, which is
    // exactly the throttled-tab case the stale rule is for.
    const sim = recordRig();
    for (let i = 0; i < 8; i++) sim.add(-300);
    sim.controller.poll();
    const { STALE_AFTER_MS } = sim.controller.state().settings;
    sim.add(-300);                       // the last frame this page ever shows
    sim.advance(STALE_AFTER_MS + 100);   // silence, with no poll taken inside it
    const state = sim.controller.poll(); // and this poll DOES read that backlog
    assert(state.controlRecords === 0 || state.rate === 1, 'a stale backlog cannot authorise a correction');
    assertEqual(state.mode, 'stale', 'the mode names the silence rather than a shortage of records');
    assertEqual(state.reason, 'no-records', 'stale is reported for its own reason');
    assertEqual(state.rate, 1, 'the correction stops when feedback does');
    assert(state.counters.drops.stale >= 1, 'the stale rule is what acted, pinned to STALE_AFTER_MS');
  });

  await check('drift-controller: an offset step moves neither the window nor its membership', async () => {
    // The drift values are restated onto the current offset; the RECENCY test
    // has to be restated with them. Judged on a stamp carrying the old offset,
    // a step silently ages every held record by the size of the step and walks
    // the oldest of them out of the window.
    const sim = recordRig();
    for (let i = 0; i < 40; i++) sim.add(-150);
    const before = sim.controller.poll();
    assert(before.controlRecords >= before.settings.MIN_RECORDS, 'the window is full before the step');
    sim.clock.state.offsetMs = 300;      // a quieter sample won; no re-anchor
    const after = sim.controller.poll();
    assertEqual(after.controlRecords, before.controlRecords, 'a step drops no record out of the window');
    assert(after.mode !== 'waiting', 'a step does not re-impose the qualification hold');
    assert(after.counters.restatements > 0, 'the held records were restated rather than merely retained');
  });

  await check('drift-controller: a band wider than the error declines forever and never latches settled', async () => {
    // `settled` is a claim that the controller CLOSED the error. A client whose
    // band covers its error never corrected at all, and reporting that as
    // settled would let change 4b's browser bar -- both windows settled, rate
    // exactly 1.0 -- pass on a client that did nothing. The converse, that a
    // client which does correct still reaches settled, is the convergence
    // checks above; this assertion is only sound alongside them.
    const sim = recordRig({ halfWidthMs: 200 });
    const { SETTLED_FOR_MS } = sim.controller.state().settings;
    const dwellRecords = Math.ceil((SETTLED_FOR_MS * 2) / 20);
    for (let i = 0; i < dwellRecords; i++) {
      sim.add(120);
      if (i % 10 === 0) sim.controller.poll();
    }
    const state = sim.controller.poll();
    assert(Math.abs(state.estimateMs) > 0, 'there is a real error to decline on');
    assert(Math.abs(state.estimateMs) <= state.bandMs, 'the error sits inside the band, so the rate is held');
    assertEqual(state.rate, 1, 'a band wider than the error holds unity');
    assertEqual(state.correctionsApplied, 0, 'nothing was ever handed to the player');
    assertEqual(state.mode, 'declining', 'declining stays distinguishable from converged past the settled dwell');
    assertEqual(state.settlingMs, null, 'a client that never corrected reports no settling time');
  });

  await check('drift-controller: an offset step is restated without a qualification reset', async () => {
    const stepped = recordRig();
    for (let i = 0; i < 8; i++) stepped.add(40, 0);
    stepped.controller.poll();
    stepped.clock.state.offsetMs = 20;
    for (let i = 0; i < 2; i++) stepped.add(20, 20);
    const steppedState = stepped.controller.poll();

    const after = recordRig({ offsetMs: 20 });
    for (let i = 0; i < 8; i++) after.add(20, 20);
    const afterState = after.controller.poll();
    assertNear(steppedState.estimateMs, afterState.estimateMs, MILLISECONDS_TOLERANCE, 'records straddling the offset step match post-step records');
    assert(steppedState.counters.restatements >= 8, 'old records were restated onto the current offset');
    assert(steppedState.mode !== 'waiting' || steppedState.reason !== 'too-few-records', 'the step did not re-impose MIN_RECORDS');
  });

  await check('drift-controller: one repeated outlier does not move the correction materially', async () => {
    const sim = plant({ standingError: -100 });
    for (let i = 0; i < 18; i++) sim.deliver();
    const beforeState = sim.controller.state();
    const repeated = sim.deliver({ repeat: true });
    const afterState = sim.controller.state();
    const meanShift = Math.abs(repeated.driftMs - beforeState.estimateMs) / afterState.controlRecords;
    const estimateShift = Math.abs(afterState.estimateMs - beforeState.estimateMs);
    assert(estimateShift < meanShift / 2, `one outlier moved the median by ${estimateShift}ms, mean shift would be ${meanShift}ms`);
    const before = beforeState.rate;
    const after = afterState.rate;
    assert(Math.abs(after - before) < 0.001, `one outlier moved the rate by ${Math.abs(after - before)}`);
    assert(after > 1, 'the outlier does not reverse the underlying correction');
    assertEqual(repeated.presentedFrames, 18, 'the outlier came from a repeated frame');
  });

  await check('drift-controller: fastest close exposes authority and never writes position', async () => {
    const sim = plant({ standingError: 1000 });
    for (let i = 0; i < 12; i++) sim.deliver();
    let state = sim.controller.state();
    assert(state.fastestCloseMs > state.settings.CLOSE_BUDGET_MS, 'the floor exceeds the close budget');
    assertEqual(state.mode, 'beyond-rate-authority', 'the mode reports an unclosable error');
    assert(sim.applied.some((rate) => Math.abs(Math.abs(rate - 1) - state.settings.MAX_RATE_DEVIATION) <= RATE_TOLERANCE), 'the controller stays at full authority');
    const floor = state.fastestCloseMs;
    const result = runUntil(sim, (next) => next.mode === 'settled', floor + state.settings.SETTLED_FOR_MS + 30000);
    assert(result.elapsedMs > floor, `the real close took ${result.elapsedMs}ms, above floor ${floor}ms`);
    assert(sim.applied.every((rate) => Number.isFinite(rate)), 'the only values applied are finite rates');
  });

  await check('drift-controller: the apply seam receives rates only', async () => {
    const calls = [];
    const sim = recordRig();
    const controller = createDriftController({
      log: sim.log,
      clock: sim.clock,
      apply: (...args) => calls.push(args),
      now: () => 1,
    });
    for (let i = 0; i < 8; i++) sim.add(100);
    controller.poll();
    assert(calls.every((args) => args.length === 1 && Number.isFinite(args[0])), 'the player seam records only one finite rate argument');
    assert(!('positionMs' in controller) && !('currentTime' in controller), 'the controller exposes no position input');
  });

  await check('drift-controller: seams preserve exactly three fields in call order', async () => {
    const sim = recordRig();
    sim.controller.markSeam({ afterSeq: 4, epochMs: 10, positionMs: 20, ignored: true });
    sim.controller.markSeam({ afterSeq: 9, epochMs: 30, positionMs: 40 });
    assertEqual(JSON.stringify(sim.controller.seams), JSON.stringify([
      { afterSeq: 4, epochMs: 10, positionMs: 20 },
      { afterSeq: 9, epochMs: 30, positionMs: 40 },
    ]), 'seams are returned in order with the published shape');
  });

}
