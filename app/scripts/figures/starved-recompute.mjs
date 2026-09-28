import { computePeerChecks } from './peer-checks.mjs';
import { computePeerFigures } from './peer-figures.mjs';
import { presentedFrameRealtimeFactorByClient } from './trap-figures.mjs';

const CORE_TAGS = ['c01', 'c02', 'c03', 'c04'];
const APART_TAG = 'c05';

function subset(input, tags) {
  return {
    ...input,
    declaredClientTags: tags,
    clientTags: tags,
    clients: Object.fromEntries(tags.map((tag) => [tag, input.clients?.[tag]])),
  };
}

function requireTags(input) {
  const tags = input.declaredClientTags ?? input.clientTags ?? Object.keys(input.clients ?? {});
  if (!CORE_TAGS.every((tag) => tags.includes(tag)) || !tags.includes(APART_TAG)) {
    throw new Error('starved-recompute-requires-c01-through-c05');
  }
  return tags;
}

function checksFor(input) {
  return computePeerChecks(input, input.condition?.bars ?? {});
}

function apartFigures(figures, frameRealtime) {
  return {
    peerFraction: figures.peerFractionByClient?.[APART_TAG] ?? null,
    realtimeFactor: frameRealtime[APART_TAG] ?? null,
    presentedFrameRealtimeFactor: frameRealtime[APART_TAG] ?? null,
    heldAheadMsMedian: figures.heldAheadMsMedianByClient?.[APART_TAG] ?? null,
  };
}

export function recomputeStarvedRun({ input = {}, directory = null } = {}) {
  const tags = requireTags(input);
  const all = { ...input, declaredClientTags: tags, clientTags: tags,
    multiplierDenominator: 'distinct-completed' };
  const checks = checksFor(all);
  const included = subset(all, CORE_TAGS);
  const coreFigures = computePeerFigures(included);
  const allFigures = computePeerFigures(all);
  const frameRealtime = presentedFrameRealtimeFactorByClient(all, all.window);
  const figures = {
    includedClientTags: CORE_TAGS,
    apartClientTags: [APART_TAG],
    peerFractionByClient: Object.fromEntries(CORE_TAGS.map((tag) => [tag,
      coreFigures.peerFractionByClient?.[tag] ?? null])),
    peerFractionAggregate: coreFigures.peerFractionAggregate ?? null,
    realtimeFactorByClient: Object.fromEntries(tags.map((tag) => [tag, frameRealtime[tag] ?? null])),
    presentedFrameRealtimeFactorByClient: Object.fromEntries(tags.map((tag) => [tag, frameRealtime[tag] ?? null])),
    heldAheadMsMedianByClient: Object.fromEntries(tags.map((tag) => [tag,
      allFigures.heldAheadMsMedianByClient?.[tag] ?? null])),
    heldAheadMsRoomMedian: coreFigures.heldAheadMsRoomMedian ?? null,
    positionSpreadMsMedian: coreFigures.positionSpreadMsMedian ?? null,
    c05: apartFigures(allFigures, frameRealtime),
  };
  return {
    ...(directory ? { directory } : {}),
    label: 'diagnostic-of-refused-runs',
    criterion: false,
    window: input.window,
    checks,
    checkResults: Object.fromEntries(checks.map((check) => [check.check, {
      passed: check.passed,
      failures: check.failures,
      exercised: check.exercised,
    }])),
    figures,
    allViewerPeerFractionAggregate: allFigures.peerFractionAggregate ?? null,
    allViewerPeerFractionByClient: allFigures.peerFractionByClient ?? {},
  };
}

export function recomputeStarvedReport(runs = []) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('starved-recompute-runs-unavailable');
  return {
    diagnostic: 'diagnostic-of-refused-runs',
    criterion: false,
    method: 'starved-refused-run-recompute-v1',
    runs: runs.map((run) => recomputeStarvedRun(run)),
  };
}

export { CORE_TAGS, APART_TAG };
