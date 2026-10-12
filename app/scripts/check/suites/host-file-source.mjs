import { assert, assertEqual, check } from '../harness.mjs';
import { createPrepareClient } from '../../../public/lib/prepare-client.mjs';
import { createPrepareRunner } from '../../../public/lib/prepare-runner.mjs';
import { createHostFileSource } from '../../../public/lib/host-file-source.mjs';
import { lockName, createPreparedStore, storeKey } from '../../../public/lib/prepared-store.mjs';
import { fileIdentity } from '../../../public/lib/file-identity.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';
import { loadFixture, memorySource } from '../remux-rig.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';

function memory() {
  return { value: null, get() { return this.value; }, set(value) { this.value = value; }, clear() { this.value = null; } };
}

function clientFor(store, buildId = 'worker-build', counts = null) {
  const listeners = new Map([['message', []], ['error', []]]);
  const worker = {
    addEventListener(type, fn) { listeners.get(type).push(fn); },
    postMessage(data) {
      counts && (counts[data.t] += 1);
      void runner(data);
    },
  };
  const runner = createPrepareRunner({ store, buildId, post: (data) => {
    for (const fn of listeners.get('message')) fn({ data });
  } });
  return createPrepareClient({ worker });
}

function makeRig(options = {}) {
  const locks = createFakeLockManager();
  const backend = createMemoryBackend({ locks });
  if (options.throwingWrite) {
    const write = backend.write;
    let count = 0;
    backend.write = async (...args) => {
      count += 1;
      if (count === options.throwingWrite) throw new Error('sink write failed');
      return write(...args);
    };
  }
  const store = createPreparedStore({ backend, locks });
  const counts = { inspect: 0, prepare: 0 };
  const snapshots = [];
  const value = memory();
  const source = createHostFileSource({
    store, locks, memory: value, client: clientFor(store, 'worker-build', counts),
    isTypeSupported: options.supported ?? (() => true),
    estimate: async () => (typeof options.estimate === 'function' ? options.estimate() : options.estimate ?? { quota: 10_000_000, usage: 0 }),
    targetSeconds: options.targetSeconds ?? 4,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { backend, locks, store, source, counts, snapshots, memory: value };
}

async function choose(fixture, rigged) {
  await rigged.source.start();
  await rigged.source.choose(new Blob([fixture.bytes]));
}

export default async function hostFileSourceSuite() {
  await check('host-file-source: A codec variant the browser cannot play is refused by name', async () => {
    const fixture = loadFixture('varying.mp4');
    const index = await readSourceIndex(memorySource(fixture.bytes));
    const refused = makeRig({ supported: (mime) => !mime.startsWith('video/') });
    await choose(fixture, refused);
    const snapshot = refused.source.snapshot();
    assertEqual(snapshot.state, 'refused', 'video codec is refused');
    assertEqual(snapshot.refusal.reason, 'codec-unplayable', 'codec refusal reason');
    assert(snapshot.refusal.message.includes(index.video.codec), 'video refusal names the fixture codec');
    assertEqual(snapshot.workerCalls.prepare, 0, 'unplayable codec is refused before preparation');
    assertEqual(refused.backend.writes.length, 0, 'unplayable codec writes nothing');
    assert(!refused.snapshots.some((entry) => entry.state === 'ready'), 'unplayable codec never reports ready');

    const accepted = makeRig({ supported: () => true });
    await choose(fixture, accepted);
    assertEqual(accepted.source.snapshot().state, 'ready', 'the same input reaches ready when supported');
  });

  await check('host-file-source: an audio codec variant the browser cannot play is refused by name', async () => {
    const fixture = loadFixture('varying.mp4');
    const index = await readSourceIndex(memorySource(fixture.bytes));
    const rigged = makeRig({ supported: (mime) => !mime.startsWith('audio/') });
    await choose(fixture, rigged);
    assertEqual(rigged.source.snapshot().state, 'refused', 'audio codec is refused');
    assertEqual(rigged.source.snapshot().refusal.reason, 'codec-unplayable', 'audio refusal reason');
    assert(rigged.source.snapshot().refusal.message.includes(index.audio.codec), 'audio refusal names the fixture codec');
    assertEqual(rigged.source.snapshot().workerCalls.prepare, 0, 'audio refusal precedes preparation');
  });

  await check('host-file-source: A file that does not fit is refused before writing', async () => {
    const fixture = loadFixture('varying.mp4');
    const short = makeRig({ estimate: { quota: fixture.bytes.byteLength - 1, usage: 0 } });
    await choose(fixture, short);
    assertEqual(short.source.snapshot().state, 'refused', 'short storage is refused');
    assertEqual(short.source.snapshot().refusal.reason, 'storage', 'storage refusal reason');
    assertEqual(short.source.snapshot().refusal.neededBytes, fixture.bytes.byteLength, 'storage refusal names needed bytes');
    assertEqual(short.source.snapshot().refusal.freeBytes, fixture.bytes.byteLength - 1, 'storage refusal names free bytes');
    assertEqual(short.backend.writes.length, 0, 'short storage writes nothing');

    const accepted = makeRig({ estimate: { quota: fixture.bytes.byteLength + 1, usage: 0 } });
    await choose(fixture, accepted);
    assertEqual(accepted.source.snapshot().state, 'ready', 'one byte more reaches ready');
  });

  await check('host-file-source: a file the core refuses is refused with the core reason', async () => {
    const fixture = loadFixture('refuse-video-codec.mp4');
    const rigged = makeRig();
    await choose(fixture, rigged);
    assertEqual(rigged.source.snapshot().state, 'refused', 'core refusal reaches refused');
    assertEqual(rigged.source.snapshot().refusal.reason, 'video-codec', 'core reason is preserved');
    assert(rigged.source.snapshot().refusal.message.includes('mp4v'), 'core message is preserved');
    assertEqual(rigged.backend.writes.length, 0, 'core refusal writes nothing');
  });

  await check('host-file-source: A prepared title is published', async () => {
    const fixture = loadFixture('varying.mp4');
    const rigged = makeRig();
    await choose(fixture, rigged);
    const snapshot = rigged.source.snapshot();
    const stored = await rigged.store.read(snapshot.key, 'content-manifest.json');
    assertEqual(snapshot.state, 'ready', 'prepared title is ready');
    assertEqual(snapshot.origin, 'prepared', 'prepared title reports prepared origin');
    assertEqual(JSON.stringify(snapshot.manifest), JSON.stringify(JSON.parse(new TextDecoder().decode(stored.bytes))), 'published manifest is the stored manifest');
    assertEqual(JSON.stringify(snapshot.manifest.overTarget), JSON.stringify({ count: 1, longestSeconds: 5 }), 'prepared manifest reports the over-target segment');
    assertEqual(snapshot.manifest.targetSeconds, 4, 'prepared manifest target');
    assertEqual(rigged.memory.value, snapshot.key, 'memory is written only for ready output');
  });

  await check('host-file-source: The host reloads', async () => {
    const fixture = loadFixture('varying.mp4');
    const first = makeRig();
    await choose(fixture, first);
    const key = first.source.snapshot().key;
    first.locks.held.delete(lockName(key));
    const second = makeRig();
    second.store = first.store;
    second.locks = first.locks;
    second.memory = first.memory;
    second.source = createHostFileSource({ store: first.store, locks: first.locks, memory: first.memory, client: clientFor(first.store, 'worker-build', second.counts), isTypeSupported: () => true, estimate: async () => ({ quota: 10_000_000, usage: 0 }), targetSeconds: 4, onChange: (snapshot) => second.snapshots.push(snapshot) });
    await second.source.start();
    assertEqual(second.source.snapshot().state, 'ready', 'reload finds the complete title');
    assertEqual(second.source.snapshot().origin, 'found', 'reload reports found origin');
    assertEqual(JSON.stringify(second.source.snapshot().workerCalls), JSON.stringify({ inspect: 0, prepare: 0 }), 'reload does not call worker');
    assertEqual(JSON.stringify(second.counts), JSON.stringify({ inspect: 0, prepare: 0 }), 'reload client is unused');
  });

  await check('host-file-source: The title is gone after a reload', async () => {
    const fixture = loadFixture('varying.mp4');
    const first = makeRig();
    await choose(fixture, first);
    const key = first.source.snapshot().key;
    first.locks.held.delete(lockName(key));
    first.backend.directories.get(key).delete('content-manifest.json');
    const states = [];
    const second = createHostFileSource({ store: first.store, locks: first.locks, memory: first.memory, client: clientFor(first.store), isTypeSupported: () => true, estimate: async () => ({ quota: 10_000_000, usage: 0 }), targetSeconds: 4, onChange: (snapshot) => states.push(snapshot.state) });
    await second.start();
    assertEqual(JSON.stringify(states), JSON.stringify(['awaiting-file']), 'an incomplete title asks for a file and never reports ready');
    assertEqual(first.memory.value, null, 'an incomplete title clears memory');
    assertEqual(first.locks.isHeld(lockName(key)), false, 'an incomplete title releases its lock, so the next sweep removes it');
  });

  await check('host-file-source: a remembered key whose lock is held waits for a new choice', async () => {
    const fixture = loadFixture('varying.mp4');
    const first = makeRig();
    await choose(fixture, first);
    const second = createHostFileSource({ store: first.store, locks: first.locks, memory: first.memory, client: clientFor(first.store), isTypeSupported: () => true, estimate: async () => ({ quota: 10_000_000, usage: 0 }), targetSeconds: 4, onChange: () => {} });
    await second.start();
    assertEqual(second.snapshot().state, 'awaiting-file', 'duplicated tab waits for a file');
    assert(second.snapshot().swept.kept.includes(first.source.snapshot().key), 'held copy is kept');
  });

  await check('host-file-source: a chosen title whose lock is held fails without writing', async () => {
    const fixture = loadFixture('varying.mp4');
    const identity = await fileIdentity(memorySource(fixture.bytes));
    const key = storeKey({ identity, targetSeconds: 4 });
    const rigged = makeRig();
    const release = rigged.locks.holdExternally(lockName(key));
    await choose(fixture, rigged);
    assertEqual(rigged.source.snapshot().state, 'failed', 'held key fails');
    assert(rigged.source.snapshot().failure.includes('another tab is serving this title'), 'held key names the serving tab');
    assertEqual(rigged.backend.writes.length, 0, 'held key writes nothing');
    release();
  });

  await check('host-file-source: a pass that fails mid-way is removed', async () => {
    const fixture = loadFixture('varying.mp4');
    const rigged = makeRig({ throwingWrite: 3 });
    await choose(fixture, rigged);
    assertEqual(rigged.source.snapshot().state, 'failed', 'mid-way failure reaches failed');
    assertEqual(JSON.stringify(await rigged.backend.list()), '[]', 'mid-way failure removes the copy');
    assertEqual(rigged.memory.value, null, 'mid-way failure does not remember the key');
  });

  await check('host-file-source: only a ready host serves media paths', async () => {
    const fixture = loadFixture('varying.mp4');
    const rigged = makeRig();
    assertEqual((await rigged.source.read('/media/master.m3u8')).status, 404, 'starting source is hidden');
    await rigged.source.start();
    assertEqual((await rigged.source.read('/media/master.m3u8')).status, 404, 'awaiting source is hidden');
    await rigged.source.choose(new Blob([fixture.bytes]));
    const served = await rigged.source.read('/media/master.m3u8');
    const stored = await rigged.store.read(rigged.source.snapshot().key, 'master.m3u8');
    assertEqual(served.status, 200, 'ready source serves media');
    assert(stored.bytes.byteLength > 0 && Buffer.from(served.bytes).equals(Buffer.from(stored.bytes)), 'ready source serves the stored bytes');
    assertEqual((await rigged.source.read('/room.html')).status, 404, 'ready source hides non-media paths');
  });
}
