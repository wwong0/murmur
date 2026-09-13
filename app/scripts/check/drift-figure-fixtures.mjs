// scripts/check/drift-figure-fixtures.mjs
//
// The manufactured controller evaluations and measurement records the drift
// figure suites share.
//
// They were local to `suites/drift-figures.mjs` while it was the only caller.
// The browser-evidence suite needs the same two shapes — a published controller
// evaluation and a frame record — and a second copy of them is a second place
// for the shape to drift away from what the page actually publishes.
//
// TEST MACHINERY — under scripts/. Pure builders: no clock, no randomness, no
// filesystem. Every record here is exactly linear, so a fit over one recovers
// the rate it was built with and any residual is the arithmetic under test.

/** Drift records carrying only a sequence number and a drift, for span figures. */
export const recordSeries = (values, startSeq = 1) => values.map((driftMs, index) => ({ seq: startSeq + index, driftMs }));

/** One published controller evaluation, in the shape the seam reports it. */
export const sample = (overrides = {}) => ({
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

export const actingSamples = (count, overrides = {}) => Array.from({ length: count }, (_, index) => sample({ atMs: index * 125, polls: index + 1, ...overrides }));

export const settledSamples = (polls, overrides = {}) => polls.map((pollsValue, index) => sample({
  atMs: index * 125,
  mode: 'settled',
  reason: 'held',
  polls: pollsValue,
  ...overrides,
}));

/** One frame record on an exact line: media = rate·local + intercept. */
export const measurementRecord = ({ localMs, offsetMs = 0, rate = 1.001, interceptMs = 7, epochMs = 1 }) => {
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

/** A line with a bounded sawtooth on it, for slope standard errors. */
export const noisyPoints = (rate, count = 120, stepMs = 50) => Array.from({ length: count }, (_, index) => ({
  x: index * stepMs,
  y: rate * index * stepMs + ((index % 7) - 3) * 0.2,
}));

/** One steady command held across consecutive polls. */
export const stableSamples = (count, overrides = {}) => Array.from({ length: count }, (_, index) => sample({
  atMs: index * 250,
  polls: index + 1,
  rate: 1.0008,
  estimateMs: 4,
  ...overrides,
}));
