import { SegmentMemoryStorage } from '../../../node_modules/p2p-media-loader-core/lib/segment-storage/segment-memory-storage.js';
import { readSegmentStore, createSegmentStoreMonitor } from '../../../public/lib/segment-store.mjs';
import { peerEngineConfig } from '../../../public/lib/peer-engine-config.mjs';
import { check, assert, assertEqual } from '../harness.mjs';

const engine = (storage) => ({ core: { segmentStorage: storage } });
async function makeStore(core) {
  const store = new SegmentMemoryStorage();
  await store.initialize(core, { highDemandTimeWindow: 15 }, { highDemandTimeWindow: 15 });
  store.setSegmentChangeCallback(() => {});
  return store;
}
async function put(store, index, size) {
  await store.storeSegment('swarm', 'stream', String(index), new ArrayBuffer(size), index * 2, index * 2 + 2, 'main', false);
}

export default async function segmentStoreSuite() {
  await check('segment store: pin and sum real library storage', async () => {
    const store = await makeStore({ segmentMemoryStorageLimit: 1024 });
    for (const [i, size] of [1000, 2000, 3000].entries()) await put(store, i, size);
    assertEqual(JSON.stringify(readSegmentStore(engine(store))), JSON.stringify({ bytes: 6000, segments: 3, limitMiB: 1024 }), 'real store is read');
  });
  await check('segment store: null, never zero for unreadable storage', async () => {
    for (const value of [{}, { core: {} }, engine({ cache: {}, segmentMemoryStorageLimit: 1 }),
      engine({ cache: new Map([[1, { data: {} }]]), segmentMemoryStorageLimit: 1 })]) {
      assertEqual(readSegmentStore(value), null, 'unreadable store is null');
    }
  });
  await check('segment store: peak survives eviction and engine replacement', async () => {
    const monitor = createSegmentStoreMonitor();
    const storage = { cache: new Map([[1, { data: new ArrayBuffer(6000) }]]), segmentMemoryStorageLimit: 1024 };
    assertEqual(monitor.read(engine(storage)).peakBytes, 6000, 'first peak');
    storage.cache.set(1, { data: new ArrayBuffer(2000) });
    const second = monitor.read(engine(storage));
    assertEqual(second.bytes, 2000, 'current bytes decrease');
    assertEqual(second.peakBytes, 6000, 'peak survives');
    assertEqual(second.samples, 2, 'both readings count');
  });
  await check('segment store: library holds the bound for the same segments', async () => {
    for (const [limit, bytes, segments] of [[1, 900_000, 3], [1024, 1_800_000, 6]]) {
      const store = await makeStore({ segmentMemoryStorageLimit: limit });
      store.onPlaybackUpdated(100, 1);
      for (let i = 0; i < 6; i += 1) {
        await put(store, i, 300_000);
        const reading = readSegmentStore(engine(store));
        assert(reading.bytes >= 0 && reading.bytes <= limit * 1_048_576, 'store stays within its limit');
      }
      const reading = readSegmentStore(engine(store));
      assertEqual(reading.bytes, bytes, 'final bytes');
      assertEqual(reading.segments, segments, 'final segments');
    }
  });
  await check('segment store: product config reaches the library', async () => {
    const core = peerEngineConfig({ roomId: 'room', trackerUrl: 'ws://tracker', iceServers: [] }).core;
    assertEqual(readSegmentStore(engine(await makeStore(core))).limitMiB, 1024, 'product limit reaches store');
  });
}
