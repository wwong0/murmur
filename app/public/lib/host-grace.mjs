function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createHostGrace({ graceMs }) {
  if (!finite(graceMs) || graceMs < 0) throw new TypeError('graceMs must be finite and non-negative');

  let running = false;
  let pending = false;
  let startedAtSharedMs = null;
  let endsAtSharedMs = null;

  function cancel() {
    running = false;
    pending = false;
    startedAtSharedMs = null;
    endsAtSharedMs = null;
  }

  function start(atSharedMs) {
    running = true;
    if (finite(atSharedMs)) {
      pending = false;
      startedAtSharedMs = atSharedMs;
      endsAtSharedMs = atSharedMs + graceMs;
    } else {
      pending = true;
      startedAtSharedMs = null;
      endsAtSharedMs = null;
    }
  }

  function observe({ hostPresent, atSharedMs }) {
    if (typeof hostPresent !== 'boolean') throw new TypeError('hostPresent must be boolean');
    if (hostPresent) {
      cancel();
    } else if (!running) {
      start(atSharedMs);
    }
  }

  function due(nowSharedMs) {
    if (!running) return null;
    if (pending && finite(nowSharedMs)) {
      pending = false;
      startedAtSharedMs = nowSharedMs;
      endsAtSharedMs = nowSharedMs + graceMs;
    }
    return finite(nowSharedMs) && endsAtSharedMs !== null && nowSharedMs >= endsAtSharedMs
      ? endsAtSharedMs
      : null;
  }

  function snapshot() {
    return {
      running,
      pending,
      startedAtSharedMs,
      endsAtSharedMs,
    };
  }

  return { observe, due, snapshot };
}
