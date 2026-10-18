import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { storeKey } from '../../../public/lib/prepared-store.mjs';

const TITLE_A = `v1:${'a'.repeat(64)}`;
const TITLE_B = `v1:${'b'.repeat(64)}`;
const LINEAGE = 'entry-title-lineage';
const HOST = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
const VIEWER = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function creation(title = TITLE_A) {
  return {
    type: 'playback-operation',
    from: 'h',
    seq: 2,
    ts: { recv: 10_001 },
    payload: {
      kind: 'create', lineage: LINEAGE, current: { playing: false, atSharedMs: 10_000, mediaMs: 0 },
      previous: null, controlMode: 'open', ...(title === undefined ? {} : { title }),
    },
  };
}

function titleOperation(title, seq = 3) {
  return {
    type: 'playback-operation',
    from: 'h',
    seq,
    ts: { recv: 10_001 },
    payload: {
      kind: 'title', basis: { lineage: LINEAGE, version: seq - 1 }, atSharedMs: 10_100, title,
    },
  };
}

function viewerPage(code) {
  return runEntry(code, {
    role: 'viewer',
    search: '?room=r&role=viewer&tab=v',
    settings: { delivery: 'host', trackerUrl: null, iceServers: [], mediaSource: 'file', targetSegmentSeconds: 2, autoStart: true },
    globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
  });
}

async function preparePage(page) {
  await drain();
  page.harness.roster = [HOST, VIEWER];
  page.harness.sharedNowMs = 10_000;
  page.emit('joined', { clientId: 'v', role: 'viewer', seq: 1, roster: [HOST, VIEWER] });
  page.deliver(creation());
}

function readyReport(page, identity, name = undefined) {
  page.deliver({
    type: 'host-status', from: 'h', payload: {
      state: 'ready', identity, ...(name === undefined ? {} : { name }),
    },
  });
}

function lastPoll(page) {
  return page.events.filter((event) => event.kind === 'playback-start-poll').at(-1)?.detail;
}

function storage(values) {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function missing() {
  const error = new Error('missing');
  error.name = 'NotFoundError';
  return error;
}

function preparedRoot(key, manifest) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const file = {
    async getFile() {
      return { arrayBuffer: async () => bytes.slice().buffer };
    },
  };
  const keyDirectory = {
    kind: 'directory',
    async getFileHandle(name) {
      if (name === 'content-manifest.json') return file;
      throw missing();
    },
  };
  const preparedDirectory = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      if (name === key) return keyDirectory;
      throw missing();
    },
    async *entries() { yield [key, keyDirectory]; },
  };
  return {
    async getDirectoryHandle(name) {
      if (name === 'prepared') return preparedDirectory;
      throw missing();
    },
  };
}

function hostPage(code) {
  const key = storeKey({ identity: TITLE_A, targetSeconds: 2 });
  const root = preparedRoot(key, { identity: TITLE_A, segments: [] });
  const locks = { request: async (name, options, callback) => callback({ name, options }) };
  return runEntry(code, {
    role: 'host',
    search: '?room=r&role=host&tab=h',
    settings: { delivery: 'host', trackerUrl: null, iceServers: [], mediaSource: 'file', targetSegmentSeconds: 2, autoStart: true },
    globals: {
      sessionStorage: storage({ 'watchalong.prepared-key': key, 'watchalong.prepared-name': 'title-a.mp4' }),
      MediaSource: { isTypeSupported: () => true },
      navigator: {
        storage: { getDirectory: async () => root, estimate: async () => ({ quota: 10_000_000, usage: 1 }) },
        locks,
      },
      Worker: class {
        addEventListener() {}
        postMessage() {}
      },
      TextEncoder,
      TextDecoder,
    },
  });
}

function loadAction(positionMs = 0) {
  return { kind: 'load', attemptId: 1, positionMs, scheduledPositionMs: positionMs, advanceMs: 0, seamEpochMs: 10_000, };
}

export default async function titleEntrySuite() {
  const product = await bundleProductEntry();

  await check('title-entry: host reports its name and issues one title per state identity', async () => {
    const page = hostPage(product.code);
    await drain();
    page.resolveSole({ clientId: 'h', nowMs: 10_000 });
    page.harness.sharedNowMs = 10_300;
    page.tick();
    await drain();
    assertEqual(page.view().title.name, 'title-a.mp4', `host view shows its prepared name (${JSON.stringify(page.app.hostFile())})`);
    assertEqual(page.app.title().name, 'title-a.mp4', 'host title seam shows its own name');
    const titleMessages = () => page.sent().filter((env) => env.payload?.kind === 'title');
    assertEqual(titleMessages().length, 1, 'host issues title once for the held state identity');
    page.deliver({ ...titleMessages()[0], seq: 3, from: 'h', ts: { recv: 10_101 } });
    page.tick();
    assertEqual(titleMessages().length, 1, 'applied title does not reissue for the same state identity');
  });

  await check('title-entry: A/B wait check — a viewer loads only while identities agree', async () => {
    const page = viewerPage(product.code);
    await preparePage(page);
    readyReport(page, TITLE_B, 'title-b.mp4');
    page.tick();
    assertEqual(lastPoll(page).titleReady, false, 'state A and report B keep the title unready');
    assertEqual(page.count('load'), 0, 'state A and report B produce no load');
    page.deliver(titleOperation(TITLE_B));
    page.act([loadAction(0)], { resolved: true });
    assertEqual(lastPoll(page).titleReady, true, 'state B and report B permit the title');
    assertEqual(page.count('load'), 1, 'matching identities allow a load');
  });

  await check('title-entry: destroy-before-load order — a title change discards old media', async () => {
    const page = viewerPage(product.code);
    await preparePage(page);
    readyReport(page, TITLE_A, 'title-a.mp4');
    page.act([loadAction(9_000)], { resolved: true });
    assertEqual(page.app.title().loadedTitle, TITLE_A, 'the initial load records title A');
    page.deliver(titleOperation(TITLE_B));
    const kinds = page.kinds();
    const destroyed = kinds.lastIndexOf('player-destroy');
    const unloaded = kinds.lastIndexOf('start-unload');
    assert(destroyed >= 0 && unloaded > destroyed, 'destroy precedes start unload on title change');
    assertEqual(page.app.title().loadedTitle, null, 'the old loaded title is cleared before replacement');
    readyReport(page, TITLE_B, 'title-b.mp4');
    page.act([loadAction(0)], { resolved: true });
    const after = page.kinds();
    const loaded = after.lastIndexOf('load');
    assert(loaded > unloaded, 'the new load follows destroy and unload');
    assertEqual(page.app.title().loadedTitle, TITLE_B, 'the replacement load records title B');
  });

  await check('title-entry: viewer report name is shown and an omitted name is empty', async () => {
    const page = viewerPage(product.code);
    await preparePage(page);
    readyReport(page, TITLE_A, 'holiday.mp4');
    assertEqual(page.view().title.name, 'holiday.mp4', 'viewer shows the believed report name');
    readyReport(page, TITLE_A);
    assertEqual(page.view().title.name, null, 'viewer renders an omitted report name as empty');
  });
}
