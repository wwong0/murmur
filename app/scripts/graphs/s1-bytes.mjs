export function s1Data({ manifest, peerBytesByClient, binWidth = 10000 }) {
  const attempts = Object.values(peerBytesByClient).flat().filter((r) =>
    r.kind === 'attempt' && Number.isFinite(r.endMs)
  ).sort((a, b) => a.endMs - b.endMs);
  const start = attempts[0]?.endMs ?? null, peers = new Map(), bins = new Map();
  for (const attempt of attempts) {
    if (attempt.end !== 'loaded' || !Number.isFinite(attempt.bytes)) {
      continue;
    }
    const index = Math.floor((attempt.endMs - start) / binWidth);
    if (!bins.has(index)) {
      bins.set(index, { startMs: start + index * binWidth, hostBytes: 0, peerBytesBySender: {} });
    }
    const bin = bins.get(index);
    if (attempt.source === 'http') {
      bin.hostBytes += attempt.bytes;
    }
    if (attempt.source === 'p2p') {
      if (!peers.has(attempt.peerId)) {
        peers.set(attempt.peerId, `peer ${peers.size + 1}`);
      }
      const peer = peers.get(attempt.peerId);
      bin.peerBytesBySender[peer] = (bin.peerBytesBySender[peer] ?? 0) + attempt.bytes;
    }
  }
  const allBins = [];
  if (bins.size) {
    for (let index = 0; index <= Math.max(...bins.keys()); index += 1) {
      allBins.push(
        bins.get(index) ?? { startMs: start + index * binWidth, hostBytes: 0, peerBytesBySender: {} },
      );
    }
  }
  return {
    bins: allBins,
    marks: {
      warmupEnd: manifest.window?.startMs ?? null,
      windowEnd: manifest.window?.endMs ?? null,
      disturbance: manifest.disturbance?.atMs ?? null,
    },
  };
}
