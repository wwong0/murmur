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

class AwaitingWorker {
  constructor() { this.listeners = new Map([['message', []], ['error', []]]); }
  addEventListener(type, fn) { this.listeners.get(type).push(fn); }
  postMessage(message) {
    queueMicrotask(() => {
      const data = message.t === 'inspect'
        ? { t: 'inspected', id: message.id, buildId: 'entry-worker', identity: `v1:${'a'.repeat(64)}`, sourceBytes: 3, tracks: { video: { codec: 'avc1' } } }
        : { t: 'progress', id: message.id, buildId: 'entry-worker', doneBytes: 0, totalBytes: 1 };
      for (const fn of this.listeners.get('message')) fn({ data });
    });
  }
}

class RefuseOnceWorker extends AwaitingWorker {
  constructor() { super(); this.inspections = 0; }
  postMessage(message) {
    if (message.t === 'inspect' && this.inspections++ === 0) {
      queueMicrotask(() => {
        const data = { t: 'refused', id: message.id, buildId: 'entry-worker', reason: 'video-codec', message: 'the video codec is not H.264' };
        for (const fn of this.listeners.get('message')) fn({ data });
      });
      return;
    }
    super.postMessage(message);
  }
}

function browserGlobals({ Worker = AwaitingWorker, lock = null } = {}) {
  const locks = lock ?? { request: async (name, options, callback) => callback(null) };
  return {
    sessionStorage: sessionStorage(),
    MediaSource: { isTypeSupported: () => true },
    TextEncoder,
    TextDecoder,
    navigator: {
      storage: { getDirectory: async () => notFoundRoot(), estimate: async () => ({ quota: 10_000_000, usage: 0 }) },
      locks,
    },
    Worker,
  };
}

function hostPage(code, options = {}) {
  return runEntry(code, {
    role: options.role ?? 'host',
    search: options.search ?? '?room=r&role=host&tab=h',
    settings: {
      delivery: 'host',
      iceServers: [],
      mediaSource: options.mediaSource ?? 'file',
      targetSegmentSeconds: 2,
      autoStart: options.autoStart ?? true,
    },
    globals: options.globals ?? browserGlobals(),
  });
}

function statuses(page) {
  return page.sent().filter((env) => env.type === 'host-status');
}

function joined(page, roster = [{ clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 }]) {
  page.emit('joined', { clientId: 'h', role: 'host', seq: 1, roster });
}

