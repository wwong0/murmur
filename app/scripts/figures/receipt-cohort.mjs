const ACCOUNTING_VERSION = 2;

const finite = (value) => Number.isFinite(value);

function describeClient(tag) {
  return `client ${JSON.stringify(tag)}`;
}

function describeRequest(tag, request) {
  return `${describeClient(tag)} request ${JSON.stringify(request?.requestId ?? request?.url ?? '<unknown>')}`;
}

function error(message) {
  throw new Error(`receipt cohort: ${message}`);
}

/**
 * Return the path used by the origin's /media classifier. Absolute CDP URLs
 * become their pathname, and query/hash text is ignored just as
 * server/byte-accounting.mjs ignores it when classifying a request.
 */
export function normalizeMediaPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let source = value;
  try {
    source = new URL(value, 'http://receipt-cohort.invalid').pathname;
  } catch {
    // Keep relative request targets for the same classifier below.
  }
  return source.split(/[?#]/, 1)[0];
}

function mediaKind(value) {
  const path = normalizeMediaPath(value);
  if (!path || !path.startsWith('/media/')) return null;
  if (path.endsWith('.m4s')) return 'segment';
  if (path.endsWith('.mp4')) return 'init';
  return null;
}

function clientEntries(clients) {
  if (Array.isArray(clients)) {
    return clients.map((client, index) => {
      const tag = client?.tag ?? client?.clientTag;
      if (typeof tag !== 'string' || tag.length === 0) error(`client at index ${index} has no client tag`);
      return [tag, client];
    });
  }
  if (!clients || typeof clients !== 'object') error('clients must be an object or array');
  return Object.entries(clients);
}

function declaredTags(input, entries) {
  const source = input.declaredClientTags ?? entries.map(([tag]) => tag);
  if (!Array.isArray(source)) error('declaredClientTags must be an array');
  const tags = source.map((tag) => {
    if (typeof tag !== 'string' || tag.length === 0) error('declared client tags must be non-empty strings');
    return tag;
  });
  if (new Set(tags).size !== tags.length) error('declaredClientTags contains a duplicate tag');
  return tags;
}

function validateWindow(window) {
  if (!window || !finite(window.startMs) || !finite(window.endMs) || window.startMs > window.endMs) {
    error('window must have finite startMs/endMs with startMs <= endMs');
  }
}

function validateOriginIndex(originEnd) {
  if (!originEnd || originEnd.responseAccountingVersion !== ACCOUNTING_VERSION) {
    error(`origin counter requires responseAccountingVersion:${ACCOUNTING_VERSION}`);
  }
  if (!Array.isArray(originEnd.responseRecords)) error('origin counter responseRecords must be an array');
  const index = new Map();
  for (const record of originEnd.responseRecords) {
    if (!record || typeof record !== 'object') error('origin response record is malformed');
    const id = record.originResponseId;
    if (typeof id !== 'string' || id.length === 0) error('origin response record is missing response identity');
    if (index.has(id)) error(`duplicate origin response identity ${JSON.stringify(id)}`);
    if (!finite(record.delivered) || record.delivered < 0) {
      error(`origin response ${JSON.stringify(id)} has malformed delivered bytes`);
    }
    if (typeof record.aborted !== 'boolean') {
      error(`origin response ${JSON.stringify(id)} has malformed aborted state`);
    }
    index.set(id, record);
  }
  return index;
}

function validateOriginBytes(tag, request, record) {
  if (record.aborted) {
    error(`${describeRequest(tag, request)} matched origin record marked aborted`);
  }
}

function validateClientBytes(tag, request) {
  if (!finite(request.bodyBytes) || request.bodyBytes < 0) {
    error(`${describeRequest(tag, request)} has malformed bodyBytes`);
  }
}

function requestList(tag, client) {
  if (!client || typeof client !== 'object') error(`${describeClient(tag)} is malformed`);
  if (client.requestTimebase !== 'measure-window') {
    error(`${describeClient(tag)} is missing requestTimebase:measure-window`);
  }
  const requests = client.requests ?? client.requestRecords;
  if (!Array.isArray(requests)) error(`${describeClient(tag)} is missing requests/requestRecords`);
  return requests;
}

/**
 * Join independently measured completed client receipts to the origin's
 * cumulative response index. Membership is decided by client endMs; origin
 * snapshots are only the retained source of the matched delivered count.
 */
export function computeReceiptCohort({ clients, declaredClientTags, window, originEnd } = {}) {
  validateWindow(window);
  const entries = clientEntries(clients);
  const tags = declaredTags({ declaredClientTags }, entries);
  const byTag = new Map(entries);
  if (byTag.size !== entries.length) error('clients contains a duplicate client tag');
  for (const tag of byTag.keys()) {
    if (!tags.includes(tag)) error(`${describeClient(tag)} is not declared`);
  }
  for (const tag of tags) {
    if (!byTag.has(tag)) error(`${describeClient(tag)} has no client records`);
  }

  const originIndex = validateOriginIndex(originEnd);
  const usedResponseIds = new Map();
  const segmentSizes = new Map();
  const byClient = Object.fromEntries(tags.map((tag) => [tag, {
    originCompletedBytes: 0,
    clientCompletedBytes: 0,
    completedResponses: 0,
  }]));

  for (const tag of tags) {
    const requests = requestList(tag, byTag.get(tag));
    for (const request of requests) {
      if (!request || typeof request !== 'object') error(`${describeClient(tag)} has a malformed request`);
      const kind = mediaKind(request.url);
      if (!kind || request.finished !== true || request.canceled === true) continue;
      if (!finite(request.endMs)) error(`${describeRequest(tag, request)} has nonfinite endMs`);
      if (request.endMs < window.startMs || request.endMs > window.endMs) continue;

      const id = request.originResponseId;
      if (typeof id !== 'string' || id.length === 0) {
        error(`${describeRequest(tag, request)} is missing response identity`);
      }
      const priorUse = usedResponseIds.get(id);
      if (priorUse) {
        error(`${describeRequest(tag, request)} reuses response identity ${JSON.stringify(id)} already used by ${describeRequest(priorUse.tag, priorUse.request)}`);
      }
      usedResponseIds.set(id, { tag, request });

      const origin = originIndex.get(id);
      if (!origin) error(`${describeRequest(tag, request)} has unmatched origin response identity ${JSON.stringify(id)}`);
      if (origin.clientTag !== tag) {
        error(`${describeRequest(tag, request)} origin/client tag mismatch: origin ${JSON.stringify(origin.clientTag)}, client ${JSON.stringify(tag)}`);
      }
      const requestPath = normalizeMediaPath(request.url);
      const originPath = normalizeMediaPath(origin.urlPath);
      if (requestPath === null || originPath === null || requestPath !== originPath) {
        error(`${describeRequest(tag, request)} origin/client path mismatch: ${JSON.stringify(originPath)} vs ${JSON.stringify(requestPath)}`);
      }
      validateOriginBytes(tag, request, origin);
      validateClientBytes(tag, request);

      const bucket = byClient[tag];
      bucket.originCompletedBytes += origin.delivered;
      bucket.clientCompletedBytes += request.bodyBytes;
      bucket.completedResponses += 1;

      if (kind === 'segment') {
        const previous = segmentSizes.get(requestPath);
        if (previous !== undefined && previous !== request.bodyBytes) {
          error(`${describeRequest(tag, request)} repeated segment ${JSON.stringify(requestPath)} has conflicting client bodyBytes`);
        }
        segmentSizes.set(requestPath, request.bodyBytes);
      }
    }
  }

  let distinctSegmentBytesConsumedInWindow = 0;
  for (const bytes of segmentSizes.values()) distinctSegmentBytesConsumedInWindow += bytes;
  return {
    method: 'client-receipt-cohort-v1',
    byClient,
    distinctSegmentBytesConsumedInWindow,
    distinctSegmentsCompletedInWindow: segmentSizes.size,
  };
}
