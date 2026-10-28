export function readSegmentStore(engine) {
  try {
    const storage = engine?.core?.segmentStorage;
    const cache = storage?.cache;
    if (!(cache instanceof Map) || !Number.isFinite(storage.segmentMemoryStorageLimit)) return null;
    let bytes = 0;
    for (const item of cache.values()) {
      if (!(item.data instanceof ArrayBuffer) || !Number.isSafeInteger(item.data.byteLength)) return null;
      bytes += item.data.byteLength;
    }
    return { bytes, segments: cache.size, limitMiB: storage.segmentMemoryStorageLimit };
  } catch {
    return null;
  }
}

export function createSegmentStoreMonitor() {
  let peakBytes = 0;
  let samples = 0;
  function read(engine) {
    const reading = readSegmentStore(engine);
    if (reading === null) return null;
    peakBytes = Math.max(peakBytes, reading.bytes);
    samples += 1;
    return { ...reading, peakBytes, samples };
  }
  return { read, sample(engine) { read(engine); } };
}
