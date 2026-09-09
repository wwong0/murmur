// scripts/check/mechanism-cadence.mjs
//
// The cadence estimator, ported from pinned Chromium 152.0.7977.76 revision
// 0d89dfa2dd7c1ec4b8a14b9f303f887bb63b6174 —
// `media/filters/video_cadence_estimator.cc` in full, and the 32-sample
// `base::MovingAverageDeviation` from `base/moving_window.h` that feeds it.
//
// Everything here is arithmetic on two durations. It holds no clock and no
// queue: the renderer stage next door supplies the render interval, the average
// frame duration and the deviation, and this returns a pattern of render counts.
//
// Rules that survive any edit:
//
//  - THE PATTERN IS RENDER COUNTS PER FRAME, over `n` frames summing to `k`
//    render intervals. `[8,7]` is not a duration and not a ppm figure.
//  - Hysteresis is counted in RENDER INTERVALS HELD, not in elapsed wall time,
//    and `render_intervals_cadence_held_` resets on agreement as well as on a
//    switch. A model that expresses it as "100 ms of wall clock" is a different
//    mechanism that happens to agree at 180 Hz.
//  - An empty cadence is a real outcome, not a failure. Above the drift horizon
//    the estimator returns no pattern and the renderer falls through to
//    coverage — which is a different observable, not a slower version of one.
//
// TEST MACHINERY — under scripts/. Deterministic; no randomness, no clock read.

/** `kMinimumCadenceDurationMs`. */
export const CADENCE_HYSTERESIS_MS = 100;
/** `kMinimumAcceptableTimeBetweenGlitchesSecs`, from video_renderer_algorithm.h. */
export const MINIMUM_TIME_UNTIL_MAX_DRIFT_MS = 8000;
/** `kMaxCadenceSize`. */
export const MAX_CADENCE_SIZE = 5;
/** `kVariableFPSFactor` / `kConstantFPSFactor`. */
export const VARIABLE_FPS_FACTOR = 0.55;
export const CONSTANT_FPS_FACTOR = 0.45;
/** `kMovingAverageSamples`. */
export const MOVING_AVERAGE_SAMPLES = 32;

/**
 * `base::MovingAverageDeviation` over the last `windowSize` samples.
 * `Deviation` is the POPULATION standard deviation — `sqrt((Σx² - (Σx)²/n)/n)` —
 * and a window shorter than `windowSize` divides by what it holds, not by the
 * window size.
 */
export function createMovingAverageDeviation(windowSize = MOVING_AVERAGE_SAMPLES) {
  const samples = [];
  let cursor = 0;
  return {
    addSample(value) {
      if (samples.length < windowSize) samples.push(value);
      else { samples[cursor] = value; cursor = (cursor + 1) % windowSize; }
    },
    count() { return samples.length; },
    mean() { return samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length; },
    deviation() {
      const n = samples.length;
      if (n === 0) return 0;
      const sum = samples.reduce((total, value) => total + value, 0);
      const sumSquares = samples.reduce((total, value) => total + value * value, 0);
      return Math.sqrt(Math.max(0, sumSquares - (sum * sum) / n) / n);
    },
    reset() { samples.length = 0; cursor = 0; },
  };
}

/**
 * `ConstructCadence(k, n)` — `n` entries of `k/n` or `k/n + 1`, spread as evenly
 * as the integer accumulator allows. Written with the source's own accumulators
 * rather than a rounding shortcut: the shortcut agrees for `[8,7]` and stops
 * agreeing at `k < n`, where the source forces the first entry to 1 so the first
 * frame is always rendered.
 */
export function constructCadence(k, n) {
  const quotient = Math.floor(k / n);
  const output = [];
  let targetAccumulate = 0;
  let actualAccumulate = 0;
  for (let i = 0; i < n; i++) {
    targetAccumulate += k;
    const targetCurrent = targetAccumulate - actualAccumulate;
    const value = (i === 0 && k < n) || targetCurrent * 2 >= n * (quotient * 2 + 1) ? quotient + 1 : quotient;
    output.push(value);
    actualAccumulate += value * n;
  }
  return output;
}

/**
 * `ConstructSimpleCadence`. A negative rounded value is no cadence at all; zero
 * is promoted to one. `timeUntilMaxDriftMs` is `Infinity` when the error is
 * exactly zero, which is what the caller's `>=` comparison wants.
 */
export function constructSimpleCadence(perfectCadence, maxAcceptableDriftMs) {
  let cadenceValue = Math.round(perfectCadence);
  if (cadenceValue < 0) return { cadence: [], timeUntilMaxDriftMs: 0 };
  if (cadenceValue === 0) cadenceValue = 1;
  const error = Math.abs(1 - perfectCadence / cadenceValue);
  return { cadence: constructCadence(cadenceValue, 1), timeUntilMaxDriftMs: maxAcceptableDriftMs / error };
}

/**
 * `CalculateCadence`. Returns `{ cadence: [], ... }` when no pattern is
 * admissible — the state that sends the renderer to coverage selection.
 */
