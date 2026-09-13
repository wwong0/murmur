// scripts/drift-browser-report.mjs
//
// The browser pass's T9 figure block, as lines rather than as writes to stdout.
//
// This is the block a person copies out of a run, so its provenance qualifiers
// are load-bearing: which population a figure was taken over, that 4a's 1.32ms
// is a Chrome task-0 number and not the plant's, and that a predicted parking
// distance is a prediction. While it lived inside the driver's one `try`, none
// of that could be read back without Chrome, a server and five minutes — so the
// only thing standing between a qualifier and silent deletion was review.
// Returning lines makes the whole block checkable from manufactured figures.
//
// Rendering only. Every figure arrives already computed; nothing here reads a
// clock, a file or a tab, which is why `elapsedMs` is a parameter and not a
// `Date.now()` call.

import { PLANT_MOVEMENT_POPULATION, plantMaxPerPollMovementMs } from './drift-figures.mjs';

/** A figure, or the string `null` — never `undefined` or `NaN` in a report. */
export function numberText(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'null';
}

/**
 * The T9 block, `BEGIN` and `END` markers included. The markers delimit what a
 * person copies; they have no parser.
 */
export function t9FigureLines({
  settleStates,
  settlePollMs,
  convergedWindowMs,
  converged,
  spread,
  wholeRunMedians,
  figures,
  predictedParkingMs,
  parkingThresholdsUsable,
  expectedObservationSamples,
  renderedLines,
  seamCounters,
  routeDiagnosis,
  elapsedMs,
}) {
  const lines = ['--- T9 FIGURES BEGIN ---'];
  for (const state of settleStates) {
    const seam = state.last?.seam;
    const controller = seam?.controller ?? {};
    const gapMs = state.firstPlaybackAt === null || state.firstSettledAt === null || state.firstSettlingMs === null
      ? NaN
      : state.firstSettledAt - state.firstPlaybackAt - state.firstSettlingMs;
    lines.push(`  settling ${state.label}: settlingMs ${numberText(controller.settlingMs)}ms; gap before first correction ${numberText(gapMs)}ms (observed at ${settlePollMs}ms endpoints, ±0.25s granularity); applied rate ${numberText(controller.rate, 9)}; correctionsApplied ${controller.correctionsApplied ?? 'null'}`);
  }
  lines.push(`  convergence: ${convergedWindowMs / 1000}s spans; A median ${numberText(converged[0].convergedMedianMs)}ms over ${converged[0].convergedCount} records; B median ${numberText(converged[1].convergedMedianMs)}ms over ${converged[1].convergedCount} records; separation ${numberText(spread)}ms; whole-run summary medians A ${numberText(wholeRunMedians[0])}ms and B ${numberText(wholeRunMedians[1])}ms (ring-held history)`);
  lines.push(`  3.3 two-client parking prediction: ${numberText(predictedParkingMs)}ms from accepted S medians A ${numberText(figures[0]?.stats.stoppingThresholdMedianMs)}ms + B ${numberText(figures[1]?.stats.stoppingThresholdMedianMs)}ms (${parkingThresholdsUsable ? 'usable threshold populations' : 'threshold unavailable'}); U medians remain A ${numberText(figures[0]?.stats.bandMedianMs)}ms + B ${numberText(figures[1]?.stats.bandMedianMs)}ms; predicted worst-case separation, not an observed distance.`);
  for (const figure of figures) {
    const { label, stats, verdicts, lag, refresh, converged: span, plantMinimum: minimum } = figure;
    const plantMinimumText = minimum === null ? 'null' : `${(minimum.dutyCycle * 100).toFixed(1)}% at ${minimum.refreshHz}Hz/${minimum.standingError}ms over ${minimum.population}`;
    lines.push(`  3.1 ${label}: first 8 drift median ${numberText(lag.firstEightMs)}ms; last estimate with correctionsApplied=0 ${numberText(figure.noCorrectionEstimateMs)}ms; 4a reference ${lag.referenceLagMs}ms; verdict: ${lag.verdict}.`);
    lines.push(`  3.2 ${label}: interpolated span scatter ${numberText(span.convergedSpreadMs)}ms over ${span.convergedCount} records; alternation ${numberText(stats.alternation?.fraction, 3)} over ${stats.alternation?.nonzeroPairs ?? 0} nonzero pairs, ${stats.alternation?.zeroPairs ?? 0} zero pairs, ${stats.alternation?.totalPairs ?? 0} total pairs; rounded drifts ${JSON.stringify(stats.histogram)}; panel refresh ${numberText(refresh.refreshRateHz)}Hz from ${refresh.frameCount ?? 'null'} frames with median delta ${numberText(refresh.medianDeltaMs)}ms; verdict: ${verdicts.cadenceVerdict}.`);
    lines.push(`  3.3 ${label}: published ${stats.population} U/band median ${numberText(stats.bandMedianMs)}ms (spread median ${numberText(stats.spreadMedianMs)}ms, max ${numberText(stats.spreadMaxMs)}ms); L/allowance median ${numberText(stats.actuatorAllowanceMedianMs)}ms; accepted S median ${numberText(stats.stoppingThresholdMedianMs)}ms, max ${numberText(stats.stoppingThresholdMaxMs)}ms; threshold usability ${stats.thresholdUsableCount}/${stats.thresholdPopulationSamples} (${numberText(stats.thresholdUsableFraction, 3)}), schemas ${JSON.stringify(stats.thresholdSchemas)}; predicted half-vsync floor ${numberText(verdicts.predictedFloorMs)}ms; estimate range over the observation ${numberText(stats.estimateRangeMs)}ms; verdict: ${verdicts.floorVerdict}.`);
    lines.push(`  3.4 ${label}: first settled sample index ${stats.firstSettledIndex}; population ${stats.population}; duty ${verdicts.dutyVerdict}; excursions ${JSON.stringify(stats.excursions)}; verdict: ${verdicts.excursionVerdict}; plant sweep minimum ${plantMinimumText}; recommendation: ${verdicts.recommendation}; read over ${figure.observedSamples}/${expectedObservationSamples} samples with ${figure.absent} absent.`);
    lines.push(`  2.11 ${label}: Chrome 10s interpolated scatter ${numberText(span.convergedSpreadMs)}ms vs half-vsync ${numberText(verdicts.predictedFloorMs)}ms; published ${stats.population} U ${numberText(stats.bandMedianMs)}ms, L ${numberText(stats.actuatorAllowanceMedianMs)}ms, accepted S ${numberText(stats.stoppingThresholdMedianMs)}ms with usability ${numberText(stats.thresholdUsableFraction, 3)}; spread ${numberText(stats.spreadMedianMs)}ms; estimate range over the observation ${numberText(stats.estimateRangeMs)}ms; max per-poll estimate movement ${numberText(stats.maxPerPollMovementMs)}ms over ${stats.perPollPairsUsed} adjacent pairs, ${stats.perPollPairsSkippedForGap} skipped for poll gaps (against the simulated plant's ${numberText(plantMaxPerPollMovementMs(refresh.refreshRateHz))}ms largest per-poll movement over ${PLANT_MOVEMENT_POPULATION}; 4a's 1.32ms is a Chrome task-0 figure, not the plant's, and the two populations are unmatched, so neither supports agreement); verdict: ${verdicts.modelVerdict}; median applied rate ${numberText(stats.actingRateMedian, 6)} over acting fraction ${numberText(stats.actingFraction, 3)}; observed closure ${numberText(stats.observedClosureRateMsPerSec)}ms/s; commanded closure ${numberText(stats.commandedClosureRateMsPerSec)}ms/s; effectiveness fraction ${numberText(stats.effectivenessFraction, 3)}; rate-effectiveness verdict: ${verdicts.rateEffectivenessVerdict}.`);
    lines.push(`  3.5 ${label}: final no-clock counters ${JSON.stringify({ noClock: figure.finalCounters?.noClock ?? null, framesOffered: figure.finalCounters?.framesOffered ?? null })}; first clock held ${figure.firstClock?.held ?? 'null'} counters ${JSON.stringify(figure.firstClock?.counters ?? null)}; first playing held ${figure.firstPlayback?.seam?.held ?? 'null'} counters ${JSON.stringify(figure.firstPlayback?.seam?.counters ?? null)}; verdict: direct controller record count is not observable, and this page construction cannot feed the no-clock arm because records require a clock and an established offset does not return to null.`);
  }
  for (const [label, readings] of renderedLines) {
    const distinct = (key) => [...new Set(readings.map((reading) => reading[key] ?? ''))];
    lines.push(`  T6b ${label} rendered clock lines ${JSON.stringify(distinct('clockText'))} (asserted against CLOCK_LINE_RE); drift lines ${JSON.stringify(distinct('driftText'))} (asserted against DRIFT_LINE_RE with a positive frame count); controller lines ${JSON.stringify(distinct('controllerText'))} (asserted against branch-specific controller shapes, with an acting match required).`);
  }
  lines.push(`  T8 seam route counters: V before ${JSON.stringify(seamCounters.before.V)}; V after ${JSON.stringify(seamCounters.after.V)}; A3 before ${JSON.stringify(seamCounters.before.A3)}; A3 after ${JSON.stringify(seamCounters.after.A3)}; diagnosis ${routeDiagnosis ?? 'seam fired'}.`);
  lines.push(`  whole pass wall-clock length: ${numberText(elapsedMs, 0)}ms (${numberText(elapsedMs / 1000, 1)}s), measured from script start.`);
  lines.push('--- T9 FIGURES END ---');
  return lines;
}
