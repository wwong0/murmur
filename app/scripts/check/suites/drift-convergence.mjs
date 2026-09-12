// Convergence, swept rather than sampled.
//
// A check that samples one point of a continuum reports the point, not the
// continuum (`docs/constraints/verification.md`) — three checks each driving the
// plant from one hand-picked standing error were all green while eight of
// thirteen starting errors at 60Hz never converged at all.
//
// So the assertions here sweep the whole −320…−80ms range that task 0 measured,
// at both refresh rates, at the 250ms interval `room.entry.js` actually polls
// on. The sweep costs about 0.3s for 26 cases of 240 simulated seconds, because
// the controller is pure and the plant is arithmetic.
//
// Trap worth preserving: a sweep that asserts only the FINAL state passes on a
// client that reached `settled` once and spent the rest of the run outside it.
// Convergence is asserted as reaching it; holding it is measured as a duty
// cycle and asserted with a floor, and the two are separate assertions because
// change 4a fixed one of them and not the other.

import { check, assert, assertEqual } from '../harness.mjs';
import { plant, runUntil } from '../drift-plant.mjs';
import { acceptedStoppingThresholdMs } from '../../drift-figures.mjs';
import { D8_COMMAND_THRESHOLD } from '../../../public/lib/drift-controller.mjs';

const POLL_EVERY_FRAMES = 6;          // 250ms at 24fps — room.entry.js's interval
const RUN_FRAMES = POLL_EVERY_FRAMES * 960;   // 240 simulated seconds
const FIRST_ERROR_MS = -320;
const LAST_ERROR_MS = -80;
const ERROR_STEP_MS = 20;
const REFRESH_RATES = [60, 180];
/** The owner-adopted floor, swept against the same bars as f = 0 (remedy-product-integration-spec.md 4.3). */
const ADOPTED = Object.freeze({ MIN_COMMAND_DEVIATION: D8_COMMAND_THRESHOLD });

/**
 * ONE EXPERIMENT, READ SIX TIMES. Every check below asserts a different property
 * of the SAME run, so the sweep is computed once per refresh rate and shared —
 * run per check it was 240 simulated seconds × 13 errors × 2 rates × 4 callers.
 * Sharing is safe because a case is inert once built: the plants are finished
 * and discarded inside `runSweep`, and nothing downstream writes to a history.
 */
const sweeps = new Map();
function sweep(refreshHz, settings = {}) {
  const key = `${refreshHz}:${settings.MIN_COMMAND_DEVIATION ?? 0}`;
  if (!sweeps.has(key)) sweeps.set(key, runSweep(refreshHz, settings));
  return sweeps.get(key);
}

function runSweep(refreshHz, settings) {
  const cases = [];
  for (let standingError = FIRST_ERROR_MS; standingError <= LAST_ERROR_MS; standingError += ERROR_STEP_MS) {
    const sim = plant({ refreshHz, standingError, pollEvery: POLL_EVERY_FRAMES, settings });
    for (let i = 0; i < RUN_FRAMES; i++) sim.deliver();
    const history = sim.history;
    const firstSettled = history.findIndex((state) => state.mode === 'settled');
    const after = firstSettled < 0 ? [] : history.slice(firstSettled);
    cases.push({
      standingError,
      history,
      settlingMs: history.find((state) => state.settlingMs !== null)?.settlingMs ?? null,
      settlingValues: new Set(history.map((state) => state.settlingMs).filter((value) => value !== null)),
      dutyCycle: after.length ? after.filter((state) => state.mode === 'settled').length / after.length : 0,
    });
  }
  return cases;
}

