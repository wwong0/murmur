// scripts/check/mechanism-presentation.mjs
//
// The stateful presentation stage: `VideoRendererAlgorithm` from pinned Chromium
// 152.0.7977.76 revision 0d89dfa2dd7c1ec4b8a14b9f303f887bb63b6174,
// `media/filters/video_renderer_algorithm.cc`, with the compositor's own
// new-frame test from `third_party/blink/renderer/platform/media/
// video_frame_compositor.cc` (`ProcessNewFrame`, `SetCurrentFrame_Locked`).
//
// What a caller gets from `render(deadlineMin, deadlineMax)` is the frame the
// algorithm selected for THAT deadline interval, plus whether it differed from
// the frame already current — which is the only thing that increments
// `presentedFrames` and the only thing that fires a frame callback.
//
// Rules that survive any edit, each bought by a way this model could quietly
// stop being the mechanism it claims to represent:
//
//  - DRIFT IS MEASURED AGAINST THE FRAME'S WALL-CLOCK INTERVAL, not against a
//    PTS point. `CalculateAbsoluteDriftForFrame` is zero for any frame whose
//    [start, end] contains `deadline_min`, positive by the gap to the nearer
//    edge otherwise. Reducing it to |start - deadline| makes every frame drift
//    and destroys the mechanism under study.
//  - THE 8 SECOND HORIZON IS NOT A TIMER. Nothing in this file counts down to a
//    frame jump; the horizon only enters `calculateCadence`'s admissibility
//    test. A pattern is abandoned when accumulated drift exceeds
//    `maxAcceptableDriftMs` at a render, whenever that happens to be.
//  - A cadence override REPHASES: `cadence_frame_counter_` returns to zero and
//    every queued frame's ideal count is recomputed from the new phase.
//  - `average_frame_duration_` is a WALL duration and therefore already carries
//    the playback rate; the cadence estimator must never be handed a media one.
//
// EXCLUDED, and named again in mechanism-model-report.md: background rendering,
// `RemoveExpiredFrames` (the driver caps queue depth, so no frame survives to be
// expired), the decoder, `EffectiveFramesQueued`, out-of-order and
// sub-millisecond frame rejection, and `frame_dropping_disabled_`.
//
// TEST MACHINERY — under scripts/. Deterministic; the caller supplies deadlines.

import { createCadenceEstimator, createMovingAverageDeviation, MOVING_AVERAGE_SAMPLES } from './mechanism-cadence.mjs';

/** ATSC IS/191, the value `Reset()` starts from before any duration is known. */
export const DEFAULT_MAX_ACCEPTABLE_DRIFT_MS = 15;
/** `kAllowableJitter`, in ms. */
export const ALLOWABLE_COVERAGE_JITTER_MS = 0.5;

/**
 * @param {{wallClockTimeCb: (mediaMs: number[]) => {wallTimes: number[], isTimeMoving: boolean},
 *   cadenceParityOffset?: number, cadenceEnabled?: boolean}} config
 */
