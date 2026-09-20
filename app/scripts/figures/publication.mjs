// Publication and CSV boundaries for harness figures.

const PUBLICATION = Symbol('published-figure');

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

export function requiredContextFields(kind, context = {}) {
  const fields = [...(REQUIRED_CONTEXT_FIELDS[kind] ?? [])];
  const tags = declaredTags(context, {});
  return fields.flatMap((field) => (field.endsWith('ByClient') ? tags.map((tag) => `${field}[${tag}]`) : [field]));
}

export function publish(kind, figure = {}, context = {}) {
  const missing = missingFields(kind, context, figure);
  if (missing) return { published: false, missing };
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
