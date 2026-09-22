// Publication and CSV boundaries for harness figures.

import { evaluateByteControl } from '../harness/byte-control.mjs';

const PUBLICATION = Symbol('published-figure');
const RECEIPT_COHORT_METHOD = 'client-receipt-cohort-v1';

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

export const REQUIRED_CONTEXT_FIELDS = Object.freeze({ byte: BYTE_FIELDS });

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

function missingFields(kind, context, figure) {
  const fields = REQUIRED_CONTEXT_FIELDS[kind];
  if (!fields) throw new Error(`unknown figure kind: ${kind}`);
  for (const field of fields) {
    const direct = missingField(field, context, figure);
    if (direct) return direct;
    if (field === 'realtimeFactorByClient' || field === 'stallCountByClient') {
      const values = lookup(field, context, figure);
      for (const tag of declaredTags(context, figure)) {
        if (absent(values?.[tag])) return `${field}[${tag}]`;
      }
    }
  }
  return null;
}

function missingReceiptCohortField(figure) {
  for (const [field, valid] of RECEIPT_COHORT_FIELDS) {
    if (!valid(figure?.[field])) return field;
  }
  return null;
}

export function requiredContextFields(kind, context = {}) {
  const fields = [...(REQUIRED_CONTEXT_FIELDS[kind] ?? [])];
  const tags = declaredTags(context, {});
  return fields.flatMap((field) => (field.endsWith('ByClient') ? tags.map((tag) => `${field}[${tag}]`) : [field]));
}

export function publish(kind, figure = {}, context = {}) {
  const missing = missingFields(kind, context, figure);
  if (missing) return { published: false, missing };
  const accountingMethod = context.byteAccountingMethod ?? figure.byteAccountingMethod;
  if (kind === 'byte' && accountingMethod === RECEIPT_COHORT_METHOD) {
    if (figure.byteAccountingMethod !== RECEIPT_COHORT_METHOD) return { published: false, missing: 'byteAccountingMethod' };
    for (const tag of declaredTags(context, figure)) {
      for (const field of ['peerByteFractionByClient', 'originVsClientBytesByClient']) {
        if (absent(figure[field]?.[tag])) return { published: false, missing: `${field}[${tag}]` };
      }
    }
    const missingReceiptField = missingReceiptCohortField(figure);
    if (missingReceiptField) return { published: false, missing: missingReceiptField };
  }
  if (kind === 'byte') {
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

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function requirePublished(figure) {
  if (!isPublishedFigure(figure)) throw new Error('CSV requires a published figure');
}

export function bytesByClientCsv(figure) {
  requirePublished(figure);
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

export const writeBytesByClientCsv = bytesByClientCsv;
export const writeUtilisationCsv = utilisationCsv;
