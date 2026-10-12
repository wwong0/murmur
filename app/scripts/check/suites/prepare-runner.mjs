import { assert, assertEqual, check } from '../harness.mjs';
import { createPreparedStore } from '../../../public/lib/prepared-store.mjs';
import { createPrepareRunner } from '../../../public/lib/prepare-runner.mjs';
import { fileIdentity } from '../../../public/lib/file-identity.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';
import { prepare } from '../../../public/lib/remux.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';
import { loadFixture, memorySink, memorySource } from '../remux-rig.mjs';

// A file the runner may read `size` and `slice` of, and nothing else (rule 10).
function fileFor(bytes) {
  const blob = new Blob([bytes]);
  return new Proxy(blob, {
    get(target, property) {
      if (property === 'size') return target.size;
      if (property === 'slice') return target.slice.bind(target);
      throw new Error(`unexpected file property: ${String(property)}`);
    },
  });
}

function rig({ throwingWrite = 0 } = {}) {
  const locks = createFakeLockManager();
  const backend = createMemoryBackend({ locks });
  if (throwingWrite) {
    const write = backend.write;
    let count = 0;
    backend.write = async (...args) => {
      count += 1;
      if (count === throwingWrite) throw new Error('sink write failed');
      return write(...args);
    };
  }
  const store = createPreparedStore({ backend, locks });
  const posted = [];
  const runner = createPrepareRunner({ store, buildId: 'runner-build', post: (message) => posted.push(message) });
  return { backend, store, posted, runner };
}

async function prepareWithStore(store, fixture) {
  const sink = memorySink();
  const manifest = await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 2 });
  return { sink, manifest };
}

function sameFiles(actual, expected) {
  const actualNames = [...actual.keys()].sort();
  const expectedNames = [...expected.keys()].sort();
  assertEqual(JSON.stringify(actualNames), JSON.stringify(expectedNames), 'runner writes the expected names');
  for (const name of expectedNames) assertEqual(Buffer.from(actual.get(name)).toString('hex'), Buffer.from(expected.get(name)).toString('hex'), `${name} is byte-identical`);
}

export default async function prepareRunnerSuite() {
  await check('prepare-runner: The tab writes the same bytes', async () => {
    const fixture = loadFixture('varying.mp4');
    const { backend, store, posted, runner } = rig();
    const expected = await prepareWithStore(store, fixture);
    await runner({ t: 'prepare', id: 1, file: fileFor(fixture.bytes), key: 'prepared-key', targetSeconds: 2 });
    sameFiles(backend.directories.get('prepared-key'), expected.sink.files);
    assertEqual(backend.writes.at(-1).name, 'content-manifest.json', 'manifest is written last');
    assertEqual(JSON.stringify(JSON.parse(new TextDecoder().decode(backend.directories.get('prepared-key').get('content-manifest.json')))), JSON.stringify(posted[0].manifest), 'posted manifest is stored manifest');
    assertEqual(posted[0].buildId, 'runner-build', 'prepare reply carries build id');
  });

  await check('prepare-runner: inspect reports identity, size and tracks', async () => {
    const fixture = loadFixture('bframes.mp4');
    const { posted, runner } = rig();
    const index = await readSourceIndex(memorySource(fixture.bytes));
    const identity = await fileIdentity(memorySource(fixture.bytes));
    await runner({ t: 'inspect', id: 2, file: fileFor(fixture.bytes) });
    assertEqual(posted[0].t, 'inspected', 'inspect posts inspected');
    assertEqual(posted[0].identity, identity, 'inspect identity matches the source');
    assertEqual(posted[0].sourceBytes, fixture.bytes.byteLength, 'inspect reports file size');
    assertEqual(JSON.stringify(posted[0].tracks), JSON.stringify({ video: { codec: index.video.codec }, audio: index.audio ? { codec: index.audio.codec } : null }), 'inspect reports manifest tracks');
  });

  await check('prepare-runner: codec refusals are reported without writes', async () => {
    const fixture = loadFixture('refuse-video-codec.mp4');
    const { backend, posted, runner } = rig();
    await runner({ t: 'inspect', id: 3, file: fileFor(fixture.bytes) });
    await runner({ t: 'prepare', id: 4, file: fileFor(fixture.bytes), key: 'refused-key', targetSeconds: 2 });
    assertEqual(JSON.stringify(posted.map(({ t, reason }) => ({ t, reason }))), JSON.stringify([{ t: 'refused', reason: 'video-codec' }, { t: 'refused', reason: 'video-codec' }]), 'inspect and prepare refuse the video codec');
    assert(posted.every((message) => message.message.includes('mp4v')), 'refusal names mp4v');
    assertEqual(backend.writes.length, 0, 'refusal writes nothing');
  });

  await check('prepare-runner: a failed sink removes the partial copy', async () => {
    const fixture = loadFixture('varying.mp4');
    const { backend, posted, runner } = rig({ throwingWrite: 3 });
    await runner({ t: 'prepare', id: 5, file: fileFor(fixture.bytes), key: 'failed-key', targetSeconds: 2 });
    assertEqual(posted[0].t, 'failed', 'sink failure posts failed');
    assertEqual(JSON.stringify(await backend.list()), '[]', 'partial output is removed');
  });

  await check('prepare-runner: every reply carries the supplied build id', async () => {
    const fixture = loadFixture('refuse-video-codec.mp4');
    const { posted, runner } = rig();
    await runner({ t: 'inspect', id: 6, file: fileFor(fixture.bytes) });
    await runner({ t: 'prepare', id: 7, file: fileFor(fixture.bytes), key: 'build-key', targetSeconds: 2 });
    assert(posted.length === 2 && posted.every((message) => message.buildId === 'runner-build'), 'all posted messages use the runner build id');
  });
}