export function calculateCadence({
  renderIntervalMs,
  frameDurationMs,
  maxAcceptableDriftMs,
  minimumTimeUntilMaxDriftMs = MINIMUM_TIME_UNTIL_MAX_DRIFT_MS,
}) {
  const perfectCadence = frameDurationMs / renderIntervalMs;
  if (maxAcceptableDriftMs >= minimumTimeUntilMaxDriftMs) {
    return { ...constructSimpleCadence(perfectCadence, maxAcceptableDriftMs), perfectCadence, via: 'simple-wide-drift' };
  }
  const driftRatio = maxAcceptableDriftMs / minimumTimeUntilMaxDriftMs;
  const minimumAcceptable = perfectCadence / (1 + driftRatio);
  const maximumAcceptable = perfectCadence / (1 - driftRatio);
  let bestError = 0;
  let bestN = 0;
  let bestK = 0;
  for (let n = 1; n <= MAX_CADENCE_SIZE; n++) {
    if (!(Math.floor(minimumAcceptable * n) < Math.floor(maximumAcceptable * n))) continue;
    const k = Math.round(perfectCadence * n);
    const error = Math.abs(1 - (perfectCadence * n) / k);
    // "Prefer the shorter pattern unless a longer one significantly reduces the
    // error" — the 0.99 is the source's, and a strict `<` against zero is why an
    // exact match at n=2 is never displaced by an equally exact one at n=4.
    if (!bestN || error < bestError * 0.99) { bestError = error; bestK = k; bestN = n; }
  }
  if (!bestN) {
    const simple = constructSimpleCadence(perfectCadence, maxAcceptableDriftMs);
    if (simple.cadence.length > 0 && simple.timeUntilMaxDriftMs >= minimumTimeUntilMaxDriftMs) {
      return { ...simple, perfectCadence, via: 'simple-fallback' };
    }
    return { cadence: [], timeUntilMaxDriftMs: 0, perfectCadence, via: 'none' };
  }
  return {
    cadence: constructCadence(bestK, bestN),
    timeUntilMaxDriftMs: maxAcceptableDriftMs / bestError,
    perfectCadence,
    via: 'pattern',
    k: bestK,
    n: bestN,
    error: bestError,
  };
}

const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** `VideoCadenceEstimator`, with its hysteresis and variable-FPS state intact. */
export function createCadenceEstimator({
  minimumTimeUntilMaxDriftMs = MINIMUM_TIME_UNTIL_MAX_DRIFT_MS,
  hysteresisMs = CADENCE_HYSTERESIS_MS,
} = {}) {
  let cadence = [];
  let pending = [];
  let intervalsHeld = 0;
  let cadenceChanges = 0;
  let lastRenderIntervalMs = 0;
  let variableFrameRate = false;
  let timeUntilMaxDriftMs = 0;

  function adopt(next, nextTimeUntilMaxDriftMs) {
    cadence = next;
    timeUntilMaxDriftMs = nextTimeUntilMaxDriftMs;
    cadenceChanges += 1;
  }

  function updateCadenceEstimate({ renderIntervalMs, frameDurationMs, deviationMs, maxAcceptableDriftMs }) {
    const renderIntervalChanged = lastRenderIntervalMs > 0
      && Math.abs(lastRenderIntervalMs - renderIntervalMs) > lastRenderIntervalMs * 0.1;
    lastRenderIntervalMs = renderIntervalMs;

    if (deviationMs > VARIABLE_FPS_FACTOR * renderIntervalMs) variableFrameRate = true;
    else if (deviationMs < CONSTANT_FPS_FACTOR * renderIntervalMs) variableFrameRate = false;

    if (variableFrameRate || frameDurationMs > 100) {
      intervalsHeld = 0;
      if (cadence.length > 0) { cadence = []; timeUntilMaxDriftMs = 0; return true; }
      return false;
    }

    const next = calculateCadence({ renderIntervalMs, frameDurationMs, maxAcceptableDriftMs, minimumTimeUntilMaxDriftMs });
    if (renderIntervalChanged && !same(next.cadence, cadence)) { adopt(next.cadence, next.timeUntilMaxDriftMs); return true; }
    if (same(next.cadence, cadence)) { intervalsHeld = 0; return false; }

    let updatePending = true;
    if (same(next.cadence, pending) || hysteresisMs <= renderIntervalMs) {
      intervalsHeld += 1;
      if (intervalsHeld * renderIntervalMs >= hysteresisMs) { adopt(next.cadence, next.timeUntilMaxDriftMs); return true; }
      updatePending = false;
    }
    if (updatePending) { pending = next.cadence; intervalsHeld = 1; }
    return false;
  }

  return {
    updateCadenceEstimate,
    hasCadence: () => cadence.length > 0,
    /** `GetCadenceForFrame` — the caller's frame counter modulo the pattern. */
    getCadenceForFrame: (frameNumber) => cadence[frameNumber % cadence.length],
    reset() { cadence = []; pending = []; intervalsHeld = 0; cadenceChanges = 0; },
    get cadence() { return [...cadence]; },
    get pending() { return [...pending]; },
    get intervalsHeld() { return intervalsHeld; },
    get cadenceChanges() { return cadenceChanges; },
    get timeUntilMaxDriftMs() { return timeUntilMaxDriftMs; },
    get isVariableFrameRate() { return variableFrameRate; },
  };
}
