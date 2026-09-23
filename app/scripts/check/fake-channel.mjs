// Deterministic RTCDataChannel-shaped plumbing for the segment checks.

const encoder = new TextEncoder();

function bytesOf(data) {
  if (typeof data === 'string') return encoder.encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new TypeError('fake channel accepts strings and binary buffers');
}

function copyBinary(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

export function createFakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const channels = new Set();

  function drainChannels(ms, endTime) {
    if (ms <= 0) return;
    for (const channel of channels) channel._drain(ms, endTime);
  }

  function advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance requires a non-negative finite duration');
    const target = time + ms;
    for (;;) {
      let next = null;
      for (const timer of timers.values()) {
        if (timer.due > target) continue;
        if (next === null || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) next = timer;
      }
      if (next === null) {
        const elapsed = target - time;
        time = target;
        drainChannels(elapsed, time);
        return;
      }
      const elapsed = next.due - time;
      time = next.due;
      drainChannels(elapsed, time);
      if (!timers.has(next.id)) continue;
      timers.delete(next.id);
      next.fn();
    }
  }

  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, fn, due: time + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance,
    _attach(channel) {
      channels.add(channel);
    },
    _detach(channel) {
      channels.delete(channel);
    },
  };
}

export function createFakeChannel({ clock, drainBytesPerMs = 0, label = 'channel' }) {
  if (!clock || typeof clock.now !== 'function') throw new TypeError('a fake clock is required');
  let peer = null;
  let rate = Number(drainBytesPerMs) || 0;
  let sequence = 0;
  let fractionalDrain = 0;
  const queue = [];
  const listeners = new Map();
  const channel = {
    label,
    readyState: 'connecting',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    binaryType: 'arraybuffer',
    ledger: [],
    send,
    close,
    addEventListener(type, fn, options = {}) {
      if (!listeners.has(type)) listeners.set(type, new Map());
      listeners.get(type).set(fn, Boolean(options?.once));
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    setDrainRate(value) {
      rate = Math.max(0, Number(value) || 0);
    },
    _pair(other) {
      peer = other;
    },
    _makePeer() {
      const other = createFakeChannel({ clock, drainBytesPerMs: 0, label: `${label}-peer` });
      channel._pair(other);
      other._pair(channel);
      other._open();
      return other;
    },
    _open() {
      if (channel.readyState !== 'connecting') return;
      channel.readyState = 'open';
      emit('open', {});
    },
    _drain,
  };

  function emit(type, event) {
    const group = listeners.get(type);
    if (!group) return;
    for (const [fn, once] of [...group]) {
      if (once) group.delete(fn);
      fn.call(channel, event);
    }
  }

  function send(data) {
    if (channel.readyState !== 'open') {
      const error = new Error(`${label}: data channel is not open`);
      error.name = 'InvalidStateError';
      throw error;
    }
    const bytes = bytesOf(data);
    const wireData = copyBinary(data);
    const record = { seq: sequence++, bytes, sentAt: clock.now(), drainedAt: null, data: wireData };
    channel.ledger.push(record);
    queue.push({ data: wireData, bytes, remaining: bytes, record });
    channel.bufferedAmount += bytes;
  }

  function close() {
    if (channel.readyState === 'closed') return;
    channel.readyState = 'closing';
    channel.readyState = 'closed';
    clock._detach?.(channel);
    emit('close', {});
  }

  function _drain(ms, endTime) {
    if (channel.readyState !== 'open' || rate <= 0 || channel.bufferedAmount === 0) return;
    fractionalDrain += rate * ms;
    let available = Math.floor(fractionalDrain);
    fractionalDrain -= available;
    const wasAbove = channel.bufferedAmount > channel.bufferedAmountLowThreshold;
    const deliveries = [];
    let consumed = 0;
    while (available > 0 && queue.length > 0) {
      const item = queue[0];
      const used = Math.min(available, item.remaining);
      item.remaining -= used;
      available -= used;
      consumed += used;
      channel.bufferedAmount -= used;
      if (item.remaining === 0) {
        const drainedAt = endTime - ms + consumed / rate;
        item.record.drainedAt = drainedAt;
        queue.shift();
        deliveries.push(item.data);
      }
    }
    for (const data of deliveries) {
      if (!peer || peer.readyState === 'closed') continue;
      peer._deliver(data);
    }
    if (wasAbove && channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      emit('bufferedamountlow', {});
    }
  }

  channel._deliver = (data) => emit('message', { data: typeof data === 'string' ? data : data.slice(0) });
  clock._attach?.(channel);
  return channel;
}

export function createFakeLink({ clock, hostDrainBytesPerMs = 0, viewerDrainBytesPerMs = 0 }) {
  const host = createFakeChannel({ clock, drainBytesPerMs: hostDrainBytesPerMs, label: 'host' });
  const viewer = createFakeChannel({ clock, drainBytesPerMs: viewerDrainBytesPerMs, label: 'viewer' });
  host._pair(viewer);
  viewer._pair(host);
  host._open();
  viewer._open();
  return {
    host,
    viewer,
    closeBoth() {
      host.close();
      viewer.close();
    },
  };
}
