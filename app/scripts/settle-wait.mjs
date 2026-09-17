// scripts/settle-wait.mjs
//
// The second way a T5 window can be done (change 5 design.md D11): a scheduled
// start that lands inside the stopping threshold never needs a correction, so it
// never reaches `settled`. Pure — the samples are the T5 seam reads.

/** Why a sample cannot extend an in-sync run, or null when it can. */
function disqualified({ playback, controller }, rateEpsilon, minRecords) {
  if (playback?.resolved !== true || playback?.playing !== true) return 'not-playing-resolved';
  if (!controller || !Number.isFinite(controller.estimateMs)) return 'no-estimate';
  if (!(controller.windowRecords >= minRecords)) return 'too-few-records';
  if (controller.thresholdUsable !== true || !Number.isFinite(controller.stoppingThresholdMs)) return 'threshold-unusable';
  if (Math.abs(controller.estimateMs) > controller.stoppingThresholdMs) return 'outside-threshold';
  if (!(Math.abs(controller.rate - 1) <= rateEpsilon)) return 'rate-off-base';
  if (controller.correctionsApplied !== 0) return 'corrected';
  if (!Number.isFinite(controller.polls)) return 'no-polls';
  return null;
}

/**
 * @param {Array<{atMs: number, playback: object, controller: object}>} samples
 * @param {{minRecords: number, settledForMs: number, rateEpsilon: number}} bars
 * @returns {{done: boolean, since: number|null, reason: string|null}}
 */
export function inSyncWithoutCorrection(samples, { minRecords, settledForMs, rateEpsilon }) {
  let since = null;
  let spanEndMs = null;
  let lastPolls = null;
  let dropKey;
  let reason = 'no-samples';
  for (const sample of samples) {
    const nextDropKey = JSON.stringify(sample.controller?.lastDrop ?? null);
    const dropChanged = dropKey !== undefined && nextDropKey !== dropKey;
    dropKey = nextDropKey;
    const why = disqualified(sample, rateEpsilon, minRecords) ?? (dropChanged ? 'dropped' : null);
    if (why !== null) {
      since = null;
      reason = why;
      continue;
    }
    if (since === null) {
      since = sample.atMs;
      spanEndMs = sample.atMs;
      lastPolls = sample.controller.polls;
    } else if (sample.controller.polls > lastPolls) {
      // A stale read (the controller has not polled since) does not extend the span.
      spanEndMs = sample.atMs;
      lastPolls = sample.controller.polls;
    }
  }
  if (since === null) return { done: false, since: null, reason };
  const done = spanEndMs - since >= settledForMs;
  return { done, since, reason: done ? null : 'short' };
}
