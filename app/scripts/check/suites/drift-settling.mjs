// scripts/check/suites/drift-settling.mjs
//
// WHEN THE CONTROLLER MAY CLAIM IT IS SETTLED, AND WHEN IT MUST GIVE THAT CLAIM
// UP: the dwell boundary, the excursion horizon, the input failures that clear
// the dwell, and the settling time that survives all of them as history.
//
// The rig this and `drift-reporting.mjs` both drive is in
// `check/drift-reporting-fixtures.mjs`.
//
// The trap this file protects: `timed` keeps its own copy of the rig's simulated
// clock, and every boundary here is asserted against that copy in milliseconds,
// twenty of which is one poll. Each boundary is observed one poll SHORT of itself
// and again AT itself, so a claim that arrives early or late fails rather than
// being averaged away.

import { check, assert, assertEqual } from '../harness.mjs';
import { settle, timed } from '../drift-reporting-fixtures.mjs';

// Float noise around an exactly-unity rate: the assertions using it require a
// client holding normal speed, not merely one close to it.
const RATE_TOLERANCE = 1e-12;

export default async function driftSettlingSuite() {
  await check('drift-reporting: settling is timed from the first non-unity write, not from a rate write', async () => {
    const rig = timed({ halfWidthMs: 4 });
    const { corrected, correctedAt, insideAt, settledAt, state } = settle(rig);
    assertEqual(corrected.mode, 'correcting', 'the client corrects before it settles');
    assertEqual(corrected.correctionsApplied, 1, 'the first write is the first correction');
    assert(Math.abs(corrected.rate - 1) > rig.controller.state().settings.RATE_EPSILON, 'and it left unity');
    assertEqual(state.mode, 'settled', 'the client reaches settled');
    assertEqual(settledAt - insideAt, 5000, 'it settles exactly one SETTLED_FOR_MS after entering the threshold');
    assertEqual(state.settlingMs, settledAt - correctedAt, 'and reports the interval since the first non-unity write');
    // THE TWO COUNTS ARE NOT THE SAME EVENT. `correctionsApplied` has risen
    // since — the return to unity is a rate write too — so a settling time
    // measured from the LAST write, or from any write, would be a different
    // number from the one asserted above.
    assert(state.correctionsApplied > corrected.correctionsApplied, 'more rate writes followed the first correction');
    assert(state.settlingMs > 0, 'the reported settling duration is positive');
  });

  await check('drift-reporting: the dwell is asserted just before its boundary and at it', async () => {
    const rig = timed({ halfWidthMs: 4 });
    for (let i = 0; i < 8; i++) rig.add(-200);
    rig.poll();
    let insideAt = null;
    let justBefore = null;
    let atBoundary = null;
    for (let i = 0; i < 400 && atBoundary === null; i++) {
      const state = rig.poll(0);
      if (insideAt === null && (state.mode === 'declining' || state.mode === 'settled')) insideAt = rig.nowMs;
      if (insideAt === null) continue;
      if (rig.nowMs - insideAt === 4980) justBefore = state;
      if (rig.nowMs - insideAt === 5000) atBoundary = state;
    }
    assert(justBefore !== null && atBoundary !== null, 'both sides of the dwell boundary were observed');
    assertEqual(justBefore.mode, 'declining', '20ms short of the dwell the client is still declining');
    assertEqual(justBefore.settlingMs, null, 'and reports no settling time');
    assertEqual(justBefore.reason, 'measurement-limit', 'and names its limit rather than going quiet');
    assertEqual(atBoundary.mode, 'settled', 'at the dwell it is settled');
    assertEqual(atBoundary.reason, null, 'and a settled client carries no reason');
    assert(atBoundary.settlingMs > 0, 'and reports its settling time');
  });

  await check('drift-reporting: a short excursion keeps the claim and a sustained one takes it', async () => {
    const rig = timed({ halfWidthMs: 4 });
    const settled = settle(rig);
    assertEqual(settled.state.mode, 'settled', 'the client is settled before the excursion');
    const historicalMs = settled.state.settlingMs;

    let excursionAt = null;
    let justBefore = null;
    let atHorizon = null;
    for (let i = 0; i < 200 && atHorizon === null; i++) {
      const state = rig.poll(-200);
      const outside = Math.abs(state.estimateMs) > state.stoppingThresholdMs;
      if (!outside) { excursionAt = null; continue; }
      if (excursionAt === null) { excursionAt = rig.nowMs; continue; }
      if (rig.nowMs - excursionAt === 980) justBefore = state;
      if (rig.nowMs - excursionAt === 1000) atHorizon = state;
    }
    assert(justBefore !== null && atHorizon !== null, 'both sides of the excursion horizon were observed');
    assertEqual(justBefore.mode, 'settled', '20ms short of one estimate window outside, the claim stands');
    assert(Math.abs(justBefore.rate - 1) <= RATE_TOLERANCE, 'and the client is holding exactly normal speed through it');
    assertEqual(atHorizon.mode, 'correcting', 'at one estimate window outside, the claim is gone and the client corrects');
    assert(Math.abs(atHorizon.rate - 1) > justBefore.settings.RATE_EPSILON, 'and it has left unity to do it');
    assertEqual(atHorizon.settlingMs, historicalMs, 'the first settling duration is history and survives the unlatch');
  });

  await check('drift-reporting: every input failure clears the dwell and keeps the settling history', async () => {
    const failures = [
      ['stale', (rig) => { rig.advance(600); }],
      ['seam', (rig) => { rig.controller.markSeam({ afterSeq: rig.log.latestSeq, epochMs: 1, positionMs: 2 }); }],
      ['reanchor', (rig) => { rig.clock.state.reanchors += 1; }],
      ['no-clock', (rig) => { rig.clock.state.present = false; }],
    ];
    for (const [name, breakInput] of failures) {
      const rig = timed({ halfWidthMs: 4 });
      const settled = settle(rig);
      assertEqual(settled.state.mode, 'settled', `${name}: the client is settled before the failure`);
      assertEqual(settled.state.thresholdUsable, true, `${name}: and its threshold was usable`);
      assert(Number.isFinite(settled.state.fastestCloseMs), `${name}: and it published a close figure`);
      breakInput(rig);
      const held = rig.controller.poll();
      assert(held.mode !== 'settled', `${name}: the failure ends the claim, got ${held.mode}`);
      assertEqual(held.stoppingThresholdMs, null, `${name}: and accepts no threshold`);
      assertEqual(held.thresholdUsable, false, `${name}: and reports none usable`);
      assertEqual(held.fastestCloseMs, null, `${name}: and withdraws the close figure`);
      assertEqual(held.settlingMs, settled.state.settlingMs, `${name}: but the settling duration it already reported is history`);
      assertEqual(held.rate, 1, `${name}: and the rate returns to unity`);
    }
  });

  await check('drift-reporting: a settled client recovers into a fresh dwell without restating its settling time', async () => {
    const rig = timed({ halfWidthMs: 4 });
    const settled = settle(rig);
    const historicalMs = settled.state.settlingMs;
    rig.advance(600);
    const stale = rig.controller.poll();
    assertEqual(stale.mode, 'stale', 'the client is held stale');

    let recoveredAt = null;
    let resettled = null;
    for (let i = 0; i < 600 && resettled === null; i++) {
      const state = rig.poll(0);
      if (recoveredAt === null && (state.mode === 'declining' || state.mode === 'settled')) recoveredAt = rig.nowMs;
      if (state.mode === 'settled') resettled = state;
    }
    assert(resettled !== null, 'the client settles again after the input returns');
    assertEqual(rig.nowMs - recoveredAt, 5000, 'the recovery served a full fresh dwell, not the remainder of the old one');
    assertEqual(resettled.settlingMs, historicalMs, 'and the reported settling time is still the first one');
  });

  await check('drift-reporting: a nondefault dwell is observed before and at its configured boundary', async () => {
    const boundaryFor = (dwellMs) => {
      const rig = timed({ halfWidthMs: 4, settings: { SETTLED_FOR_MS: dwellMs } });
      for (let i = 0; i < 8; i++) rig.add(-200);
      const corrected = rig.controller.poll();
      const correctedAt = rig.nowMs;
      let insideAt = null;
      let before = null;
      let at = null;
      for (let i = 0; i < 500 && at === null; i++) {
        const state = rig.poll(0);
        if (insideAt === null && (state.mode === 'declining' || state.mode === 'settled')) insideAt = rig.nowMs;
        if (insideAt === null) continue;
        if (rig.nowMs - insideAt === dwellMs - 20) before = state;
        if (rig.nowMs - insideAt === dwellMs) at = state;
      }
      return { correctedAt, corrected, insideAt, before, at };
    };
    const short = boundaryFor(1000);
    const standard = boundaryFor(5000);
    assertEqual(short.correctedAt, standard.correctedAt, 'the dwell override leaves the first-correction instant unchanged');
    assertEqual(short.corrected.mode, standard.corrected.mode, 'the otherwise identical input enters the same correcting branch');
    assert(short.before !== null && short.at !== null, 'the 1000ms override is observed just before and at its boundary');
    assertEqual(short.before.mode, 'declining', '1000ms minus one poll is still declining');
    assertEqual(short.before.settlingMs, null, '1000ms minus one poll has no settling duration');
    assertEqual(short.at.mode, 'settled', 'the 1000ms override settles at its boundary');
    assert(Number.isFinite(short.at.settlingMs) && short.at.settlingMs > 0, 'the short dwell publishes a settling duration after correction');
    assert(standard.before !== null && standard.at !== null, 'the default dwell is observed just before and at its boundary');
    assertEqual(standard.before.mode, 'declining', 'the default dwell remains declining just before its boundary');
    assertEqual(standard.at.mode, 'settled', 'the default dwell settles at its boundary');
    assertEqual(standard.at.settlingMs - short.at.settlingMs, 4000, 'the configured dwell changes the observed settling interval by 4000ms');
  });
}