export default async function driftConvergenceSuite() {
  await check('drift-convergence: every standing offset in the measured range converges and reports its settling time', async () => {
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, settlingMs } of sweep(refreshHz)) {
        assert(settlingMs !== null,
          `${refreshHz}Hz from ${standingError}ms never reached settled in ${RUN_FRAMES / POLL_EVERY_FRAMES / 4}s`);
        assert(settlingMs > 0, `${refreshHz}Hz from ${standingError}ms reported settlingMs ${settlingMs}`);
      }
    }
  });

  await check('drift-convergence: a converged client stays converged for most of the run', async () => {
    // A FLOOR, NOT THE TARGET. The remaining excursions are window-composition
    // artifacts that outlive one ESTIMATE_WINDOW_MS, and closing them is a design
    // question filed as a ⚑ under change 4b. This asserts the property has not
    // regressed to the pre-4a behaviour, where a client left `settled` and never
    // returned; it is deliberately not a claim that the duty cycle is 100%.
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, dutyCycle } of sweep(refreshHz)) {
        assert(dutyCycle >= 0.8,
          `${refreshHz}Hz from ${standingError}ms held settled for only ${(dutyCycle * 100).toFixed(0)}% of the run after first reaching it`);
      }
    }
  });

  await check('drift-convergence: the settling time is reported once and never restated', async () => {
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, settlingValues } of sweep(refreshHz)) {
        assertEqual(settlingValues.size, 1,
          `${refreshHz}Hz from ${standingError}ms reported ${settlingValues.size} different settling times`);
      }
    }
  });

  await check('drift-convergence: the band never narrows on the poll where the cadence displaces the estimate', async () => {
    // The two arms must not move apart: no poll may combine a displaced estimate
    // with a dispersion arm that has collapsed below the distance it must cover.
    // That is what a MAD did on this signal, and what a centre-distance statistic
    // will do again (design.md D1).
    for (const refreshHz of REFRESH_RATES) {
      const vsyncMs = 1000 / refreshHz;
      for (const { standingError, history } of sweep(refreshHz)) {
        const settled = history.filter((state) => state.mode === 'settled' && state.spreadMs !== null);
        assert(settled.length > 0, `${refreshHz}Hz from ${standingError}ms never settled`);
        for (const state of settled) {
          assert(state.spreadMs >= vsyncMs / 2 - 1e-9,
            `${refreshHz}Hz from ${standingError}ms: dispersion arm ${state.spreadMs.toFixed(4)}ms is under the ${(vsyncMs / 2).toFixed(2)}ms cadence it must cover, at estimate ${state.estimateMs.toFixed(2)}ms`);
        }
      }
    }
  });

  await check('drift-convergence: a rate too small to write does not prevent converging', async () => {
    // PINNED, not swept: -100ms at 60Hz is the case whose final correction parks
    // the applied rate four billionths above unity, which is what an exact
    // `=== BASE_RATE` test held in `declining` forever (design.md D3). It is also
    // client B's own measured offset. The assertion below fails loudly if this
    // case stops parking off unity, rather than passing vacuously.
    const sim = plant({ refreshHz: 60, standingError: -100, pollEvery: POLL_EVERY_FRAMES });
    for (let i = 0; i < RUN_FRAMES; i++) sim.deliver();
    const settled = sim.history.filter((state) => state.mode === 'settled');
    assert(settled.length > 0, 'the client never reported converging');
    const parked = settled.filter((state) => state.rate !== 1);
    assert(parked.length > 0,
      'this case no longer parks the applied rate off unity, so it no longer covers the epsilon; pick another starting error that does');
    for (const state of parked) {
      assert(Math.abs(state.rate - 1) <= state.settings.RATE_EPSILON,
        `converged while the applied rate was ${state.rate}, outside RATE_EPSILON`);
    }
  });

  await check('drift-convergence: one outlying poll does not unreport convergence or move the rate', async () => {
    // SWEEP RATHER THAN PIN A CASE. Isolated excursions are rare — four of the 26
    // cases produce one each — and which case produces one moves whenever the
    // band or the window does. A check pinned to `-280` at 180Hz proved nothing
    // the moment the band changed, silently, so the sweep collects them across
    // the range and fails if the range stops producing any.
    let excursions = 0;
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, history } of sweep(refreshHz)) {
        for (let i = 1; i < history.length - 1; i++) {
          const [before, state, next] = [history[i - 1], history[i], history[i + 1]];
          const beforeThreshold = acceptedStoppingThresholdMs(before);
          const threshold = acceptedStoppingThresholdMs(state);
          const nextThreshold = acceptedStoppingThresholdMs(next);
          if (before.mode !== 'settled' || threshold === null || beforeThreshold === null || nextThreshold === null) continue;
          const isolated = Math.abs(state.estimateMs) > threshold
            && Math.abs(before.estimateMs) <= beforeThreshold
            && Math.abs(next.estimateMs) <= nextThreshold;
          if (!isolated) continue;
          excursions += 1;
          assertEqual(state.mode, 'settled',
            `${refreshHz}Hz from ${standingError}ms: an isolated excursion to ${state.estimateMs.toFixed(2)}ms against a ${threshold.toFixed(2)}ms accepted stopping threshold left settled`);
          assert(Math.abs(state.rate - 1) <= state.settings.RATE_EPSILON,
            `${refreshHz}Hz from ${standingError}ms: an isolated excursion moved the applied rate to ${state.rate}`);
        }
      }
    }
    assert(excursions > 0, 'the sweep produced no isolated excursion, so this check proved nothing — the plant or the window has changed');
  });

  await check('drift-convergence: closing a step after settling never reverses the correction', async () => {
    // Task 2.4. THE SWEEP CANNOT SEE THIS: every case in it starts behind and
    // stays behind, so after the first latch the controller writes 1.0 or a
    // same-signed correction and could not reverse if it tried — measured, zero
    // signed writes to zero reversals across all 26. Asserting on that window
    // would be a check that cannot fail. So this one injects a real step, in
    // both directions, and reads the correction that closes it: 9-30 signed
    // writes per case, which is enough activity for a reversal to show up in.
    //
    // The bound is ZERO, not the `<= 2` an earlier version of this assertion
    // carried. Proportional control of an integrator does not overshoot, so any
    // reversal at all is the failure D1 names — an integral term winding through
    // the correction — and 0.05 of one produces exactly one reversal here, which
    // a bound of 2 would have let through.
    closeSteps({}, '');
  });

  await check('drift-convergence: at the adopted f every standing offset converges and holds settled for most of the run', async () => {
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, settlingMs, dutyCycle } of sweep(refreshHz, ADOPTED)) {
        assert(settlingMs !== null && settlingMs > 0,
          `f: ${refreshHz}Hz from ${standingError}ms never reached settled in ${RUN_FRAMES / POLL_EVERY_FRAMES / 4}s`);
        assert(dutyCycle >= 0.8,
          `f: ${refreshHz}Hz from ${standingError}ms held settled for only ${(dutyCycle * 100).toFixed(0)}% of the run after first reaching it`);
      }
    }
  });

  await check('drift-convergence: at the adopted f, closing a step after settling never reverses the correction', async () => {
    // The isolated-excursion sweep is not repeated here: at f this sweep
    // produces none, so that check could not fail. Its fixture at f is in
    // d8-product-integration.mjs.
    closeSteps(ADOPTED, 'f: ');
  });
}

