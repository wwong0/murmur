import { assert, assertEqual, check } from '../harness.mjs';
import { createHostFileSource } from '../../../public/lib/host-file-source.mjs';
import { createPrepareClient } from '../../../public/lib/prepare-client.mjs';
import { createPrepareRunner } from '../../../public/lib/prepare-runner.mjs';
import { fileIdentity } from '../../../public/lib/file-identity.mjs';
import { createPreparedStore } from '../../../public/lib/prepared-store.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';
import { prepare } from '../../../public/lib/remux.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';
import { loadFixture, memorySink, memorySource } from '../remux-rig.mjs';

function memory() {
  return { value: null, get() { return this.value; }, set(value) { this.value = value; }, clear() { this.value = null; } };
}

function sameFiles(actual, expected) {
  assertEqual(JSON.stringify([...actual.keys()].sort()), JSON.stringify([...expected.keys()].sort()), 'progress does not change output names');
  for (const name of expected.keys()) assertEqual(Buffer.from(actual.get(name)).toString('hex'), Buffer.from(expected.get(name)).toString('hex'), `${name} remains byte-identical`);
}

function clientFor(store, buildId = 'worker-build') {
  const listeners = new Map([['message', []], ['error', []]]);
  let runner;
  const worker = {
    addEventListener(type, fn) { listeners.get(type).push(fn); },
    postMessage(data) { void runner(data); },
  };
  runner = createPrepareRunner({
    store, buildId,
    post: (data) => { for (const fn of listeners.get('message')) fn({ data }); },
  });
  return createPrepareClient({ worker });
}

