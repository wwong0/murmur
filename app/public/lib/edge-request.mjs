import { EDGE_RECHECK_MS } from './urgent-source.mjs';

function wait(untilMs) {
  return Number.isFinite(untilMs) ? { do: 'wait', untilMs } : { do: 'none' };
}

function host(edgeSource, cancel) {
  return {
    do: 'host',
    reason: edgeSource.reason,
    rank: edgeSource.rank,
    cancel,
  };
}

export function edgeRequestStep({
  edgeSource = {},
  spreadChoice,
  request = {},
  nowMs = 0,
  canLoadThroughP2P = false,
  peerAvailable = false,
  canLoadThroughHttp = false,
  hostSlotFree = false,
  recheckMs = EDGE_RECHECK_MS,
} = {}) {
  const loading = request.status === 'loading';
  const p2pLoading = loading && request.downloadSource === 'p2p';
  if (loading && !p2pLoading) return { do: 'none' };

  if (p2pLoading) {
    if (edgeSource.source === 'move') {
      return spreadChoice?.holderId && peerAvailable
        ? { do: 'move', holderId: spreadChoice.holderId }
        : { do: 'none' };
    }
    if (edgeSource.source === 'p2p') return wait(edgeSource.wakeMs);
    if (edgeSource.source === 'http' && canLoadThroughHttp && hostSlotFree) return host(edgeSource, true);
    return { do: 'none' };
  }

  if (edgeSource.source === 'wait') return wait(edgeSource.untilMs);
  if (edgeSource.source === 'p2p') {
    if (spreadChoice?.holderId) {
      if (peerAvailable && canLoadThroughP2P) return { do: 'peer', holderId: spreadChoice.holderId };
      return { do: 'recheck', untilMs: nowMs + recheckMs };
    }
    if (Number.isFinite(spreadChoice?.waitUntilMs)) return wait(spreadChoice.waitUntilMs);
    return { do: 'recheck', untilMs: nowMs + recheckMs };
  }
  if (edgeSource.source === 'http' && canLoadThroughHttp && hostSlotFree) return host(edgeSource, false);
  return { do: 'none' };
}
