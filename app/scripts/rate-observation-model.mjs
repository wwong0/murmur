import assert from 'node:assert/strict';

// Conditional PCM/pitch-preserving path, not an observed device configuration
// or a WSOLA waveform simulation.
export function audioPassthroughHypothesis(ppm, sampleRate = 48000, preservesPitch = true) {
  const rate = 1 + ppm / 1e6;
  assert(Number.isFinite(rate) && rate > 0 && Number.isSafeInteger(sampleRate) && sampleRate >= 100);
  const samples = Math.floor(sampleRate * 0.02), windowSamples = samples + samples % 2;
  const bypass = Math.ceil(windowSamples / rate) >= windowSamples && Math.ceil(windowSamples * rate) >= windowSamples;
  const mode = !preservesPitch ? 'resampler' : bypass ? 'passthrough' : 'wsola';
  return { ppm, sampleRate, preservesPitch, windowSamples, mode, passthroughRate: mode === 'passthrough' ? 1 : null,
    lowerOpenRate: (windowSamples - 1) / windowSamples, upperOpenRate: windowSamples / (windowSamples - 1) };
}

const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { count: values.length, min: sorted[0], max: sorted.at(-1),
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
};

// Linear interpolation is descriptive; a 250 ms gap cap is not a bound on
// unobserved media-clock curvature or callback/presentation error.
export function interpolate(points, at, maxGap = 250) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].t < at) lo = mid + 1; else hi = mid; }
  const right = points[lo];
  if (right?.t === at) return { value: right.value, gapMs: 0 };
  const left = points[lo - 1];
  if (!left || !right || right.t - left.t > maxGap) return null;
  return { value: left.value + (right.value - left.value) * ((at - left.t) / (right.t - left.t)), gapMs: right.t - left.t };
}

// Ideal steady-input arithmetic from the pinned cadence estimator. Not a
// renderer simulation: excludes its moving averages, startup and frame queue.
export function cadenceHypothesis(ppm, fps = 24, hz = 180) {
  const rate = 1 + ppm / 1e6, frameMs = 1000 / fps / rate, gridMs = 1000 / hz;
  const driftMs = Math.min(125, Math.max(1000 / 60, frameMs / 2));
  const perfect = frameMs / gridMs, ratio = driftMs / 8000;
  const lower = perfect / (1 + ratio), upper = perfect / (1 - ratio);
  let best = null;
  for (let n = 1; n <= 5; n++) {
    if (Math.floor(lower * n) >= Math.floor(upper * n)) continue;
    const k = Math.round(perfect * n), error = Math.abs(1 - perfect * n / k);
    if (!best || error < best.error * 0.99) best = { k, n, error };
  }
  if (!best) {
    const k = Math.max(1, Math.round(perfect)), error = Math.abs(1 - perfect / k);
    if (driftMs / error >= 8000) best = { k, n: 1, error };
  }
  return { ppm, fps, hz, frameMs, driftMs, pattern: best
    ? Array.from({ length: best.n }, (_, i) => Math.round((i + 1) * best.k / best.n) - Math.round(i * best.k / best.n)) : null,
  timeUntilMaxDriftMs: best && best.error > 0 ? driftMs / best.error : null,
  zeroMismatch: best?.error === 0 };
}

export function windowDescription(segment, population, captures) {
  const origin = segment.trimmedStartMs, span = population === 'early-17s' ? 17000 : segment.trimmedSpanMs;
  const frames = segment.frames.map(frame => ({ ...frame, t: (frame.displaySharedMs - origin) - frame.clock.offsetMs }))
    .filter(frame => frame.t >= 0 && frame.t <= span);
  const points = captures.map(capture => ({ t: capture.pair?.readAtMs - origin, value: capture.pair?.currentTimeMs }))
    .filter(point => Number.isFinite(point.t) && Number.isFinite(point.value));
  assert(points.every((point, index) => index === 0 || point.t > points[index - 1].t), 'native read times must increase');
  const phase = frames.map(frame => { const value = interpolate(points, frame.t); return value
    ? { seq: frame.seq, relativeMs: frame.t, nativeMinusFrameMs: value.value - frame.mediaMs, gapMs: value.gapMs } : null; });
  const matched = phase.filter(Boolean), bins = {}, gridMs = 1000 / 180, residuals = [];
  let gapPairs = 0, previousBin = null, runEdges = 0, longest = { edges: 0, spanMs: 0 };
  for (let index = 1; index < frames.length; index++) {
    const left = frames[index - 1], right = frames[index];
    if (right.seq !== left.seq + 1 || right.presentedFrames !== left.presentedFrames + 1) {
      gapPairs++; previousBin = null; runEdges = 0; continue;
    }
    const dt = right.t - left.t, bin = Math.round(dt / gridMs);
    bins[bin] = (bins[bin] ?? 0) + 1; residuals.push(dt - bin * gridMs);
    if (bin === 7 || bin === 8) runEdges = previousBin !== null && previousBin !== bin ? runEdges + 1 : 1;
    else runEdges = 0;
    previousBin = runEdges ? bin : null;
    if (runEdges > longest.edges) longest = { edges: runEdges, spanMs: right.t - frames[index - runEdges].t,
      firstSeq: frames[index - runEdges].seq, lastSeq: right.seq };
  }
  return { repeat: segment.repeat, label: segment.label, population, commandPpm: segment.ppm, spanMs: span,
    frameCount: frames.length, interpolatedCount: matched.length, unmatchedCount: frames.length - matched.length,
    phaseMs: stats(matched.map(row => row.nativeMinusFrameMs)), firstPhase: phase[0], lastPhase: phase.at(-1),
    phaseAdvanceMs: phase[0] && phase.at(-1) ? phase.at(-1).nativeMinusFrameMs - phase[0].nativeMinusFrameMs : null,
    interpolationGapMs: stats(matched.map(row => row.gapMs)), nominal180HzStepBins: bins, gapPairs,
    nominalGridResidualMs: stats(residuals), longestAlternating7And8: longest };
}
