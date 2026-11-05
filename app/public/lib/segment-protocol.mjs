// The ordered data-channel protocol and its per-channel send bucket.

export const FRAME_HEADER_BYTES = 8;
export const CHUNK_PAYLOAD_BYTES = 65528;
export const FIRST_BYTE_BUDGET_MS = 500;
export const BUFFER_FLOOR_BYTES = 65536;
export const DRAIN_POLL_MS = 20;
export const RATE_WINDOW_MS = 1000;

const CONTROL_TYPES = new Set(['req', 'abort', 'head', 'end', 'err', 'echo', 'class']);
const textEncoder = new TextEncoder();

// A request's class only rises, urgent over near. `flags` carries
// `urgent` and `near`; any other class leaves them as they are.
export function raiseClass(flags, cls) {
  if (cls === 'urgent') {
    flags.urgent = true;
    flags.near = false;
  } else if (cls === 'near' && !flags.urgent) flags.near = true;
}

export function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('segment payload must be an ArrayBuffer or view');
}

function messageBytes(value) {
  return typeof value === 'string' ? textEncoder.encode(value).byteLength : asBytes(value).byteLength;
}

export function encodeFrame(id, seq, bytes) {
  const payload = asBytes(bytes);
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, id >>> 0, true);
  view.setUint32(4, seq >>> 0, true);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(payload);
  return frame;
}

export function decodeFrame(value) {
  let bytes;
  try {
    bytes = asBytes(value);
  } catch {
    return null;
  }
  if (bytes.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: view.getUint32(0, true),
    seq: view.getUint32(4, true),
    payload: bytes.slice(FRAME_HEADER_BYTES).buffer,
  };
}

export function encodeControl(object) {
  return JSON.stringify(object);
}

export function parseControl(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value && typeof value === 'object' && !Array.isArray(value) && CONTROL_TYPES.has(value.t) ? value : null;
}

export function parseRange(header) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (match[2] === '') return { start, end: null };
  const end = Number(match[2]);
  return Number.isSafeInteger(end) && end >= start ? { start, end } : null;
}

export function sliceForRange(total, range) {
  const size = Math.max(0, Number(total) || 0);
  if (range === null || range === undefined) {
    return { status: 200, start: 0, end: size - 1, length: size };
  }
  if (range.start >= size || range.end !== null && range.end < range.start) {
    return { status: 416, start: 0, end: -1, length: 0 };
  }
  const end = range.end === null ? size - 1 : Math.min(range.end, size - 1);
  return { status: 206, start: range.start, end, length: end - range.start + 1 };
}

function setting(settings, name, fallback) {
  return Number.isFinite(settings?.[name]) ? settings[name] : fallback;
}