export default async function hostPreparingEntrySuite() {
  const product = await bundleProductEntry();

  await check('host-preparing-entry: a file host joins once before a choice', async () => {
    const page = hostPage(product.code);
    await drain();
    assertEqual(page.count('connect'), 1, 'file host connects before choosing a file');
    assertEqual(page.app.hostFile().state, 'awaiting-file', 'file host awaits a choice');
  });

  await check('host-preparing-entry: joined host reports preparing synchronously', async () => {
    const page = hostPage(product.code);
    await drain();
    joined(page);
    const sent = statuses(page);
    assertEqual(sent.length, 1, 'joined host sends one status');
    assertEqual(JSON.stringify(sent[0].payload), JSON.stringify({ state: 'choosing' }), 'joined host reports choosing');
  });

  await check('host-preparing-entry: refusal returns a joined file host to choosing', async () => {
    const page = hostPage(product.code, { globals: browserGlobals({ Worker: RefuseOnceWorker }) });
    await drain();
    joined(page);
    page.chooseHostFile(new Blob([Uint8Array.from([1, 2, 3])]));
    await drain();
    assertEqual(JSON.stringify(statuses(page).at(-1).payload), JSON.stringify({ state: 'choosing' }), 'refusal reports choosing');
    assert(page.view().hostFile.status.includes('the video codec is not H.264'), 'file status names the refusal');
    assertEqual(page.view().hostFile.inputHidden, false, 'file input remains visible');
    assertEqual(page.sent().filter((env) => env.type === 'leave').length, 0, 'refusal does not leave the room');
    page.chooseHostFile(new Blob([Uint8Array.from([4, 5, 6])]));
    await drain();
    assert(statuses(page).some(({ payload }) => JSON.stringify(payload) === JSON.stringify({ state: 'preparing', fraction: 0 })), 'an answering worker reports preparing on retry');
  });

  await check('host-preparing-entry: only another member join forces a status', async () => {
    const host = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
    const viewer = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };
    const page = hostPage(product.code);
    await drain();
    joined(page, [host]);
    page.harness.roster = [host, viewer];
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'join', member: viewer, roster: [host, viewer] } });
    const afterJoin = statuses(page).length;
    assertEqual(afterJoin, 2, 'another member join forces the current status');
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'leave', member: viewer, roster: [host] } });
    assertEqual(statuses(page).length, afterJoin, 'leave does not force a status');
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'join', member: host, roster: [host] } });
    assertEqual(statuses(page).length, afterJoin, 'the host own join does not force a status');
  });

  await check('host-preparing-entry: dir host reports ready on joined', async () => {
    const page = hostPage(product.code, { mediaSource: 'dir' });
    await drain();
    joined(page);
    assertEqual(JSON.stringify(statuses(page).at(-1).payload), JSON.stringify({ state: 'ready' }), 'dir host reports ready');
  });

  await check('host-preparing-entry: http delivery sends no host status', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      search: '?room=r&role=host&tab=h',
      settings: { delivery: 'http', iceServers: [], mediaSource: 'file', targetSegmentSeconds: 2 },
      globals: browserGlobals(),
    });
    await drain();
    joined(page);
    page.deliver({ type: 'presence', from: 'server', payload: { event: 'join', member: { clientId: 'v', role: 'viewer' }, roster: [] } });
    assertEqual(statuses(page).length, 0, 'http delivery sends no status');
  });

  await check('host-preparing-entry: progress status is throttled and advances', async () => {
    let worker;
    class ProgressWorker extends AwaitingWorker {
      constructor() { super(); worker = this; }
      postMessage(message) {
        if (message.t === 'inspect') {
          super.postMessage(message);
          return;
        }
        this.prepare = message;
      }
      progress(doneBytes, totalBytes) {
        const data = { t: 'progress', id: this.prepare.id, buildId: 'entry-worker', doneBytes, totalBytes };
        for (const fn of this.listeners.get('message')) fn({ data });
      }
    }
    const page = hostPage(product.code, {
      globals: browserGlobals({
        Worker: ProgressWorker,
        lock: { request: (name, options, callback) => callback({ name }) },
      }),
    });
    await drain();
    page.setNow(0);
    joined(page);
    page.chooseHostFile(new Blob([Uint8Array.from([1, 2, 3])]));
    await drain();
    assertEqual(page.app.hostFile().state, 'preparing', 'worker preparation is active');
    page.setNow(500);
    worker.progress(100, 1000);
    assertEqual(statuses(page).length, 2, 'half-interval progress is not sent');
    page.setNow(1000);
    worker.progress(200, 1000);
    assertEqual(statuses(page).length, 3, 'one-second progress is sent');
    assertEqual(statuses(page).at(-1).payload.fraction, 0.2, 'sent progress carries the new fraction');
  });

  await check('host-preparing-entry: preparing viewer gates controls until the host is ready', async () => {
    const host = hostPage(product.code, { mediaSource: 'dir', autoStart: false, globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder } });
    await drain();
    host.resolveSole({ clientId: 'h', nowMs: 10_000 });
    const creation = host.sent().find((env) => env.payload?.kind === 'create');
    if (!creation) throw new Error('paused host creation was not sent');

    const page = runEntry(product.code, {
      role: 'viewer',
      search: '?room=r&role=viewer&tab=v',
      settings: { delivery: 'host', iceServers: [], mediaSource: 'dir', targetSegmentSeconds: 2, autoStart: false },
      globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
    });
    await drain();
    const hostMember = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
    const viewer = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };
    page.emit('joined', { clientId: 'v', role: 'viewer', roster: [hostMember, viewer] });
    page.deliver({ ...creation, room: 'r', from: 'h', seq: 1, ts: { recv: 10_000, send: 10_000 } });
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'choosing' } });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    const choosing = page.view();
    assertEqual(choosing.hostStatus.state, 'choosing', 'viewer believes the host is choosing');
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(choosing.controls[id].disabled, true, `${id} is disabled while choosing`);
    assertEqual(choosing.bar.preparing, true, 'bar records choosing as blocked');
    assertEqual(choosing.bar.syncShown, false, 'the sync dot is not shown while the host chooses');
    assertEqual(page.count('load'), 0, 'choosing host does not load media');
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'preparing', fraction: 0.4 } });
    page.tick();
    const preparing = page.view();
    assertEqual(preparing.hostStatus.state, 'preparing', 'viewer believes the host is preparing');
    assertEqual(preparing.hostStatus.fraction, 0.4, 'viewer shows the host fraction');
    assertEqual(preparing.hostStatus.received, 2, 'viewer counts the choosing and preparing reports');
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(preparing.controls[id].disabled, true, `${id} is disabled while preparing`);
    assertEqual(preparing.bar.preparing, true, 'bar records preparing');
    assertEqual(preparing.bar.syncShown, false, 'the sync dot is not shown while the host prepares');

    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'ready' } });
    page.tick();
    const ready = page.view();
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(ready.controls[id].disabled, false, `${id} follows paused-room rules after ready`);
    assertEqual(ready.bar.preparing, false, 'bar leaves preparing');
  });

  await check('host-preparing-entry: a file host gates its controls before the title is ready', async () => {
    const page = hostPage(product.code, { autoStart: false });
    await drain();
    page.resolveSole({ clientId: 'h', nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    const preparing = page.view();
    assertEqual(preparing.hostStatus.state, 'choosing', 'file host is choosing before a choice');
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(preparing.controls[id].disabled, true, `${id} is disabled for a preparing file host`);
    assertEqual(preparing.bar.preparing, true, 'file host bar records preparing');
    assertEqual(preparing.bar.syncShown, false, 'the file host\'s sync dot is not shown before a title loads');
  });

  // The source ignores a pick while it prepares, so the page must not store that pick's name.
  await check('host-preparing-entry: a pick ignored while preparing keeps the first file name', async () => {
    const globals = browserGlobals({ lock: { request: async (name, options, callback) => callback({ name, options }) } });
    const page = hostPage(product.code, { globals });
    await drain();
    joined(page);
    const named = (name, bytes) => Object.assign(new Blob([Uint8Array.from(bytes)]), { name });
    page.chooseHostFile(named('first.mp4', [1, 2, 3]));
    await drain();
    assertEqual(page.app.hostFile().state, 'preparing', `the first pick is preparing (${page.app.hostFile().failure})`);
    assertEqual(globals.sessionStorage.getItem('watchalong.prepared-name'), 'first.mp4', 'the accepted pick stores its name');
    page.chooseHostFile(named('second.mp4', [4, 5, 6]));
    await drain();
    assertEqual(page.app.hostFile().workerCalls.inspect, 1, 'the source ignored the second pick');
    assertEqual(globals.sessionStorage.getItem('watchalong.prepared-name'), 'first.mp4', 'an ignored pick does not replace the stored name');
  });
}