export function createRendererAlgorithm({ wallClockTimeCb, cadenceParityOffset = 0, cadenceEnabled = true }) {
  const estimator = createCadenceEstimator();
  const durations = createMovingAverageDeviation(MOVING_AVERAGE_SAMPLES);
  /** @type {{ptsMs: number, metadataDurationMs: number, startWallMs: number, endWallMs: number,
   *   hasEstimatedEndTime: boolean, idealRenderCount: number, renderCount: number, dropCount: number,
   *   id: number}[]} */
  let queue = [];
  let nextId = 1;
  let averageFrameDurationMs = 0;
  let deviationMs = 0;
  let maxAcceptableDriftMs = DEFAULT_MAX_ACCEPTABLE_DRIFT_MS;
  let renderIntervalMs = 0;
  let lastDeadlineMaxMs = null;
  let cadenceFrameCounter = 0;
  let wasTimeMoving = false;
  let haveRenderedFrames = false;
  let firstFrame = true;
  let cadenceEverEstablished = false;
  let framesDroppedDuringEnqueue = 0;
  const counters = { cadenceOverrides: 0, cadenceChanges: 0, framesDropped: 0, glitches: 0 };

  const hasCadence = () => cadenceEnabled && estimator.hasCadence();

  function updateCadenceForFrames() {
    for (let i = 0; i < queue.length; i++) {
      queue[i].idealRenderCount = hasCadence() ? estimator.getCadenceForFrame(cadenceFrameCounter + i) : 0;
    }
  }

  function enqueueFrame({ ptsMs, metadataDurationMs }) {
    const mediaTimestamps = [ptsMs];
    if (durations.count() === 0 && metadataDurationMs > 0) mediaTimestamps.push(ptsMs + metadataDurationMs);
    const { wallTimes } = wallClockTimeCb(mediaTimestamps);
    const frame = {
      ptsMs,
      metadataDurationMs,
      startWallMs: wallTimes[0],
      endWallMs: 0,
      hasEstimatedEndTime: true,
      idealRenderCount: 0,
      renderCount: 0,
      dropCount: 0,
      id: nextId++,
    };
    if (durations.count() > 0) frame.endWallMs = frame.startWallMs + averageFrameDurationMs;
    else if (wallTimes.length > 1) frame.endWallMs = wallTimes[1];
    queue.push(frame);
    queue.sort((a, b) => a.ptsMs - b.ptsMs);
    if (hasCadence()) updateCadenceForFrames();
    return frame;
  }

  function accountForMissedIntervals(deadlineMinMs) {
    if (lastDeadlineMaxMs === null || deadlineMinMs <= lastDeadlineMaxMs || !haveRenderedFrames
      || !wasTimeMoving || renderIntervalMs === 0) return;
    const renderCycleCount = Math.trunc((deadlineMinMs - lastDeadlineMaxMs) / renderIntervalMs);
    if (!renderCycleCount) return;
    const front = queue[0];
    if (!front.renderCount) return;
    if (front.renderCount === front.dropCount) front.dropCount += renderCycleCount;
    front.renderCount += renderCycleCount;
  }

  function updateFrameStatistics() {
    const mediaTimestamps = queue.map((frame) => frame.ptsMs);
    const last = queue.at(-1);
    const haveMetadataDuration = last.metadataDurationMs > 0;
    if (haveMetadataDuration) mediaTimestamps.push(last.ptsMs + last.metadataDurationMs);

    const converted = wallClockTimeCb(mediaTimestamps);
    wasTimeMoving = converted.isTimeMoving;
    const wallTimes = converted.wallTimes;

    // Never the last queued frame: its end time is always an estimate, so a
    // sample taken from it would be the estimate feeding its own average.
    for (let i = 0; i < queue.length - 1; i++) {
      const frame = queue[i];
      const newSample = frame.hasEstimatedEndTime;
      frame.startWallMs = wallTimes[i];
      frame.endWallMs = wallTimes[i + 1];
      frame.hasEstimatedEndTime = false;
      if (newSample) durations.addSample(frame.endWallMs - frame.startWallMs);
    }

    if (durations.count() > 0) {
      averageFrameDurationMs = durations.mean();
      deviationMs = durations.deviation();
    } else {
      deviationMs = 0;
    }

    if (haveMetadataDuration) {
      last.startWallMs = wallTimes[wallTimes.length - 2];
      last.endWallMs = wallTimes[wallTimes.length - 1];
      if (durations.count() === 0) {
        averageFrameDurationMs = last.endWallMs - last.startWallMs;
        if (averageFrameDurationMs === 0) return;
      }
    } else {
      last.startWallMs = wallTimes[wallTimes.length - 1];
      if (durations.count() === 0) return;
      last.endWallMs = last.startWallMs + averageFrameDurationMs;
    }

    maxAcceptableDriftMs = Math.min(125, Math.max(1000 / 60, averageFrameDurationMs / 2));
    if (renderIntervalMs === 0) return;

    const changed = estimator.updateCadenceEstimate({
      renderIntervalMs, frameDurationMs: averageFrameDurationMs, deviationMs, maxAcceptableDriftMs,
    });
    if (!changed) return;
    counters.cadenceChanges += 1;
    // The parity knob is a MODEL INPUT, applied once when a pattern is first
    // adopted: which phase the real estimator locks at is not recoverable from
    // any retained record, so both are swept rather than assumed.
    cadenceFrameCounter = cadenceEverEstablished ? 0 : cadenceParityOffset;
    if (estimator.hasCadence()) cadenceEverEstablished = true;
    updateCadenceForFrames();
  }

  /** Distance from the frame's mapped INTERVAL, zero inside it. */
  function absoluteDriftForFrame(deadlineMinMs, index) {
    const frame = queue[index];
    if (frame.endWallMs < deadlineMinMs) return deadlineMinMs - frame.endWallMs;
    if (frame.startWallMs > deadlineMinMs) return frame.startWallMs - deadlineMinMs;
    return 0;
  }

  function findBestFrameByCadence() {
    if (!hasCadence()) return -1;
    const front = queue[0];
    if (front.renderCount < front.idealRenderCount) return 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].idealRenderCount > 0) return i;
    return -1;
  }

  function findBestFrameByCoverage(deadlineMinMs, deadlineMaxMs) {
    let best = -1;
    let bestCoverage = 0;
    const coverage = new Array(queue.length).fill(0);
    for (let i = 0; i < queue.length; i++) {
      const frame = queue[i];
      if (frame.startWallMs > deadlineMaxMs) break;
      const endMs = Math.min(deadlineMaxMs, frame.endWallMs);
      if (endMs < deadlineMinMs) continue;
      coverage[i] = endMs - Math.max(deadlineMinMs, frame.startWallMs);
      if (coverage[i] > bestCoverage) { best = i; bestCoverage = coverage[i]; }
    }
    let secondBest = -1;
    if (best >= 0) {
      coverage[best] = 0;
      let most = 0;
      for (let i = 0; i < coverage.length; i++) if (coverage[i] > most) { most = coverage[i]; secondBest = i; }
      if (!(most > 0)) secondBest = -1;
    }
    // Two frames within half a millisecond of equal coverage: prefer the earlier.
    if (secondBest >= 0 && best > secondBest
      && Math.abs(bestCoverage - coverage[secondBest]) <= ALLOWABLE_COVERAGE_JITTER_MS) {
      const swap = best; best = secondBest; secondBest = swap;
    }
    return { best, secondBest };
  }

  function findBestFrameByDrift(deadlineMinMs) {
    let best = -1;
    let bestDrift = Infinity;
    // `<=` on purpose: the source prefers the LATEST frame at equal drift.
    for (let i = 0; i < queue.length; i++) {
      const drift = absoluteDriftForFrame(deadlineMinMs, i);
      if (drift <= bestDrift) { bestDrift = drift; best = i; }
    }
    return { best, drift: bestDrift };
  }

  /**
   * One `Render(deadline_min, deadline_max)`. Returns the selected frame and the
   * bookkeeping a caller needs to decide whether a callback is owed.
   */
  function render(deadlineMinMs, deadlineMaxMs) {
    if (queue.length === 0) return null;
    const framesDroppedThisRender = framesDroppedDuringEnqueue;
    framesDroppedDuringEnqueue = 0;
    haveRenderedFrames = true;
    renderIntervalMs = deadlineMaxMs - deadlineMinMs;
    accountForMissedIntervals(deadlineMinMs);
    updateFrameStatistics();

    if (!wasTimeMoving || !(averageFrameDurationMs > 0) || renderIntervalMs === 0) {
      queue[0].renderCount += 1;
      if (!wasTimeMoving) firstFrame = true;
      return { frame: queue[0], selection: 'held-no-time', drift: 0, framesDropped: framesDroppedThisRender };
    }

    lastDeadlineMaxMs = deadlineMaxMs;
    const cadenceFrame = findBestFrameByCadence();
    let frameToRender = cadenceFrame;
    let selectedDrift = 0;
    let selection = 'cadence';
    if (frameToRender >= 0) selectedDrift = absoluteDriftForFrame(deadlineMinMs, frameToRender);

    if (frameToRender < 0 || selectedDrift > maxAcceptableDriftMs) {
      const { best, secondBest } = findBestFrameByCoverage(deadlineMinMs, deadlineMaxMs);
      if (frameToRender === best && secondBest >= 0
        && absoluteDriftForFrame(deadlineMinMs, secondBest) <= selectedDrift) frameToRender = secondBest;
      else frameToRender = best;
      selection = 'coverage';
      if (frameToRender >= 0) selectedDrift = absoluteDriftForFrame(deadlineMinMs, frameToRender);
    }

    if (frameToRender < 0 || selectedDrift > maxAcceptableDriftMs) {
      const byDrift = findBestFrameByDrift(deadlineMinMs);
      frameToRender = byDrift.best;
      selectedDrift = byDrift.drift;
      selection = 'drift';
    }

    const ignoredCadenceFrame = cadenceFrame >= 0 && frameToRender !== cadenceFrame;
    if (ignoredCadenceFrame) counters.cadenceOverrides += 1;
    if (selectedDrift > maxAcceptableDriftMs) counters.glitches += 1;

    let dropped = 0;
    if (frameToRender > 0) {
      for (let i = 0; i < frameToRender; i++) {
        const frame = queue[i];
        if (frame.renderCount !== frame.dropCount) continue;
        if (hasCadence() && !frame.idealRenderCount) continue;
        dropped += 1;
      }
      counters.framesDropped += dropped;
      cadenceFrameCounter += frameToRender;
      queue = queue.slice(frameToRender);
    }

    if (firstFrame && frameToRender > 0) firstFrame = false;
    queue[0].renderCount += 1;
    if (ignoredCadenceFrame) { cadenceFrameCounter = 0; updateCadenceForFrames(); }

    return {
      frame: queue[0],
      selection,
      drift: selectedDrift,
      ignoredCadenceFrame,
      framesDropped: framesDroppedThisRender + dropped,
    };
  }

  return {
    enqueueFrame,
    render,
    get queue() { return queue.map((frame) => ({ ...frame })); },
    get queueLength() { return queue.length; },
    get averageFrameDurationMs() { return averageFrameDurationMs; },
    get deviationMs() { return deviationMs; },
    get maxAcceptableDriftMs() { return maxAcceptableDriftMs; },
    /** What the estimator holds. It keeps estimating with cadence selection off. */
    get cadenceEstimated() { return estimator.cadence; },
    /** What selection actually used — empty whenever cadence is disabled. */
    get cadenceInUse() { return hasCadence() ? estimator.cadence : []; },
    get cadenceFrameCounter() { return cadenceFrameCounter; },
    get timeUntilMaxDriftMs() { return estimator.timeUntilMaxDriftMs; },
    get counters() { return { ...counters }; },
    get lastPtsMs() { return queue.length ? queue[0].ptsMs : null; },
  };
}
