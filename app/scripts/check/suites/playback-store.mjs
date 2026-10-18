import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { FROZEN_WS } from '../fixtures.mjs';
import {
  TYPE_PLAYBACK_OPERATION,
  TYPE_PLAYBACK_STATE_ANSWER,
  TYPE_PLAYBACK_STATE_REQUEST,
} from '../../../public/lib/envelope.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { mediaMsAt } from '../../../public/lib/playback-state.mjs';

const SETTINGS = Object.freeze({
  transitionLeadMs: 0,
  maxFutureMs: 1000,
  requestTimeoutMs: 100,
  backoffMs: 10,
  autoStart: () => false,
});

function memoryStore(value = null) {
  let slot = value;
  return {
    get: () => slot,
    set: (next) => { slot = String(next); },
    clear: () => { slot = null; },
    read: () => slot,
  };
}

function storedState({ version = 41, playing = false, atSharedMs = 1000, mediaMs = 120000, controlMode = 'host' } = {}) {
  return {
    lineage: `stored-${version}`,
    version,
    current: { playing, atSharedMs, mediaMs },
    previous: null,
    controlMode,
  };
}

function waitFor(test, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (test()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

function driver(client, options = {}) {
  return createPlaybackAcquisition({
    client,
    clock: options.clock ?? { sharedNow: () => performance.timeOrigin + performance.now() },
    settings: options.settings ?? SETTINGS,
    store: options.store,
    room: options.room,
    mintLineage: () => `fresh-${client.tabId ?? client.clientId}`,
    report: options.report,
  });
}

async function connectAndResolve(client, acquisition) {
  const joined = new Promise((resolve) => client.onEvent('joined', resolve));
  client.connect();
  await joined;
  await waitFor(() => acquisition.snapshot.resolved, 'playback state');
}

function fakeClient(clientId = 'self') {
  const events = new Map();
  const eventEvents = new Map();
  const sent = [];
  const client = {
    clientId,
    tabId: clientId,
    role: 'host',
    sent,
    on(type, fn) {
      const callbacks = events.get(type) ?? [];
      callbacks.push(fn);
      events.set(type, callbacks);
      return () => events.set(type, callbacks.filter((callback) => callback !== fn));
    },
    onEvent(type, fn) {
      const callbacks = eventEvents.get(type) ?? [];
      callbacks.push(fn);
      eventEvents.set(type, callbacks);
      return () => eventEvents.set(type, callbacks.filter((callback) => callback !== fn));
    },
    request: () => new Promise(() => {}),
    send(env) { sent.push(env); },
    emit(type, value) { for (const fn of events.get(type) ?? []) fn(value); },
    emitEvent(type, value) { for (const fn of eventEvents.get(type) ?? []) fn(value); },
  };
  return client;
}

function electionPair({ aState, bState } = {}) {
  const clients = new Map();
  const pending = new Map();
  let seq = 0;
  const make = (id, state) => {
    const client = fakeClient(id);
    const originalSend = client.send;
    client.send = (env) => {
      if (env.type === TYPE_PLAYBACK_STATE_ANSWER) {
        pending.get(env.replyTo)?.(env);
        pending.delete(env.replyTo);
        return;
      }
      if (env.type === TYPE_PLAYBACK_OPERATION) {
        const delivered = { ...env, from: id, seq: ++seq, ts: { recv: performance.timeOrigin + performance.now() } };
        for (const recipient of clients.values()) recipient.emit(TYPE_PLAYBACK_OPERATION, delivered);
        return;
      }
      originalSend(env);
    };
    client.request = ({ to }) => new Promise((resolve) => {
      const requestId = `${id}-request-${seq}`;
      pending.set(requestId, resolve);
      clients.get(to)?.emit(TYPE_PLAYBACK_STATE_REQUEST, { from: id, id: requestId, payload: {} });
    });
    clients.set(id, client);
    const store = state ? memoryStore(JSON.stringify({ room: 'r', state })) : undefined;
    const acquisition = driver(client, { store, room: state ? 'r' : undefined });
    return { client, acquisition };
  };
  return {
    a: make('A', aState),
    b: make('B', bState),
  };
}

function fakeJoined(client, roster = [{ clientId: client.clientId, role: client.role }]) {
  client.emitEvent('joined', { seq: 0, roster });
}

export default async function playbackStoreSuite() {
  await check('playback store: a stored paused sole state is recreated, and no store keeps the old fresh state', async ({ room, client }) => {
    const state = storedState({ playing: false, mediaMs: 120000, controlMode: 'host' });
    const store = memoryStore(JSON.stringify({ room, state }));
    const withStoreClient = client('stored', 'host', { url: FROZEN_WS });
    const withStore = driver(withStoreClient, { store, room });
    const freshRoom = `${room}-fresh`;
    const withoutStoreClient = client('fresh', 'host', { url: FROZEN_WS, room: freshRoom });
    const withoutStore = driver(withoutStoreClient);
    try {
      await Promise.all([
        connectAndResolve(withStoreClient, withStore),
        connectAndResolve(withoutStoreClient, withoutStore),
      ]);
      assertEqual(withStore.state.current.mediaMs, 120000, 'stored paused media position is recreated');
      assertEqual(withStore.state.controlMode, 'host', 'stored control mode is recreated');
      assertEqual(withoutStore.state.current.mediaMs, 0, 'without store the fresh position is zero');
      assertEqual(withoutStore.state.controlMode, 'open', 'without store the old open mode remains');
    } finally {
      withStore.dispose();
      withoutStore.dispose();
    }
  });

  await check('playback store: a stored playing mapping is copied at three instants', async ({ room, client }) => {
    const atSharedMs = performance.timeOrigin + performance.now() - 10000;
    const state = storedState({ playing: true, atSharedMs, mediaMs: 120000 });
    const store = memoryStore(JSON.stringify({ room, state }));
    const c = client('playing', 'host', { url: FROZEN_WS });
    const acquisition = driver(c, { store, room });
    try {
      await connectAndResolve(c, acquisition);
      for (const instant of [atSharedMs, atSharedMs + 10000, atSharedMs + 20000]) {
        assertEqual(mediaMsAt(acquisition.state, instant), mediaMsAt(state, instant), `stored mapping agrees at ${instant}`);
      }
    } finally {
      acquisition.dispose();
    }
  });

  await check('playback store: a mismatched room is ignored and the first B write replaces it', async ({ room, client }) => {
    const store = memoryStore(JSON.stringify({ room: 'A', state: storedState({ mediaMs: 120000 }) }));
    const c = client('B', 'host', { url: FROZEN_WS });
    const acquisition = driver(c, { store, room });
    try {
      await connectAndResolve(c, acquisition);
      assertEqual(acquisition.state.current.mediaMs, 0, 'a state labelled for room A is not held in room B');
      const written = JSON.parse(store.read());
      assertEqual(written.room, room, 'the first B application replaces the mismatched room label');
    } finally {
      acquisition.dispose();
    }
  });

  // hostRoom names the room in-page after the acquisition exists.
  await check('playback store: a room named after construction is the label written', async ({ room, client }) => {
    const store = memoryStore();
    let current = null;
    const c = client('B', 'host', { url: FROZEN_WS });
    const acquisition = driver(c, { store, room: () => current });
    try {
      current = room;
      await connectAndResolve(c, acquisition);
      assert(store.read() !== null, 'the first application after the room is named is stored');
      assertEqual(JSON.parse(store.read()).room, room, 'the stored label is the room named after construction');
    } finally {
      acquisition.dispose();
    }
  });

  await check('playback store: malformed entries are absent without reporting', async ({ room }) => {
    for (const raw of ['not json', '{}', JSON.stringify({ room, state: {} }), JSON.stringify(7)]) {
      const client = fakeClient();
      const reports = [];
      const store = memoryStore(raw);
      const acquisition = driver(client, { store, room, report: (where, error) => reports.push([where, error]) });
      try {
        fakeJoined(client);
        assertEqual(client.sent[0].payload.current.mediaMs, 0, `malformed entry ${raw} is absent`);
        assertEqual(client.sent[0].payload.controlMode, 'open', `malformed entry ${raw} keeps fresh mode`);
        assertEqual(reports.length, raw === 'not json' ? 1 : 0, `malformed entry ${raw} reports only parse failure`);
      } finally {
        acquisition.dispose();
      }
    }
  });

  await check('playback store: a higher stored version wins an election, while no stores retain fresh election behavior', async () => {
    const stored = electionPair({
      aState: storedState({ version: 41, mediaMs: 41000 }),
      bState: storedState({ version: 38, mediaMs: 38000 }),
    });
    try {
      const roster = [{ clientId: 'A', role: 'host' }, { clientId: 'B', role: 'viewer' }];
      fakeJoined(stored.a.client, roster);
      fakeJoined(stored.b.client, roster);
      await waitFor(() => stored.a.acquisition.state && stored.b.acquisition.state, 'stored election to resolve');
      assertEqual(stored.a.acquisition.state.current.mediaMs, 41000, 'version 41 mappings win the election');
      assertEqual(stored.b.acquisition.state.current.mediaMs, 41000, 'the other member applies version 41 mappings');
      assertEqual(stored.a.acquisition.state.version, 1, 'the elected creation carries the room sequence');
    } finally {
      stored.a.acquisition.dispose();
      stored.b.acquisition.dispose();
    }

    const fresh = electionPair();
    try {
      const roster = [{ clientId: 'A', role: 'host' }, { clientId: 'B', role: 'viewer' }];
      fakeJoined(fresh.a.client, roster);
      fakeJoined(fresh.b.client, roster);
      await waitFor(() => fresh.a.acquisition.state && fresh.b.acquisition.state, 'fresh election to resolve');
      assertEqual(fresh.a.acquisition.state.current.mediaMs, 0, 'without the store the fresh elected state starts at zero');
      assertEqual(fresh.a.acquisition.state.controlMode, 'open', 'without the store the fresh elected state stays open');
    } finally {
      fresh.a.acquisition.dispose();
      fresh.b.acquisition.dispose();
    }
  });

  await check('playback store: front route clears storage, while room route keeps it', async () => {
    const product = await bundleProductEntry();
    const makeStorage = () => {
      const values = new Map([['watchalong.playback-state', 'retained']]);
      let clears = 0;
      return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => { clears += 1; values.delete(key); },
        value: () => values.get('watchalong.playback-state') ?? null,
        clears: () => clears,
      };
    };
    const frontStorage = makeStorage();
    const front = runEntry(product.code, { search: '', globals: { sessionStorage: frontStorage } });
    assertEqual(frontStorage.value(), null, 'the front page clears the playback state');
    assertEqual(frontStorage.clears(), 1, 'the front page clears exactly once at load');

    const roomStorage = makeStorage();
    const roomPage = runEntry(product.code, { search: '?room=r&tab=t', globals: { sessionStorage: roomStorage } });
    await roomPage.settled();
    assertEqual(roomStorage.value(), 'retained', 'a room page keeps the playback state');
    assertEqual(roomStorage.clears(), 0, 'a room page does not clear the playback state');
  });
}
