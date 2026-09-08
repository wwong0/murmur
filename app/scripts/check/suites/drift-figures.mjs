// Pure figure cases. These are deliberately small: the browser pass is not
// needed to prove arithmetic or population choices.

import { readFileSync } from 'node:fs';
import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { quantile } from '../../../public/lib/drift-controller.mjs';
import {
  MIN_CONVERGED_RECORDS,
  DEFAULT_BARS,
  ENDPOINT_CROSSCHECK_MS,
  MAX_RESIDUAL_SLOPE_SE_PPM,
  MAX_STRETCH_SLOPE_SE_PPM,
  MIN_STRETCH_RECORDS,
  MIN_STRETCH_SPAN_MS,
  RATE_STEADY_TOLERANCE,
  alternationStats,
  acceptedStoppingThresholdMs,
  compareStretchSlopes,
  convergedStats,
  driftAgainstLocal,
  mediaAgainstLocal,
  observationStats,
  predictedParkingDistanceMs,
  refreshFrom,
  residualPpm,
  slopeOf,
  standingLag,
  steadyCommandStretches,
  stretchSlopes,
  thresholdContractOf,
  windowVerdicts,
} from '../../drift-figures.mjs';

const recordSeries = (values, startSeq = 1) => values.map((driftMs, index) => ({ seq: startSeq + index, driftMs }));
const verifyBrowserSource = readFileSync(new URL('../../verify-browser.mjs', import.meta.url), 'utf8');
const sample = (overrides = {}) => ({
  atMs: 0,
  mode: 'declining',
  reason: null,
  rate: 1.001,
  polls: 1,
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
const actingSamples = (count, overrides = {}) => Array.from({ length: count }, (_, index) => sample({ atMs: index * 125, polls: index + 1, ...overrides }));
const settledSamples = (polls, overrides = {}) => polls.map((pollsValue, index) => sample({
  atMs: index * 125,
  mode: 'settled',
  reason: 'held',
  polls: pollsValue,
  ...overrides,
}));

const measurementRecord = ({ localMs, offsetMs = 0, rate = 1.001, interceptMs = 7, epochMs = 1 }) => {
  const mediaMs = rate * localMs + interceptMs;
  return {
    seq: localMs + 1,
    epochMs,
    mediaMs,
    displaySharedMs: localMs + offsetMs,
    driftMs: mediaMs - localMs - offsetMs,
    clock: { offsetMs },
  };
};

const noisyPoints = (rate, count = 120, stepMs = 50) => Array.from({ length: count }, (_, index) => ({
  x: index * stepMs,
  y: rate * index * stepMs + ((index % 7) - 3) * 0.2,
}));

const stableSamples = (count, overrides = {}) => Array.from({ length: count }, (_, index) => sample({
  atMs: index * 250,
  polls: index + 1,
  rate: 1.0008,
  estimateMs: 4,
  ...overrides,
}));

export default async function driftFiguresSuite() {
  await check('drift-figures: refresh and span use their declared quantiles', async () => {
    assertNear(quantile([0, 10], 0.25), 2.5, 1e-12, 'interpolated quantile [0,10] at .25 is expected 2.5');
    const span = convergedStats({ records: recordSeries(Array.from({ length: MIN_CONVERGED_RECORDS }, (_, index) => index)) }, 0);
    assertEqual(span.convergedCount, 120, 'the span population is expected 120 records');
    assertNear(span.convergedSpreadMs, 107.1, 1e-12, 'interpolated p95-p5 of 0..119 is expected 107.1ms');
    assertEqual(convergedStats({ records: recordSeries(Array.from({ length: MIN_CONVERGED_RECORDS - 1 }, (_, index) => index)) }, 0).convergedMedianMs, null, '119 records are expected to return a null span median');
    assertEqual(convergedStats({ records: recordSeries([0]) }, 0).convergedSpreadMs, null, 'one record is expected to return a null span spread');
    assertEqual(convergedStats({ records: recordSeries([0, 1]) }, 0).convergedMedianMs, null, 'two records are expected to return a null span median');
    const boundary = convergedStats({ records: recordSeries([100, 101, ...Array.from({ length: 118 }, (_, index) => index)], 10) }, 10);
    assertEqual(boundary.records[0].seq, 11, 'the first record at the span boundary is expected to be included only after barSeq');
    assertEqual(boundary.records.at(-1).seq, 129, 'the last record at the span boundary is expected to remain in the population');
    const nonFinite = recordSeries(Array.from({ length: MIN_CONVERGED_RECORDS }, (_, index) => index));
    nonFinite[0].driftMs = null;
    assertEqual(convergedStats({ records: nonFinite }, 0).convergedSpreadMs, null, 'a null drift is expected to make the span unavailable');
    const refresh = refreshFrom([0, 10, 20]);
    assertEqual(refresh.frameCount, 3, 'three stamps are expected to report three frames');
    assertEqual(refresh.medianDeltaMs, 10, 'equal 10ms deltas are expected to report a 10ms median');
    assertEqual(refresh.refreshRateHz, 100, 'a 10ms median delta is expected to report 100Hz');
  });

  await check('drift-figures: alternation counts quiet and nonzero populations', async () => {
    const quiet = alternationStats(recordSeries([5, 5, 5, 5]));
    assertEqual(quiet.totalPairs, 2, 'four quiet records are expected to make two total pairs');
    assertEqual(quiet.zeroPairs, 2, 'the two quiet pairs are expected to be counted as zero pairs');
    assertEqual(quiet.nonzeroPairs, 0, 'the quiet plateau is expected to have zero nonzero pairs');
    assertEqual(quiet.fraction, null, 'a quiet plateau is expected to have no alternation fraction');
    const alternating = alternationStats(recordSeries([0, 1, 0, 1]));
    assertEqual(alternating.totalPairs, 2, 'four alternating records are expected to make two total pairs');
    assertEqual(alternating.nonzeroPairs, 2, 'the alternating sequence is expected to have two nonzero pairs');
    assertEqual(alternating.zeroPairs, 0, 'the alternating sequence is expected to have zero zero-pairs');
    assertEqual(alternating.fraction, 1, 'two sign changes over two nonzero pairs are expected to produce fraction 1');
    const mostlyQuiet = alternationStats(recordSeries([0, 1, 0, 0, 0]));
    assertEqual(mostlyQuiet.totalPairs, 3, 'five records are expected to make three total pairs');
    assertEqual(mostlyQuiet.nonzeroPairs, 1, 'one pair survives the quiet tail as the only nonzero pair');
    assertEqual(mostlyQuiet.zeroPairs, 2, 'the quiet tail is expected to contribute two zero pairs');
    assertEqual(mostlyQuiet.fraction, 1, 'the one nonzero pair is expected to remain the alternation denominator');
    const nonFinite = alternationStats(recordSeries([0, null, 1]));
    assertEqual(nonFinite.totalPairs, 0, 'a non-finite difference is expected to be excluded from pair population');
    assertEqual(nonFinite.fraction, null, 'no finite difference pair is expected to produce a null fraction');
  });

  await check('drift-figures: cadence gates the half-vsync floor', async () => {
    const period2Records = recordSeries([0, 1, 0, 1]);
    const period2Stats = observationStats(settledSamples([1, 2, 3], { spreadMs: 1 }), period2Records, 125);
    const applicable = windowVerdicts({ stats: period2Stats, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } });
    assertEqual(applicable.predictedFloorMs, 5, '100Hz is expected to predict a 5ms half-vsync floor');
    assertEqual(applicable.floorApplicable, true, 'period-2-like cadence is expected to make the floor applicable');
    assertEqual(applicable.floorHeld, true, 'a 1ms published spread is expected to hold below 1.5 times the 5ms prediction');
    const monotonicRecords = recordSeries([0, 1, 2, 3]);
    const monotonicStats = observationStats(settledSamples([1, 2, 3], { spreadMs: 20 }), monotonicRecords, 125);
    const inapplicable = windowVerdicts({ stats: monotonicStats, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } });
    assertEqual(inapplicable.floorHeld, null, 'non-period-2 cadence is expected to clear the held/not-held floor result');
    assert(inapplicable.floorVerdict.startsWith('inapplicable:'), 'non-period-2 cadence is expected to report an inapplicable floor verdict');
    assert(inapplicable.cadenceVerdict.includes('2 nonzero pairs over 2 total pairs'), 'the cadence verdict is expected to name its 2-pair population');
    assertEqual(inapplicable.cadencePeriod2Like, false, 'the non-period-2 decision is expected to be an explicit boolean separate from its sentence');
    assert(inapplicable.cadenceVerdict.startsWith('not period-2-like'), 'the printed cadence sentence is expected to remain separate from the boolean decision');
    const noCadence = windowVerdicts({ stats: observationStats(settledSamples([1], { spreadMs: 1 }), [], 125), refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } });
    assert(noCadence.floorVerdict.startsWith('inapplicable:'), 'an empty cadence population is expected to make the floor inapplicable');
    const noRefresh = windowVerdicts({ stats: period2Stats, refresh: { refreshRateHz: null }, plantMinimum: { dutyCycle: 0.8 } });
    assertEqual(noRefresh.floorHeld, null, 'a null refresh rate is expected to make the floor unavailable');
  });

  await check('drift-figures: excursions use distinct observed polls', async () => {
    const stats = observationStats([
      sample({ polls: 4 }),
      sample({ polls: 4 }),
      sample({ polls: 5 }),
      sample({ polls: 6 }),
    ], [], 125);
    assertEqual(stats.excursions.length, 1, 'four non-settled samples are expected to make one whole excursion');
    assertEqual(stats.excursions[0].lengthMs, 500, 'four 125ms samples are expected to span 500ms');
    assertEqual(stats.excursions[0].controllerPolls, 3, 'poll values 4,4,5,6 are expected to make three distinct polls');
    assertEqual(stats.excursions[0].controllerPollsLabel, '3 distinct polls', 'three distinct polls are expected to carry their observed label');
    const one = observationStats([sample({ polls: 8 })], [], 125).excursions[0];
    assertEqual(one.controllerPolls, 1, 'one-sample excursion is expected to count one observed poll');
    assertEqual(one.lengthMs, 125, 'one sample is expected to span 125ms');
    const missing = observationStats([sample({ polls: null }), sample({ polls: 9 })], [], 125).excursions[0];
    assertEqual(missing.controllerPolls, null, 'a missing poll identity is expected to make excursion polls null');
    assertEqual(missing.controllerPollsLabel, 'unavailable', 'a missing poll identity is expected to label excursion polls unavailable');
  });

  await check('drift-figures: browser duty uses distinct controller polls', async () => {
    const stats = observationStats([
      sample({ polls: 1 }),
      ...settledSamples([2, 2]),
      sample({ polls: 3 }),
      ...settledSamples([4]),
    ], [], 125);
    assertEqual(stats.firstSettledIndex, 1, 'the first settled sample is expected at index 1');
    assertEqual(stats.settledSamples, 4, 'four samples after first settling are expected');
    assertEqual(stats.settledCount, 3, 'three settled samples are expected before poll de-duplication');
    assertEqual(stats.dutyPopulationPolls, 3, 'polls 2,2,3,4 are expected to make three duty-population polls');
    assertEqual(stats.settledPolls, 2, 'polls 2 and 4 are expected to be settled while poll 3 is acting');
    assertNear(stats.dutyCycle, 2 / 3, 1e-12, 'two settled polls over three are expected to produce duty 2/3');
    const verdicts = windowVerdicts({ stats, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } });
    assert(verdicts.dutyVerdict.includes('2/3'), 'the duty verdict is expected to print the distinct poll ratio 2/3');
    assert(verdicts.dutyVerdict.includes('distinct controller polls'), 'the duty verdict is expected to name the browser population');
    const absent = observationStats(actingSamples(3), [], 125);
    assertEqual(absent.dutyCycle, null, 'no settled sample is expected to have an undefined duty cycle');
    assert(windowVerdicts({ stats: absent, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } }).dutyVerdict.startsWith('unavailable'), 'absent settling is expected to report an unavailable duty verdict');
    const incomplete = observationStats([sample({ mode: 'settled', reason: 'held', polls: null })], [], 125);
    assertEqual(incomplete.dutyCycle, null, 'a settled sample without polls is expected to have unavailable duty');
  });

  await check('drift-figures: lag and parking preserve provenance', async () => {
    const firstEight = recordSeries([100, 101, 102, 103, 104, 105, 106, 107, 1000]);
    const lag = standingLag(firstEight, 103.5);
    assertEqual(lag.firstEightMs, 103.5, 'the first eight records 100..107 are expected to have median 103.5ms');
    assertEqual(lag.population, 'first eight records the window ever produced', 'standing lag is expected to name its first-eight population');
    assertEqual(lag.units, 'ms', 'standing lag is expected to report milliseconds');
    assert(lag.verdict.startsWith('reproduces'), 'a 103.5ms result against a 103.5ms reference is expected to reproduce');
    const short = standingLag(recordSeries([100, 101, 102, 103, 104, 105, 106]), 103);
    assertEqual(short.firstEightMs, null, 'seven records are expected to make first-eight lag null');
    assert(short.verdict.startsWith('unavailable'), 'missing first-eight records are expected to have an unavailable verdict');
    const invalid = standingLag(recordSeries([100, 101, 102, 103, 104, 105, 106, null]), 103);
    assertEqual(invalid.firstEightMs, null, 'a null first-eight drift is expected to make lag null');
    assertEqual(predictedParkingDistanceMs(3, 4), 7, 'published bands 3ms and 4ms are expected to predict 7ms separation');
    assertEqual(predictedParkingDistanceMs(3, null), null, 'a missing published band is expected to make parking prediction null');
    assert(predictedParkingDistanceMs(3, 4) !== 3 * 2, 'the two-window sum 7ms is expected not to equal the old one-window double 6ms');
  });

  await check('drift-figures: band median keeps its field and population', async () => {
    const bandSamples = [
      sample({ atMs: 0, mode: 'settled', reason: 'held', polls: 7, estimateMs: 5, bandMs: 4, spreadMs: 1 }),
      sample({ atMs: 125, mode: 'settled', reason: 'held', polls: 8, estimateMs: 6, bandMs: 8, spreadMs: 3 }),
    ];
    const spreadSamples = bandSamples.map((entry) => ({ ...entry, bandMs: entry.spreadMs }));
    const bandStats = observationStats(bandSamples, [], 125);
    const spreadStats = observationStats(spreadSamples, [], 125);
    assertEqual(bandStats.population, 'settled', 'a settled sample is expected to select the settled population for its band median');
    assertEqual(bandStats.bandMedianMs, 6, 'published bands 4ms and 8ms are expected to have a 6ms median');
    assertEqual(bandStats.spreadMedianMs, 2, 'published spreads 1ms and 3ms are expected to have a 2ms median');
    assertEqual(spreadStats.bandMedianMs, 2, 'replacing the bands with the same spreads is expected to produce a 2ms band median');
    assert(/predictedParkingDistanceMs\(\s*t7Figures\[0\]\.stats\.stoppingThresholdMedianMs,\s*t7Figures\[1\]\.stats\.stoppingThresholdMedianMs,/.test(verifyBrowserSource), 'the browser parking call site is expected to feed both accepted stopping-threshold medians');
    for (const field of [
      'firstSettledIndex',
      'settledSamples',
      'settledCount',
      'dutyCycle',
      'dutyPopulation',
      'dutyPopulationPolls',
      'settledPolls',
      'population',
      'populationSamples',
      'thresholdPopulation',
      'thresholdPopulationSamples',
      'thresholdSchemas',
      'thresholdUsableCount',
      'thresholdUsableFraction',
      'stoppingThresholdMedianMs',
      'stoppingThresholdMaxMs',
      'actuatorAllowanceMedianMs',
      'actuatorAllowanceMaxMs',
      'spreadMedianMs',
      'spreadMaxMs',
      'estimateRangeMs',
      'maxPerPollMovementMs',
      'perPollEvaluations',
      'perPollPairsUsed',
      'perPollPairsSkippedForGap',
      'actingCount',
      'actingFraction',
      'actingRateMedian',
      'observedClosureRateMsPerSec',
      'commandedClosureRateMsPerSec',
      'effectivenessFraction',
      'alternation',
      'histogram',
      'excursions',
    ]) {
      assertEqual(JSON.stringify(bandStats[field]), JSON.stringify(spreadStats[field]), `${field} is expected to agree when only bandMs differs`);
    }
  });

  await check('drift-figures: accepted thresholds require the current contract or identified legacy evidence', async () => {
    const legacy = sample();
    for (const field of ['actuatorAllowanceMs', 'requiredStoppingThresholdMs', 'stoppingThresholdMs', 'thresholdUsable', 'measurementLimit']) delete legacy[field];
    assertEqual(thresholdContractOf(legacy).schema, 'legacy-4d', 'a snapshot with no additive fields is identified as legacy 4d');
    assertEqual(acceptedStoppingThresholdMs(legacy), legacy.bandMs, 'legacy 4d uses bandMs as S explicitly');
    const legacyStats = observationStats([legacy], [], 125);
    assertEqual(legacyStats.thresholdSchemas[0], 'legacy-4d', 'legacy population retains its schema identity');
    assertEqual(legacyStats.stoppingThresholdMedianMs, legacy.bandMs, 'legacy population reports its stopping threshold as U');

    const malformed = sample();
    delete malformed.stoppingThresholdMs;
    assertEqual(thresholdContractOf(malformed).schema, 'malformed-new', 'a partial additive snapshot is identified as malformed new data');
    assertEqual(acceptedStoppingThresholdMs(malformed), null, 'malformed new data never infers an accepted threshold');
    assertEqual(observationStats([malformed], [], 125).populationSamples, 0, 'malformed new data is excluded from the acting population');
    assertEqual(steadyCommandStretches([malformed], DEFAULT_BARS).length, 0, 'malformed new data starts no steady command stretch');

    const refused = sample({ thresholdUsable: false, stoppingThresholdMs: null });
    assertEqual(acceptedStoppingThresholdMs(refused), null, 'an explicit refusal never becomes usable through a finite band');
    assertEqual(observationStats([refused], [], 125).populationSamples, 0, 'an explicit refusal is excluded from distance-to-stop populations');
  });

  await check('drift-figures: regression and residuals carry measured uncertainty', async () => {
    const knownRate = 1.0012;
    const points = noisyPoints(knownRate);
    const fit = slopeOf(points);
    assert(fit !== null, 'a finite 120-point series is expected to produce a slope');
    assertEqual(fit.n, points.length, 'the fitted population is expected to retain all finite points');
    assertNear(fit.slope, knownRate, fit.standardError * 3 + 1e-12, 'the fitted rate is expected within three fitted standard errors');
    assert(fit.standardError < 0.001, `the fitted standard error is expected below the 1000ppm bound, got ${fit.standardError}`);
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const residuals = points.map((point) => point.y - (fit.slope * point.x + fit.intercept));
    const sxx = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const expectedError = Math.sqrt(residuals.reduce((sum, residual) => sum + residual ** 2, 0) / (fit.n - 2) / sxx);
    assertNear(fit.standardError, expectedError, 1e-15, 'the slope standard error is expected to use n-2 residual degrees of freedom');
    assertNear(fit.spanX, points.at(-1).x - points[0].x, 1e-12, 'the fit span is expected to use the predictor endpoints');
    const residual = residualPpm(fit, 1.0004);
    const expectedResidual = (fit.slope / 1.0004 - 1) * 1e6;
    assert(residual !== null, 'a finite slope and nonzero command are expected to produce a residual');
    assertNear(residual.residualPpm, expectedResidual, 1e-9, 'the residual is expected to divide by the commanded rate');
    assertNear(residual.standardErrorPpm, fit.standardError / 1.0004 * 1e6, 1e-9, 'the residual standard error is expected to propagate the slope error');
    assertEqual(residualPpm(null, 1), null, 'a missing slope is expected to produce no residual');
    assertEqual(residualPpm(fit, 0), null, 'a zero commanded rate is expected to produce no residual');
  });

  await check('drift-figures: local-clock slopes discriminate command and offset questions', async () => {
    const recordsForRate = (rate, flat = false) => noisyPoints(rate).map((point, index) => {
      const noise = ((index % 7) - 3) * 0.2;
      const mediaMs = flat ? 500 + noise : point.y;
      return { ...measurementRecord({ localMs: point.x, rate: 1, interceptMs: 0 }), mediaMs, displaySharedMs: point.x, driftMs: mediaMs - point.x };
    });
    const slow = slopeOf(mediaAgainstLocal(recordsForRate(1.0008)));
    const fast = slopeOf(mediaAgainstLocal(recordsForRate(1.0021)));
    assert(slow !== null && fast !== null, 'both commanded operating points are expected to fit');
    const commandDifference = 1300e-6;
    const combinedError = 3 * Math.hypot(slow.standardError, fast.standardError);
    assertNear(fast.slope - slow.slope, commandDifference, combinedError + 1e-12, 'media tracking the command is expected to resolve the command difference');
    const flatSlow = slopeOf(mediaAgainstLocal(recordsForRate(1.0008, true)));
    const flatFast = slopeOf(mediaAgainstLocal(recordsForRate(1.0021, true)));
    assert(flatSlow !== null && flatFast !== null, 'both flat operating points are expected to fit');
    assert(Math.abs(flatFast.slope - flatSlow.slope) <= 3 * Math.hypot(flatSlow.standardError, flatFast.standardError) + 1e-12, 'flat media is expected to make the command difference indistinguishable from zero');

    const offsetRecords = Array.from({ length: 40 }, (_, index) => measurementRecord({
      localMs: index * 500,
      offsetMs: index < 20 ? 0 : 200,
      rate: 1.001,
      interceptMs: 11,
    }));
    const localFit = slopeOf(mediaAgainstLocal(offsetRecords));
    const restatedFit = slopeOf(driftAgainstLocal(offsetRecords, 0));
    const roomFit = slopeOf(offsetRecords.map((record) => ({ x: record.displaySharedMs, y: record.driftMs })));
    assert(localFit !== null && restatedFit !== null && roomFit !== null, 'offset-step records are expected to fit in all three views');
    assertNear(restatedFit.slope + 1, localFit.slope, 1e-12, 'offset restatement is expected to preserve the local-clock slope');
    assert(Math.abs(roomFit.slope - restatedFit.slope) > 1e-5, 'the un-restated room slope is expected to change when the offset steps');

    const base = Array.from({ length: 20 }, (_, index) => measurementRecord({ localMs: index * 500, rate: 1.001, interceptMs: 3 }));
    const biased = base.map((record) => ({ ...record, displaySharedMs: record.displaySharedMs + 100 }));
    const baseFit = slopeOf(mediaAgainstLocal(base));
    const biasedFit = slopeOf(mediaAgainstLocal(biased));
    assert(baseFit !== null && biasedFit !== null, 'the base and biased series are expected to fit');
    assertNear(biasedFit.slope, baseFit.slope, 1e-12, 'a constant display bias is expected not to move the slope');
    assertNear(biasedFit.intercept - baseFit.intercept, -baseFit.slope * 100, 1e-9, 'a constant display bias is expected to move the intercept');
  });

  await check('drift-figures: poll identity drives the live movement term', async () => {
    const samples = [
      sample({ polls: 1, estimateMs: 4, rate: 1.001 }),
      sample({ polls: 2, estimateMs: 4, rate: 1.001 }),
      sample({ polls: 3, estimateMs: 5, rate: 1.001 }),
    ];
    const identityStats = observationStats(samples, [], 125);
    const valueChangePairs = samples.slice(1).filter((current, index) => current.estimateMs !== samples[index].estimateMs).length;
    assertEqual(valueChangePairs, 1, 'value-change counting is expected to count one changed estimate pair');
    assertEqual(identityStats.perPollPairsUsed, 2, 'two adjacent poll pairs are expected to be used');
    assertEqual(identityStats.perPollEvaluations, 3, 'three published poll identities are expected to count as three evaluations');
    assertEqual(identityStats.perPollPairsSkippedForGap, 0, 'the consecutive identity series is expected to skip no gaps');
    assertEqual(identityStats.maxPerPollMovementMs, 1, 'the largest adjacent movement is expected to be one millisecond');
    const live = windowVerdicts({
      stats: observationStats(settledSamples([1, 2, 3], { estimateMs: 4, spreadMs: 1 }), recordSeries([0, 1, 0, 1]), 125),
      refresh: { refreshRateHz: 100 },
      plantMinimum: { dutyCycle: 0.8 },
    });
    assertEqual(live.movementComparable, true, 'a finite adjacent-poll movement is expected to make the model term comparable');
    for (const population of ['acting', 'settled']) {
      for (const movement of [0, 1.32, 1000000]) {
        const verdict = windowVerdicts({
          stats: { ...identityStats, population, maxPerPollMovementMs: movement,
            spreadMedianMs: 1, alternation: observationStats([], recordSeries([0, 1, 0, 1]), 125).alternation },
          refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 },
        });
        assertEqual(verdict.cadencePeriod2Like, true, 'the fixture must reach the otherwise affirmative cadence arm');
        assertEqual(verdict.floorHeld, true, 'the fixture must reach the otherwise affirmative floor arm');
        assertEqual(verdict.maxPerPollMovementMs, movement, 'the measured movement must stay available');
        assert(verdict.modelVerdict.startsWith('inconclusive:'), 'available movement cannot imply model agreement');
        assert(verdict.modelVerdict.includes('movement agreement criterion undefined'), 'the missing criterion must be named');
      }
    }
    const gappedStats = observationStats([sample({ polls: 1, estimateMs: 4 }), sample({ polls: 3, estimateMs: 7 })], [], 125);
    assertEqual(gappedStats.maxPerPollMovementMs, null, 'a poll gap is expected not to produce a movement');
    assertEqual(gappedStats.perPollPairsUsed, 0, 'a poll gap is expected to use no adjacent pair');
    assertEqual(gappedStats.perPollPairsSkippedForGap, 1, 'one gap is expected to be counted as one skipped pair');
    const gappedVerdict = windowVerdicts({ stats: gappedStats, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } });
    assertEqual(gappedVerdict.movementComparable, false, 'all-gapped samples are expected to withhold the model term');
    assert(gappedVerdict.modelVerdict.includes('all observed pairs had a poll gap'), 'the withheld model term is expected to name the poll-gap reason');
    const absentPolls = observationStats([sample({ polls: null, estimateMs: 4 })], [], 125);
    assertEqual(absentPolls.perPollEvaluations, 0, 'missing published polls are expected not to create an identity group');
    assert(windowVerdicts({ stats: absentPolls, refresh: { refreshRateHz: 100 }, plantMinimum: { dutyCycle: 0.8 } }).modelVerdict.includes('no consecutive published poll pair'), 'missing polls are expected to keep the withholding reason explicit');
  });

  await check('drift-figures: steady stretches and both record views fit by time', async () => {
    const samples = stableSamples(113);
    const stretches = steadyCommandStretches(samples, DEFAULT_BARS);
    assertEqual(stretches.length, 1, 'a stable consecutive command is expected to make one maximal stretch');
    assertEqual(stretches[0].firstPolls, 1, 'the stable stretch is expected to retain its first poll identity');
    assertEqual(stretches[0].lastPolls, 113, 'the stable stretch is expected to retain its last poll identity');
    assertEqual(stretches[0].sampleCount, 113, 'the stable stretch is expected to count its evaluations');
    assertNear(stretches[0].medianRate, 1.0008, 1e-12, 'the stable stretch is expected to report its median command');
    const records = Array.from({ length: 141 }, (_, index) => measurementRecord({ localMs: index * 200, rate: 1.0008, interceptMs: 9 }));
    const fitted = stretchSlopes({ stretches, records, bars: DEFAULT_BARS });
    assertEqual(fitted.length, 1, 'one stretch is expected to produce one fit result');
    assertEqual(fitted[0].refused, false, 'a qualifying stable stretch is expected to be accepted');
    assert(fitted[0].recordCount >= MIN_STRETCH_RECORDS, 'the accepted stretch is expected to clear the record bar');
    assert(fitted[0].trimmedSpanMs >= MIN_STRETCH_SPAN_MS, 'the accepted stretch is expected to clear the span bar');
    assertNear(fitted[0].media.slope, 1.0008, 1e-12, 'media-against-local is expected to recover the known rate');
    assertNear(fitted[0].drift.slope, 0.0008, 1e-12, 'restated drift-against-local is expected to recover the residual slope');
    assert(fitted[0].media.standardErrorPpm <= MAX_STRETCH_SLOPE_SE_PPM, 'the media slope error is expected to be reported in ppm below its bar');
    assert(fitted[0].drift.standardErrorPpm <= MAX_RESIDUAL_SLOPE_SE_PPM, 'the drift slope error is expected to be reported in ppm below its bar');
    assert(fitted[0].endpointCrosscheck.mediaMs <= ENDPOINT_CROSSCHECK_MS, 'the endpoint cross-check is expected to clear its 48ms bar');
    assertEqual(fitted[0].distinctOffsetCount, 1, 'one clock offset is expected to report one distinct offset');
    assertEqual(fitted[0].offsetMovementMs, 0, 'a constant clock offset is expected to report zero movement');
    const comparison = compareStretchSlopes(fitted);
    assertEqual(comparison.available, false, 'fewer than two stretches are expected to leave command comparison unavailable');
    assert(comparison.reason.includes('fewer-than-two'), 'the unavailable command comparison is expected to name its population reason');

    const split = steadyCommandStretches([
      sample({ atMs: 0, polls: 1, rate: 1 }),
      sample({ atMs: 250, polls: 2, rate: 1 }),
      sample({ atMs: 500, polls: 3, rate: 1 + RATE_STEADY_TOLERANCE * 2 }),
      sample({ atMs: 750, polls: 4, rate: 1 + RATE_STEADY_TOLERANCE * 2 }),
    ], DEFAULT_BARS);
    assertEqual(split.length, 2, 'a command excursion beyond the tolerance is expected to split stretches');
    assertEqual(split[0].lastPolls, 2, 'the first stable stretch is expected to end before the command excursion');
    assertEqual(split[1].firstPolls, 3, 'the second stable stretch is expected to begin at the changed command');
    const reasonSplit = steadyCommandStretches([
      sample({ atMs: 0, polls: 1, reason: null }),
      sample({ atMs: 250, polls: 2, reason: 'held' }),
      sample({ atMs: 500, polls: 3, reason: null }),
    ], DEFAULT_BARS);
    assertEqual(reasonSplit.length, 2, 'a non-null controller reason is expected to exclude that evaluation from a stretch');
    const gapSplit = steadyCommandStretches([
      sample({ atMs: 0, polls: 1 }),
      sample({ atMs: 250, polls: 3 }),
    ], DEFAULT_BARS);
    assertEqual(gapSplit.length, 2, 'a missing published evaluation is expected to split stretches');
  });

  await check('drift-figures: stretch boundaries refuse unsafe populations explicitly', async () => {
    const smallBars = { ...DEFAULT_BARS, STRETCH_EDGE_EXCLUSION_MS: 1, MIN_STRETCH_SPAN_MS: 2, MIN_STRETCH_RECORDS: 3 };
    const baseStretch = { firstAtMs: 0, lastAtMs: 10, firstPolls: 1, lastPolls: 5, medianRate: 1 };
    const goodRecords = [2, 4, 6, 8].map((localMs) => measurementRecord({ localMs }));
    const outside = [...goodRecords, measurementRecord({ localMs: 1000 })];
    const good = stretchSlopes({ stretches: [baseStretch], records: outside, bars: smallBars })[0];
    assertEqual(good.refused, false, 'records outside the trimmed stretch are expected not to enter its fit');
    assertEqual(good.recordCount, 4, 'the fit is expected to contain only records inside the trimmed time interval');
    assertEqual(good.excludedNonFiniteRecords, 0, 'records outside the interval are expected not to count as non-finite exclusions');
    const invalid = stretchSlopes({
      stretches: [baseStretch],
      records: [...goodRecords, { ...goodRecords[0], mediaMs: null }],
      bars: smallBars,
    })[0];
    assertEqual(invalid.excludedNonFiniteRecords, 1, 'one non-finite record is expected to be counted rather than silently dropped');
    assertEqual(invalid.recordCount, 4, 'the non-finite record is expected to be excluded from the fit population');
    const short = stretchSlopes({ stretches: [{ ...baseStretch, firstAtMs: 0, lastAtMs: 1 }], records: goodRecords, bars: smallBars })[0];
    assertEqual(short.refused, true, 'a stretch shorter than its edge exclusion is expected to be refused');
    assert(short.reasons.includes('stretch-shorter-than-edge-exclusion'), 'the short stretch is expected to report its exclusion reason');
    const spanRefused = stretchSlopes({ stretches: [baseStretch], records: goodRecords, bars: { ...smallBars, MIN_STRETCH_SPAN_MS: 20 } })[0];
    assertEqual(spanRefused.refused, true, 'a trimmed span below its bar is expected to be refused');
    assert(spanRefused.reasons.includes('trimmed-span-below-bar'), 'the short trimmed span is expected to name its bar');
    const countRefused = stretchSlopes({ stretches: [baseStretch], records: goodRecords, bars: { ...smallBars, MIN_STRETCH_RECORDS: 8 } })[0];
    assertEqual(countRefused.refused, true, 'a record population below its bar is expected to be refused');
    assert(countRefused.reasons.includes('record-count-below-bar'), 'the short record population is expected to name its bar');
    const epochRefused = stretchSlopes({
      stretches: [baseStretch],
      records: goodRecords.map((record, index) => index === 2 ? { ...record, epochMs: 2 } : record),
      bars: smallBars,
    })[0];
    assert(epochRefused.reasons.includes('epoch-revision'), 'records spanning two epochs are expected to be refused');
    const dropRefused = stretchSlopes({ stretches: [{ ...baseStretch, dropsChanged: true }], records: goodRecords, bars: smallBars })[0];
    assert(dropRefused.reasons.includes('control-drop'), 'a changed drop counter is expected to refuse the stretch');
    const offsetStep = goodRecords.map((record, index) => index < 2 ? record : { ...record, clock: { offsetMs: 10 }, displaySharedMs: record.displaySharedMs + 10, driftMs: record.driftMs - 10 });
    const reselection = stretchSlopes({ stretches: [baseStretch], records: offsetStep, bars: smallBars })[0];
    assertEqual(reselection.refused, false, 'clock sample reselection is expected not to be treated as actuator motion');
    assertEqual(reselection.distinctOffsetCount, 2, 'offset reselection is expected to report two distinct offsets');
    assertEqual(reselection.offsetMovementMs, 10, 'offset reselection is expected to report its total movement');
    const zeroSpread = stretchSlopes({
      stretches: [{ ...baseStretch, firstAtMs: 0, lastAtMs: 10 }],
      records: goodRecords.map((record) => ({ ...record, displaySharedMs: 5, clock: { offsetMs: 0 } })),
      bars: smallBars,
    })[0];
    assert(zeroSpread.reasons.includes('slope-unavailable'), 'zero predictor spread is expected to return unavailable fits');
    assertEqual(zeroSpread.media, null, 'zero predictor spread is expected to return no media slope');
    const customEdge = stretchSlopes({ stretches: [baseStretch], records: goodRecords, bars: { ...smallBars, STRETCH_EDGE_EXCLUSION_MS: 3 } })[0];
    assertEqual(customEdge.trimmedStartMs, 3, 'the edge exclusion is expected to come from the passed bars');
    assertEqual(customEdge.trimmedEndMs, 7, 'the passed edge exclusion is expected to trim both ends');
  });

  await check('drift-figures: empty and non-finite populations stay unavailable', async () => {
    const empty = observationStats([], [], 125);
    assertEqual(empty.firstSettledIndex, -1, 'an empty sample population is expected to have no settled index');
    assertEqual(empty.populationSamples, 0, 'an empty sample population is expected to contain zero steady-state samples');
    assertEqual(empty.spreadMedianMs, null, 'an empty sample population is expected to have a null spread median');
    assertEqual(empty.bandMedianMs, null, 'an empty sample population is expected to have a null band median');
    assertEqual(empty.estimateRangeMs, null, 'an empty sample population is expected to have a null estimate range');
    assertEqual(empty.maxPerPollMovementMs, null, 'an empty sample population is expected to have a null per-poll movement');
    assertEqual(empty.dutyCycle, null, 'an empty sample population is expected to have an undefined duty cycle');
    const badRefresh = refreshFrom([0, NaN, 20]);
    assertEqual(badRefresh.medianDeltaMs, null, 'a non-finite refresh delta is expected to have a null median');
    assertEqual(badRefresh.refreshRateHz, null, 'a non-finite refresh delta is expected to have a null refresh rate');
    const badSamples = observationStats([sample({ polls: null, estimateMs: null, spreadMs: null })], [], 125);
    assertEqual(badSamples.actingRateMedian, 1.001, 'a finite rate is expected to remain measurable beside null figures');
    assertEqual(badSamples.spreadMedianMs, null, 'a null spread is expected to leave the spread median unavailable');
    const badBand = observationStats([sample({ bandMs: NaN })], [], 125);
    assertEqual(badBand.bandMedianMs, null, 'a non-finite band is expected to leave the band median unavailable');
    assertEqual(badSamples.estimateRangeMs, null, 'a null estimate is expected to leave estimate range unavailable');
    assertEqual(badSamples.maxPerPollMovementMs, null, 'a null estimate is expected to leave per-poll movement unavailable');
    assertEqual(badSamples.excursions[0].controllerPolls, null, 'a null polls field is expected to leave excursion poll count unavailable');
  });
}
