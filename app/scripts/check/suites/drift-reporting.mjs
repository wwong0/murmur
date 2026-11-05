// scripts/check/suites/drift-reporting.mjs
//
// What the controller publishes, what it withholds, and which population a
// consumer built on that snapshot is entitled to.
//
// The threshold arithmetic is exercised at U=3, L=12, S=15 through the exported
// pure functions, with every expected value computed here from the inputs. A
// default-constructed controller runs at f=0, where L is 0 and S is U. A
// positive f is the adopted stopping value, passed in by the page only once the
// pitch treatment holds; its behaviour is in
// stopping-product-integration.mjs, and this file checks only what construction takes.
//
// Traps worth preserving:
//  - `recordRig` owns its simulated clock and does not publish it, so `timed`
//    keeps a second copy. It cannot drift silently: the dwell and excursion
//    boundaries in `drift-settling.mjs` are asserted against that copy, in ms.
//  - A hold retains what it MEASURED and withholds what it would have ACTED on.
//    Every "still null" assertion here follows a poll that published the figure,
//    so the clearing is a transition rather than a constant.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { plant, recordRig } from '../drift-plant.mjs';
import { timed } from '../drift-reporting-fixtures.mjs';
import { createDriftLog } from '../../../public/lib/frame-drift.mjs';
import { createDiagnosticsOverlay } from '../../../public/lib/diagnostics-overlay.mjs';
import {
  STOPPING_COMMAND_THRESHOLD,
  DECLINING_REASONS,
  MAX_STOPPING_THRESHOLD_MS,
  actuatorAllowanceMs,
  createDriftController,
  decliningReason,
  shortestCloseMs,
  thresholdComponents,
} from '../../../public/lib/drift-controller.mjs';
import { DEFAULT_BARS, actedOnMeasurement, observationStats, steadyCommandStretches } from '../../drift-figures.mjs';

// The hand-computed reference case. f and T are independent inputs, L is their
// product, U is the larger of two independent measurement arms and S is U + L.
const HAND_FLOOR = 0.003;
const HAND_T_MS = 4000;
const HAND_L_MS = 12;
const HAND_U_MS = 3;
const HAND_S_MS = 15;
const MAX_RATE_DEVIATION = 0.01;
// A millionth of the smallest quantity any case below turns on, asserted as
// such rather than chosen to fit: 1e-8 against an L of 12 ms and a U of 3 ms.
const COMPONENT_TOLERANCE_MS = 1e-8;
const CLOSE_TOLERANCE_MS = 1e-9;

const refused = (overrides) => {
  const applied = [];
  const rig = recordRig();
  let error = null;
  try {
    createDriftController({ log: rig.log, clock: rig.clock, apply: (rate) => applied.push(rate), settings: overrides, now: () => 0 });
  } catch (err) {
    error = err;
  }
  return { error, applied };
};

/** A snapshot as a consumer receives it, with only the tested field free to vary. */
const consumerSample = (overrides = {}) => ({
  atMs: 0,
  polls: 1,
  mode: 'declining',
  reason: null,
  rate: 1.001,
  estimateMs: 2,
  bandMs: 2,
  spreadMs: 1,
  halfWidthMs: 2,
  measurementLimit: 'clock',
  actuatorAllowanceMs: 0,
  requiredStoppingThresholdMs: 2,
  stoppingThresholdMs: 2,
  thresholdUsable: true,
  fastestCloseMs: 0,
  windowRecords: 8,
  controlRecords: 8,
  ...overrides,
});

const overlayLine = (state) => createDiagnosticsOverlay({
  clock: { read: () => ({ offsetMs: null, halfWidthMs: null, sampleCount: 0 }) },
  controller: { state: () => state },
  log: createDriftLog(),
  playback: { state: () => ({ playing: true, missing: null }) },
}).lines().controller;

