// Publication and CSV boundaries for harness figures.

import { evaluateByteControl } from '../harness/byte-control.mjs';
import { armFor } from '../harness/arms.mjs';

const PUBLICATION = Symbol('published-figure');
const RECEIPT_COHORT_METHOD = 'client-receipt-cohort-v1';
const PEER_ATTEMPT_COHORT_METHOD = 'peer-attempt-cohort-v1';

const RECEIPT_COHORT_FIELDS = Object.freeze([
  ['hostUploadMultiplier', (value) => Number.isFinite(value) && value >= 0],
  ['distinctSegmentBytesConsumedInWindow', (value) => Number.isFinite(value) && value > 0],
  ['originSegmentBytesDeliveredInWindow', (value) => Number.isFinite(value) && value >= 0],
  ['distinctSegmentsCompletedInWindow', (value) => Number.isInteger(value) && value > 0],
]);

const BYTE_FIELDS = Object.freeze([
  'condition.name',
  'condition.capacityMbps',
  'window.startMs',
  'window.endMs',
  'window.startSnapshotAtMs',
  'window.endSnapshotAtMs',
  'originWasteFraction',
  'realtimeFactorByClient',
  'stallCountByClient',
  'content.identity',
  'content.frameRate',
]);

const PEER_TIME_FIELDS = Object.freeze([
  'heldAheadMsMedianByClient',
  'heldAheadMsRoomMedian',
  'positionSpreadMsMedian',
  'positionSpreadSecondsUsed',
  'positionUnavailableSecondsByClient',
]);

const PEER_BYTE_FIELDS = Object.freeze([
  'condition.name',
  'condition.capacityMbps',
  'window.startMs',
  'window.endMs',
  'window.startSnapshotAtMs',
  'window.endSnapshotAtMs',
  'byteAccountingMethod',
  'keptHostBytesByClient',
  'keptPeerBytesByClient',
  'peerFractionByClient',
  'peerFractionAggregate',
  'mediaBytesDeliveredInWindow',
  'distinctSegmentBytesInWindow',
  'distinctSegmentsCompletedInWindow',
  'hostUploadMultiplier',
  'hostWasteFraction',
  'hostWasteBytes',
  'hostExcusedResponses',
  'hostExcusedBytes',
  'hostDeliveredBytesSettledInWindow',
  'peerWasteBytesByClient',
  'realtimeFactorByClient',
  'stallCountByClient',
  'declaredOffsetMsByClient',
  'startLatenessMsByClient',
  'achievedSpacingMsByClient',
  'content.identity',
  'content.frameRate',
  ...PEER_TIME_FIELDS,
]);

const PEER_ONE_VIEWING_FIELDS = Object.freeze([
  ...PEER_BYTE_FIELDS.filter((field) => field !== 'hostUploadMultiplier'),
  'hostFetchOnceRatio',
  'oneViewingBytesInWindow',
  'multiplierDenominator',
  'peerFractionSteady',
  'steadyState',
  'roomPositionSpreadMs',
]);

export const HOST_ONE_VIEWING_FIELDS = Object.freeze([
  ...BYTE_FIELDS,
  'distinctSegmentBytesConsumedInWindow',
  'originSegmentBytesDeliveredInWindow',
  'distinctSegmentsCompletedInWindow',
  'oneViewingBytesInWindow',
  'multiplierDenominator',
  'steadyState',
  'roomPositionSpreadMs',
]);

export const PEER_TRAP_FIELDS = Object.freeze([
  ...PEER_BYTE_FIELDS.filter((field) => field !== 'hostUploadMultiplier'),
  'hostFetchOnceRatio',
  'multiplierDenominator',
  'peerFractionSteady',
  'hostUploadMultiplierRefusal',
  'trapLandingSegment',
  'preLandingSegmentsByClient',
  'presentedFrameRealtimeFactorByClient',
  'mediaAdvanceFactorByClient',
  'parkAdvanceMsByClient',
]);

export const DRIFT_FIELDS = Object.freeze([
  'condition.name',
  'condition.capacityMbps',
  'condition.runLengthMs',
  'window.startMs',
  'window.endMs',
  'window.excludedPrefixMs',
  'window.measureWindowMs',
  'content.frameRate',
  'uplinkUtilisationMean',
  'uplinkUtilisationPeak',
  'capacityBitsPerSecond',
  'qdiscBacklogBytesMean',
  'qdiscOverlimitsInWindow',
  'qdiscBacklogNonzeroFraction',
  'standingQueueDelayMsP50NearestRank',
  'standingQueueDelayMsP99',
  'clockHalfWidthMsP50ByClient',
  'clockHalfWidthMsP99ByClient',
  'clockDelayTermMsP50ByClient',
  'clockDelayTermMsP99ByClient',
  'clockAgeTermMsP50ByClient',
  'clockAgeTermMsP99ByClient',
  'controllerBandMsP50ByClient',
  'controllerBandMsP99ByClient',
  'controllerStoppingThresholdMsP50ByClient',
  'controllerStoppingThresholdMsP99ByClient',
  'thresholdUsableFractionByClient',
  'settlingByClient',
  'presentIntervalMsByClient',
  'cadenceClassificationByClient',
  'instrumentFloorMsP50',
  'instrumentFloorMsP99',
  'floorDelayTermMsP50',
  'floorDelayTermMsP99',
  'floorAgeTermMsP50',
  'floorAgeTermMsP99',
  'floorPresentIntervalMs',
  'pairwiseDriftAbsMsMedian',
  'pairwiseDriftAbsMsP99',
  'criterionVerdict',
  'realtimeFactorByClient',
  'droppedFrameFractionByClient',
  'evaluationSkipsByClient',
  'clockBestDelayMsP50ByClient',
  'clockBestDelayMsP95ByClient',
  'clockBestDelayMsP99ByClient',
  'echoRoundTripMsP50ByClient',
  'echoRoundTripMsP95ByClient',
  'echoRoundTripMsP99ByClient',
]);

