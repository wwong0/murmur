import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

async function drain() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function notFoundRoot() {
  return { getDirectoryHandle() { const error = new Error('missing'); error.name = 'NotFoundError'; throw error; } };
}

function sessionStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

class ReadyWorker {
  constructor() { this.listeners = new Map([['message', []], ['error', []]]); }
  addEventListener(type, fn) { this.listeners.get(type).push(fn); }
  postMessage(message) {
    queueMicrotask(() => {
      const data = { t: 'refused', id: message.id, buildId: 'entry-worker', reason: 'video-codec', message: 'video-codec: found mp4v.20.1' };
      for (const fn of this.listeners.get('message')) fn({ data });
    });
  }
}

function browserGlobals({ worker = ReadyWorker, locks = true, storage = true } = {}) {
  const globals = { sessionStorage: sessionStorage(), MediaSource: { isTypeSupported: () => true }, TextEncoder, TextDecoder };
  if (storage) globals.navigator = { storage: { getDirectory: async () => notFoundRoot(), estimate: async () => ({ quota: 10_000_000, usage: 0 }) } };
  if (locks) globals.navigator = { ...(globals.navigator ?? {}), locks: { request: async (name, options, callback) => callback(null) } };
  if (worker) globals.Worker = worker;
  return globals;
}

// One page, so a pair of checks differs in the field it names and in nothing else.
// `host` delivery is the only one a server allows beside `file` (D1).
function hostPage(code, { mediaSource = 'file', search = '?room=r&role=host&tab=h', role = 'host', globals = browserGlobals() } = {}) {
  return runEntry(code, { role, search, settings: { delivery: 'host', iceServers: [], mediaSource, targetSegmentSeconds: 2 }, globals });
}

export default async function hostFileEntrySuite() {
  const product = await bundleProductEntry();

  await check('host-file-entry: a file host waits for a choice before joining', async () => {
    const page = hostPage(product.code);
    await drain();
    assertEqual(page.count('connect'), 0, 'file host does not connect before a ready title');
    assertEqual(page.app.hostFile().state, 'awaiting-file', 'file host awaits a choice');
  });

  await check('host-file-entry: the same page with mediaSource dir connects once and hostFile is off', async () => {
    const page = hostPage(product.code, { mediaSource: 'dir' });
    await drain();
    assertEqual(page.count('connect'), 1, 'directory host connects');
    assertEqual(page.app.hostFile().state, 'off', 'directory host has no file source');
  });

  await check('host-file-entry: a viewer under file connects once', async () => {
    const page = hostPage(product.code, { search: '?room=r&role=viewer&tab=v', role: 'viewer', globals: { ...browserGlobals(), RTCPeerConnection: class {} } });
    await drain();
    assertEqual(page.count('connect'), 1, 'file viewer connects');
    assertEqual(page.app.hostFile().state, 'off', 'viewer has no host file source');
  });

  await check('host-file-entry: settings without mediaSource are invalid', async () => {
    const page = hostPage(product.code, { mediaSource: null });
    await drain();
    assertEqual(page.count('connect'), 0, 'invalid settings do not connect');
    assert(page.notices().some((text) => text.includes('invalid application settings')), 'invalid settings are noticed');
  });

  await check('host-file-entry: a worker refusal stays out of the room', async () => {
    const page = hostPage(product.code);
    await drain();
    page.chooseHostFile(new Blob([Uint8Array.from([1, 2, 3])]));
    await drain();
    assertEqual(page.app.hostFile().state, 'refused', 'worker refusal is published');
    assertEqual(page.app.hostFile().refusal.reason, 'video-codec', 'worker refusal reason is preserved');
    assertEqual(page.count('connect'), 0, 'worker refusal does not connect');
  });

  await check('host-file-entry: choosing before the input opens does nothing', async () => {
    const page = hostPage(product.code);
    page.chooseHostFile(new Blob([Uint8Array.from([1, 2, 3])]));
    assertEqual(page.count('connect'), 0, 'early choice does not connect');
    assertEqual(page.app.hostFile().state, 'off', 'early choice does not replace the initial view');
  });

  await check('host-file-entry: missing host capabilities fail by name and do not join', async () => {
    const cases = [
      ['navigator.storage.getDirectory', browserGlobals({ storage: false })],
      ['navigator.locks', browserGlobals({ locks: false })],
      ['Worker', browserGlobals({ worker: null })],
    ];
    for (const [name, globals] of cases) {
      const page = hostPage(product.code, { globals });
      await drain();
      assertEqual(page.count('connect'), 0, `${name} does not connect`);
      assertEqual(page.app.hostFile().state, 'failed', `${name} reports failed`);
      assertEqual(page.app.hostFile().failure, name, `${name} is named`);
    }
  });
}
