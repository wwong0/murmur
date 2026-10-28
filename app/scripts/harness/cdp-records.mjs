const finite = (value) => Number.isFinite(value);

function framePayload(params) {
  const raw = params?.response?.payloadData ?? params?.payloadData;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function isTabTakenNetworkFrame(params) {
  const message = framePayload(params);
  const code = message?.payload?.code
    ?? message?.payload?.error?.code
    ?? message?.error?.code
    ?? message?.code;
  return message?.type === 'error' && code === 'tab-taken';
}

export function attachClockJoinRecorder(tab) {
  const joined = [];
  const echoSent = [];
  const echoReplies = [];
  const stamp = (params) => finite(params?.timestamp) ? { cdpMs: params.timestamp * 1000 } : null;
  const off = [
    tab.on('Network.webSocketFrameReceived', (params) => {
      const message = framePayload(params);
      const at = stamp(params);
      if (!at) return;
      if (message?.type === 'joined') joined.push({ ...at, recvSharedMs: message.ts?.recv ?? null });
      if (joined.length && message?.type === 'echo-reply' && echoReplies.length < 20) echoReplies.push(at);
    }),
    tab.on('Network.webSocketFrameSent', (params) => {
      const message = framePayload(params);
      const at = stamp(params);
      if (at && joined.length && message?.type === 'echo' && echoSent.length < 20) echoSent.push(at);
    }),
  ];
  return {
    snapshot() {
      return { timebase: 'cdp-monotonic', joined: joined.map((entry) => ({ ...entry })), echoSent: echoSent.map((entry) => ({ ...entry })), echoReplies: echoReplies.map((entry) => ({ ...entry })) };
    },
    dispose() {
      for (const remove of off) remove();
    },
  };
}

/** Record the room's shared-clock roster envelopes before any navigation. */
export function attachPresenceRecorder(tab) {
  const records = [];
  const off = tab.on('Network.webSocketFrameReceived', (params) => {
    const message = framePayload(params);
    const body = message?.payload;
    const at = finite(params?.timestamp) ? params.timestamp * 1000 : null;
    if (message?.type !== 'presence' || !finite(at) || !body || !Number.isSafeInteger(message.seq)) return;
    const member = body.member;
    if ((body.event !== 'join' && body.event !== 'leave') || typeof member?.tabId !== 'string'
      || typeof member?.clientId !== 'string' || !Array.isArray(body.roster)) return;
    records.push({ cdpMs: at, seq: message.seq, recvSharedMs: message.ts?.recv ?? null,
      event: body.event, tabId: member.tabId, clientId: member.clientId,
      roster: body.roster.map((entry) => ({ clientId: entry?.clientId, tabId: entry?.tabId, role: entry?.role })) });
  });
  return {
    snapshot() { return records.map((record) => ({ ...record, roster: record.roster.map((entry) => ({ ...entry })) })); },
    dispose() { off(); },
  };
}

export function attachTabTakenDetector(tab, onCollision) {
  return tab.on('Network.webSocketFrameReceived', (params) => {
    if (isTabTakenNetworkFrame(params)) onCollision(params);
  });
}

function responseHeader(headers, wanted) {
  if (!headers || typeof headers !== 'object') return null;
  const matches = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === wanted.toLowerCase())
    .map(([, value]) => value);
  if (matches.length === 0) return null;
  if (matches.length > 1 && new Set(matches.map(String)).size !== 1) {
    throw new Error(`response has conflicting ${wanted} headers`);
  }
  const value = matches[0];
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

export function createRequestRecorder(tab) {
  const requests = new Map();
  const records = [];
  const mapping = { source: 'cdp-monotonic-to-wall', samples: [], offsetMs: null };
  const eventMs = (params) => {
    const timestamp = params?.timestamp;
    if (!finite(timestamp)) return undefined;
    if (finite(mapping.offsetMs)) return timestamp * 1000 + mapping.offsetMs;
    return undefined;
  };
  const rememberMapping = (params) => {
    if (finite(params?.timestamp) && finite(params?.wallTime)) {
      const sample = { cdpMonotonicMs: params.timestamp * 1000, wallMs: params.wallTime * 1000 };
      mapping.samples.push(sample);
      mapping.offsetMs = sample.wallMs - sample.cdpMonotonicMs;
    }
  };
  const finish = (id, patch) => {
    const request = requests.get(id);
    if (!request) return;
    Object.assign(request, patch);
    if (request.finished || request.canceled) {
      const bodyFromTotal = finite(request.bodyBytesFromTotal) && request.bodyBytesFromTotal >= 0
        ? request.bodyBytesFromTotal
        : undefined;
      const bodyFromChunks = finite(request.bodyBytesFromChunks) ? request.bodyBytesFromChunks : undefined;
      request.bodyBytes = bodyFromTotal ?? bodyFromChunks ?? 0;
      request.source = bodyFromTotal !== undefined ? 'loadingFinished-total-minus-response-header' : 'dataReceived-chunk-sum';
      records.push({ ...request });
      requests.delete(id);
    }
  };
  const off = [
    tab.on('Network.requestWillBeSent', (params) => {
      rememberMapping(params);
      requests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request?.url,
        startMs: eventMs(params),
        raw: { requestTimestamp: params.timestamp, requestWallTime: params.wallTime },
        headerBytes: undefined,
        originResponseId: null,
        bodyBytesFromChunks: 0,
        bodyBytesFromTotal: undefined,
        finished: false,
        canceled: false,
      });
    }),
    tab.on('Network.responseReceived', (params) => {
      const request = requests.get(params.requestId);
      if (!request) return;
      request.headerBytes = params.response?.encodedDataLength;
      request.originResponseId = responseHeader(params.response?.headers, 'x-app-response-id');
      request.raw.responseTimestamp = params.timestamp;
    }),
    tab.on('Network.dataReceived', (params) => {
      const request = requests.get(params.requestId);
      if (request) request.bodyBytesFromChunks += Number(params.encodedDataLength ?? 0);
    }),
    tab.on('Network.loadingFinished', (params) => {
      const request = requests.get(params.requestId);
      if (!request) return;
      const total = Number(params.encodedDataLength);
      request.endMs = eventMs(params);
      request.raw.finishedTimestamp = params.timestamp;
      request.bodyBytesFromTotal = finite(total) && finite(request.headerBytes) ? total - request.headerBytes : undefined;
      finish(params.requestId, { finished: true, canceled: false });
    }),
    tab.on('Network.loadingFailed', (params) => {
      const request = requests.get(params.requestId);
      if (!request) return;
      request.endMs = eventMs(params) ?? request.startMs;
      request.raw.failedTimestamp = params.timestamp;
      request.errorText = params.errorText ?? null;
      finish(params.requestId, { finished: false, canceled: true });
    }),
  ];
  return {
    records,
    mapping,
    listeners: off,
    setPageMapping({ wallMs, performanceNowMs }) {
      if (finite(wallMs) && finite(performanceNowMs)) {
        mapping.page = { wallMs, performanceNowMs };
        if (!finite(mapping.offsetMs)) mapping.offsetMs = wallMs - performanceNowMs;
      }
    },
    flush(atMs = Date.now()) {
      for (const [id, request] of requests) {
        finish(id, { endMs: request.endMs ?? atMs, canceled: true });
      }
      records.sort((a, b) => (a.endMs ?? Infinity) - (b.endMs ?? Infinity));
      return records.map((record) => ({ ...record, requestTimebase: 'measure-window' }));
    },
    dispose() {
      for (const remove of off) remove();
    },
  };
}

