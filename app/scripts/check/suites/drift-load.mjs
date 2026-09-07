import { check, assert, assertEqual } from '../harness.mjs';
import { plant } from '../drift-plant.mjs';

const POLL_EVERY_FRAMES = 6;
const RUN_POLLS = 960;
const RUN_FRAMES = POLL_EVERY_FRAMES * RUN_POLLS;
const TAIL_POLLS = 240;
const REFRESH_RATES_HZ = [60, 180];
const STARTING_ERRORS_MS = Array.from({ length: 13 }, (_, index) => -320 + index * 20);
const OPEN_LOOP_LOADS_PPM = [0, 100, -100, 900, -900];
const LOADED_PPM = -900;
const EXPECTED_LOADED_RATE = 1 - LOADED_PPM / 1e6;
const EXPECTED_LOADED_EXCESS_MS = Math.abs(LOADED_PPM) * 4 / 1000;
// 20 ppm leaves headroom over the measured 9.4 ppm worst-case slope error
// while remaining smaller than the +/-100 ppm loads that must discriminate.
const OPEN_LOOP_TOLERANCE_PPM = 20;
// 20 ppm covers the measured 886-912 ppm tail-rate spread around the 900 ppm
// target without allowing the load to disappear into the tolerance.
const PARK_RATE_TOLERANCE_PPM = 20;
// 0.05 ms covers the measured 3.590-3.623 ms 180 Hz excess spread around 3.6.
const PARK_EXCESS_TOLERANCE_MS = 0.05;
const DUTY_FLOOR = 0.8;

const runs = new Map();

function runCase({ refreshHz, standingError, rateLoadPpm = 0, settings = {} }) {
  const key = `${refreshHz}:${standingError}:${rateLoadPpm}:${JSON.stringify(settings)}`;
  if (runs.has(key)) return runs.get(key);
  const sim = plant({ refreshHz, standingError, rateLoadPpm, settings, pollEvery: POLL_EVERY_FRAMES });
  for (let frame = 0; frame < RUN_FRAMES; frame++) sim.deliver();
  const records = sim.log.read({ afterSeq: 0 }).records;
  const result = { sim, records, history: sim.history };
  runs.set(key, result);
  return result;
}