export const REQUIRED_CONTEXT_FIELDS = Object.freeze({ byte: BYTE_FIELDS, drift: DRIFT_FIELDS,
  peerByte: PEER_BYTE_FIELDS });

function fieldsFor(kind, context = {}, figure = {}) {
  if (kind === 'byte' && (context.byteAccountingMethod ?? figure.byteAccountingMethod) === PEER_ATTEMPT_COHORT_METHOD) {
    const denominator = context.multiplierDenominator ?? figure.multiplierDenominator ?? 'distinct-completed';
    if (denominator === 'none-across-seek') return PEER_TRAP_FIELDS;
    return denominator === 'one-viewing' ? PEER_ONE_VIEWING_FIELDS : PEER_BYTE_FIELDS;
  }
  if (kind === 'byte' && (context.byteAccountingMethod ?? figure.byteAccountingMethod) === RECEIPT_COHORT_METHOD
    && (context.multiplierDenominator ?? figure.multiplierDenominator) === 'one-viewing') {
    return HOST_ONE_VIEWING_FIELDS;
  }
  if (kind === 'drift') {
    const condition = context.condition ?? figure.condition;
    return Object.freeze([...DRIFT_FIELDS, ...armFor(condition).driftRequiredFields]);
  }
  return REQUIRED_CONTEXT_FIELDS[kind] ?? [];
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function absent(value) {
  return value === undefined || value === null;
}

function finiteTree(value, path = '') {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const bad = finiteTree(value[index], `${path}[${index}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const bad = finiteTree(child, path ? `${path}.${key}` : key);
      if (bad) return bad;
    }
  }
  return null;
}

function declaredTags(context, figure) {
  return context.declaredClientTags
    ?? context.clientTags
    ?? context.condition?.clientTags
    ?? Object.keys(context.clients ?? figure.clients ?? figure.realtimeFactorByClient ?? {});
}

function lookup(path, context, figure) {
  const direct = getPath(context, path);
  if (!absent(direct)) return direct;
  return getPath(figure, path);
}

function missingField(path, context, figure) {
  if (path.endsWith('ByClient')) return null;
  const value = lookup(path, context, figure);
  return absent(value) ? path : null;
}

export function missingFields(kind, context, figure = {}) {
  const fields = fieldsFor(kind, context, figure);
  for (const field of fields) {
    const direct = missingField(field, context, figure);
    if (direct) return direct;
    if (field.endsWith('ByClient')) {
      const values = lookup(field, context, figure);
      for (const tag of declaredTags(context, figure)) {
        if (absent(values?.[tag])) return `${field}[${tag}]`;
      }
    }
    if (field === 'settlingByClient') {
      const values = lookup(field, context, figure);
      for (const tag of declaredTags(context, figure)) {
        const value = values?.[tag];
        if (!value || (value.settlingMs !== null && !Number.isFinite(value.settlingMs))
          || typeof value.mode !== 'string' || typeof value.thresholdUsable !== 'boolean') {
          return `${field}[${tag}]`;
        }
      }
    }
  }
  return null;
}

function settlingCorrectionCount(tag, context, figure, settling) {
  return settling?.correctionsApplied
    ?? context.correctionsAppliedByClient?.[tag]
    ?? figure.correctionsAppliedByClient?.[tag]
    ?? context.clients?.[tag]?.polls?.at(-1)?.controller?.correctionsApplied
    ?? figure.clients?.[tag]?.polls?.at(-1)?.controller?.correctionsApplied;
}

function settlingRefusal(context, figure) {
  const values = lookup('settlingByClient', context, figure);
  for (const tag of declaredTags(context, figure)) {
    const settling = values?.[tag];
    if (settling?.settlingMs === 0 && settlingCorrectionCount(tag, context, figure, settling) === 0) {
      return 'settling-zero-without-correction';
    }
  }
  return null;
}

function missingReceiptCohortField(figure, allowRefusedMultiplier = false) {
  for (const [field, valid] of RECEIPT_COHORT_FIELDS) {
    if (allowRefusedMultiplier && field === 'hostUploadMultiplier') continue;
    if (!valid(figure?.[field])) return field;
  }
  return null;
}

export function requiredContextFields(kind, context = {}) {
  const fields = [...fieldsFor(kind, context)];
  const tags = declaredTags(context, {});
  return fields.flatMap((field) => (field.endsWith('ByClient') ? tags.map((tag) => `${field}[${tag}]`) : [field]));
}

export function publish(kind, figure = {}, context = {}) {
  const missing = missingFields(kind, context, figure);
  if (missing) return { published: false, missing };
  if (kind === 'drift') {
    const settling = settlingRefusal(context, figure);
    if (settling) return { published: false, missing: settling };
  }
  const accountingMethod = context.byteAccountingMethod ?? figure.byteAccountingMethod;
  if (kind === 'byte' && accountingMethod === RECEIPT_COHORT_METHOD) {
    if (figure.byteAccountingMethod !== RECEIPT_COHORT_METHOD) return { published: false, missing: 'byteAccountingMethod' };
    for (const tag of declaredTags(context, figure)) {
      for (const field of ['peerByteFractionByClient', 'originVsClientBytesByClient']) {
        if (absent(figure[field]?.[tag])) return { published: false, missing: `${field}[${tag}]` };
      }
    }
    const denominator = context.multiplierDenominator ?? figure.multiplierDenominator;
    const missingReceiptField = missingReceiptCohortField(figure, denominator === 'one-viewing');
    if (missingReceiptField) return { published: false, missing: missingReceiptField };
  }
  if (kind === 'byte') {
    const accountingMethod = context.byteAccountingMethod ?? figure.byteAccountingMethod;
    const denominator = context.multiplierDenominator ?? figure.multiplierDenominator;
    if ((accountingMethod === PEER_ATTEMPT_COHORT_METHOD || accountingMethod === RECEIPT_COHORT_METHOD)
      && denominator === 'one-viewing') {
      const hasMultiplier = !absent(figure.hostUploadMultiplier);
      const hasRefusal = !absent(figure.hostUploadMultiplierRefusal);
      if (hasMultiplier === hasRefusal) {
        return { published: false, missing: 'hostUploadMultiplier-or-refusal' };
      }
    }
    if (accountingMethod === PEER_ATTEMPT_COHORT_METHOD && denominator === 'none-across-seek') {
      if (!absent(figure.hostUploadMultiplier)) {
        return { published: false, missing: 'hostUploadMultiplier-forbidden-in-trap' };
      }
      if (absent(figure.hostUploadMultiplierRefusal)) {
        return { published: false, missing: 'hostUploadMultiplierRefusal' };
      }
    }
    const reasons = evaluateByteControl({ bars: context.condition?.bars, tags: declaredTags(context, figure), figures: figure });
    if (reasons.length) return { published: false, missing: `${reasons[0].reason}:${reasons[0].tag}`, reasons };
  }
  const copy = structuredClone(figure);
  const bad = finiteTree(copy);
  if (bad) return { published: false, missing: `nonfinite:${bad}` };
  Object.defineProperty(copy, PUBLICATION, { value: true, enumerable: false });
  return copy;
}

export function isPublishedFigure(value) {
  return Boolean(value?.[PUBLICATION]);
}

export function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function requirePublished(figure) {
  if (!isPublishedFigure(figure)) throw new Error('CSV requires a published figure');
}

export function bytesByClientCsv(figure) {
  requirePublished(figure);
  if (figure.byteAccountingMethod === PEER_ATTEMPT_COHORT_METHOD) {
    const tags = Object.keys(figure.peerFractionByClient ?? {});
    const header = ['tag', 'keptHostBytes', 'keptPeerBytes', 'peerFraction', 'peerWasteBytes'];
    const rows = tags.map((tag) => [tag, figure.keptHostBytesByClient?.[tag], figure.keptPeerBytesByClient?.[tag],
      figure.peerFractionByClient?.[tag], figure.peerWasteBytesByClient?.[tag]]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  }
  const tags = Object.keys(figure.peerByteFractionByClient ?? {});
  const header = ['tag', 'originMediaBytes', 'clientReceivedMediaBytes', 'peerByteFraction', 'originVsClientDifferenceBytes', 'originVsClientDifferenceFraction', 'abortedQueuedResidualBytes'];
  const rows = tags.map((tag) => [
    tag,
    figure.originMediaBytesByClient?.[tag],
    figure.clientReceivedMediaBytesByClient?.[tag],
    figure.peerByteFractionByClient?.[tag],
    figure.originVsClientBytesByClient?.[tag]?.differenceBytes,
    figure.originVsClientBytesByClient?.[tag]?.differenceFraction,
    figure.abortedQueuedResidualBytesByClient?.[tag],
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function utilisationCsv(figure) {
  requirePublished(figure);
  const header = ['uplinkUtilisationMean', 'uplinkUtilisationPeak', 'qdiscBacklogBytesMean', 'qdiscBacklogBytesPeak', 'qdiscDropsInWindow', 'qdiscOverlimitsInWindow'];
  const row = header.map((field) => figure[field]);
  return [header, row].map((line) => line.map(csvCell).join(',')).join('\n') + '\n';
}
