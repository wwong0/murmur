// A room hosted from the front page starts empty, and Back from it reaches the front page.

import { assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { storeKey } from '../../../public/lib/prepared-store.mjs';

const TITLE = `v1:${'a'.repeat(64)}`;
const KEY_NAME = 'watchalong.prepared-key';
const NAME_NAME = 'watchalong.prepared-name';

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function storage(values) {
  const map = new Map(Object.entries(values));
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

function missing() {
  const error = new Error('missing');
  error.name = 'NotFoundError';
  return error;
}

// A complete prepared copy under `key`, so a page that still remembers it serves it.
function preparedRoot(key) {
  const bytes = new TextEncoder().encode(JSON.stringify({ identity: TITLE, segments: [] }));
  const keyDirectory = {
    kind: 'directory',
    async getFileHandle(name) {
      if (name === 'content-manifest.json') return { getFile: async () => ({ arrayBuffer: async () => bytes.slice().buffer }) };
      throw missing();
    },
  };
  const prepared = {
    kind: 'directory',
    async getDirectoryHandle(name) { if (name === key) return keyDirectory; throw missing(); },
    async removeEntry() {},
    async *entries() { yield [key, keyDirectory]; },
  };
  return { async getDirectoryHandle(name) { if (name === 'prepared') return prepared; throw missing(); } };
}

// One page per check; a pair differs only in `search`, the route the tab loads.
function filePage(code, search) {
  const key = storeKey({ identity: TITLE, targetSeconds: 2 });
  const session = storage({ [KEY_NAME]: key, [NAME_NAME]: 'title-a.mp4' });
  const page = runEntry(code, {
    role: 'host',
    search,
    settings: { delivery: 'host', trackerUrl: null, iceServers: [], mediaSource: 'file', targetSegmentSeconds: 2, autoStart: true },
    globals: {
      sessionStorage: session,
      MediaSource: { isTypeSupported: () => true },
      navigator: {
        storage: { getDirectory: async () => preparedRoot(key), estimate: async () => ({ quota: 10_000_000, usage: 1 }) },
        locks: { request: async (name, options, callback) => callback({ name, options }) },
      },
      Worker: class { addEventListener() {} postMessage() {} },
      TextEncoder,
      TextDecoder,
    },
  });
  return { page, session, key };
}

export default async function hostNewRoomSuite() {
  const product = await bundleProductEntry();

  await check('host-new-room D1: Host from a front page whose tab held a prepared copy starts empty', async () => {
    const { page, session } = filePage(product.code, '');
    page.screens().actions.host();
    await drain();
    assertEqual(page.app.hostFile().state, 'awaiting-file', 'the new room asks for a file');
    assertEqual(session.map.has(KEY_NAME), false, 'the prepared key is forgotten');
    assertEqual(session.map.has(NAME_NAME), false, 'the prepared name is forgotten');
  });

  // The other half of the pair: the same storage, loaded as the room it belongs to.
  await check('host-new-room D1: a reloaded host room keeps and serves its prepared copy', async () => {
    const { page, session, key } = filePage(product.code, '?room=r&role=host&tab=h');
    await drain();
    assertEqual(page.app.hostFile().state, 'ready', 'the reloaded host serves its copy');
    assertEqual(session.map.get(KEY_NAME), key, 'the prepared key is kept');
    assertEqual(session.map.get(NAME_NAME), 'title-a.mp4', 'the prepared name is kept');
  });

  await check('host-new-room D2: Host adds a history entry and replaces none', async () => {
    const page = runEntry(product.code, { search: '' });
    page.screens().actions.host();
    await page.settled();
    assertEqual(page.history.pushes.length, 1, 'Host pushes one entry');
    assertEqual(page.history.replacements.length, 0, 'Host keeps the front page entry');
  });

  await check('host-new-room D2: Back to the front page reloads, and a popstate within the room does not', async () => {
    const page = runEntry(product.code, { search: '' });
    page.screens().actions.host();
    await page.settled();
    // Whichever call wrote the room's address, so the unchanged entry fails on the reload, not here.
    page.location.search = (page.history.pushes[0] ?? page.history.replacements[0]).url;
    page.fireWindow('popstate');
    assertEqual(page.location.reloads, 0, 'the room keeps its page on its own address');
    page.location.search = '';
    page.fireWindow('popstate');
    assertEqual(page.location.reloads, 1, 'Back to the front page reloads it');
  });
}
