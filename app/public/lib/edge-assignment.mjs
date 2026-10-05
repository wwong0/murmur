export function viewerOrder(roster = []) {
  return (roster ?? [])
    .filter((member) => member?.role === 'viewer')
    .map((member) => member.clientId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function edgeRank({ viewerIds = [], selfId, segmentIndex } = {}) {
  const ids = Array.isArray(viewerIds) ? viewerIds : [];
  const count = ids.length;
  if (count === 0) return 0;
  const position = ids.indexOf(selfId);
  if (position === -1) return count;
  const index = Number.isSafeInteger(segmentIndex) && segmentIndex >= 0 ? segmentIndex : 0;
  const first = index % count;
  return (position - first + count) % count;
}

export const SPREAD_START_ANYWAY_MS = 1_500;

function sortIds(ids) {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function spreadChoice({
  selfPeerId,
  peers = [],
  segmentIndex,
  nowMs,
  holdersRoseMs,
} = {}) {
  const connected = Array.isArray(peers) ? peers : [];
  const holders = sortIds(connected.filter((peer) => peer?.loaded === true).map((peer) => peer.id));
  if (holders.length === 0) return { none: true };

  const waiters = sortIds([
    selfPeerId,
    ...connected.filter((peer) => peer?.loaded !== true).map((peer) => peer.id),
  ]);
  const index = Number.isSafeInteger(segmentIndex) && segmentIndex >= 0 ? segmentIndex : 0;
  const rotation = index % waiters.length;
  const rotated = [...waiters.slice(rotation), ...waiters.slice(0, rotation)];
  const place = rotated.indexOf(selfPeerId);
  const elapsed = nowMs - holdersRoseMs;
  if (place < holders.length || elapsed >= SPREAD_START_ANYWAY_MS) {
    for (let offset = 0; offset < holders.length; offset += 1) {
      const holderId = holders[(place + offset) % holders.length];
      const holder = connected.find((peer) => peer?.id === holderId);
      if (holder?.busy !== true) return { holderId };
    }
    return { none: true };
  }
  return { waitUntilMs: holdersRoseMs + SPREAD_START_ANYWAY_MS };
}
