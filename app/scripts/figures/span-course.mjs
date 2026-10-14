import { parseRate } from '../../harness/apply-qdisc.mjs';
import { figuresForWindows, linkUtilisation, spansFor } from './qa-recompute.mjs';
import { tagsOf, finite } from './peer-evidence.mjs';
import { computeHeldAhead } from './held-ahead.mjs';
import { presentedFrameRealtimeFactorByClient, trapCohorts, peerFractionForCohorts } from './trap-figures.mjs';

const SPAN_MS = 30_000;

function sourceSpans(input) {
  const tags = tagsOf(input);
  const ready = Number(input.window?.clientsReadyAtMs);
  const firstTag = tags[0];
  const clients = { ...input.clients };
  if (finite(ready) && firstTag) {
    clients[firstTag] = {
      ...clients[firstTag],
      peerRecords: [{ kind: 'attempt', startMs: ready }, ...(clients[firstTag]?.peerRecords ?? [])],
    };
  }
  const base = spansFor({ ...input, clients });
  const start = finite(ready) ? ready : base[0]?.startMs;
  const end = Number(input.window?.endMs);
  if (!finite(start) || !finite(end) || !(end > start)) return [];
  const spans = [];
  for (let cursor = start; cursor < end; cursor += SPAN_MS) {
    spans.push({ startMs: cursor, endMs: Math.min(cursor + SPAN_MS, end) });
  }
  return spans;
}

function capacity(input) {
  return input.capacityBitsPerSecond ?? input.condition?.capacityBitsPerSecond
    ?? input.condition?.capacityMbps * 1_000_000;
}

function weightedUtilisation(input, window) {
  const step = input.capacityStep ?? input.context?.capacityStep;
  if (!step) return linkUtilisation(input.linkSamples, [window], capacity(input));
  const before = Number(step.before?.rate?.got ?? capacity(input));
  const after = Number(step.readBack?.rate?.got ?? parseRate(step.declared?.params?.rate));
  const changeAt = Number(step.readBackAtMs);
  if (![before, after, changeAt].every(finite) || before <= 0 || after <= 0) return null;
  const pieces = [
    { startMs: window.startMs, endMs: Math.min(window.endMs, changeAt), cap: before },
    { startMs: Math.max(window.startMs, changeAt), endMs: window.endMs, cap: after },
  ].filter((piece) => piece.endMs > piece.startMs);
  const values = pieces.map((piece) => ({
    durationMs: piece.endMs - piece.startMs,
    cap: piece.cap,
    value: linkUtilisation(input.linkSamples, [piece], piece.cap),
  }));
  if (values.some((piece) => !finite(piece.value))) return null;
  const denominator = values.reduce((sum, piece) => sum + piece.durationMs * piece.cap, 0);
  const numerator = values.reduce((sum, piece) => sum + piece.value * piece.durationMs * piece.cap, 0);
  return denominator > 0 ? numerator / denominator : null;
}

function spanFigure(input, window) {
  const tags = tagsOf(input);
  const windows = Object.fromEntries(tags.map((tag) => [tag, window]));
  try { figuresForWindows(input, windows, true); } catch (error) {
    if (!input.seek) throw error;
  }
  const filterAfterEffective = finite(Number(input.seek?.effectiveSharedMs ?? input.seek?.host?.atSharedMs))
    && window.endMs > Number(input.seek?.effectiveSharedMs ?? input.seek?.host?.atSharedMs);
  const cohort = trapCohorts(input, { window, filterAfterEffective });
  const peer = peerFractionForCohorts(input, cohort.cohorts);
  const held = computeHeldAhead({ input, window, segmentSeconds: input.segmentSeconds });
  return {
    window,
    lengthMs: window.endMs - window.startMs,
    partial: window.endMs - window.startMs < SPAN_MS,
    peerFractionAggregate: peer.aggregate,
    peerFractionByClient: peer.byClient,
    preLandingSegmentsByClient: cohort.preLandingSegmentsByClient,
    heldAheadMsRoomMedian: held?.heldAheadMsRoomMedian ?? null,
    positionSpreadMsMedian: held?.positionSpreadMsMedian ?? null,
    presentedFrameRealtimeFactorByClient: presentedFrameRealtimeFactorByClient(input, window),
    uplinkUtilisationMean: weightedUtilisation(input, window),
  };
}

export function computeSpanCourse(input = {}) {
  return {
    label: 'diagnostic-undeclared-spans',
    spans: sourceSpans(input).map((window) => spanFigure(input, window)),
  };
}

export { weightedUtilisation };
