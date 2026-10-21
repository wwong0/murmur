// The cap used over a declared harness-clock window: bytes the host handed out
// over bytes its pace allowed (design.md D2). Pure. The pace in force is not
// stored, so the host's own estimate and probe plan are replayed over the
// interval records; a replay that disagrees with the recorded flags reads no value.

import { MAX_PACE_EVIDENCE_GAP_MS, paceBoundFraction } from './pace-bound.mjs';
import { PROBE_AFTER_INTERVALS, PROBE_FACTOR } from '../../public/lib/host-pace.mjs';
import { createCapacityEstimate, createProbePlan } from '../../public/lib/capacity-estimate.mjs';
import { ECHO_MARGIN_MS } from '../../public/lib/echo-delay.mjs';

const finite = (value) => Number.isFinite(value);

function validate({ intervals, window, wallOffsetMs }) {
  if (!Array.isArray(intervals)) throw new TypeError('pace-bound: intervals must be an array');
  paceBoundFraction({
    intervals: intervals.map((interval) => ({ ...interval, paceBoundMs: 0 })),
    window,
    wallOffsetMs,
  });
}

// A record missing a field the replay reads is missing evidence: a default would
// replay a host that never existed (CONSTRAINTS.md → A null is never zero).
function replayable(record) {
  const nullable = (value) => value === null || finite(value);
  return finite(record.handedBytes) && nullable(record.wireBytes) && nullable(record.readingBytesPerSecond)
    && [record.probe, record.linkBound, record.raised, record.climbing].every((flag) => typeof flag === 'boolean');
}

function spansFor(intervals, wallOffsetMs) {
  return intervals.map((record, index) => {
    const endMs = record.endWallMs - wallOffsetMs;
    return { record, index, startMs: endMs - record.durationMs, endMs };
  });
}

function coverage(spans, window) {
  const windowMs = window.endMs - window.startMs;
  if (spans.length === 0) return { complete: false, coveredMs: 0, lastOverlapIndex: -1 };
  const ordered = [...spans].sort((left, right) => left.startMs - right.startMs);
  const firstStartMs = Math.min(...ordered.map((span) => span.startMs));
  const lastEndMs = Math.max(...ordered.map((span) => span.endMs));
  if (firstStartMs > window.startMs || lastEndMs < window.endMs) {
    return { complete: false, coveredMs: 0, lastOverlapIndex: -1 };
  }
  let coveredMs = 0;
  let coveredEndMs = window.startMs;
  let lastOverlapIndex = -1;
  for (const span of ordered) {
    const overlapStartMs = Math.max(span.startMs, window.startMs);
    const overlapEndMs = Math.min(span.endMs, window.endMs);
    if (overlapEndMs <= overlapStartMs) continue;
    if (overlapStartMs - coveredEndMs > MAX_PACE_EVIDENCE_GAP_MS) {
      return { complete: false, coveredMs, lastOverlapIndex };
    }
    if (overlapEndMs > coveredEndMs) {
      coveredMs += overlapEndMs - Math.max(overlapStartMs, coveredEndMs);
      coveredEndMs = overlapEndMs;
    }
    lastOverlapIndex = Math.max(lastOverlapIndex, span.index);
  }
  if (window.endMs - coveredEndMs > MAX_PACE_EVIDENCE_GAP_MS) {
    return { complete: false, coveredMs, lastOverlapIndex };
  }
  return { complete: true, coveredMs, lastOverlapIndex, windowMs };
}

function replay(intervals) {
  const estimate = createCapacityEstimate({});
  const restartOnRaise = intervals.every((record) => 'estimateBytesPerSecond' in record);
  const plan = createProbePlan({ after: PROBE_AFTER_INTERVALS, factor: PROBE_FACTOR, marginMs: ECHO_MARGIN_MS, restartOnRaise });
  const steps = [];
  for (const record of intervals) {
    const inForce = estimate.read().bytesPerSecond;
    if (record.readingBytesPerSecond !== null) {
      estimate.record({ wireBytes: record.readingBytesPerSecond, durationMs: 1000, linkBound: true });
    }
    const wireBytes = record.wireBytes;
    const rate = wireBytes === null ? null : wireBytes * 1000 / record.durationMs;
    const step = plan.close({
      probe: record.probe,
      linkBound: record.linkBound,
      reason: record.reason,
      rate,
      headQueueMs: record.headQueueMs,
      tailQueueMs: record.tailQueueMs,
    }, estimate.read().bytesPerSecond);
    if (step.raiseTo !== null) estimate.raise(step.raiseTo);
    steps.push({ inForce, mismatch: (step.raiseTo !== null) !== record.raised || step.climbing !== record.climbing });
  }
  return { estimate, steps };
}

function result(reason, values) {
  return { ...values, value: null, reason };
}

export function capUsed({ intervals, window, wallOffsetMs, fraction, finalEstimateBytesPerSecond } = {}) {
  validate({ intervals, window, wallOffsetMs });
  if (!finite(fraction) || fraction <= 0 || fraction > 1) {
    throw new RangeError('cap-used: fraction must be finite and in (0, 1]');
  }
  const windowMs = window.endMs - window.startMs;
  const spans = spansFor(intervals, wallOffsetMs);
  const covered = coverage(spans, window);
  const values = { handedBytes: 0, allowedBytes: 0, coveredMs: covered.coveredMs, windowMs, unpacedMs: 0 };
  const sequential = intervals.length > 0 && intervals.every((record, index) => record.seq === index + 1);
  if (!sequential || !covered.complete || !intervals.every(replayable)) return result('pace-evidence-incomplete', values);

  const { estimate, steps } = replay(intervals);
  const replayMismatch = steps.slice(0, covered.lastOverlapIndex + 1).some((step) => step.mismatch);
  const finalMismatch = finite(finalEstimateBytesPerSecond)
    && finalEstimateBytesPerSecond !== estimate.read().bytesPerSecond;
  if (replayMismatch || finalMismatch) return result('pace-replay-mismatch', values);

  for (const span of spans) {
    const overlapMs = Math.max(0, Math.min(span.endMs, window.endMs) - Math.max(span.startMs, window.startMs));
    if (overlapMs === 0) continue;
    const step = steps[span.index];
    const share = overlapMs / span.record.durationMs;
    values.handedBytes += span.record.handedBytes * share;
    if (step.inForce === null) {
      values.unpacedMs += overlapMs;
      continue;
    }
    const factor = span.record.probe ? PROBE_FACTOR : fraction;
    values.allowedBytes += factor * step.inForce * span.record.durationMs / 1000 * share;
  }
  if (values.unpacedMs > 0) return result('pace-not-in-force', values);
  if (!(values.allowedBytes > 0)) return result('pace-allowed-zero', values);
  return { ...values, value: values.handedBytes / values.allowedBytes, reason: null };
}