export function createChannelSender({ channel, clock, settings = {}, onClosed = null, onCredited = null, gate = null, onWaiting = null, held = null, onChunk = null }) {
  const config = {
    chunkPayloadBytes: setting(settings, 'chunkPayloadBytes', CHUNK_PAYLOAD_BYTES),
    firstByteBudgetMs: setting(settings, 'firstByteBudgetMs', FIRST_BYTE_BUDGET_MS),
    bufferFloorBytes: setting(settings, 'bufferFloorBytes', BUFFER_FLOOR_BYTES),
    drainPollMs: setting(settings, 'drainPollMs', DRAIN_POLL_MS),
    rateWindowMs: setting(settings, 'rateWindowMs', RATE_WINDOW_MS),
  };
  const bodies = new Map();
  const order = [];
  const deliveredById = new Map();
  const frameFifo = [];
  const samples = [];
  let roundRobin = 0;
  let handedBytes = 0;
  let rateBytesPerMs = null;
  let busyMs = 0;
  let previousAt = clock.now();
  let previousBuffered = channel.bufferedAmount;
  let previousCursor = cursor();
  let timer = null;
  let waiting = false;
  let closed = false;
  let notified = false;
  let hasWaiting = false;
  let turn = null;

  channel.bufferedAmountLowThreshold = config.bufferFloorBytes;

  function cursor() {
    return handedBytes - channel.bufferedAmount;
  }

  // Credited payload plus the drained part of the first uncredited frame's
  // payload — byte-exact, unlike counting whole credited chunks alone.
  function drainedBodyBytes() {
    let total = 0;
    for (const bytes of deliveredById.values()) total += bytes;
    const first = frameFifo[0];
    if (first) {
      const frameStart = first.cumulativeEnd - (first.payloadBytes + FRAME_HEADER_BYTES);
      const partial = Math.min(Math.max(cursor() - frameStart - FRAME_HEADER_BYTES, 0), first.payloadBytes);
      total += partial;
    }
    return total;
  }

  function waitingBodyBytes() {
    let total = 0;
    for (const body of bodies.values()) total += body.bytes.byteLength - body.offset;
    return total;
  }

  function notifyWaiting() {
    const now = waitingBodyBytes() > 0;
    if (now === hasWaiting) return;
    hasWaiting = now;
    try { onWaiting?.(now); } catch { /* a waiting listener must not stop delivery */ }
  }

  function credit() {
    const drained = cursor();
    while (frameFifo.length > 0 && frameFifo[0].cumulativeEnd <= drained) {
      const frame = frameFifo.shift();
      deliveredById.set(frame.id, (deliveredById.get(frame.id) ?? 0) + frame.payloadBytes);
      try { onCredited?.(frame.id, frame.payloadBytes); } catch { /* accounting cannot stop delivery */ }
    }
  }

  function currentBound() {
    return Math.max(config.bufferFloorBytes, (rateBytesPerMs ?? 0) * config.firstByteBudgetMs);
  }

  function updateRate() {
    const now = clock.now();
    const elapsed = now - previousAt;
    const moved = cursor() - previousCursor;
    if (previousBuffered > 0 && elapsed > 0) {
      samples.push({ elapsed, moved });
      busyMs += elapsed;
      while (busyMs > config.rateWindowMs && samples.length > 1) busyMs -= samples.shift().elapsed;
      if (busyMs >= 4 * config.drainPollMs) {
        const movedTotal = samples.reduce((sum, sample) => sum + sample.moved, 0);
        rateBytesPerMs = movedTotal / busyMs;
      }
    }
  }

  function captureWake() {
    previousAt = clock.now();
    previousBuffered = channel.bufferedAmount;
    previousCursor = cursor();
  }

  function cancelWait() {
    if (!waiting) return;
    waiting = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    channel.removeEventListener('bufferedamountlow', wake);
  }

  function notifyClosed(error) {
    if (notified) return;
    notified = true;
    if (typeof onClosed === 'function') onClosed(error);
  }

  function closeInternal(error = null, report = false) {
    if (closed) return;
    closed = true;
    cancelWait();
    bodies.clear();
    order.length = 0;
    turn?.unregister();
    notifyWaiting();
    if (report) notifyClosed(error);
  }

  function sendRaw(data) {
    if (closed) return false;
    try {
      channel.send(data);
      handedBytes += messageBytes(data);
      credit();
      return true;
    } catch (error) {
      closeInternal(error, true);
      return false;
    }
  }

  function sendControl(object) {
    if (closed) return false;
    const sent = sendRaw(encodeControl(object));
    scheduleWake();
    return sent;
  }

  function removeBody(id) {
    bodies.delete(id);
    const index = order.indexOf(id);
    if (index !== -1) {
      order.splice(index, 1);
      if (index < roundRobin) roundRobin -= 1;
      if (roundRobin >= order.length) roundRobin = 0;
    }
    notifyWaiting();
  }

  // The next body in turn among urgent, near, then normal bodies.
  function select() {
    let fallback = null;
    let nearFallback = null;
    for (let scan = 0; scan < order.length; scan++) {
      const index = (roundRobin + scan) % order.length;
      const body = bodies.get(order[index]);
      if (!body || body.offset >= body.bytes.byteLength) continue;
      if (body.urgent) return { body, index };
      if (body.near) nearFallback ??= { body, index };
      fallback ??= { body, index };
    }
    return nearFallback ?? fallback;
  }

  function offer() {
    if (closed || channel.bufferedAmount >= currentBound()) return null;
    // The cap: the host holds a channel with too much unconfirmed.
    if (held?.() === true) return null;
    const selected = select();
    if (!selected) return null;
    return selected.body.urgent ? 'urgent' : selected.body.near ? 'near' : 'normal';
  }

  // One body chunk, and its `end` when it is the last. Returns the payload
  // length handed, or 0 when nothing was.
  function admitChunk() {
    const selected = select();
    if (!selected) return 0;
    const { body, index } = selected;
    const length = Math.min(config.chunkPayloadBytes, body.bytes.byteLength - body.offset);
    const frame = encodeFrame(body.id, body.seq, body.bytes.subarray(body.offset, body.offset + length));
    if (!sendRaw(frame)) return 0;
    body.offset += length;
    body.seq += 1;
    frameFifo.push({ id: body.id, cumulativeEnd: handedBytes, payloadBytes: length });
    roundRobin = (index + 1) % order.length;
    if (body.offset >= body.bytes.byteLength) {
      if (!sendControl({ t: 'end', id: body.id })) return length;
      removeBody(body.id);
    }
    onChunk?.();
    return length;
  }

  function admitOne() {
    const length = offer() === null ? 0 : admitChunk();
    notifyWaiting();
    return length;
  }

  // Gated, the arbiter decides whose chunk goes next across every channel
  // (send-arbiter.mjs); this channel only says it has one.
  function admit() {
    if (turn) {
      turn.poke(clock.now());
      return;
    }
    while (offer() !== null) {
      if (admitChunk() === 0) break;
    }
    notifyWaiting();
  }

  function runWake() {
    if (closed) return;
    credit();
    updateRate();
    admit();
    captureWake();
    scheduleWake();
  }

  function scheduleWake() {
    if (closed || waiting || (bodies.size === 0 && channel.bufferedAmount === 0)) return;
    waiting = true;
    channel.addEventListener('bufferedamountlow', wake);
    timer = clock.setTimeout(wake, config.drainPollMs);
  }

  // The buffer-low event, the drain poll and a new body all wake the same way.
  function wake() {
    cancelWait();
    runWake();
  }

  function onChannelClose() {
    closeInternal(new Error('data channel closed'), true);
  }

  channel.addEventListener('close', onChannelClose);
  turn = gate ? gate.register({ offer, admitOne }) : null;

  return {
    sendControl,
    start(id, bytes, { urgent = false, near = false } = {}) {
      if (closed || bodies.has(id)) return;
      const payload = asBytes(bytes);
      const body = {
        id,
        bytes: payload,
        offset: 0,
        seq: 0,
        urgent: urgent === true,
        near: near === true && urgent !== true,
      };
      bodies.set(id, body);
      order.push(id);
      wake();
      if (payload.byteLength === 0 && bodies.has(id)) {
        if (sendControl({ t: 'end', id })) removeBody(id);
      }
    },
    // A body's class only rises; bytes already framed stay framed.
    raise(id, cls) {
      const body = bodies.get(id);
      if (!body) return false;
      raiseClass(body, cls);
      wake();
      return true;
    },
    abort(id) {
      if (closed) return;
      removeBody(id);
      credit();
      scheduleWake();
      notifyWaiting();
    },
    close() {
      if (closed) return;
      closeInternal();
      channel.removeEventListener('close', onChannelClose);
    },
    delivered(id) {
      return deliveredById.get(id) ?? 0;
    },
    pendingFrames(id) {
      return frameFifo.reduce((count, frame) => count + (frame.id === id ? 1 : 0), 0);
    },
    drainedBodyBytes,
    waitingBodyBytes,
    flush() {
      if (!closed) credit();
    },
    stats() {
      return {
        handedBytes,
        drainedBytes: cursor(),
        rateBytesPerMs,
        boundBytes: currentBound(),
      };
    },
  };
}
