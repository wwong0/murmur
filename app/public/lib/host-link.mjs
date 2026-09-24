// Viewer-side signalling, WebRTC link lifecycle, and request demultiplexing.
// The HTTP facades live in host-link-shim.mjs; this module owns only the wire.

import {
  decodeFrame,
  encodeControl,
  parseControl,
} from './segment-protocol.mjs';
import { createShimFetch, createShimXhr } from './host-link-shim.mjs';
import { ADDR_SERVER } from './envelope.mjs';

function nowOf(clock) {
  return clock && typeof clock.now === 'function' ? () => clock.now() : () => performance.now();
}

function randomId() {
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function rosterFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.roster)) return value.roster;
  if (value?.payload && Array.isArray(value.payload.roster)) return value.payload.roster;
  return [];
}

function reportStats(stats) {
  if (stats && typeof stats.then === 'function') return stats.then(reportStats);
  const values = [];
  if (stats && typeof stats.forEach === 'function') stats.forEach((value) => values.push(value));
  else if (stats && typeof stats[Symbol.iterator] === 'function') {
    for (const value of stats) values.push(value?.type ? value : value[1]);
  } else if (stats && typeof stats === 'object') values.push(...Object.values(stats));
  const transport = values.find((value) => value?.type === 'transport') ?? null;
  const pairId = transport?.selectedCandidatePairId;
  const pair = (pairId && values.find((value) => value?.id === pairId))
    ?? values.find((value) => value?.type === 'candidate-pair' && value.nominated && value.state === 'succeeded');
  if (!pair) return null;
  const local = values.find((value) => value?.id === pair.localCandidateId);
  const remote = values.find((value) => value?.id === pair.remoteCandidateId);
  if (!local || !remote) return null;
  return {
    relayed: local.candidateType === 'relay' || remote.candidateType === 'relay',
    candidateTypes: { local: local.candidateType ?? null, remote: remote.candidateType ?? null },
    addresses: { local: local.address ?? null, remote: remote.address ?? null },
  };
}

/**
 * @param {{client: object, RTCPeerConnection: Function, rtcConfig?: object, clock?: object, onChange?: Function}} config
 */
