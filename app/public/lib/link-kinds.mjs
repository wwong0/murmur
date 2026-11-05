export const LINKS_LINE_RE = /^host links: \d+ direct · \d+ relayed · \d+ pending$/;

export function linkKind(statsReport) {
  if (!statsReport) return 'pending';
  return statsReport.relayed === true ? 'relayed' : 'direct';
}

export function linksText({ direct = 0, relayed = 0, pending = 0 } = {}) {
  return `host links: ${direct} direct · ${relayed} relayed · ${pending} pending`;
}

const usable = (peerConnection) => peerConnection
  && peerConnection.connectionState !== 'closed'
  && peerConnection.iceConnectionState !== 'closed';

// The links line's counts: one refresh at a time, read from each usable link's
// selected pair, counting only links still open when the reads return. `tick` refreshes at most
// every `intervalMs`; `readStats` is absent until the host transport has loaded.
export function createLinkKinds({ links, readStats, onChange, intervalMs = 2_000 }) {
  let inFlight = false;
  let lastTickAt = null;
  let counts = { direct: 0, relayed: 0, pending: 0 };

  async function refresh() {
    const read = readStats();
    if (inFlight || typeof read !== 'function') return;
    inFlight = true;
    const peers = links().filter(usable);
    try {
      const reports = await Promise.all(peers.map(async (peerConnection) => {
        try {
          return { peerConnection, report: read(await peerConnection.getStats()) };
        } catch {
          return { peerConnection, report: null };
        }
      }));
      const current = new Set(links().filter(usable));
      counts = { direct: 0, relayed: 0, pending: 0 };
      for (const { peerConnection, report } of reports) {
        if (current.has(peerConnection)) counts[linkKind(report)] += 1;
      }
      onChange(linksText(counts));
    } finally {
      inFlight = false;
    }
  }

  return {
    refresh,
    tick(nowMs) {
      if (lastTickAt !== null && nowMs - lastTickAt < intervalMs) return;
      lastTickAt = nowMs;
      void refresh();
    },
    text: () => linksText(counts),
  };
}
