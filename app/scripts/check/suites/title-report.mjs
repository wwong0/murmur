import { assert, assertEqual, check } from '../harness.mjs';
import { buildHostStatusEnvelope, readHostStatus } from '../../../public/lib/envelope.mjs';
import { fileIdentity } from '../../../public/lib/file-identity.mjs';
import { createHostFileSource, hostFileSnapshot } from '../../../public/lib/host-file-source.mjs';
import { ownHostStatus } from '../../../public/lib/host-status.mjs';
import { isFileIdentity, isValidHostName } from '../../../public/lib/title-fields.mjs';
import { createPrepareClient } from '../../../public/lib/prepare-client.mjs';
import { createPrepareRunner } from '../../../public/lib/prepare-runner.mjs';
import { createPreparedStore } from '../../../public/lib/prepared-store.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';
import { loadFixture, memorySource } from '../remux-rig.mjs';

function memory() {
  return { value: null, get() { return this.value; }, set(value) { this.value = value; }, clear() { this.value = null; } };
}

function clientFor(store) {
  const listeners = new Map([['message', []], ['error', []]]);
  let runner;
  const worker = {
    addEventListener(type, fn) { listeners.get(type).push(fn); },
    postMessage(data) { void runner(data); },
  };
  runner = createPrepareRunner({
    store, buildId: 'title-report-worker',
    post: (data) => { for (const fn of listeners.get('message')) fn({ data }); },
  });
  return createPrepareClient({ worker });
}

async function preparedFixture() {
  const fixture = loadFixture('even-1s.mp4');
  const locks = createFakeLockManager();
  const backend = createMemoryBackend({ locks });
  const store = createPreparedStore({ backend, locks });
  const source = createHostFileSource({
    store, locks, memory: memory(), client: clientFor(store),
    isTypeSupported: () => true,
    estimate: async () => ({ quota: 10_000_000, usage: 0 }),
    targetSeconds: 4, onChange: () => {},
  });
  await source.start();
  await source.choose(new Blob([fixture.bytes], { type: 'video/mp4' }));
  return { fixture, source, identity: await fileIdentity(memorySource(fixture.bytes)) };
}

function reportWith(payload) {
  const envelope = buildHostStatusEnvelope(payload);
  envelope.from = 'host';
  return envelope;
}

