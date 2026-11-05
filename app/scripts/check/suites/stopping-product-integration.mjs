// scripts/check/suites/stopping-product-integration.mjs
//
// The adopted stopping policy in the product controller, on manufactured input only.
// Driven through the same rig as stopping-research.mjs, so a poll can sit exactly on S.
//
// Both kinds of assertion, on purpose: the product must equal the tested
// research copy on one long positive-f history, AND the figures that history
// turns on are computed here from U, f and T. Equality alone passes when both
// copies carry the same mistake.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { BAND_MS, STEP_MS, rig } from '../controller-rig.mjs';
import { createStoppingResearchController, commandThresholdFor } from '../stopping-research-controller.mjs';
import {
  COMMAND_TOLERANCE,
  STOPPING_COMMAND_THRESHOLD,
  ESTIMATE_WINDOW_MS,
  MAX_RATE_DEVIATION,
  MAX_STOPPING_THRESHOLD_MS,
  SETTLED_FOR_MS,
  TIME_CONSTANT_MS,
  actuatorAllowanceMs,
  createDriftController,
} from '../../../public/lib/drift-controller.mjs';

const F = STOPPING_COMMAND_THRESHOLD;
const ALLOWANCE = actuatorAllowanceMs(F, TIME_CONSTANT_MS);
const STOP_MS = BAND_MS + ALLOWANCE;
const EXACT_BAND_MS = MAX_STOPPING_THRESHOLD_MS - ALLOWANCE;
const OVER_BAND_MS = 16;
const HOLD_MODE = 'resolution-budget-hold';
const HOLD_REASON = 'stopping-threshold-over-budget';
const EXCURSION_MS = 12;

function lawRate(estimateMs, bandMs) {
  const excess = Math.sign(estimateMs) * Math.max(0, Math.abs(estimateMs) - bandMs);
  return 1 + Math.max(-MAX_RATE_DEVIATION, Math.min(MAX_RATE_DEVIATION, -excess / TIME_CONSTANT_MS));
}

/** Every published field, less the research copy's refusal-policy selector. */
function parityView(snapshot) {
  const { refusalPolicy: _policy, settings, ...rest } = snapshot;
  const { refusalPolicy: _settingsPolicy, ...shared } = settings;
  return { ...rest, settings: shared };
}

/**
 * One history through every state the adopted policy can reach: a pre-settle
 * refusal, both signs, a reversal, commands just outside S on each side, the
 * ceiling from both sides after settling, a fresh dwell, an isolated and a
 * sustained excursion, then a missing clock, silence, shortage, seam and re-anchor.
 */
function positiveHistory(sim) {
  sim.state.halfWidthMs = OVER_BAND_MS;
  sim.poll(0);
  sim.state.halfWidthMs = BAND_MS;
  sim.run(-40, 3);
  sim.run(30, 2);
  sim.run(STOP_MS + 0.5, 2);
  sim.run(-(STOP_MS + 0.5), 2);
  sim.run(0, 7);
  sim.state.halfWidthMs = EXACT_BAND_MS;
  sim.poll(0);
  sim.state.halfWidthMs = EXACT_BAND_MS + 1e-9;
  sim.poll(0);
  sim.state.halfWidthMs = BAND_MS;
  sim.run(0, 7);
  sim.poll(EXCURSION_MS);
  sim.run(0, 3);
  sim.run(-EXCURSION_MS, 3);
  sim.run(0, 7);
  sim.state.present = false;
  sim.poll(0, { silent: true });
  sim.state.present = true;
  sim.poll(0, { silent: true });
  sim.poll(0, { count: 3 });
  sim.run(0, 7);
  sim.controller.markSeam({ afterSeq: sim.log.latestSeq, epochMs: 0, positionMs: 0 });
  sim.poll(0, { count: 3 });
  sim.run(0, 7);
  sim.state.reanchors += 1;
  sim.run(0, 7);
}