function slopeOf(records) {
  const points = records.map((record) => ({
    x: record.displaySharedMs - record.clock.offsetMs,
    y: record.mediaMs,
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return numerator / denominator;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function tailOf(history) {
  return history.slice(-TAIL_POLLS);
}

export default async function driftLoadSuite() {
  await check('drift-load: open-loop slopes expose both load signs at unity command', async () => {
    const cases = [];
    for (const refreshHz of REFRESH_RATES_HZ) {
      for (const rateLoadPpm of OPEN_LOOP_LOADS_PPM) {
        const result = runCase({ refreshHz, standingError: -240, rateLoadPpm, settings: { MAX_RATE_DEVIATION: 0 } });
        cases.push({
          refreshHz,
          rateLoadPpm,
          sim: result.sim,
          records: result.records,
          history: result.history,
          slope: slopeOf(result.records),
        });
      }
    }

    const noFrame = plant({ rateLoadPpm: LOADED_PPM });
    const noLoad = plant({ rateLoadPpm: 0 });
    const noFrameState = JSON.stringify(noFrame.controller.state());
    const noLoadState = JSON.stringify(noLoad.controller.state());
    noFrame.advance(1234);
    noLoad.advance(1234);
    const afterAdvance = {
      loadedNow: noFrame.now,
      noLoadNow: noLoad.now,
      loadedState: JSON.stringify(noFrame.controller.state()),
      noLoadState: JSON.stringify(noLoad.controller.state()),
      loadedRecords: noFrame.log.latestSeq,
      noLoadRecords: noLoad.log.latestSeq,
    };

    for (const { refreshHz, rateLoadPpm, sim, records, history, slope } of cases) {
      const expected = 1 + rateLoadPpm / 1e6;
      assertEqual(sim.rateLoadPpm, rateLoadPpm,
        `${refreshHz}Hz load readback is the requested physical load`);
      assertEqual(records.length, RUN_FRAMES,
        `${refreshHz}Hz ${rateLoadPpm}ppm retains every delivered frame`);
      assertEqual(history.length, RUN_POLLS,
        `${refreshHz}Hz ${rateLoadPpm}ppm evaluates every configured poll`);
      assert(history.every((state) => state.rate === 1),
        `${refreshHz}Hz ${rateLoadPpm}ppm applied rate stayed exactly 1 with MAX_RATE_DEVIATION 0`);
      assertEqual(sim.rate, 1,
        `${refreshHz}Hz ${rateLoadPpm}ppm final applied rate stayed exactly 1`);
      assert(Math.abs(slope - expected) * 1e6 <= OPEN_LOOP_TOLERANCE_PPM,
        `${refreshHz}Hz ${rateLoadPpm}ppm open-loop slope ${slope} differs from ${expected} by more than ${OPEN_LOOP_TOLERANCE_PPM}ppm; the bound covers the measured 9.4ppm worst-case error`);
      if (rateLoadPpm === 0) {
        assert(Math.abs(slope - 1) * 1e6 <= OPEN_LOOP_TOLERANCE_PPM,
          `${refreshHz}Hz zero-load slope ${slope} is not unity within ${OPEN_LOOP_TOLERANCE_PPM}ppm`);
      }
    }

    assertEqual(noFrameState, noLoadState, 'a load has no effect before the first frame');
    assertEqual(afterAdvance.loadedNow, afterAdvance.noLoadNow,
      'advance moves wall time equally without delivering a frame');
    assertEqual(afterAdvance.loadedState, afterAdvance.noLoadState,
      'advance does not let a load mutate controller state');
    assertEqual(afterAdvance.loadedRecords, 0, 'a loaded plant with no delivery has no records');
    assertEqual(afterAdvance.noLoadRecords, 0, 'an unloaded plant with no delivery has no records');
  });

  await check('drift-load: a negative physical load holds a standing error without settling', async () => {
    const cases = [];
    for (const refreshHz of REFRESH_RATES_HZ) {
      for (const standingError of STARTING_ERRORS_MS) {
        const result = runCase({ refreshHz, standingError, rateLoadPpm: LOADED_PPM });
        const tail = tailOf(result.history);
        cases.push({
          refreshHz,
          standingError,
          history: result.history,
          tail,
          meanRate: mean(tail.map((state) => state.rate)),
          // This is the legacy load-only excess diagnostic: it stays U/bandMs,
          // not the accepted stopping threshold used by convergence consumers.
          meanExcessMs: mean(tail.map((state) => Math.abs(state.estimateMs) - state.bandMs)),
        });
      }
    }

    const alternating60 = cases.filter(({ refreshHz, tail }) => refreshHz === 60
      && tail.some((state) => state.mode === 'declining'));
    const nonAlternating60 = cases.filter(({ refreshHz, tail }) => refreshHz === 60
      && !tail.some((state) => state.mode === 'declining'));

    assert(alternating60.length > 0,
      `60Hz alternating population (${alternating60.length} of ${STARTING_ERRORS_MS.length}) is present`);
    assert(nonAlternating60.length > 0,
      `60Hz non-alternating population (${nonAlternating60.length} of ${STARTING_ERRORS_MS.length}) is present`);

    for (const { refreshHz, standingError, history, tail, meanRate, meanExcessMs } of cases) {
      assert(history.some((state) => state.mode === 'correcting'),
        `${refreshHz}Hz from ${standingError}ms reaches correcting under ${LOADED_PPM}ppm`);
      assert(history.every((state) => state.mode !== 'settled'),
        `${refreshHz}Hz from ${standingError}ms never reports settled under ${LOADED_PPM}ppm`);
      assert(tail.every((state) => Number.isFinite(state.rate)
        && Number.isFinite(state.estimateMs) && Number.isFinite(state.bandMs)),
      `${refreshHz}Hz from ${standingError}ms has finite parked measurements`);
      assert(tail.some((state) => Math.abs(state.rate - 1) > state.settings.RATE_EPSILON),
        `${refreshHz}Hz from ${standingError}ms has a non-unity applied rate`);
      assert(Math.abs(meanRate - EXPECTED_LOADED_RATE) * 1e6 <= PARK_RATE_TOLERANCE_PPM,
        `${refreshHz}Hz from ${standingError}ms tail-mean applied rate ${meanRate} is not ${EXPECTED_LOADED_RATE} within ${PARK_RATE_TOLERANCE_PPM}ppm; both refresh-rate populations are load-carrying`);
      if (refreshHz === 180) {
        assert(tail.every((state) => state.mode === 'correcting'),
          `180Hz parked population from ${standingError}ms has no declining tail polls`);
        assert(Math.abs(meanExcessMs - EXPECTED_LOADED_EXCESS_MS) <= PARK_EXCESS_TOLERANCE_MS,
          `180Hz parked population from ${standingError}ms tail-mean excess ${meanExcessMs}ms is not ${EXPECTED_LOADED_EXCESS_MS}ms within ${PARK_EXCESS_TOLERANCE_MS}ms`);
      }
    }

    for (const { standingError, tail } of alternating60) {
      // Load stress measures excess beyond the measurement band U. It does not
      // claim convergence eligibility or a distance-to-stop figure.
      const excesses = tail.map((state) => Math.abs(state.estimateMs) - state.bandMs);
      assert(tail.some((state) => state.mode === 'correcting')
        && tail.some((state) => state.mode === 'declining'),
      `60Hz alternating population from ${standingError}ms contains both correcting and declining tail polls`);
      assert(Math.min(...excesses) <= 0,
        `60Hz alternating population from ${standingError}ms has a band wide enough to contain the equilibrium error`);
      assert(Math.max(...excesses) > 0,
        `60Hz alternating population from ${standingError}ms crosses outside the band into correcting`);
    }

    for (const { standingError, tail } of nonAlternating60) {
      assert(tail.every((state) => state.mode === 'correcting'),
        `60Hz non-alternating population from ${standingError}ms has no declining tail polls`);
    }
  });

  await check('drift-load: removing the load restores the shipped settling control', async () => {
    const cases = [];
    for (const refreshHz of REFRESH_RATES_HZ) {
      for (const standingError of STARTING_ERRORS_MS) {
        const loaded = runCase({ refreshHz, standingError, rateLoadPpm: LOADED_PPM });
        const unloaded = runCase({ refreshHz, standingError, rateLoadPpm: 0 });
        const tail = tailOf(unloaded.history);
        cases.push({
          refreshHz,
          standingError,
          loadedHistory: loaded.history,
          unloadedHistory: unloaded.history,
          unloadedSettled: unloaded.history.filter((state) => state.mode === 'settled').length,
          unloadedDuty: tail.filter((state) => state.mode === 'settled').length / tail.length,
        });
      }
    }

    for (const { refreshHz, standingError, loadedHistory, unloadedHistory, unloadedSettled, unloadedDuty } of cases) {
      assert(loadedHistory.every((state) => state.mode !== 'settled'),
        `${refreshHz}Hz from ${standingError}ms loaded control does not settle`);
      assert(unloadedSettled > 0,
        `${refreshHz}Hz from ${standingError}ms zero-load control reaches settled`);
      assert(unloadedDuty >= DUTY_FLOOR,
        `${refreshHz}Hz from ${standingError}ms zero-load control holds settled for ${(unloadedDuty * 100).toFixed(1)}% of the tail`);
      assert(unloadedHistory.some((state) => state.mode === 'settled'),
        `${refreshHz}Hz from ${standingError}ms zero-load history contains the settled state`);
    }
  });

  await check('drift-load: omitted load is zero and bit-identical to explicit zero', async () => {
    const implicit = plant({ refreshHz: 180, standingError: -240, pollEvery: POLL_EVERY_FRAMES });
    const explicit = plant({ refreshHz: 180, standingError: -240, rateLoadPpm: 0, pollEvery: POLL_EVERY_FRAMES });
    for (let frame = 0; frame < RUN_FRAMES; frame++) {
      implicit.deliver();
      explicit.deliver();
    }
    const implicitRecords = implicit.log.read({ afterSeq: 0 }).records;
    const explicitRecords = explicit.log.read({ afterSeq: 0 }).records;
    const comparison = {
      separatePlants: implicit !== explicit,
      implicitLoad: implicit.rateLoadPpm,
      explicitLoad: explicit.rateLoadPpm,
      historyEqual: JSON.stringify(implicit.history) === JSON.stringify(explicit.history),
      recordsEqual: JSON.stringify(implicitRecords) === JSON.stringify(explicitRecords),
    };

    assert(comparison.separatePlants, 'omitted and explicit-zero checks use separate plant objects');
    assertEqual(comparison.implicitLoad, 0, 'plant() defaults rateLoadPpm to zero');
    assertEqual(comparison.explicitLoad, 0, 'explicit zero rateLoadPpm is exposed as zero');
    assert(comparison.historyEqual, 'omitting rateLoadPpm preserves controller history exactly');
    assert(comparison.recordsEqual, 'omitting rateLoadPpm preserves delivered records exactly');
  });
}
