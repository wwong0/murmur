// Delivered-byte accounting for the origin measurement seam.

const MEDIA_KINDS = new Set(['segment', 'init', 'playlist']);

export const RESPONSE_ACCOUNTING_VERSION = 2;

export function classifyPath(urlPath) {
  const pathname = String(urlPath).split(/[?#]/, 1)[0];
  if (!pathname.startsWith('/media/')) return 'overhead';
  if (pathname.endsWith('.m4s')) return 'segment';
  if (pathname.endsWith('.mp4')) return 'init';
  if (pathname.endsWith('.m3u8')) return 'playlist';
  return 'overhead';
}

export function countDelivered({
  socketBytesAtStart,
  socketBytesAtEnd,
  expectedBytes,
  writableFinished,
}) {
  if (!Number.isFinite(expectedBytes) || expectedBytes < 0) {
    throw new TypeError('expectedBytes must be a non-negative finite number');
  }
  if (writableFinished) return { delivered: expectedBytes, waste: 0, aborted: false };
  const delta = Math.min(Math.max(socketBytesAtEnd - socketBytesAtStart, 0), expectedBytes);
  return { delivered: delta, waste: delta, aborted: true };
}

function mediaBucket() {
  return {
    mediaBytesDelivered: 0,
    segmentBytesDelivered: 0,
    initBytesDelivered: 0,
    playlistBytesDelivered: 0,
    abortedMediaBytesDelivered: 0,
    responses: 0,
  };
}

function clone(value) {
  return structuredClone(value);
}

export function createCounters() {
  const state = {
    responseAccountingVersion: RESPONSE_ACCOUNTING_VERSION,
    mediaBytesDelivered: 0,
    segmentBytesDelivered: 0,
    initBytesDelivered: 0,
    playlistBytesDelivered: 0,
    overheadBytesDelivered: 0,
    unattributedMediaBytesDelivered: 0,
    abortedMediaBytesDelivered: 0,
    abortedResponses: 0,
    completedResponses: 0,
    responsesWithNoSocket: 0,
    byClient: {},
    byPath: {},
    responseRecords: [],
    snapshotRequests: 0,
  };

  function record({
    kind,
    clientTag = null,
    urlPath,
    delivered,
    waste,
    aborted,
    expectedBytes,
    socketId = null,
    responseIndex = null,
    originResponseId = null,
    socketBytesAtStart = null,
    socketBytesAtEnd = null,
  }) {
    const media = MEDIA_KINDS.has(kind);
    const path = state.byPath[urlPath] ?? {
      hits: 0,
      completedHits: 0,
      bytesDelivered: 0,
      expectedBytes: 0,
    };
    path.hits += 1;
    if (!aborted) path.completedHits += 1;
    path.bytesDelivered += delivered;
    path.expectedBytes += expectedBytes;
    state.byPath[urlPath] = path;

    if (aborted) state.abortedResponses += 1;
    else state.completedResponses += 1;

    if (media) {
      state.mediaBytesDelivered += delivered;
      state[`${kind}BytesDelivered`] += delivered;
      if (aborted) state.abortedMediaBytesDelivered += waste;
      if (clientTag === null) {
        state.unattributedMediaBytesDelivered += delivered;
      } else {
        const client = state.byClient[clientTag] ?? mediaBucket();
        client.mediaBytesDelivered += delivered;
        client[`${kind}BytesDelivered`] += delivered;
        if (aborted) client.abortedMediaBytesDelivered += waste;
        client.responses += 1;
        state.byClient[clientTag] = client;
      }
    } else {
      state.overheadBytesDelivered += delivered;
    }

    state.responseRecords.push({
      socketId,
      responseIndex,
      originResponseId,
      clientTag,
      kind,
      urlPath,
      socketBytesAtStart,
      socketBytesAtEnd,
      delivered,
      expectedBytes,
      aborted,
    });
  }

  function snapshot() {
    return clone(state);
  }

  return {
    record,
    snapshot,
    incrementSnapshotRequests() {
      state.snapshotRequests += 1;
    },
    incrementResponsesWithNoSocket() {
      state.responsesWithNoSocket += 1;
    },
  };
}
