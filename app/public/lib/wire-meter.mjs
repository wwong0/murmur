// The host's cumulative bytes on the wire, read from its peer connections'
// stats. Handed its connections, so it reads no page global.

// Every candidate pair's count, summed: the selected pair can change, and a
// superseded pair keeps what it sent.
export function candidatePairBytesSent(report) {
  let total = 0;
  report.forEach((stat) => {
    if (stat?.type === 'candidate-pair' && Number.isFinite(stat.bytesSent)) total += stat.bytesSent;
  });
  return total;
}

export function createWireMeter({ peers }) {
  if (typeof peers !== 'function') throw new TypeError('createWireMeter: peers is required');
  const last = new Map();
  const retired = new WeakSet();
  let retiredBytes = 0;

  async function read() {
    const current = new Set(peers());
    for (const [pc, bytes] of last) {
      if (current.has(pc)) continue;
      retiredBytes += bytes;
      last.delete(pc);
      retired.add(pc);
    }
    await Promise.all([...current].map(async (pc) => {
      let bytes = null;
      try {
        bytes = candidatePairBytesSent(await pc.getStats());
      } catch {
        // A failed read keeps the connection's last total.
      }
      if (retired.has(pc)) return;
      last.set(pc, Math.max(last.get(pc) ?? 0, bytes ?? 0));
    }));
    let total = retiredBytes;
    for (const bytes of last.values()) total += bytes;
    return total;
  }

  return Object.freeze({ read });
}