/** Task 2.4's step fixture, run at a given floor. */
function closeSteps(settings, label) {
  for (const stepMs of [-200, -80, 80, 200]) {
    for (const refreshHz of REFRESH_RATES) {
      const sim = plant({ refreshHz, standingError: -240, pollEvery: POLL_EVERY_FRAMES, settings });
      for (let i = 0; i < 24; i++) sim.deliver();
      runUntil(sim, (state) => state.mode === 'settled', 120_000);
      assertEqual(sim.controller.state().mode, 'settled',
        `${label}${refreshHz}Hz never settled before the ${stepMs}ms step, so the step proves nothing`);

      const before = sim.history.length;
      sim.advance(stepMs);
      for (let i = 0; i < POLL_EVERY_FRAMES * 400; i++) sim.deliver();

      const after = sim.history.slice(before);
      const written = [];
      for (let i = 1; i < after.length; i++) {
        if (after[i].correctionsApplied !== after[i - 1].correctionsApplied) written.push(after[i].rate);
      }
      const signs = written.map((rate) => Math.sign(rate - 1)).filter(Boolean);
      assert(signs.length >= 5,
        `${label}${refreshHz}Hz: a ${stepMs}ms step drew only ${signs.length} signed corrections, too few for a reversal to be visible`);
      let reversals = 0;
      for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) reversals += 1;
      assertEqual(reversals, 0,
        `${label}${refreshHz}Hz: closing a ${stepMs}ms step reversed the correction ${reversals} time(s) across ${signs.length} writes`);
      assertEqual(after.at(-1).mode, 'settled', `${label}${refreshHz}Hz did not re-settle after a ${stepMs}ms step`);
    }
  }
}