function sourceRig(options = {}) {
  const locks = createFakeLockManager();
  const backend = createMemoryBackend({ locks });
  const store = createPreparedStore({ backend, locks });
  const snapshots = [];
  const source = createHostFileSource({
    store, locks, memory: memory(), client: options.client ?? clientFor(store),
    isTypeSupported: options.isTypeSupported ?? (() => true),
    estimate: async () => options.estimate ?? { quota: 10_000_000, usage: 0 },
    targetSeconds: options.targetSeconds ?? 4,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { backend, locks, store, source, snapshots };
}

export default async function preparationProgressSuite() {
  await check('preparation-progress: reports each segment and its computed payload total', async () => {
    const fixture = loadFixture('varying.mp4');
    const index = await readSourceIndex(memorySource(fixture.bytes));
    const total = [index.video, index.audio].filter(Boolean).reduce((sum, track) => sum + Array.from(track.sizes).reduce((part, size) => part + size, 0), 0);
    const reports = [];
    const sink = memorySink();
    const manifest = await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 4, onProgress: (report) => reports.push(report) });
    assertEqual(reports.length, manifest.segmentCount, 'one report is emitted per segment');
    assert(reports.length > 0, 'the segment pass has an opportunity to report');
    assert(reports.every((report) => report.totalBytes === total), 'each report carries the index-derived total');
    assert(reports.every((report, i) => i === 0 || report.doneBytes > reports[i - 1].doneBytes), 'done bytes increase strictly');
    assertEqual(reports.at(-1).doneBytes, total, 'the final report reaches the total');
  });

  await check('preparation-progress: progress leaves the prepared bytes unchanged', async () => {
    const fixture = loadFixture('varying.mp4');
    const plain = memorySink();
    const reported = memorySink();
    await prepare({ source: memorySource(fixture.bytes), sink: plain, targetSeconds: 4 });
    await prepare({ source: memorySource(fixture.bytes), sink: reported, targetSeconds: 4, onProgress: () => {} });
    sameFiles(reported.files, plain.files);
  });

  await check('preparation-progress: runner posts monotone per-mille progress and client waits for prepared', async () => {
    const fixture = loadFixture('varying.mp4');
    const locks = createFakeLockManager();
    const backend = createMemoryBackend({ locks });
    const store = createPreparedStore({ backend, locks });
    const messages = [];
    const observed = [];
    const listeners = [];
    let runner;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const worker = {
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
      postMessage(data) { void runner(data).finally(finish); },
    };
    runner = createPrepareRunner({
      store, buildId: 'progress-build',
      post: (data) => { messages.push(data); for (const fn of listeners) fn({ data }); },
    });
    const client = createPrepareClient({ worker });
    let progressCountAtResolve = null;
    const resultPromise = client.prepare(new Blob([fixture.bytes]), 'progress-key', 4, (report) => observed.push(report));
    resultPromise.then(() => { progressCountAtResolve = messages.filter((message) => message.t === 'progress').length; });
    await done;
    const result = await resultPromise;
    const progress = messages.filter((message) => message.t === 'progress');
    const perMille = progress.map(({ doneBytes, totalBytes }) => Math.floor(1000 * doneBytes / totalBytes));
    assert(progress.length > 0, 'the runner posts progress before its final reply');
    assert(progress.every((message) => message.id === 1 && message.buildId === 'progress-build'), 'progress carries the call id and build id');
    assert(perMille.every((value, i) => i === 0 || value > perMille[i - 1]), 'posted per-mille values increase strictly');
    assertEqual(perMille.at(-1), 1000, 'the final progress is per-mille 1000');
    assertEqual(result.t, 'prepared', 'the prepare promise resolves with prepared');
    assertEqual(progressCountAtResolve, progress.length, 'the prepare promise waits for the final progress');
    assertEqual(JSON.stringify(observed), JSON.stringify(progress), 'the client observes every progress post');
  });

  await check('preparation-progress: host snapshots expose an increasing fraction', async () => {
    const fixture = loadFixture('varying.mp4');
    const rig = sourceRig();
    await rig.source.start();
    await rig.source.choose(new Blob([fixture.bytes]));
    const preparing = rig.snapshots.filter((snapshot) => snapshot.state === 'preparing');
    const progress = preparing.slice(1).map((snapshot) => snapshot.fraction);
    assert(rig.snapshots.some((snapshot) => snapshot.state === 'inspecting' && snapshot.fraction === null), 'inspection has no fraction');
    assertEqual(preparing[0].fraction, 0, 'preparation starts at zero');
    assert(progress.length > 0 && progress.every((value) => value > 0 && value <= 1), 'progress fractions are in range');
    assert(progress.every((value, i) => i === 0 || value > progress[i - 1]), 'progress fractions increase strictly');
    assertEqual(rig.snapshots.at(-1).state, 'ready', 'preparation finishes ready');
    assertEqual(rig.snapshots.at(-1).fraction, null, 'ready clears the fraction');
  });

  await check('preparation-progress: refusal never exposes a fraction', async () => {
    const fixture = loadFixture('refuse-video-codec.mp4');
    const rig = sourceRig();
    await rig.source.start();
    await rig.source.choose(new Blob([fixture.bytes]));
    assert(rig.snapshots.length > 0, 'refusal had an observable state transition');
    assert(rig.snapshots.every((snapshot) => snapshot.fraction === null), 'refusal keeps the fraction null');
  });

  await check('preparation-progress: out-of-order reports cannot lower the fraction', async () => {
    const fixture = loadFixture('varying.mp4');
    const index = await readSourceIndex(memorySource(fixture.bytes));
    const identity = await fileIdentity(memorySource(fixture.bytes));
    const snapshots = [];
    const client = {
      buildId: () => 'constructed-build',
      inspect: async () => ({ t: 'inspected', identity, sourceBytes: fixture.bytes.length, tracks: { video: { codec: index.video.codec }, audio: { codec: index.audio.codec } } }),
      prepare: async (file, key, targetSeconds, onProgress) => {
        onProgress({ doneBytes: 500, totalBytes: 1000 });
        onProgress({ doneBytes: 300, totalBytes: 1000 });
        return { t: 'prepared', manifest: {} };
      },
    };
    const store = { sweep: async () => ({}), isComplete: async () => true, read: async () => ({ status: 200, bytes: new Uint8Array() }) };
    const locks = { hold: async () => () => {} };
    const source = createHostFileSource({
      store, locks, memory: memory(), client, isTypeSupported: () => true,
      estimate: async () => ({ quota: 10_000_000, usage: 0 }), targetSeconds: 4,
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await source.start();
    await source.choose(new Blob([fixture.bytes]));
    assert(snapshots.some((snapshot) => snapshot.state === 'preparing' && snapshot.fraction === 0.5), 'the first progress report is accepted');
    assert(!snapshots.some((snapshot) => snapshot.state === 'preparing' && snapshot.fraction === 0.3), 'a lower report is ignored');
  });
}
