// Per-attempt byte attribution read from the engine's own Request (change 7b design.md D4).
// engineRequestLookup is the only reader of engine internals, pinned at 3.0.1 by the
// peer-bytes suite: a renamed field there makes every attempt's bytes null, never 0.

const loaderNames = ['mainStreamLoader', 'secondaryStreamLoader'];

function isObject(value) {
  return value !== null && typeof value === 'object';
}

export function engineRequestLookup(engine) {
  const core = engine?.core;
  return (segment) => {
    if (!isObject(core) || !isObject(segment)) return null;
    for (const name of loaderNames) {
      const loader = core[name];
      if (loader === undefined || loader === null) continue;
      const container = loader.requests;
      const requests = container?.requests;
      if (!(requests instanceof Map)) return null;
      for (const request of requests.values()) {
        if (request?.segment?.runtimeId === segment.runtimeId) return request;
      }
    }
    return null;
  };
}

export function readRequest(request) {
  try {
    const heldBytes = request?.loadedBytes;
    const startFromBytes = request?.progress?.startFromByte;
    const addedBytes = request?.progress?.loadedBytes;
    if (![heldBytes, startFromBytes, addedBytes].every(Number.isSafeInteger)) return null;
    if ([heldBytes, startFromBytes, addedBytes].some((value) => value < 0)) return null;
    return { heldBytes, startFromBytes, addedBytes };
  } catch {
    return null;
  }
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

export function createPeerBytes({ wallNow = () => Date.now(), capacity = 65536 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive safe integer');

  const records = [];
  const openByRuntimeId = new Map();
  const lastRequestByRuntimeId = new Map();
  const requestState = new WeakMap();
  const attemptsById = new Map();
  const connected = new Set();
  const peerIds = [];
  const chunkBytes = { http: 0, p2p: {} };
  const uploadBytes = {};
  const kept = { hostBytes: 0, peerBytes: 0 };
  const errors = { count: 0, last: null };
  // T7 (design.md D5): finished segments' media-time spans, outside the ring so
  // held-ahead can always see the whole run — the ring evicts, this must not.
  const finishedByRuntimeId = new Map();
  let finishedWithoutTimes = 0;
  let attribution = 'unavailable';
  let unavailable = false;
  let peerId = null;
  let latestSeq = 0;
  let missed = 0;
  let nextAttemptId = 0;
  let lookup = () => null;

  function captureError(error) {
    errors.count += 1;
    errors.last = error instanceof Error ? error.message : String(error);
  }

  function guarded(handler) {
    return (...args) => {
      try {
        handler(...args);
      } catch (error) {
        captureError(error);
      }
    };
  }

  function append(record) {
    const item = { seq: ++latestSeq, ...record };
    records.push(item);
    if (records.length > capacity) {
      records.shift();
      missed += 1;
    }
    return item;
  }

  function stateFor(request) {
    if (!request || (typeof request !== 'object' && typeof request !== 'function')) return null;
    let state = requestState.get(request);
    if (!state) {
      state = { unclaimed: [], unclaimedBytes: 0 };
      requestState.set(request, state);
    }
    return state;
  }

  function discard(state, reason, attemptIds = state.unclaimed) {
    const ids = [...attemptIds];
    if (ids.length) append({ kind: 'discard', attemptIds: ids, reason });
    state.unclaimed = [];
    state.unclaimedBytes = 0;
  }

  function markUnavailable() {
    unavailable = true;
    attribution = 'unavailable';
  }

  function pathOf(segment) {
    return new URL(segment.url).pathname;
  }

  function openAttempt(event) {
    const { segment, downloadSource: source, peerId: sendingPeerId } = event;
    if (!segment || typeof segment.runtimeId !== 'string') throw new Error('segment runtimeId is required');

    let request = null;
    let snapshot = null;
    if (attribution === 'engine-request') {
      request = lookup(segment);
      snapshot = readRequest(request);
      if (!request || !snapshot) markUnavailable();
    }

    const path = pathOf(segment);
    if (request && snapshot && attribution === 'engine-request') {
      const previous = lastRequestByRuntimeId.get(segment.runtimeId);
      if (previous && previous !== request) {
        const previousState = stateFor(previous);
        if (previousState) discard(previousState, 'request-dropped');
      }
      const state = stateFor(request);
      if (snapshot.startFromBytes !== state.unclaimedBytes) {
        if (snapshot.startFromBytes === 0) discard(state, 'cleared');
        else append({ kind: 'anomaly', runtimeId: segment.runtimeId, path, reason: 'start-held-mismatch' });
      }
      lastRequestByRuntimeId.set(segment.runtimeId, request);
    }

    const attempt = {
      attemptId: ++nextAttemptId,
      runtimeId: segment.runtimeId,
      path,
      source,
      peerId: source === 'p2p' ? sendingPeerId : null,
      startMs: wallNow(),
      heldAtStartBytes: snapshot?.startFromBytes ?? null,
      request,
    };
    openByRuntimeId.set(segment.runtimeId, attempt);
  }

  function endAttempt(event, end) {
    const segment = event?.segment;
    const runtimeId = segment?.runtimeId;
    const open = openByRuntimeId.get(runtimeId);
    if (!open) {
      append({ kind: 'anomaly', runtimeId, path: segment ? pathOf(segment) : null, reason: 'end-without-start' });
      return;
    }
    openByRuntimeId.delete(runtimeId);

    let snapshot = null;
    if (attribution === 'engine-request' && open.request) {
      const request = lookup(segment);
      snapshot = readRequest(request);
      if (!request || !snapshot) markUnavailable();
    }
    const attemptRecord = append({
      kind: 'attempt',
      attemptId: open.attemptId,
      runtimeId: open.runtimeId,
      path: open.path,
      source: open.source,
      peerId: open.peerId,
      startMs: open.startMs,
      endMs: wallNow(),
      end,
      bytes: snapshot?.addedBytes ?? null,
      heldAtStartBytes: open.heldAtStartBytes,
      heldAtEndBytes: snapshot?.heldBytes ?? null,
    });
    attemptsById.set(open.attemptId, attemptRecord);

    if (attribution !== 'engine-request' || !snapshot || !open.request) return;
    const state = stateFor(open.request);
    const priorIds = [...state.unclaimed];
    const start = open.heldAtStartBytes;
    const added = snapshot.addedBytes;
    const held = snapshot.heldBytes;
    if (held === start + added) {
      state.unclaimed.push(open.attemptId);
      state.unclaimedBytes += added;
    } else if (held === added) {
      discard(state, 'cleared');
      state.unclaimed.push(open.attemptId);
      state.unclaimedBytes = added;
    } else if (held === 0) {
      discard(state, 'cleared', [...priorIds, open.attemptId]);
    } else {
      append({ kind: 'anomaly', runtimeId: open.runtimeId, path: open.path, reason: 'end-held-mismatch' });
      state.unclaimed.push(open.attemptId);
      state.unclaimedBytes += added;
    }
  }

  function segmentLoaded(event) {
    endAttempt(event, 'loaded');
    const { segment, bytesLength } = event;
    const request = lastRequestByRuntimeId.get(segment.runtimeId);
    const state = stateFor(request);
    const keptAttemptIds = attribution === 'engine-request' && state ? [...state.unclaimed] : [];
    const keptSumBytes = attribution === 'engine-request' && state ? state.unclaimedBytes : 0;
    // T7: the engine's fragment carries startTime/endTime in seconds (3.0.1
    // hlsjs segment-manager.js); held-ahead reads media milliseconds.
    const mediaStartMs = Number(segment.startTime) * 1000;
    const mediaEndMs = Number(segment.endTime) * 1000;
    const hasTimes = Number.isFinite(mediaStartMs) && Number.isFinite(mediaEndMs);
    if (hasTimes) finishedByRuntimeId.set(segment.runtimeId, { mediaStartMs, mediaEndMs });
    else finishedWithoutTimes += 1;
    append({
      kind: 'segment',
      runtimeId: segment.runtimeId,
      path: pathOf(segment),
      lengthBytes: bytesLength,
      completedAtMs: wallNow(),
      keptAttemptIds,
      keptSumBytes,
      mediaStartMs,
      mediaEndMs,
    });
    if (attribution === 'engine-request' && state) {
      for (const attemptId of keptAttemptIds) {
        const attempt = attemptsById.get(attemptId);
        if (!attempt || !Number.isSafeInteger(attempt.bytes)) continue;
        if (attempt.source === 'p2p') kept.peerBytes += attempt.bytes;
        else kept.hostBytes += attempt.bytes;
      }
      state.unclaimed = [];
      state.unclaimedBytes = 0;
    }
  }

  function chunkDownloaded(bytes, source, sendingPeerId) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('chunk bytes must be a non-negative safe integer');
    if (source === 'http') chunkBytes.http += bytes;
    else if (source === 'p2p') {
      if (typeof sendingPeerId !== 'string' || sendingPeerId.length === 0) throw new Error('p2p chunk peer id is required');
      chunkBytes.p2p[sendingPeerId] = (chunkBytes.p2p[sendingPeerId] ?? 0) + bytes;
    } else throw new Error(`unknown chunk source: ${source}`);
  }

  function chunkUploaded(bytes, sendingPeerId) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof sendingPeerId !== 'string') throw new Error('upload data is invalid');
    uploadBytes[sendingPeerId] = (uploadBytes[sendingPeerId] ?? 0) + bytes;
  }

  function peerConnected(event) {
    const id = event?.peerId;
    connected.add(id);
    append({ kind: 'peer', event: 'connect', peerId: id, atMs: wallNow() });
  }

  function peerClosed(event) {
    const id = event?.peerId;
    connected.delete(id);
    append({ kind: 'peer', event: 'close', peerId: id, atMs: wallNow() });
  }

  function attach(engine) {
    const ownPeerId = engine?.core?.peerId;
    if (typeof ownPeerId !== 'string' || ownPeerId.length === 0) markUnavailable();
    else {
      peerId ??= ownPeerId;
      peerIds.push(ownPeerId);
      if (!unavailable) attribution = 'engine-request';
    }
    try {
      lookup = engineRequestLookup(engine);
    } catch (error) {
      captureError(error);
      lookup = () => null;
    }
    const handlers = {
      onSegmentStart: guarded(openAttempt),
      onSegmentLoaded: guarded(segmentLoaded),
      onSegmentError: guarded((event) => endAttempt(event, `error:${event?.error?.type ?? 'unknown'}`)),
      onSegmentAbort: guarded((event) => endAttempt(event, 'abort')),
      onChunkDownloaded: guarded(chunkDownloaded),
      onChunkUploaded: guarded(chunkUploaded),
      onPeerConnect: guarded(peerConnected),
      onPeerClose: guarded(peerClosed),
    };
    for (const [name, handler] of Object.entries(handlers)) engine.addEventListener(name, handler);
  }

  function read(afterSeq = 0) {
    const open = [...openByRuntimeId.values()].map((attempt) => ({
      attemptId: attempt.attemptId,
      runtimeId: attempt.runtimeId,
      path: attempt.path,
      source: attempt.source,
      peerId: attempt.peerId,
      startMs: attempt.startMs,
      bytesSoFar: attribution === 'engine-request' && attempt.request
        ? readRequest(attempt.request)?.addedBytes ?? null
        : null,
    }));
    return {
      attribution,
      peerId,
      peerIds: [...peerIds],
      records: records.filter((record) => record.seq > afterSeq).map(copy),
      latestSeq,
      missed,
      open: copy(open),
      kept: copy(kept),
      chunkBytes: copy(chunkBytes),
      uploadBytes: copy(uploadBytes),
      connected: [...connected],
      errors: copy(errors),
    };
  }

  // T7: outside the ring, so a segment's finished span survives eviction.
  function finishedSegments() {
    return [...finishedByRuntimeId.values()].map((entry) => ({ ...entry }));
  }

  return { attach, read, finishedSegments, get finishedWithoutTimes() { return finishedWithoutTimes; } };
}