/**
 * The 125 ms poll, read FIELD BY FIELD rather than as objects.
 *
 * VideoPlaybackQuality carries its counters as prototype accessors, and CDP's
 * returnByValue keeps own enumerable properties only — so the object itself
 * crosses as an empty one, and nothing throws. `harness-poll-shape.mjs` asserts
 * this expression through the same serialisation.
 */
export function pollExpression() {
  return `(() => {
    const video = document.querySelector('video');
    const playback = __app.playback();
    const scalar = (({ starts, seams, ...rest }) => rest)(playback);
    return {
      atMs: performance.timeOrigin + performance.now(),
      wallMs: Date.now(),
      clock: __app.clock(),
      controller: __app.controller(),
      playback: scalar,
      store: typeof __app.segmentStore === 'function' ? __app.segmentStore() : null,
      quality: video && typeof video.getVideoPlaybackQuality === 'function'
        ? (() => {
            const q = video.getVideoPlaybackQuality();
            return {
              droppedVideoFrames: q.droppedVideoFrames,
              totalVideoFrames: q.totalVideoFrames,
              corruptedVideoFrames: q.corruptedVideoFrames,
              creationTime: q.creationTime
            };
          })()
        : null,
      stalls: window.__harnessStalls ?? null
    };
  })()`;
}

export function boundaryExpression() {
  return `(() => {
    const playback = __app.playback();
    return {
      atMs: performance.timeOrigin + performance.now(),
      playback: {
        ...playback,
        starts: Array.isArray(playback.starts) ? playback.starts.map((entry) => ({ ...entry })) : [],
        seams: Array.isArray(playback.seams) ? playback.seams.map((entry) => ({ ...entry })) : []
      }
    };
  })()`;
}

export function peerPageReadingExpression() {
  return `(() => {
    const bytes = typeof __app.peerBytes === 'function' ? __app.peerBytes(0) : null;
    return {
      buildId: typeof __app.buildId === 'string' ? __app.buildId : null,
      peerExchange: typeof __app.peerExchange === 'function' ? __app.peerExchange() : null,
      positionOffset: typeof __app.positionOffset === 'function' ? __app.positionOffset() : null,
      peerBytes: bytes && typeof bytes === 'object'
        ? { attribution: bytes.attribution ?? null, peerId: bytes.peerId ?? null }
        : null,
    };
  })()`;
}

export function installStallRecorder(epoch) {
  return `(() => {
    const state = { epoch: ${JSON.stringify(epoch)}, count: 0, lastAtMs: 0, installedAtMs: performance.now() };
    window.__harnessStalls = state;
    const video = document.querySelector('video');
    const on = () => {
      const at = performance.now();
      if (at - state.lastAtMs < 500) return;
      state.lastAtMs = at;
      state.count += 1;
    };
    video?.addEventListener('waiting', on);
    video?.addEventListener('stalled', on);
    return { epoch: state.epoch, installedAtMs: state.installedAtMs };
  })()`;
}
