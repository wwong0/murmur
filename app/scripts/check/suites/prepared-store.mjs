import { assert, assertEqual, check } from '../harness.mjs';
import {
  MANIFEST_NAME,
  createPreparedStore,
  lockName,
  storageFit,
  storeKey,
} from '../../../public/lib/prepared-store.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';

const IDENTITY = `v1:${'a'.repeat(64)}`;
const bytes = {
  init: Uint8Array.from([1, 2, 3]),
  first: Uint8Array.from([4, 5]),
  second: Uint8Array.from([6, 7, 8]),
  manifest: Uint8Array.from([9]),
};

function rig() {
  const locks = createFakeLockManager();
  const backend = createMemoryBackend({ locks });
  return { locks, backend, store: createPreparedStore({ backend, locks }) };
}

async function complete(store, key) {
  const sink = store.sink(key);
  await sink.write(MANIFEST_NAME, bytes.manifest);
}

async function reads(store, key, names) {
  return Promise.all(names.map((name) => store.read(key, name)));
}

export default async function preparedStoreSuite() {
  await check('prepared-store: keys encode identity, target and format exactly', async () => {
    const four = storeKey({ identity: IDENTITY, targetSeconds: 4 });
    const two = storeKey({ identity: IDENTITY, targetSeconds: 2 });
    assertEqual(four, `v1-${'a'.repeat(64)}-t4000-f1`, 'four-second key');
    assert(four !== two, 'target changes the key');
    let error = null;
    try { storeKey({ identity: 'v1:not-an-identity', targetSeconds: 4 }); } catch (caught) { error = caught; }
    assert(error instanceof TypeError, 'malformed identity throws');
  });

  await check('prepared-store: incomplete writes are never served', async () => {
    const { backend, store } = rig();
    const key = storeKey({ identity: IDENTITY, targetSeconds: 4 });
    const sink = store.sink(key);
    await sink.write('init.mp4', bytes.init);
    await sink.write('seg-00000.m4s', bytes.first);
    await sink.write('seg-00001.m4s', bytes.second);
    const names = ['init.mp4', 'seg-00000.m4s', 'seg-00001.m4s'];
    const incomplete = await reads(store, key, names);
    assertEqual(JSON.stringify(incomplete.map(({ status }) => status)), JSON.stringify([404, 404, 404]), 'incomplete files are hidden');
    assertEqual(JSON.stringify(backend.writes), JSON.stringify(names.map((name) => ({ dir: key, name }))), 'writes are logged in order');
    assertEqual(await store.isComplete(key), false, 'manifest absence is incomplete');
    await sink.write(MANIFEST_NAME, bytes.manifest);
    const completeReads = await reads(store, key, names);
    assertEqual(JSON.stringify(completeReads.map(({ status }) => status)), JSON.stringify([200, 200, 200]), 'manifest makes the copy complete');
    assertEqual(JSON.stringify(completeReads.map(({ bytes: value }) => [...value])), JSON.stringify([[1, 2, 3], [4, 5], [6, 7, 8]]), 'complete reads return written bytes');
  });

  await check('prepared-store: closed tab titles are swept in directory order', async () => {
    const { backend, store } = rig();
    const completeKey = storeKey({ identity: IDENTITY, targetSeconds: 4 });
    const partialKey = storeKey({ identity: IDENTITY, targetSeconds: 2 });
    await complete(store, completeKey);
    await store.sink(partialKey).write('seg-00000.m4s', bytes.first);
    const result = await store.sweep();
    assertEqual(JSON.stringify(result), JSON.stringify({ removed: [completeKey, partialKey], kept: [] }), 'unheld keys are removed');
    assertEqual(JSON.stringify(await backend.list()), '[]', 'sweep empties the backend');
  });

  await check('prepared-store: another open tab and keep both preserve keys', async () => {
    const { locks, store } = rig();
    const heldKey = storeKey({ identity: IDENTITY, targetSeconds: 4 });
    const freeKey = storeKey({ identity: IDENTITY, targetSeconds: 2 });
    await complete(store, heldKey);
    await complete(store, freeKey);
    const release = locks.holdExternally(lockName(heldKey));
    const swept = await store.sweep();
    assertEqual(JSON.stringify(swept), JSON.stringify({ removed: [freeKey], kept: [heldKey] }), 'held key is kept and free key is removed');
    assertEqual((await store.read(heldKey, MANIFEST_NAME)).status, 200, 'held key remains readable');
    release();

    const keepRig = rig();
    const keptKey = storeKey({ identity: IDENTITY, targetSeconds: 8 });
    await complete(keepRig.store, keptKey);
    const kept = await keepRig.store.sweep({ keep: keptKey });
    assertEqual(JSON.stringify(kept), JSON.stringify({ removed: [], kept: [keptKey] }), 'explicit keep preserves a free key');
  });

  await check('prepared-store: sweep holds each removal lock until deletion finishes', async () => {
    const { backend, locks, store } = rig();
    const key = storeKey({ identity: IDENTITY, targetSeconds: 4 });
    await complete(store, key);
    const result = await store.sweep();
    assertEqual(JSON.stringify(result.removed), JSON.stringify([key]), 'key is removed');
    assertEqual(backend.removals.length, 1, 'one removal is observed');
    assertEqual(backend.removals[0].held, true, 'lock is held while backend removes');
    assertEqual(locks.isHeld(lockName(key)), false, 'lock is released afterwards');
  });

  await check('prepared-store: storage fit reports exact arithmetic and unknown capacity', async () => {
    assertEqual(JSON.stringify(storageFit({ sourceBytes: 1000, estimate: { quota: 1500, usage: 500 } })), JSON.stringify({ fits: true, neededBytes: 1000, freeBytes: 1000 }), 'fitting source');
    assertEqual(JSON.stringify(storageFit({ sourceBytes: 1001, estimate: { quota: 1500, usage: 500 } })), JSON.stringify({ fits: false, neededBytes: 1001, freeBytes: 1000 }), 'source over free capacity');
    assertEqual(JSON.stringify(storageFit({ sourceBytes: 1000, estimate: { usage: 500 } })), JSON.stringify({ fits: false, neededBytes: 1000, freeBytes: null }), 'unknown quota refuses');
  });
}