export default async function stoppingProductIntegrationSuite() {
  await check('stopping-product-integration: the product literal is the research formula, bit for bit', async () => {
    assert(Object.is(STOPPING_COMMAND_THRESHOLD, commandThresholdFor()), `STOPPING_COMMAND_THRESHOLD ${STOPPING_COMMAND_THRESHOLD} is not commandThresholdFor() ${commandThresholdFor()}`);
    assertEqual(STOPPING_COMMAND_THRESHOLD, 0.0011360737797956866, 'and it is the adopted value named in the spec');
    assertNear(ALLOWANCE, F * 4000, 0, 'L is f times the 4000 ms time constant');
  });

  for (const epsilon of [undefined, 0.003]) {
    const label = epsilon === undefined ? 'the default write filter' : `a ${epsilon} write filter, wider than 2f`;
    await check(`stopping-product-integration: at the adopted f the product is the tested research controller, under ${label}`, async () => {
      const settings = epsilon === undefined ? { MIN_COMMAND_DEVIATION: F } : { MIN_COMMAND_DEVIATION: F, RATE_EPSILON: epsilon };
      const research = rig({ factory: createStoppingResearchController, settings });
      const product = rig({ factory: createDriftController, settings });
      positiveHistory(research);
      positiveHistory(product);
      assertEqual(JSON.stringify(product.applied), JSON.stringify(research.applied), 'the applied streams are identical');
      assertEqual(
        JSON.stringify(product.snapshots.map(parityView)),
        JSON.stringify(research.snapshots.map(parityView)),
        'and every published field agrees on every poll',
      );

      // What the shared history must contain, read off the product and judged
      // against numbers computed here, so the parity above is not vacuous.
      const states = product.snapshots;
      const firstSettled = states.findIndex((state) => state.mode === 'settled');
      assert(firstSettled > 0, 'the history reaches settled');
      assertEqual(states[0].mode, HOLD_MODE, 'the first poll is a refusal before any settling');
      assertEqual(states[0].reason, HOLD_REASON, 'and names the budget');
      assertEqual(states[0].settlingMs, null, 'with nothing settled yet');
      const refusalsAfter = states.map((state, index) => ({ state, index })).filter(({ state, index }) => index > firstSettled && state.mode === HOLD_MODE);
      assert(refusalsAfter.length > 0, 'a refusal also happens after settling');
      for (const { state } of refusalsAfter) {
        assertEqual(state.rate, 1, 'a refusal publishes exact unity');
        assertEqual(state.stoppingThresholdMs, null, 'and no accepted S');
        assertEqual(state.settlingMs, states[firstSettled].settlingMs, 'and keeps the historical settling time');
      }
      const lastRefusal = refusalsAfter.at(-1).index;
      const resettled = states.findIndex((state, index) => index > lastRefusal && state.mode === 'settled');
      assert(resettled > lastRefusal, 'the loop settles again after the last refusal');
      assert((resettled - lastRefusal) * STEP_MS >= SETTLED_FOR_MS, `re-settling took ${(resettled - lastRefusal) * STEP_MS} ms, less than a fresh ${SETTLED_FOR_MS} ms dwell`);
      const atCeiling = states.find((state) => state.requiredStoppingThresholdMs === EXACT_BAND_MS + ALLOWANCE);
      assertEqual(atCeiling.thresholdUsable, EXACT_BAND_MS + ALLOWANCE <= MAX_STOPPING_THRESHOLD_MS, 'the boundary poll is judged by U + L <= 20 as computed here');
      assert(Math.abs(EXACT_BAND_MS + ALLOWANCE - MAX_STOPPING_THRESHOLD_MS) < 1e-12, 'and it sits on the 20 ms ceiling');
      assertEqual(states.at(-1).counters.budgetRefusals, states.filter((state) => state.mode === HOLD_MODE).length, 'every hold is one counted refusal');

      const rates = product.applied.map((write) => write.rate);
      for (const rate of rates.filter((value) => value !== 1)) {
        const deviation = Math.abs(rate - 1);
        assert(deviation >= F - COMMAND_TOLERANCE && deviation <= MAX_RATE_DEVIATION + COMMAND_TOLERANCE, `a non-unity write of ${rate} is outside [f, 0.01]`);
      }
      assert(rates.some((rate) => rate > 1) && rates.some((rate) => rate < 1), 'writes go in both directions');
      assert(rates.some((rate, index) => index > 0 && rate !== 1 && rates[index - 1] !== 1 && Math.sign(rate - 1) !== Math.sign(rates[index - 1] - 1)), 'including a direct sign reversal');
      const nearS = lawRate(-(STOP_MS + 0.5), BAND_MS);
      assertNear(nearS - 1, F + 0.5 / TIME_CONSTANT_MS, 1e-12, 'just outside S the command is f plus the half-millisecond excess over T');
      assert(rates.some((rate, index) => rate === 1 && Math.abs(rates[index - 1] - nearS) < 1e-12), 'and the return from that smallest command to unity reaches the player');
      assertEqual(states.at(-1).counters.drops.seam, 1, 'the seam was taken');
      assertEqual(states.at(-1).counters.drops.reanchor, 1, 'and the re-anchor');
      assertEqual(states.at(-1).counters.drops.stale, 1, 'and the silence');
    });
  }

  await check('stopping-product-integration: at the adopted f one outlying poll keeps settled and unity, and a sustained one resumes correction', async () => {
    assert(STEP_MS >= ESTIMATE_WINDOW_MS, 'a second consecutive poll is past the unchanged excursion delay');
    assert(EXCURSION_MS > STOP_MS, `the ${EXCURSION_MS} ms excursion lies outside S = ${STOP_MS} ms`);
    for (const sign of [1, -1]) {
      const sim = rig({ factory: createDriftController, settings: { MIN_COMMAND_DEVIATION: F } });
      sim.poll(-40);
      const settled = sim.run(0, 7);
      assertEqual(settled.mode, 'settled', `${sign}: the fixture starts from settled`);
      const writes = sim.applied.length;

      const out = sim.poll(sign * EXCURSION_MS);
      assertEqual(out.estimateMs, sign * EXCURSION_MS, `${sign}: the outlying poll's estimate is the fed value`);
      assert(Math.abs(out.estimateMs) > out.stoppingThresholdMs, `${sign}: and it is outside the accepted S`);
      assertEqual(out.mode, 'settled', `${sign}: one outlying poll does not unreport settled`);
      assertEqual(out.rate, 1, `${sign}: or move the rate`);
      const back = sim.poll(0);
      assertEqual(back.mode, 'settled', `${sign}: the next inside poll is still settled`);
      assertEqual(back.settlingMs, settled.settlingMs, `${sign}: with the same settling time`);
      assertEqual(sim.applied.length, writes, `${sign}: and nothing reached the player`);

      const held = sim.poll(sign * EXCURSION_MS);
      assertEqual(held.mode, 'settled', `${sign}: a sustained excursion is held for its first poll`);
      const resumed = sim.poll(sign * EXCURSION_MS);
      assert(resumed.mode !== 'settled', `${sign}: once it outlives ${ESTIMATE_WINDOW_MS} ms the loop is no longer settled`);
      assertNear(resumed.rate, lawRate(sign * EXCURSION_MS, BAND_MS), 1e-12, `${sign}: and the command is the law measured from U`);
      assertEqual(sim.applied.length, writes + 1, `${sign}: and that one correction reaches the player`);
    }
  });
}