export default async function driftReportingSuite() {
  await check('drift-reporting: U, L and S are computed from independent inputs', async () => {
    assert(COMPONENT_TOLERANCE_MS <= HAND_U_MS * 1e-6, 'the component tolerance is a millionth of the smallest quantity it bounds');
    assertNear(actuatorAllowanceMs(HAND_FLOOR, HAND_T_MS), HAND_L_MS, COMPONENT_TOLERANCE_MS, 'f times T is the actuator allowance');
    assertNear(actuatorAllowanceMs(0.002, 3000), 6, COMPONENT_TOLERANCE_MS, 'a different f and T give a different allowance');
    assertEqual(actuatorAllowanceMs(0, HAND_T_MS), 0, 'a zero floor allows nothing, at any time constant');

    // ONE U FROM THREE DIFFERENT PAIRS OF ARMS. The band is the larger arm, so
    // all three give 3 ms and 15 ms; only `measurementLimit` tells them apart,
    // which is what it is for.
    const clockArm = thresholdComponents({ halfWidthMs: 3, spreadMs: 2, allowanceMs: HAND_L_MS });
    const dispersionArm = thresholdComponents({ halfWidthMs: 2, spreadMs: 3, allowanceMs: HAND_L_MS });
    const tied = thresholdComponents({ halfWidthMs: 3, spreadMs: 3, allowanceMs: HAND_L_MS });
    for (const [name, components] of [['clock', clockArm], ['dispersion', dispersionArm], ['tie', tied]]) {
      assertEqual(components.bandMs, HAND_U_MS, `${name} dominance gives U = 3ms`);
      assertEqual(components.requiredStoppingThresholdMs, HAND_S_MS, `${name} dominance gives S = U + L = 15ms`);
    }
    assertEqual(clockArm.measurementLimit, 'clock', 'the wider clock arm names the clock');
    assertEqual(dispersionArm.measurementLimit, 'dispersion', 'the wider dispersion arm names the dispersion');
    assertEqual(tied.measurementLimit, 'clock-and-dispersion', 'equal arms name both, on exact equality alone');
    assertEqual(thresholdComponents({ halfWidthMs: 3, spreadMs: 3.000001, allowanceMs: 0 }).measurementLimit, 'dispersion',
      'a millionth of a millisecond apart is not a tie');

    // S MOVES WITH L AND WITH U SEPARATELY, so neither is the other in disguise.
    assertEqual(thresholdComponents({ halfWidthMs: 3, spreadMs: 2, allowanceMs: 6 }).requiredStoppingThresholdMs, 9, 'halving the allowance halves what it added');
    assertEqual(thresholdComponents({ halfWidthMs: 3, spreadMs: 2, allowanceMs: 0 }).requiredStoppingThresholdMs, HAND_U_MS, 'a zero allowance leaves S equal to U — this branch');
    assertEqual(thresholdComponents({ halfWidthMs: 9, spreadMs: 2, allowanceMs: HAND_L_MS }).requiredStoppingThresholdMs, 21, 'a wider band widens S by the same amount');

    const noWindow = thresholdComponents({ halfWidthMs: 3, spreadMs: null, allowanceMs: HAND_L_MS });
    assertEqual(noWindow.bandMs, null, 'no dispersion is no band');
    assertEqual(noWindow.measurementLimit, null, 'with no U there is no arm to name');
    assertEqual(noWindow.requiredStoppingThresholdMs, null, 'with no U there is no required threshold — never the allowance alone');
    const noClock = thresholdComponents({ halfWidthMs: null, spreadMs: 3, allowanceMs: HAND_L_MS });
    assertEqual(noClock.bandMs, HAND_U_MS, 'a missing clock arm leaves the dispersion arm as U');
    assertEqual(noClock.measurementLimit, 'dispersion', 'a missing clock arm is not a tie at zero');
  });

  await check('drift-reporting: the shortest close is a bound, and never a non-finite number', async () => {
    assertEqual(shortestCloseMs(100, HAND_S_MS, MAX_RATE_DEVIATION), 8500, '85ms of excess closes in 8500ms at 0.01');
    assertEqual(shortestCloseMs(-100, HAND_S_MS, MAX_RATE_DEVIATION), 8500, 'the bound is on the magnitude, not the sign');
    assertEqual(shortestCloseMs(HAND_S_MS, HAND_S_MS, MAX_RATE_DEVIATION), 0, 'at the threshold there is nothing left to close');
    assertEqual(shortestCloseMs(HAND_U_MS, HAND_S_MS, MAX_RATE_DEVIATION), 0, 'inside the threshold there is nothing left to close');
    const justOutside = shortestCloseMs(15.000001, HAND_S_MS, MAX_RATE_DEVIATION);
    assert(justOutside > 0, 'a millionth of a millisecond outside is a positive close, not zero');
    assertNear(justOutside, 1e-4, CLOSE_TOLERANCE_MS, 'and it is that millionth divided by the authority');

    // A ZERO ALLOWED MAXIMUM. The division is 0/0 and x/0; neither answer may
    // be published as a number, and the two cases are not the same answer.
    assertEqual(shortestCloseMs(HAND_S_MS, HAND_S_MS, 0), 0, 'zero authority still closes an error it is already inside');
    assertEqual(shortestCloseMs(100, HAND_S_MS, 0), null, 'zero authority cannot close an error outside, so there is no figure');
    for (const estimateMs of [0, 3, 15, 15.000001, 100, -100]) {
      for (const max of [0, MAX_RATE_DEVIATION]) {
        const close = shortestCloseMs(estimateMs, HAND_S_MS, max);
        assert(close === null || Number.isFinite(close), `close for ${estimateMs}ms at max ${max} is null or finite, not ${close}`);
      }
    }
  });

  await check('drift-reporting: a declining client names the limit that held it', async () => {
    assertEqual(JSON.stringify(DECLINING_REASONS), JSON.stringify(['measurement-limit', 'actuator-limit']), 'the two declining reasons are published in the contract');
    assertEqual(decliningReason(HAND_U_MS, HAND_U_MS), 'measurement-limit', 'at U exactly, the measurement is the limit');
    assertEqual(decliningReason(2.999999, HAND_U_MS), 'measurement-limit', 'inside U, the measurement is the limit');
    assertEqual(decliningReason(3.000001, HAND_U_MS), 'actuator-limit', 'past U, the allowance is what is left');
    assertEqual(decliningReason(-HAND_S_MS, HAND_U_MS), 'actuator-limit', 'the limit is judged on the magnitude');
  });

  await check('drift-reporting: the construction contract takes a floor up to the rate authority and refuses the rest', async () => {
    const shipped = recordRig().controller.state().settings;
    assertEqual(shipped.MIN_COMMAND_DEVIATION, 0, 'the default floor is zero');
    assertEqual(shipped.MAX_STOPPING_THRESHOLD_MS, MAX_STOPPING_THRESHOLD_MS, 'the settings in force publish the fixed ceiling');
    assertEqual(shipped.MAX_STOPPING_THRESHOLD_MS, 20, 'and the ceiling is 20ms');

    for (const overrides of [{}, { MIN_COMMAND_DEVIATION: 0 }, { MAX_RATE_DEVIATION: 0 }, { RATE_EPSILON: 0.02 }, { MAX_STOPPING_THRESHOLD_MS: 20 }, { TIME_CONSTANT_MS: 1 },
      { MIN_COMMAND_DEVIATION: HAND_FLOOR }, { MIN_COMMAND_DEVIATION: STOPPING_COMMAND_THRESHOLD }, { MIN_COMMAND_DEVIATION: MAX_RATE_DEVIATION }]) {
      assertEqual(refused(overrides).error, null, `${JSON.stringify(overrides)} is a settings set the controller accepts`);
    }
    const invalid = [
      { MIN_COMMAND_DEVIATION: MAX_RATE_DEVIATION + 1e-9 }, { MIN_COMMAND_DEVIATION: -1 }, { MIN_COMMAND_DEVIATION: Number.NaN },
      { MIN_COMMAND_DEVIATION: Number.POSITIVE_INFINITY }, { TIME_CONSTANT_MS: 0 }, { TIME_CONSTANT_MS: -1 },
      { TIME_CONSTANT_MS: Number.NaN }, { MAX_RATE_DEVIATION: -0.1 }, { MAX_RATE_DEVIATION: 1 },
      { MAX_RATE_DEVIATION: Number.NaN }, { RATE_EPSILON: -1 }, { RATE_EPSILON: Number.NaN },
      { MAX_STOPPING_THRESHOLD_MS: 21 }, { MAX_STOPPING_THRESHOLD_MS: 19 }, { MAX_STOPPING_THRESHOLD_MS: Number.NaN },
    ];
    for (const overrides of invalid) {
      const { error, applied } = refused(overrides);
      assert(error instanceof RangeError, `${JSON.stringify(overrides)} is refused with a RangeError, got ${error}`);
      // THE PLAYER IS NEVER TOUCHED ON THE WAY TO THE THROW: a settings mistake
      // must not reach the media element as a rate first.
      assertEqual(applied.length, 0, `${JSON.stringify(overrides)} handed nothing to the player before refusing`);
    }
    // The authority is the bound, whatever it is set to: the same floor is
    // accepted at 0.01 above and refused once the authority drops below it.
    assertEqual(refused({ MIN_COMMAND_DEVIATION: HAND_FLOOR, MAX_RATE_DEVIATION: HAND_FLOOR }).error, null, 'a floor equal to its authority constructs');
    for (const overrides of [{ MIN_COMMAND_DEVIATION: MAX_RATE_DEVIATION + 1e-9 }, { MIN_COMMAND_DEVIATION: HAND_FLOOR, MAX_RATE_DEVIATION: 0.002 }]) {
      const { error } = refused(overrides);
      assert(error instanceof RangeError && error.message.includes('exceeds the rate authority'),
        `${JSON.stringify(overrides)} is refused because it exceeds the rate authority, got ${error?.message}`);
    }
  });

  await check('drift-reporting: the unavailable-value ladder distinguishes what was measured from what was accepted', async () => {
    const rig = timed({ halfWidthMs: 4 });
    const before = rig.controller.state();
    assertEqual(before.rate, 1, 'before any poll the rate is unity');
    assertEqual(before.mode, 'waiting', 'before any poll the mode is waiting');
    assertEqual(before.reason, 'no-clock', 'before any poll the reason is the missing clock');
    assertEqual(before.settlingMs, null, 'before any poll nothing has settled');
    assertEqual(before.correctionsApplied, 0, 'before any poll nothing was written');
    for (const field of ['estimateMs', 'bandMs', 'spreadMs', 'halfWidthMs', 'measurementLimit', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'fastestCloseMs']) {
      assertEqual(before[field], null, `before any poll ${field} is unavailable`);
    }
    assertEqual(before.thresholdUsable, false, 'before any poll no threshold is usable');
    // L IS KNOWN FROM THE SETTINGS ALONE and is the one figure a state with no
    // measurement may publish. It is 0 on this branch and can be no other value
    // — construction refuses a positive f — so this asserts the field is
    // present and correct, not that it moved. What it is computed FROM is
    // covered above, where f is free.
    assertEqual(before.actuatorAllowanceMs, 0, 'the allowance is known before the first poll');

    const noFrame = rig.poll();
    assertEqual(noFrame.mode, 'waiting', 'a clock without a frame waits');
    assertEqual(noFrame.reason, 'too-few-records', 'and names the shortage of records');
    assertEqual(noFrame.rate, 1, 'and holds unity');
    assertEqual(noFrame.halfWidthMs, 4, 'the clock half-width is known as soon as the clock is');
    for (const field of ['estimateMs', 'bandMs', 'spreadMs', 'measurementLimit', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'fastestCloseMs']) {
      assertEqual(noFrame[field], null, `with no frame ${field} is unavailable`);
    }
    assertEqual(noFrame.thresholdUsable, false, 'a half-width alone makes no threshold usable');

    for (let i = 0; i < 6; i++) rig.add(-200);
    const provisional = rig.poll(-200);
    assertEqual(provisional.controlRecords, 7, 'the seventh record is one short of the qualification');
    assertEqual(provisional.mode, 'waiting', 'one short of MIN_RECORDS still waits');
    assertEqual(provisional.estimateMs, -200, 'a provisional estimate is published');
    assertEqual(provisional.bandMs, 4, 'a provisional U is published');
    assertEqual(provisional.measurementLimit, 'clock', 'and names the arm that set it');
    assertEqual(provisional.requiredStoppingThresholdMs, 4, 'and the S it requires, which at f=0 is U');
    assertEqual(provisional.stoppingThresholdMs, null, 'but nothing accepts that threshold yet');
    assertEqual(provisional.thresholdUsable, false, 'so it is not usable');
    assertEqual(provisional.fastestCloseMs, null, 'and there is no close to project from it');

    const acting = rig.poll(-200);
    assertEqual(acting.controlRecords, 8, 'the eighth record qualifies the window');
    assertEqual(acting.mode, 'correcting', 'the eighth record authorises the correction');
    assertEqual(acting.stoppingThresholdMs, 4, 'the required threshold is now the accepted one');
    assertEqual(acting.thresholdUsable, true, 'and it is usable');
    assertEqual(acting.fastestCloseMs, 19600, '196ms of excess closes in 19600ms at 0.01');
    assert(acting.rate > 1, 'a client behind the room speeds up');

    // THE CLEARING IS A TRANSITION, not a state that was always empty: the poll
    // above published all four of these. The stale rule cuts the control window
    // at the current cursor, so this hold has no estimate to have measured
    // either — the hold that keeps its provisional components is the
    // too-few-records one above, which suffered no drop.
    rig.advance(600);
    const stale = rig.controller.poll();
    assertEqual(stale.mode, 'stale', 'silence enters the stale hold');
    assertEqual(stale.reason, 'no-records', 'and names the absent records');
    assertEqual(stale.controlRecords, 0, 'the stale cutoff leaves no record to measure from');
    assertEqual(stale.estimateMs, null, 'so the estimate is unavailable rather than the one it last published');
    assertEqual(stale.bandMs, null, 'and so is U');
    assertEqual(stale.halfWidthMs, 4, 'while the clock arm, which is read fresh each poll, is still known');
    assertEqual(stale.requiredStoppingThresholdMs, null, 'with no U there is no required threshold');
    assertEqual(stale.stoppingThresholdMs, null, 'and none accepted');
    assertEqual(stale.thresholdUsable, false, 'so no threshold is usable');
    assertEqual(stale.fastestCloseMs, null, 'and the close figure it published a poll ago is gone');
    assertEqual(stale.rate, 1, 'and the correction stops');

    rig.clock.state.present = false;
    const noClock = rig.controller.poll();
    assertEqual(noClock.mode, 'waiting', 'a lost clock waits');
    assertEqual(noClock.reason, 'no-clock', 'and names the clock');
    for (const field of ['estimateMs', 'bandMs', 'spreadMs', 'halfWidthMs', 'measurementLimit', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'fastestCloseMs']) {
      assertEqual(noClock[field], null, `a lost clock clears ${field}`);
    }
    assertEqual(noClock.thresholdUsable, false, 'and leaves no threshold usable');
    assertEqual(noClock.actuatorAllowanceMs, 0, 'the allowance is a setting and survives the loss');
  });

  await check('drift-reporting: an exact tie between the arms is reachable and names both', async () => {
    // A clock of zero width and a window of identical records: the two arms are
    // the same number, so `clock-and-dispersion` is not only an arithmetic case.
    const rig = recordRig({ halfWidthMs: 0 });
    for (let i = 0; i < 8; i++) rig.add(0);
    const state = rig.controller.poll();
    assertEqual(state.halfWidthMs, 0, 'the clock arm is zero');
    assertEqual(state.spreadMs, 0, 'the dispersion arm is zero');
    assertEqual(state.bandMs, 0, 'so U is zero');
    assertEqual(state.measurementLimit, 'clock-and-dispersion', 'and both arms are named');
    assertEqual(state.estimateMs, 0, 'the estimate is exactly the drift the rig fed it');
    assertEqual(state.stoppingThresholdMs, 0, 'a zero band accepts a zero threshold at f=0');
    assertEqual(state.thresholdUsable, true, 'which is usable: a threshold of zero is a value, not an absence');
    assertEqual(state.fastestCloseMs, 0, 'and the error is already inside it');
    assertEqual(state.mode, 'declining', 'the client declines rather than correcting');
    assertEqual(state.reason, 'measurement-limit', 'and names the measurement as its limit');
  });

  await check('drift-reporting: removing the rate conjunct cannot fail a reachable case', async () => {
    // TASK 4.3. Every path into the settled/declining branch has already asked
    // for exactly normal speed, and `applyRate` either writes it or keeps a rate
    // already within RATE_EPSILON — so the predicate that was removed was true
    // of every state that reaches it. Asserted over a sweep rather than argued.
    let parked = 0;
    let quiet = 0;
    for (const standingError of [-320, -240, -160, -100]) {
      const sim = plant({ refreshHz: 60, standingError, pollEvery: 6 });
      for (let i = 0; i < 6 * 960; i++) sim.deliver();
      for (const state of sim.history) {
        if (state.mode !== 'settled' && state.mode !== 'declining') continue;
        quiet += 1;
        assert(Math.abs(state.rate - 1) <= state.settings.RATE_EPSILON,
          `${standingError}ms: a ${state.mode} poll published rate ${state.rate}, outside RATE_EPSILON`);
        if (state.rate !== 1) parked += 1;
      }
    }
    assert(quiet > 0, 'the sweep produced quiet polls, so the assertion above ran');
    // AND THE EPSILON IS DOING WORK: some of those polls are parked off exact
    // unity, so `rate === 1` would have been a stricter and false predicate.
    assert(parked > 0, 'some quiet poll is parked off exact unity, so the epsilon is not standing in for equality');
  });

  await check('drift-reporting: the reasons a poll can carry are the ones the branch can reach', async () => {
    const seen = new Map();
    for (const standingError of [-320, -100]) {
      const sim = plant({ refreshHz: 60, standingError, pollEvery: 6 });
      for (let i = 0; i < 6 * 960; i++) sim.deliver();
      for (const state of sim.history) seen.set(`${state.mode}/${state.reason}`, (seen.get(`${state.mode}/${state.reason}`) ?? 0) + 1);
    }
    assert((seen.get('declining/measurement-limit') ?? 0) > 0, 'declining inside U names the measurement limit');
    assert((seen.get('settled/null') ?? 0) > 0, 'a settled poll carries no reason');
    assert((seen.get('correcting/null') ?? 0) > 0, 'a correcting poll carries no reason');
    assertEqual(seen.get('declining/null'), undefined, 'no declining poll goes quiet');
    // AT f=0, S IS U, so `U < abs(error) <= S` is an empty interval and the
    // actuator arm is arithmetic without a reachable state behind it. It is
    // covered where it is reachable — as a function of independent inputs —
    // and recorded as unreachable here rather than fabricated into a fixture.
    assertEqual(seen.get('declining/actuator-limit'), undefined, 'the actuator limit is unreachable while the allowance is zero');
    assertEqual(seen.get('resolution-budget-hold/stopping-threshold-over-budget'), undefined,
      'and so is the resolution-budget refusal, which only a positive floor can require');
  });

  await check('drift-reporting: zero rate authority reports no close rather than an infinite one', async () => {
    const rig = recordRig({ halfWidthMs: 4, settings: { MAX_RATE_DEVIATION: 0 } });
    for (let i = 0; i < 8; i++) rig.add(-200);
    const outside = rig.controller.poll();
    assertEqual(outside.thresholdUsable, true, 'the input is valid, so the threshold is usable');
    assertEqual(outside.stoppingThresholdMs, 4, 'and accepted');
    assertEqual(outside.fastestCloseMs, null, 'but an error outside it can never be closed at zero authority');
    assertEqual(outside.mode, 'beyond-rate-authority', 'which is beyond the authority, not a correction in progress');
    assertEqual(outside.rate, 1, 'and nothing but unity is written');
    assert(!JSON.stringify(outside).includes('Infinity') && !JSON.stringify(outside).includes('NaN'),
      'the published snapshot carries no non-finite number');
    assertEqual(JSON.parse(JSON.stringify(outside)).fastestCloseMs, null, 'and survives a JSON round trip as an absence');
  });

  await check('drift-reporting: a snapshot publishes exactly the contracted fields', async () => {
    const rig = recordRig();
    for (let i = 0; i < 8; i++) rig.add(-200);
    const keys = Object.keys(rig.controller.poll()).sort();
    assertEqual(JSON.stringify(keys), JSON.stringify([
      'actuatorAllowanceMs', 'bandMs', 'controlRecords', 'correctionsApplied', 'counters', 'estimateMs',
      'fastestCloseMs', 'halfWidthMs', 'lastDrop', 'measurementLimit', 'mode', 'polls', 'rate', 'reason',
      'requiredStoppingThresholdMs', 'settings', 'settlingMs', 'spreadMs', 'stoppingThresholdMs',
      'thresholdUsable', 'windowRecords',
    ]), 'the snapshot publishes the contracted field set and nothing else');
  });

  await check('drift-reporting: the valid-input population survives a declining client explaining itself', async () => {
    // THE PAIR VARIES IN ONE FIELD. Built from one base and asserted to agree
    // everywhere else before either is used, so a difference in the figures
    // cannot be what separates the two populations below.
    const quiet = Array.from({ length: 6 }, (_, index) => consumerSample({ atMs: index * 125, polls: index + 1, reason: null }));
    const explained = quiet.map((sample) => ({ ...sample, reason: 'measurement-limit' }));
    assertEqual(
      JSON.stringify(quiet.map((sample) => ({ ...sample, reason: null }))),
      JSON.stringify(explained.map((sample) => ({ ...sample, reason: null }))),
      'the two fixture sets agree in every field but the reason under test',
    );
    assert(Object.keys(quiet[0]).length > 15, 'and that agreement covers the whole published sample, not a few rendered figures');

    const quietStats = observationStats(quiet, [], 125);
    const explainedStats = observationStats(explained, [], 125);
    assertEqual(quietStats.actingCount, 6, 'the old quiet declining stretch is the whole population');
    assertEqual(explainedStats.actingCount, quietStats.actingCount, 'and naming its limit does not erase it');
    assertEqual(explainedStats.actingFraction, quietStats.actingFraction, 'nor shrink its share of the window');
    assertEqual(explainedStats.actingRateMedian, quietStats.actingRateMedian, 'nor move the rate it commanded');
    assertEqual(explainedStats.populationSamples, quietStats.populationSamples, 'nor change which samples the steady figures come from');

    assertEqual(steadyCommandStretches(explained, DEFAULT_BARS).length, 1, 'the explained stretch is still one steady command run');
    assertEqual(steadyCommandStretches(explained, DEFAULT_BARS)[0].observationCount, 6, 'of the same six observations');

    // AND THE HOLDS STAY OUT. Each of these differs from the pair above in its
    // reason alone, and each names a poll that acted on nothing.
    for (const reason of ['no-clock', 'too-few-records', 'no-records', 'stopping-threshold-over-budget']) {
      const held = quiet.map((sample) => ({ ...sample, reason }));
      assertEqual(observationStats(held, [], 125).actingCount, 0, `${reason} is not a poll that acted on a measurement`);
      assertEqual(steadyCommandStretches(held, DEFAULT_BARS).length, 0, `and ${reason} starts no steady command stretch`);
    }
    assertEqual(actedOnMeasurement({ reason: undefined }), false, 'a sample with no reason field at all is not admitted by default');
    for (const reason of [null, ...DECLINING_REASONS]) {
      assertEqual(actedOnMeasurement({ reason }), true, `${reason} is a poll that acted on a measurement`);
    }
  });

  await check('drift-reporting: the overlay reads usability rather than the absence of a reason', async () => {
    const acting = {
      rate: 1, mode: 'declining', reason: 'measurement-limit', estimateMs: 1.2, bandMs: 9.7, spreadMs: 3,
      halfWidthMs: 9.7, measurementLimit: 'clock', actuatorAllowanceMs: 0,
      requiredStoppingThresholdMs: 9.7, stoppingThresholdMs: 9.7, thresholdUsable: true,
      fastestCloseMs: 0, windowRecords: 8,
    };
    const expected = 'controller: rate 1.000000 · declining · measurement-limit · measurement arm clock · error +1.2ms · U 9.7ms · actuator allowance 0.0ms · stopping threshold 9.7ms over 8 frames';
    assertEqual(overlayLine(acting), expected, 'a measurement-limited declining poll shows its limit and published figures');

    // The hold that proves the two are not simply the same line: it has the
    // components but no accepted threshold, so it renders its reason.
    const held = { ...acting, mode: 'waiting', reason: 'too-few-records', stoppingThresholdMs: null, thresholdUsable: false, fastestCloseMs: null };
    assertEqual(overlayLine(held), 'controller: rate 1.000000 · waiting · too-few-records over 8 frames', 'a hold renders its reason and none of the components it did not act on');
  });

  await check('drift-reporting: write filtering uses the configured epsilon and keeps the last applied command', async () => {
    const run = (epsilon) => {
      const rig = recordRig({ halfWidthMs: 0, settings: { RATE_EPSILON: epsilon } });
      for (let i = 0; i < 8; i++) rig.add(-4);
      const first = rig.controller.poll();
      const writesBefore = rig.applied.length;
      const states = [];
      for (let i = 0; i < 8; i++) {
        rig.add(-4.4);
        states.push(rig.controller.poll());
      }
      return { first, final: states.at(-1), writesBefore, writesAfter: rig.applied.length, applied: rig.applied };
    };
    const nondefault = run(0.0002);
    const standard = run(1e-6);
    assert(nondefault.final.estimateMs < nondefault.first.estimateMs, 'the nondefault probe changes the desired correction while retaining its sign');
    assert(nondefault.final.rate === nondefault.first.rate, 'a same-sign change below 0.0002 keeps the earlier applied rate');
    assertEqual(nondefault.writesAfter, nondefault.writesBefore, 'the nondefault epsilon suppresses the nearby write in the actual applied list');
    assert(standard.final.rate !== standard.first.rate, 'the default epsilon does not suppress the same desired change');
    assert(standard.writesAfter > standard.writesBefore, 'the default epsilon writes the changed command');
    assert(standard.applied.length > nondefault.applied.length, 'the two settings produce distinguishable applied command lists');
  });
}