export default async function titleReportSuite() {
  await check('title-report: prepared ready reports carry the manifest identity and name', async () => {
    const { fixture, source, identity } = await preparedFixture();
    const snapshot = source.snapshot();
    assertEqual(snapshot.state, 'ready', 'the real prepare runner reaches ready');
    assertEqual(snapshot.manifest.identity, identity, 'manifest identity matches the independent file identity');
    assert(isFileIdentity(identity), 'the fixture identity has the wire shape');
    const ready = ownHostStatus({ mediaSource: 'file', hostFile: snapshot, name: 'holiday.mp4' });
    assertEqual(JSON.stringify(ready), JSON.stringify({ state: 'ready', fraction: null, identity, name: 'holiday.mp4' }), 'file ready status carries identity and name');
    const directory = ownHostStatus({ mediaSource: 'dir', hostFile: snapshot, name: fixture.name });
    assertEqual(JSON.stringify(directory), JSON.stringify({ state: 'ready', fraction: null }), 'dir status carries neither identity nor name');
    const wire = reportWith(ready);
    assertEqual(JSON.stringify(wire.payload), JSON.stringify({ state: 'ready', identity, name: 'holiday.mp4' }), 'ready envelope carries the exact three-field shape');
    assertEqual(JSON.stringify(readHostStatus(wire)), JSON.stringify({ from: 'host', state: 'ready', fraction: null, identity, name: 'holiday.mp4' }), 'ready reader returns identity and name');
  });

  await check('title-report: renamed copies retain identity and report their own names', async () => {
    const { fixture, source, identity } = await preparedFixture();
    const first = ownHostStatus({ mediaSource: 'file', hostFile: source.snapshot(), name: 'first.mp4' });
    const second = ownHostStatus({ mediaSource: 'file', hostFile: source.snapshot(), name: 'second.mp4' });
    assertEqual(first.identity, second.identity, 'same bytes keep one identity');
    assertEqual(first.identity, identity, 'both names use the prepared identity');
    assertEqual(first.name, 'first.mp4', 'first report keeps its name');
    assertEqual(second.name, 'second.mp4', 'renamed report keeps its own name');
  });

  await check('title-report: the name rule keeps safe names and omits path or control names', async () => {
    const identity = `v1:${'a'.repeat(64)}`;
    const hostFile = { state: 'ready', manifest: { identity } };
    for (const name of ['a/b.mp4', 'a\\b.mp4', '', 'a\u0007.mp4', 'x'.repeat(256)]) {
      assertEqual(isValidHostName(name), false, `rejects ${JSON.stringify(name)}`);
      assertEqual(Object.hasOwn(ownHostStatus({ mediaSource: 'file', hostFile, name }), 'name'), false, `omits ${JSON.stringify(name)}`);
    }
    assertEqual(ownHostStatus({ mediaSource: 'file', hostFile, name: 'holiday.mp4' }).name, 'holiday.mp4', 'keeps a safe name');
    const longName = `${'x'.repeat(251)}.mp4`;
    assertEqual(longName.length, 255, 'the boundary fixture is 255 UTF-16 units');
    assertEqual(ownHostStatus({ mediaSource: 'file', hostFile, name: longName }).name, longName, 'keeps a 255-unit name');
  });

  await check('title-report: invalid identity reports choosing without a wire cause', async () => {
    const errors = [];
    const status = ownHostStatus({
      mediaSource: 'file', hostFile: { state: 'ready', manifest: { identity: 'v1:XYZ' } }, name: 'holiday.mp4',
      report: (where, error) => errors.push({ where, error }),
    });
    assertEqual(JSON.stringify(status), JSON.stringify({ state: 'choosing', fraction: null }), 'invalid identity is not reported ready');
    assertEqual(errors.length, 1, 'invalid identity is reported');
    assertEqual(errors[0].where, 'host-status', 'identity report is diagnostic');
    assertEqual(buildHostStatusEnvelope(status).payload.state, 'choosing', 'the wire carries choosing only');
  });

  await check('title-report: ready reader accepts three shapes and rejects paths, causes and malformed identities', async () => {
    const identity = `v1:${'b'.repeat(64)}`;
    for (const payload of [{ state: 'ready' }, { state: 'ready', identity }, { state: 'ready', identity, name: 'holiday.mp4' }]) {
      assert(readHostStatus({ from: 'host', payload }) !== null, `accepts ${JSON.stringify(payload)}`);
    }
    const invalid = [
      { state: 'ready', identity: 'v1:XYZ' },
      { state: 'ready', identity: `V1:${'b'.repeat(64)}` },
      { state: 'ready', identity, name: 'a/b.mp4' },
      { state: 'ready', name: 'holiday.mp4' },
      { state: 'ready', identity, extra: true },
      { state: 'ready', identity, cause: 'codec' },
    ];
    for (const payload of invalid) assertEqual(readHostStatus({ from: 'host', payload }), null, `rejects ${JSON.stringify(payload)}`);
    let error = null;
    try { buildHostStatusEnvelope({ state: 'ready', identity, name: 'a/b.mp4' }); } catch (caught) { error = caught; }
    assert(error instanceof TypeError, 'builder rejects a path name');
  });

  await check('title-report: the stored name remains outside the host-file snapshot and report causes', async () => {
    const identity = `v1:${'c'.repeat(64)}`;
    const snapshot = hostFileSnapshot({ mediaSource: 'file', targetSegmentSeconds: 4, state: 'ready', manifest: { identity } });
    const status = ownHostStatus({ mediaSource: 'file', hostFile: snapshot, name: 'holiday.mp4' });
    assertEqual(Object.hasOwn(snapshot, 'name'), false, 'host-file snapshot has no stored name');
    assertEqual(Object.hasOwn(status, 'name'), true, 'only the ready status receives the stored name');
    assertEqual(Object.hasOwn(buildHostStatusEnvelope(status).payload, 'cause'), false, 'ready report has no cause');
  });
}
