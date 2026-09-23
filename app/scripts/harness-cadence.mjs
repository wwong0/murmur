// What display cadence a headless container actually has (design.md D6).
//
// rAF is the cadence reading and rVFC is not: rAF follows the compositor's
// begin-frame source whether or not a video is playing, while rVFC is bounded
// below by the content's 24fps and would report the content's rate as the
// display's. Both are collected; only rAF classifies.

import { median, percentile } from '../public/lib/frame-drift.mjs';

export const RAF_SAMPLES = 600;
export const RVFC_SAMPLES = 600;
export const CEILING_MS = 30_000;

// Half a vsync at 180Hz is 2.78ms, so a band below 1.0ms cannot be a sawtooth:
// it is one value with jitter, which is what "a cadence" means here.
export const DISPERSION_MAX_MS = 1.0;

export const SIXTY_HZ_INTERVAL_MS = 1000 / 60;
const ROUND_INTERVALS = [1000 / 60, 1000 / 120, 1000 / 30];
const ROUND_TOLERANCE_MS = 0.05;

export function intervalsOf(timestamps) {
  const values = [];
  for (let index = 1; index < timestamps.length; index++) {
    const gap = timestamps[index] - timestamps[index - 1];
    if (Number.isFinite(gap)) values.push(gap);
  }
  return values;
}

export function describeIntervals(timestamps) {
  const values = intervalsOf(timestamps);
  const sorted = [...values].sort((left, right) => left - right);
  const rounded = new Set(values.map((value) => Math.round(value)));
  return {
    callbacks: timestamps.length,
    intervals: values.length,
    p5: values.length ? percentile(sorted, 0.05) : null,
    p50: values.length ? median(sorted) : null,
    p95: values.length ? percentile(sorted, 0.95) : null,
    min: values.length ? sorted[0] : null,
    max: values.length ? sorted[sorted.length - 1] : null,
    mean: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    dispersionMs: values.length ? percentile(sorted, 0.95) - percentile(sorted, 0.05) : null,
    distinctRoundedIntervals: rounded.size,
  };
}

const isRound = (value) => ROUND_INTERVALS.some((candidate) => Math.abs(value - candidate) <= ROUND_TOLERANCE_MS);

/**
 * Assert the shape the probe returned before deriving anything from it. Change
 * 4c lost a whole hardware question to a probe whose closing parenthesis made
 * it return a function: every figure printed `null` and nothing threw
 * (CONSTRAINTS.md -> Verification).
 */
export function assertProbeShape(raw, tag) {
  if (!raw || typeof raw !== 'object') throw new Error(`cadence probe for ${tag} returned ${typeof raw}, not an object`);
  for (const field of ['rafTimestamps', 'rvfcDisplayTimes']) {
    if (!Array.isArray(raw[field])) throw new Error(`cadence probe for ${tag} returned no ${field} array`);
  }
  if (raw.rafTimestamps.length > 1 && !Number.isFinite(raw.rafTimestamps[1] - raw.rafTimestamps[0])) {
    throw new Error(`cadence probe for ${tag} returned non-finite rAF timestamps`);
  }
  return raw;
}

/**
 * `none` is the answer that stops the change and goes to the owner as OQ2, so
 * it carries the reason it was reached: too few callbacks, no video callbacks
 * at all, or intervals too dispersed to be one cadence.
 */
export function classifyCadence({ raf, rvfc }) {
  const reasons = [];
  if (raf.callbacks < RAF_SAMPLES) reasons.push(`only ${raf.callbacks} rAF callbacks in ${CEILING_MS}ms`);
  if (rvfc.callbacks === 0) reasons.push('no rVFC callbacks');
  if (raf.dispersionMs === null || raf.dispersionMs >= DISPERSION_MAX_MS) {
    reasons.push(`rAF p95-p5 is ${raf.dispersionMs === null ? 'unavailable' : raf.dispersionMs.toFixed(3)}ms, not below ${DISPERSION_MAX_MS}ms`);
  }
  if (reasons.length) {
    return { classification: 'none', reasons, presentIntervalMs: raf.p50, impliedHz: null, dispersionMs: raf.dispersionMs, optimismVsSixtyHzMs: null };
  }
  return {
    classification: isRound(raf.p50) ? 'synthetic-fixed' : 'real-display',
    reasons,
    presentIntervalMs: raf.p50,
    impliedHz: 1000 / raf.p50,
    dispersionMs: raf.dispersionMs,
    optimismVsSixtyHzMs: Math.max(0, SIXTY_HZ_INTERVAL_MS - raf.p50),
  };
}

export function cadenceExpression({ rafSamples = RAF_SAMPLES, rvfcSamples = RVFC_SAMPLES, ceilingMs = CEILING_MS } = {}) {
  return `(async () => {
    const raf = [];
    const rvfc = [];
    const video = document.querySelector('video');
    const until = performance.now() + ${ceilingMs};
    let rvfcDone = !video || typeof video.requestVideoFrameCallback !== 'function';
    let rafDone = false;
    const step = (now) => {
      raf.push(now);
      rafDone = raf.length >= ${rafSamples};
      if (!rafDone && performance.now() < until) requestAnimationFrame(step);
    };
    const frame = (now, metadata) => {
      rvfc.push({ expectedDisplayTime: metadata.expectedDisplayTime, presentedFrames: metadata.presentedFrames, now });
      rvfcDone = rvfc.length >= ${rvfcSamples};
      if (!rvfcDone && performance.now() < until) video.requestVideoFrameCallback(frame);
    };
    requestAnimationFrame(step);
    if (!rvfcDone) video.requestVideoFrameCallback(frame);
    while (performance.now() < until && !(rafDone && rvfcDone)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      rafTimestamps: raf,
      rvfcDisplayTimes: rvfc.map((entry) => entry.expectedDisplayTime),
      rvfcPresentedFrames: rvfc.length ? rvfc[rvfc.length - 1].presentedFrames : null,
      hasVideo: Boolean(video),
      hasRvfc: Boolean(video && typeof video.requestVideoFrameCallback === 'function'),
      elapsedMs: ${ceilingMs} - (until - performance.now()),
      timeOriginMs: performance.timeOrigin
    };
  })()`;
}

export function cadenceRecord(raw, tag) {
  assertProbeShape(raw, tag);
  const raf = describeIntervals(raw.rafTimestamps);
  const rvfc = describeIntervals(raw.rvfcDisplayTimes);
  return {
    tag,
    ...classifyCadence({ raf, rvfc }),
    raf,
    rvfc,
    hasVideo: raw.hasVideo,
    hasRvfc: raw.hasRvfc,
    elapsedMs: raw.elapsedMs,
    rvfcPresentedFrames: raw.rvfcPresentedFrames,
    measuredAt: new Date().toISOString(),
  };
}

/** One record per client, in the manifest, beside every figure the run publishes. */
export async function establishCadence(sessions, options = {}) {
  const records = {};
  const collected = await Promise.all(sessions.map(async (session) => [
    session.tag,
    await session.tab.evaluate(cadenceExpression(options)),
  ]));
  for (const [tag, raw] of collected) records[tag] = cadenceRecord(raw, tag);
  return records;
}
