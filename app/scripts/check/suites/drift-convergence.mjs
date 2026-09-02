// Convergence, swept rather than sampled.
//
// This suite exists because its predecessor did not. Three convergence checks
// lived in `drift-controller.mjs`, each driving the plant from ONE hand-picked
// standing error, and all three were green while eight of thirteen starting
// errors at 60Hz never converged at all — the band's dispersion arm read zero on
// exactly the poll where the estimate was furthest out, and the settled latch
// compared a rate with `===` against a writer that refuses sub-epsilon writes.
// A check that samples one point of a continuum reports the point, not the
// continuum (`docs/constraints/verification.md`).
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
import { plant } from '../drift-plant.mjs';

const POLL_EVERY_FRAMES = 6;          // 250ms at 24fps — room.entry.js's interval
const RUN_FRAMES = POLL_EVERY_FRAMES * 960;   // 240 simulated seconds
const FIRST_ERROR_MS = -320;
const LAST_ERROR_MS = -80;
const ERROR_STEP_MS = 20;
const REFRESH_RATES = [60, 180];

function sweep(refreshHz) {
  const cases = [];
  for (let standingError = FIRST_ERROR_MS; standingError <= LAST_ERROR_MS; standingError += ERROR_STEP_MS) {
    const sim = plant({ refreshHz, standingError, pollEvery: POLL_EVERY_FRAMES });
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
    // The defect this replaces: with a MAD the majority arm sends every deviation
    // from the median — and the MAD with them — to zero, so the band read its
    // narrowest at exactly the polls where the estimate read its widest. Assert
    // the two do not move apart: no poll may combine a displaced estimate with a
    // dispersion arm that has collapsed below the distance it must cover.
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
    // `applyRate` refuses to write within RATE_EPSILON of the last rate, so a
    // client whose final correction parks the applied rate four billionths above
    // unity never writes exact 1.0 again. Tested against `=== BASE_RATE` that
    // client held `declining` with a null settlingMs forever. -100ms at 60Hz is
    // the case that produced it, and it is client B's own measured offset.
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
    // The window's membership turns over as its boundary sweeps the frame grid,
    // so its composition is occasionally unrepresentative for a single poll —
    // an estimate several milliseconds out between neighbours reading a fraction
    // of one. Believed immediately it cost the whole 5s dwell.
    //
    // SWEEP RATHER THAN PIN A CASE. These are rare — four of the twenty-six
    // cases produce one each — and which case produces one moves whenever the
    // band or the window does. A check pinned to `-280` at 180Hz proved nothing
    // the moment the band changed, silently, so the sweep collects them across
    // the range and fails if the range stops producing any.
    let excursions = 0;
    for (const refreshHz of REFRESH_RATES) {
      for (const { standingError, history } of sweep(refreshHz)) {
        for (let i = 1; i < history.length - 1; i++) {
          const [before, state, next] = [history[i - 1], history[i], history[i + 1]];
          if (before.mode !== 'settled' || state.bandMs === null) continue;
          const isolated = Math.abs(state.estimateMs) > state.bandMs
            && Math.abs(before.estimateMs) <= before.bandMs
            && Math.abs(next.estimateMs) <= next.bandMs;
          if (!isolated) continue;
          excursions += 1;
          assertEqual(state.mode, 'settled',
            `${refreshHz}Hz from ${standingError}ms: an isolated excursion to ${state.estimateMs.toFixed(2)}ms against a ${state.bandMs.toFixed(2)}ms band left settled`);
          assert(Math.abs(state.rate - 1) <= state.settings.RATE_EPSILON,
            `${refreshHz}Hz from ${standingError}ms: an isolated excursion moved the applied rate to ${state.rate}`);
        }
      }
    }
    assert(excursions > 0, 'the sweep produced no isolated excursion, so this check proved nothing — the plant or the window has changed');
  });
}