export function attemptDispositions(records) {
  const dispositions = new Map();
  for (const record of records) {
    if (record.kind === 'attempt') dispositions.set(record.attemptId, 'abandoned');
  }
  for (const record of records) {
    if (record.kind === 'segment') {
      for (const attemptId of record.keptAttemptIds ?? []) {
        const prior = dispositions.get(attemptId);
        if (prior === 'discarded') throw new Error(`attempt ${attemptId} is both kept and discarded`);
        if (prior === undefined) throw new Error(`segment claims unknown attempt ${attemptId}`);
        dispositions.set(attemptId, 'kept');
      }
    }
    if (record.kind === 'discard') {
      for (const attemptId of record.attemptIds ?? []) {
        const prior = dispositions.get(attemptId);
        if (prior === 'kept') throw new Error(`attempt ${attemptId} is both kept and discarded`);
        if (prior === undefined) throw new Error(`discard names unknown attempt ${attemptId}`);
        dispositions.set(attemptId, 'discarded');
      }
    }
  }
  return dispositions;
}

export function keptBytes(records) {
  const dispositions = attemptDispositions(records);
  const result = { hostBytes: 0, peerBytes: 0 };
  for (const record of records) {
    if (record.kind !== 'attempt' || dispositions.get(record.attemptId) !== 'kept') continue;
    if (!Number.isSafeInteger(record.bytes)) continue;
    if (record.source === 'p2p') result.peerBytes += record.bytes;
    else if (record.source === 'http') result.hostBytes += record.bytes;
  }
  return result;
}