export function createHostLink({ client, RTCPeerConnection, rtcConfig = {}, clock, onChange, wallNow = () => Date.now(), receiptCapacity = 4096 } = {}) {
  if (!client || typeof client.on !== 'function' || typeof client.onEvent !== 'function') throw new TypeError('createHostLink: client is required');
  if (typeof RTCPeerConnection !== 'function') throw new TypeError('createHostLink: RTCPeerConnection is required');
  if (typeof wallNow !== 'function') throw new TypeError('createHostLink: wallNow must be a function');
  const time = nowOf(clock);
  const maxReceipts = Math.max(0, Math.floor(Number(receiptCapacity) || 0));
  const state = {
    state: 'absent',
    relayed: null,
    candidateTypes: null,
    addresses: null,
    hostClientId: null,
    linkId: null,
    openedAtMs: null,
    requestsByPath: Object.create(null),
    lastError: null,
  };
  let ownClientId = client.clientId ?? null;
  let pc = null;
  let channel = null;
  let detachChannel = null;
  let currentHost = null;
  let tornDown = false;
  let nextId = 1;
  const pending = new Map();
  const queuedIce = [];
  const receiptLog = [];
  let latestReceiptSeq = 0;
  let missedReceipts = 0;

  function snapshot() {
    return {
      state: state.state,
      relayed: state.relayed,
      candidateTypes: state.candidateTypes ? { ...state.candidateTypes } : null,
      addresses: state.addresses ? { ...state.addresses } : null,
      hostClientId: state.hostClientId,
      linkId: state.linkId,
      openedAtMs: state.openedAtMs,
      requests: pending.size,
      requestsByPath: { ...state.requestsByPath },
      lastError: state.lastError,
    };
  }

  function changed() {
    try { onChange?.(snapshot()); } catch (error) {
      state.lastError = error?.message ?? String(error);
    }
  }

  function setState(value, error = null) {
    state.state = value;
    state.lastError = error ? (error.message ?? String(error)) : state.lastError;
    changed();
  }

  function finishReceipt(entry, finished, canceled) {
    if (entry.receiptDone) return;
    entry.receiptDone = true;
    latestReceiptSeq += 1;
    const receipt = {
      seq: latestReceiptSeq,
      requestId: entry.requestId,
      url: entry.path,
      originResponseId: entry.head?.rid ?? null,
      status: entry.head?.status ?? 0,
      expectedBytes: entry.head?.length ?? null,
      startMs: entry.startMs,
      headMs: entry.headMs,
      endMs: wallNow(),
      bodyBytes: entry.bodyBytes,
      finished,
      canceled,
      source: 'host-link-receipt',
    };
    if (maxReceipts === 0) {
      missedReceipts += 1;
      return;
    }
    receiptLog.push(receipt);
    if (receiptLog.length > maxReceipts) {
      receiptLog.shift();
      missedReceipts += 1;
    }
  }

  function failRequests() {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      finishReceipt(entry, false, true);
      try { entry.onError(0); } catch { /* request handlers are isolated */ }
    }
  }

  function clearPeer() {
    if (detachChannel) detachChannel();
    detachChannel = null;
    try { channel?.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
    channel = null;
    pc = null;
    queuedIce.length = 0;
    failRequests();
  }

  function tearDown(nextState = 'absent', error = null) {
    tornDown = true;
    clearPeer();
    state.linkId = null;
    if (nextState === 'absent') state.hostClientId = null;
    state.openedAtMs = null;
    state.relayed = null;
    state.candidateTypes = null;
    state.addresses = null;
    setState(nextState, error);
  }

  function sendSignal(type, payload) {
    if (!currentHost) return;
    client.send({ type, to: currentHost, payload });
  }

  async function addCandidate(candidate) {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      queuedIce.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      state.lastError = error?.message ?? String(error);
      changed();
    }
  }

  async function readRelayFlag() {
    try {
      const result = reportStats(await pc.getStats());
      if (!result) throw new Error('selected candidate pair was not available');
      state.relayed = result.relayed;
      state.candidateTypes = result.candidateTypes;
      state.addresses = result.addresses;
      changed();
    } catch (error) {
      state.relayed = null;
      state.candidateTypes = null;
      state.addresses = null;
      state.lastError = error?.message ?? String(error);
      changed();
    }
  }

  function wireChannel(candidate) {
    channel = candidate;
    channel.binaryType = 'arraybuffer';
    const onMessage = (event) => {
      if (tornDown) return;
      if (typeof event?.data === 'string') {
        const control = parseControl(event.data);
        if (!control) return;
        const entry = pending.get(control.id);
        if (!entry) return;
        if (control.t === 'head') entry.onHead(control);
        else if (control.t === 'end') {
          pending.delete(control.id);
          finishReceipt(entry, true, false);
          entry.onEnd(control);
        } else if (control.t === 'err') {
          pending.delete(control.id);
          finishReceipt(entry, false, true);
          entry.onError(control.status ?? 0);
        }
        return;
      }
      const frame = decodeFrame(event?.data);
      if (!frame) return;
      const entry = pending.get(frame.id);
      if (!entry) return;
      entry.onChunk(new Uint8Array(frame.payload));
    };
    const onClose = () => {
      if (!tornDown) fail(new Error('data channel closed'));
    };
    const onError = (event) => {
      if (!tornDown) fail(event?.error ?? new Error('data channel error'));
    };
    const onOpen = () => {
      if (tornDown) return;
      state.openedAtMs = time();
      setState('open');
      void readRelayFlag();
    };
    const listeners = { message: onMessage, close: onClose, error: onError, open: onOpen };
    for (const [type, fn] of Object.entries(listeners)) candidate.addEventListener(type, fn);
    detachChannel = () => {
      for (const [type, fn] of Object.entries(listeners)) candidate.removeEventListener(type, fn);
    };
    if (channel.readyState === 'open') onOpen();
  }

  async function initiate(hostId) {
    clearPeer();
    tornDown = false;
    ownClientId = client.clientId ?? null;
    currentHost = hostId;
    state.hostClientId = hostId;
    state.linkId = randomId();
    state.relayed = null;
    state.candidateTypes = null;
    state.openedAtMs = null;
    setState('connecting');
    const linkId = state.linkId;
    try {
      pc = new RTCPeerConnection(rtcConfig);
      channel = pc.createDataChannel('segments', { ordered: true });
      wireChannel(channel);
      pc.addEventListener('icecandidate', (event) => {
        if (!tornDown && event?.candidate) {
          const candidate = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
          sendSignal('host-link-ice', { linkId, candidate });
        }
      });
      pc.addEventListener('connectionstatechange', () => {
        if (!tornDown && pc.connectionState === 'failed') fail(new Error('peer connection failed'));
      });
      const offer = await pc.createOffer();
      if (tornDown || state.linkId !== linkId) return;
      await pc.setLocalDescription(offer);
      sendSignal('host-link-offer', { linkId, sdp: offer.sdp ?? offer });
    } catch (error) {
      if (!tornDown && state.linkId === linkId) tearDown('failed', error);
    }
  }

  // A link that fails after this viewer rejoined was initiated under a departed
  // clientId, and the host drops a pc whose viewer left its roster: re-initiate.
  function fail(error) {
    tearDown('failed', error);
    if (currentHost && client.clientId !== ownClientId) void initiate(currentHost);
  }

  function discover(value) {
    const host = rosterFrom(value).find((entry) => entry?.role === 'host');
    const hostId = host?.clientId ?? null;
    if (!hostId) {
      currentHost = null;
      if (state.state !== 'absent' || pc) tearDown('absent');
      return;
    }
    if (hostId !== currentHost) {
      tearDown('absent');
      void initiate(hostId);
      return;
    }
    // An open link survives the viewer's own rejoin.
    if (state.state !== 'open' && client.clientId !== ownClientId) void initiate(hostId);
  }

  function incomingAnswer(env) {
    if (!pc || env?.from !== currentHost || env.payload?.linkId !== state.linkId) return;
    const sdp = env.payload?.sdp;
    Promise.resolve(pc.setRemoteDescription({ type: 'answer', sdp }))
      .then(async () => {
        const queued = queuedIce.splice(0);
        for (const candidate of queued) await addCandidate(candidate);
      })
      .catch((error) => {
        if (!tornDown) tearDown('failed', error);
      });
  }

  function incomingIce(env) {
    if (env?.from !== currentHost || env.payload?.linkId !== state.linkId) return;
    void addCandidate(env.payload?.candidate);
  }

  client.on('host-link-answer', incomingAnswer);
  client.on('host-link-ice', incomingIce);
  // Only the server's presence names the host: a member can relay an envelope
  // typed `presence` (7a d1-findings D1-1).
  client.on('presence', (env) => {
    if (env?.from === ADDR_SERVER) discover(env);
  });
  client.onEvent('joined', discover);

  return {
    snapshot,
    receipts(afterSeq = 0) {
      return {
        records: receiptLog.filter((entry) => entry.seq > afterSeq).map((entry) => ({ ...entry })),
        latestSeq: latestReceiptSeq,
        missed: missedReceipts,
      };
    },
    request({ path, range = null, handlers = {} }) {
      const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {};
      if (state.state !== 'open' || !channel || channel.readyState !== 'open') {
        queueMicrotask(() => onError(0));
        return { abort() {} };
      }
      const id = nextId++;
      const requestId = `${state.linkId}:${id}`;
      state.requestsByPath[path] = (state.requestsByPath[path] ?? 0) + 1;
      const entry = {
        path,
        requestId,
        startMs: wallNow(),
        headMs: null,
        head: null,
        bodyBytes: 0,
        receiptDone: false,
        onHead: (head) => {
          entry.head = head;
          entry.headMs = wallNow();
          (handlers.onHead ?? (() => {}))(head);
        },
        onChunk: (chunk) => {
          entry.bodyBytes += chunk.byteLength;
          (handlers.onChunk ?? (() => {}))(chunk);
        },
        onEnd: handlers.onEnd ?? (() => {}),
        onError,
      };
      pending.set(id, entry);
      try {
        channel.send(encodeControl({ t: 'req', id, path, range }));
      } catch {
        pending.delete(id);
        finishReceipt(entry, false, true);
        queueMicrotask(() => onError(0));
      }
      return {
        abort() {
          if (!pending.has(id)) return;
          pending.delete(id);
          finishReceipt(entry, false, true);
          if (channel?.readyState === 'open') {
            try { channel.send(encodeControl({ t: 'abort', id })); } catch { /* link close reports through teardown */ }
          }
        },
      };
    },
    close() {
      tearDown('absent');
      currentHost = null;
    },
    createShimFetch({ realFetch, baseUrl }) {
      return createShimFetch({ link: this, realFetch, baseUrl });
    },
    createShimXhr({ RealXHR, baseUrl }) {
      return createShimXhr({ link: this, RealXHR, baseUrl });
    },
  };
}

