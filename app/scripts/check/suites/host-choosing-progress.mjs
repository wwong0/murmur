import { assert, assertEqual, check } from '../harness.mjs';
import { createHostFileSource } from '../../../public/lib/host-file-source.mjs';
import { ownHostStatus } from '../../../public/lib/host-status.mjs';
import { createPrepareClient } from '../../../public/lib/prepare-client.mjs';
import { createPrepareRunner } from '../../../public/lib/prepare-runner.mjs';
import { createPreparedStore } from '../../../public/lib/prepared-store.mjs';
import { createFakeLockManager, createMemoryBackend } from '../prepared-store-memory.mjs';
import { loadFixture } from '../remux-rig.mjs';

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
    store,
    buildId: 'choosing-progress-build',
    post: (data) => { for (const fn of listeners.get('message')) fn({ data }); },
  });
  return createPrepareClient({ worker });
}

export default async function hostChoosingProgressSuite() {
  await check('host-choosing-progress: own status reaches ready after preparing', async () => {
    const fixture = loadFixture('varying.mp4');
    const locks = createFakeLockManager();
    const backend = createMemoryBackend({ locks });
    const store = createPreparedStore({ backend, locks });
    const snapshots = [];
    let source;
    source = createHostFileSource({
      store,
      locks,
      memory: memory(),
      client: clientFor(store),
      isTypeSupported: () => true,
      estimate: async () => ({ quota: 10_000_000, usage: 0 }),
      targetSeconds: 4,
      onChange: () => snapshots.push(ownHostStatus({ mediaSource: 'file', hostFile: source.snapshot() })),
    });
    await source.start();
    await source.choose(new Blob([fixture.bytes]));
    const states = snapshots.map(({ state }) => state).filter((state, index, all) => index === 0 || state !== all[index - 1]);
    assertEqual(JSON.stringify(states), JSON.stringify(['choosing', 'preparing', 'ready']), 'status sequence is choosing, preparing, ready');
    const preparing = states.indexOf('preparing');
    assert(!states.slice(preparing + 1).includes('choosing'), 'choosing does not return after preparing');
  });
}
