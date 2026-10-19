function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createHostGrace({ graceMs }) {
  if (!finite(graceMs) || graceMs < 0) throw new TypeError('graceMs must be finite and non-negative');

  // Running with a null start is pending: the departure came before a synchronised
  // clock, so the first finite tick anchors it.
  let running = false;
  let startedAtSharedMs = null;

  function observe({ hostPresent, atSharedMs }) {
    if (typeof hostPresent !== 'boolean') throw new TypeError('hostPresent must be boolean');
    if (hostPresent) {
      running = false;
      startedAtSharedMs = null;
    } else if (!running) {
      running = true;
      startedAtSharedMs = finite(atSharedMs) ? atSharedMs : null;
    }
  }

  function due(nowSharedMs) {
    if (!running || !finite(nowSharedMs)) return null;
    startedAtSharedMs ??= nowSharedMs;
    const endsAtSharedMs = startedAtSharedMs + graceMs;
    return nowSharedMs >= endsAtSharedMs ? endsAtSharedMs : null;
  }

  function snapshot() {
    return {
      running,
      pending: running && startedAtSharedMs === null,
      startedAtSharedMs,
      endsAtSharedMs: startedAtSharedMs === null ? null : startedAtSharedMs + graceMs,
    };
  }

  return { observe, due, snapshot };
}
