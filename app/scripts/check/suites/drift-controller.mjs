// This suite drives the pure controller with constructed records and time.
//
// Traps worth preserving:
//  - A rate-only authority check lets a controller that never corrects pass, so
//    each authority assertion also proves that a nonzero error leaves unity.
//  - The stale check uses a shorter silence than the estimate window; otherwise
//    an empty window could satisfy it without proving the stale rule acted.

import { check, assert, assertEqual } from '../harness.mjs';
import { createFakeClock, DEFAULT_CALLBACK_LEAD_MS, DEFAULT_TIME_ORIGIN_MS } from '../fake-frames.mjs';
import { createDriftLog, deriveDriftRecord } from '../../../public/lib/frame-drift.mjs';
import { createDriftController } from '../../../public/lib/drift-controller.mjs';
import { createRoomTimeline } from '../../../public/lib/room-timeline.mjs';

const TIME_ORIGIN_MS = DEFAULT_TIME_ORIGIN_MS;
const MILLISECONDS_TOLERANCE = 0.05;
const RATE_TOLERANCE = 1e-12;

function near(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function controllerClock(base) {
  return {
    state: base.state,
    reads: base.reads,
    read(atMs) {
      return { ...base.read(atMs), counters: { reanchors: base.state.reanchors ?? 0 } };
    },
  };
}

function plant({
  standingError = -240,
  refreshHz = 180,
  fps = 24,
  offsetMs = 0,
  delayTermMs = 3,
  ageTermMs = 1,
  clockPresent = true,
  settings = {},
  pollEvery = 1,
} = {}) {
  const epochMs = TIME_ORIGIN_MS + 60_000;
  const intervalMs = 1000 / fps;
  const vsyncMs = 1000 / refreshHz;
  const timeline = createRoomTimeline();
  timeline.observeRoster([{ clientId: 'a', joinedAt: epochMs }]);
  const clock = controllerClock(createFakeClock({ offsetMs, delayTermMs, ageTermMs, present: clockPresent }));
  const log = createDriftLog({ capacity: 10000 });
  const applied = [];
  const history = [];
  let simulatedNowMs = epochMs - offsetMs;
  const firstDisplayMs = Math.ceil(intervalMs / vsyncMs) * vsyncMs;
  let mediaMs = standingError + firstDisplayMs - intervalMs;
  let frameIndex = 0;
  let controller;

  const quantisedDisplay = () => {
    const sharedElapsed = simulatedNowMs + offsetMs - epochMs;
    return epochMs + Math.ceil(sharedElapsed / vsyncMs) * vsyncMs;
  };

  controller = createDriftController({
    log,
    clock,
    apply: (rate) => {
      applied.push(rate);
      controllerRate = rate;
    },
    settings,
    now: () => simulatedNowMs,
  });
  let controllerRate = 1;

  function deliver({ repeat = false } = {}) {
    if (!repeat) mediaMs += intervalMs;
    simulatedNowMs += intervalMs / controllerRate;
    const displaySharedMs = quantisedDisplay();
    const displayLocalMs = displaySharedMs - offsetMs;
    const metadata = {
      mediaTime: mediaMs / 1000,
      expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
      presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
      presentedFrames: repeat ? frameIndex : frameIndex + 1,
    };
    log.add(deriveDriftRecord({
      metadata,
      timeOriginMs: TIME_ORIGIN_MS,
      localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
      clock,
      timeline,
    }));
    frameIndex += 1;
    if (frameIndex % pollEvery === 0) history.push(controller.poll());
    return log.read().records.at(-1);
  }

  return {
    clock,
    log,
    applied,
    history,
    controller,
    get now() { return simulatedNowMs; },
    get rate() { return controllerRate; },
    deliver,
    advance(ms) { simulatedNowMs += ms; },
  };
}

function recordRig({ settings = {}, offsetMs = 0, halfWidthMs = 4 } = {}) {
  const epochMs = TIME_ORIGIN_MS + 60_000;
  const timeline = createRoomTimeline();
  timeline.observeRoster([{ clientId: 'a', joinedAt: epochMs }]);
  const clock = controllerClock(createFakeClock({ offsetMs, delayTermMs: halfWidthMs, ageTermMs: 0 }));
  const log = createDriftLog({ capacity: 10000 });
  let localNowMs = epochMs + 2000 - offsetMs;
  const applied = [];
  const controller = createDriftController({
    log,
    clock,
    apply: (rate) => applied.push(rate),
    settings,
    now: () => localNowMs,
  });

  function add(rawDriftMs, recordOffsetMs = clock.state.offsetMs) {
    const displaySharedMs = localNowMs + clock.state.offsetMs;
    const displayLocalMs = displaySharedMs - recordOffsetMs;
    clock.state.offsetMs = recordOffsetMs;
    const scheduledMediaMs = displaySharedMs - epochMs;
    const outcome = deriveDriftRecord({
      metadata: {
        mediaTime: (scheduledMediaMs + rawDriftMs) / 1000,
        expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
        presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
        presentedFrames: 1,
      },
      timeOriginMs: TIME_ORIGIN_MS,
      localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
      clock,
      timeline,
    });
    log.add(outcome);
    localNowMs += 20;
    return outcome;
  }

  function poll() {
    return controller.poll();
  }

  return { clock, log, controller, applied, add, poll, advance(ms) { localNowMs += ms; } };
}

function runUntil(thing, predicate, limitMs, frameMs = 1000 / 24) {
  const start = thing.now;
  let frames = 0;
  while (!predicate(thing.controller.state()) && thing.now - start <= limitMs) {
    thing.deliver();
    frames += 1;
  }
  return { elapsedMs: thing.now - start, frames, state: thing.controller.state() };
}

export default async function driftControllerSuite() {
  await check('drift-controller: converges from a standing offset within the computed budget', async () => {
    const sim = plant();
    for (let i = 0; i < 24; i++) sim.deliver();
    const { settings } = sim.controller.state();
    const band = sim.controller.state().bandMs;
    const d0 = Math.abs(sim.controller.state().estimateMs ?? 240);
    const saturated = (d0 - settings.MAX_RATE_DEVIATION * settings.TIME_CONSTANT_MS) / settings.MAX_RATE_DEVIATION;
    const glide = Math.log(settings.MAX_RATE_DEVIATION * settings.TIME_CONSTANT_MS / band) * settings.TIME_CONSTANT_MS;
    const budget = (saturated + glide + settings.SETTLED_FOR_MS) * 1.25;
    const result = runUntil(sim, (state) => state.mode === 'settled', budget);
    assert(result.elapsedMs <= budget, `settled in ${result.elapsedMs}ms, budget was ${budget}ms`);
    assertEqual(result.state.mode, 'settled', 'the controller latches settled');
    assert(result.state.settlingMs !== null, 'settlingMs reports the completed settling interval');
  });

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

  await check('drift-controller: settling does not oscillate or leave the band', async () => {
    const sim = plant({ standingError: -120, pollEvery: 24 });
    for (let i = 0; i < 24; i++) sim.deliver();
    const result = runUntil(sim, (state) => state.mode === 'settled', 40000);
    assertEqual(result.state.mode, 'settled', 'the run settles before its observation span');
    const start = sim.applied.length;
    for (let i = 0; i < 300; i++) sim.deliver();
    const signs = sim.applied.slice(start).map((rate) => Math.sign(rate - 1)).filter(Boolean);
    let reversals = 0;
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) reversals += 1;
    assert(reversals <= 2, `the settled correction reversed ${reversals} times`);
    assertEqual(sim.controller.state().mode, 'settled', 'the estimate remains settled');
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
  });

  await check('drift-controller: startup waits for MIN_RECORDS', async () => {
    const sim = recordRig();
    sim.add(-200);
    const state = sim.poll();
    assertEqual(state.mode, 'waiting', 'one record does not authorize correction');
    assertEqual(state.reason, 'too-few-records', 'startup identifies the qualification hold');
    assertEqual(state.rate, 1, 'one record leaves the applied rate at unity');
    assertEqual(state.estimateMs, -200, 'one record is still reported as the measured estimate');
  });

  await check('drift-controller: seam, re-anchor and stale each drop and rebuild the window', async () => {
    const seam = recordRig();
    for (let i = 0; i < 8; i++) seam.add(100);
    seam.poll();
    const seamSeq = seam.log.latestSeq;
    seam.controller.markSeam({ afterSeq: seamSeq, epochMs: 1, positionMs: 2 });
    seam.poll();
    assertEqual(seam.controller.state().lastDrop.reason, 'seam', 'the seam is reported as the drop reason');
    assertEqual(seam.controller.state().mode, 'waiting', 'a seam holds unity while rebuilding');
    for (let i = 0; i < 8; i++) seam.add(-100);
    seam.poll();
    assert(seam.controller.state().estimateMs < 0, 'records before the seam never enter its rebuilt estimate');

    const reanchor = recordRig();
    for (let i = 0; i < 8; i++) reanchor.add(100);
    reanchor.poll();
    reanchor.clock.state.reanchors = 1;
    for (let i = 0; i < 8; i++) reanchor.add(-100);
    reanchor.poll();
    assertEqual(reanchor.controller.state().lastDrop.reason, 'reanchor', 'the re-anchor is reported');
    assert(reanchor.controller.state().estimateMs < 0, 'records before the re-anchor never enter the rebuilt estimate');

    const stale = recordRig({ settings: { STALE_AFTER_MS: 500, ESTIMATE_WINDOW_MS: 1000 } });
    for (let i = 0; i < 8; i++) stale.add(100);
    stale.poll();
    stale.advance(501);
    stale.poll();
    assertEqual(stale.controller.state().lastDrop.reason, 'stale', 'the stale gap is reported');
    assertEqual(stale.controller.state().mode, 'stale', 'the stale rule owns the mode');
    for (let i = 0; i < 8; i++) stale.add(-100);
    stale.poll();
    assert(stale.controller.state().estimateMs < 0, 'records before the stale event never enter the rebuilt estimate');
  });

  await check('drift-controller: stale is distinct while its records still fill the window', async () => {
    const sim = recordRig({ settings: { STALE_AFTER_MS: 500, ESTIMATE_WINDOW_MS: 1000 } });
    for (let i = 0; i < 8; i++) sim.add(80);
    sim.poll();
    sim.advance(501);
    const state = sim.controller.poll();
    assertEqual(state.mode, 'stale', 'silence enters stale mode before the estimate window empties');
    assertEqual(state.reason, 'no-records', 'stale names the absent new records');
    assert(state.windowRecords >= state.settings.MIN_RECORDS, 'the old records still fill the rolling window');
    assertEqual(state.controlRecords, 0, 'the stale cutoff leaves no records for control');
    assertEqual(state.rate, 1, 'staleness stops the correction');
  });

  await check('drift-controller: an offset step is restated without a qualification reset', async () => {
    const stepped = recordRig();
    for (let i = 0; i < 8; i++) stepped.add(40, 0);
    stepped.poll();
    stepped.clock.state.offsetMs = 20;
    for (let i = 0; i < 2; i++) stepped.add(20, 20);
    const steppedState = stepped.poll();

    const after = recordRig({ offsetMs: 20 });
    for (let i = 0; i < 8; i++) after.add(20, 20);
    const afterState = after.poll();
    near(steppedState.estimateMs, afterState.estimateMs, MILLISECONDS_TOLERANCE, 'records straddling the offset step match post-step records');
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

  await check('drift-controller: the measured 60Hz sawtooth still converges', async () => {
    const sim = plant({ refreshHz: 60, standingError: -240, pollEvery: 24 });
    for (let i = 0; i < 24; i++) sim.deliver();
    const { settings, bandMs } = sim.controller.state();
    const d0 = Math.abs(sim.controller.state().estimateMs ?? 240);
    const budget = ((d0 - settings.MAX_RATE_DEVIATION * settings.TIME_CONSTANT_MS) / settings.MAX_RATE_DEVIATION
      + Math.log(settings.MAX_RATE_DEVIATION * settings.TIME_CONSTANT_MS / bandMs) * settings.TIME_CONSTANT_MS
      + settings.SETTLED_FOR_MS) * 1.25;
    const result = runUntil(sim, (state) => state.mode === 'settled', budget);
    assert(result.elapsedMs <= budget, `60Hz settled in ${result.elapsedMs}ms, budget was ${budget}ms`);
    assert(result.state.spreadMs !== null, '60Hz publishes the measured cadence spread');
    assert(sim.history.some((state) => state.spreadMs > state.halfWidthMs), '60Hz exercises dispersion in the band');
    assertEqual(result.state.mode, 'settled', 'the display-rate change does not prevent settling');
  });
}
