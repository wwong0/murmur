// scripts/check/entry-harness.mjs
//
// Runs the real bundled room.entry.js in a node:vm context, with no browser:
// the four network/media imports are replaced by entry-fakes.mjs, and the
// element is a scripted object whose pitch and rate writes are logged in order
// with everything else the page does.
//
// Two ways in. `bundleProductEntry` builds the product entry with the
// controller and sampler spied; `researchEsbuild` hands buildResearchBundle an
// esbuild whose builds also carry the fakes, so a composed research arm runs
// through its own resolver and wrappers unchanged.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { buildOptions, ENTRY_POINT } from '../build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKES = path.join(HERE, 'entry-fakes.mjs');

export const FAKED_SPECIFIERS = Object.freeze([
  './lib/room-client.mjs',
  './lib/clock-sync.mjs',
  './lib/player.mjs',
  './lib/playback-start.mjs',
  './room/screens.jsx',
]);
const SPIES = Object.freeze({
  './lib/drift-controller.mjs': path.join(HERE, 'entry-controller-spy.mjs'),
  './lib/frame-sampler.mjs': path.join(HERE, 'entry-sampler-spy.mjs'),
  './lib/host-link.mjs': path.join(HERE, 'entry-host-link-spy.mjs'),
});

/** Substitutes the entry's own imports only; `hits` lets a test prove all fired. */
export function entryFakesPlugin({ spies, hits = [] }) {
  const entry = path.resolve(ENTRY_POINT);
  return {
    name: 'entry-harness-fakes',
    setup(build) {
      build.onResolve({ filter: /^\.\/(lib|room)\// }, (args) => {
        if (path.resolve(args.importer) !== entry) return null;
        if (FAKED_SPECIFIERS.includes(args.path)) {
          hits.push(args.path);
          return { path: FAKES };
        }
        if (spies && SPIES[args.path]) {
          hits.push(args.path);
          return { path: SPIES[args.path] };
        }
        return null;
      });
    },
  };
}

export async function bundleProductEntry() {
  const hits = [];
  const result = await esbuild.build({
    ...buildOptions('entry-harness'),
    sourcemap: false,
    write: false,
    metafile: true,
    outfile: path.join(os.tmpdir(), 'entry-harness.bundle.js'),
    plugins: [...(buildOptions('entry-harness').plugins ?? []), entryFakesPlugin({ spies: true, hits })],
  });
  return { code: result.outputFiles[0].text, hits, metafile: result.metafile };
}

/** An esbuild for buildResearchBundle: its own plugins run after the fakes. */
export function researchEsbuild(hits = []) {
  return { build: (options) => esbuild.build({ ...options, plugins: [entryFakesPlugin({ spies: false, hits }), ...(options.plugins ?? [])] }) };
}

export async function withTempDir(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-harness-'));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * A scripted media element. `supported: false` is an extensible object with no
 * pitch property at all; `rejectWrite` keeps the old value; `throwOn` names the
 * accesses that throw ('has', 'write', 'read', 'read-after-write').
 */
export function fakeVideo({ supported = true, initial = true, paused = true, rejectWrite = false, throwOn = [], onEvent = () => {} } = {}) {
  const log = [];
  const state = { pitch: initial, rate: 1, written: false, readThrows: false, rateWritesFail: false, currentTime: 0 };
  const listeners = new Map();
  const plays = [];
  // Every armed `requestVideoFrameCallback`, so a test can both count the
  // consumers the page installed and deliver one frame to all of them.
  const armed = new Map();
  let frameHandles = 0;
  const note = (kind, value) => {
    log.push({ kind, value });
    onEvent(kind, value);
  };
  const video = {
    paused,
    readyState: 0,
    muted: true,
    get currentTime() { return state.currentTime; },
    set currentTime(value) {
      note('position-write', { value, paused: video.paused });
      state.currentTime = value;
    },
    /** A promise the test settles through `control.settlePlay`. */
    play() {
      note('play', null);
      video.paused = false;
      return new Promise((resolve, reject) => plays.push({ resolve, reject }));
    },
    pause() {
      note('pause', null);
      video.paused = true;
    },
    get playbackRate() { return state.rate; },
    set playbackRate(value) {
      note('rate-write', value);
      if (state.rateWritesFail) throw new Error('rate write refused');
      state.rate = value;
    },
    requestVideoFrameCallback(callback) {
      const handle = ++frameHandles;
      armed.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback(handle) {
      armed.delete(handle);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  if (supported) {
    Object.defineProperty(video, 'preservesPitch', {
      configurable: true,
      enumerable: true,
      get() {
        if (state.readThrows || throwOn.includes('read') || (state.written && throwOn.includes('read-after-write'))) throw new Error('pitch unreadable');
        return state.pitch;
      },
      set(value) {
        note('pitch-write', value);
        state.written = true;
        if (throwOn.includes('write')) throw new Error('pitch write refused');
        if (!rejectWrite) state.pitch = value;
      },
    });
  }
  const element = throwOn.includes('has') ? new Proxy(video, { has() { throw new Error('in refused'); } }) : video;
  const control = {
    log,
    /** Changes the flag the way a browser or another script would: not a page write. */
    setPitch(value) { state.pitch = value; },
    setReadThrows(value) { state.readThrows = value; },
    setRateWritesFail(value) { state.rateWritesFail = value; },
    fire(type) { for (const fn of listeners.get(type) ?? []) fn({ type }); },
    settlePlay(index, error = null) {
      if (error) plays[index].reject(error);
      else plays[index].resolve();
    },
    pitchWrites: () => log.filter((entry) => entry.kind === 'pitch-write'),
    rateWrites: () => log.filter((entry) => entry.kind === 'rate-write').map((entry) => entry.value),
    /** How many rVFC consumers the page has armed right now. */
    armedFrames: () => armed.size,
    /** One frame to every armed consumer, the way an element delivers it. */
    deliverFrame(metadata, nowMs = metadata.expectedDisplayTime) {
      for (const [handle, callback] of [...armed]) {
        armed.delete(handle);
        callback(nowMs, metadata);
      }
    },
  };
  return { video: element, control };
}

/** The scheduled start's published status, as the fake returns it. */
export const IDLE_START_STATE = Object.freeze({
  playing: false,
  resolved: false,
  missing: 'clock-estimate',
  waiting: null,
  opens: 0,
  begun: 0,
  retargets: 0,
  lastLatenessMs: null,
  lastPlayError: null,
  attemptId: null,
  startAtSharedMs: null,
  projectedAtSharedMs: null,
  reprojections: 0,
  skips: 0,
});

/**
 * Runs a bundle once, as a page load, against a fakeVideo built from
 * `videoOptions` whose writes land in the same ordered event list as the
 * page's own. `onLoad`/`onPark` receive the element's control.
 */
export function runEntry(code, { videoOptions = {}, search = '?room=r&tab=t', onPark, onLoad, settings = { delivery: 'http', iceServers: [] }, role = 'viewer', globals = {} } = {}) {
  let pinnedNowMs = null;
  const events = [];
  // Kept out of `events`, whose order several suites compare whole.
  const fetches = [];
  const intervals = [];
  const documentListeners = new Map();
  const location = {
    search,
    protocol: 'http:',
    host: '127.0.0.1:8100',
    href: 'http://127.0.0.1:8100/room.html',
    assignments: [],
    assign(url) { this.assignments.push(url); },
  };
  const history = { replacements: [], replaceState(state, title, url) {
    this.replacements.push({ state, title, url });
  } };
  const log = (kind, detail) => events.push({ kind, detail });
  const { video, control } = fakeVideo({ ...videoOptions, onEvent: log });
  const harness = {
    screens: null,
    clock: { offsetMs: null, halfWidthMs: null, sampleCount: 0, counters: { reanchors: 0 } },
    sharedNowMs: null,
    clientId: null,
    isJoined: false,
    role,
    roster: [],
    clientEvents: new Map(),
    clientHandlers: new Map(),
    playing: false,
    pendingActions: [],
    acceptSkip: false,
    skips: 0,
    skipPositionMs: 1234,
    pollThrows: false,
    finished: null,
    finishedHandlers: [],
    startState: { ...IDLE_START_STATE },
    onPark: onPark && (() => onPark(control)),
    onLoad: onLoad && (() => onLoad(control)),
    log,
  };
  const context = {
    __entryHarness: harness,
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    URL,
    crypto: globalThis.crypto,
    // The page's settings read; `settings: null` leaves the page without fetch.
    fetch: settings && (async (resource) => (fetches.push(String(resource)), String(resource) === '/app-settings'
      ? { ok: true, status: 200, json: async () => ({ trackerUrl: null, mediaSource: 'dir', targetSegmentSeconds: 2, autoStart: true, hostGraceMs: 10_000, ...settings }) }
      : { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) })),
    location,
    history,
    // `now` walks with the event list so page stamps stay ordered and distinct.
    // A test that needs a fixed timebase pins it with `setNow`.
    performance: { timeOrigin: 1_700_000_000_000, now: () => pinnedNowMs ?? events.length },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    queueMicrotask,
    setTimeout: () => 0,
    clearTimeout() {},
    document: {
      getElementById(id) {
        if (id === 'video') return video;
        throw new Error(`the engine read #${id}`);
      },
      createElement: () => { throw new Error('the engine created an element'); },
      addEventListener(type, fn) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(fn);
      },
    },
  };
  context.location.origin = 'http://127.0.0.1:8100';
  context.location.pathname = '/room.html';
  Object.assign(context, globals);
  if (!context.fetch) delete context.fetch;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  const requireScreens = () => {
    if (!harness.screens) throw new Error('the screens never mounted');
    return harness.screens;
  };
  return {
    events,
    video,
    control,
    history,
    location,
    fetches,
    app: context.__app,
    xhr() {
      if (typeof context.XMLHttpRequest !== 'function') throw new Error('entry harness: XMLHttpRequest is not installed');
      return new context.XMLHttpRequest();
    },
    remedy: () => context.__remedyBrowser ?? null,
    view: () => requireScreens().view.get(),
    screens: () => requireScreens(),
    chooseHostFile(file) { requireScreens().actions.chooseHostFile(file); },
    notices: () => requireScreens().view.get().notices.map((notice) => notice.text),
    controllerLine: () => requireScreens().view.get().overlay.controller,
    click(id) {
      const actions = requireScreens().actions;
      const action = {
        play: 'play',
        pause: 'pause',
        'back-10': 'back10',
        'forward-10': 'forward10',
        'control-mode': 'controlMode',
        mute: 'mute',
      }[id];
      if (!action || this.view().controls[id].disabled) return;
      actions[action]();
      for (const fn of documentListeners.get('click') ?? []) fn({ type: 'click', target: { id } });
    },
    /** Pin `performance.now()`, for a test whose expected values are arithmetic on it. */
    setNow(ms) { pinnedNowMs = ms; },
    settled() { return new Promise((resolve) => setImmediate(resolve)); },
    kinds: () => events.map((event) => event.kind),
    count: (kind) => events.filter((event) => event.kind === kind).length,
    /** One page tick, exactly the entry's own 250 ms interval body. */
    tick() {
      for (const fn of intervals) fn();
    },
    harness,
    sent: () => events.filter((event) => event.kind === 'send').map((event) => event.detail),
    /** A room-client event (`joined`, …) as the fake client's subscribers receive it. */
    emit(type, value) {
      if (type === 'joined') {
        harness.clientId = value.clientId ?? harness.clientId;
        harness.role = value.role ?? harness.role;
        harness.roster = value.roster ?? harness.roster;
        harness.isJoined = true;
      }
      if (type === 'presence' && value?.payload?.roster) harness.roster = value.payload.roster;
      for (const fn of harness.clientEvents.get(type) ?? []) fn(value);
    },
    emitFinished() {
      for (const fn of [...harness.finishedHandlers]) fn();
    },
    /** A room-scoped envelope delivered to the fake client's `on(type)` subscribers. */
    deliver(env) {
      // A real websocket client receives JSON parsed in the page realm. Clone
      // here so exact plain-object checks see that same realm's prototype.
      const delivered = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(env))})`, context);
      if (delivered.type === 'presence' && delivered.from === 'server' && Array.isArray(delivered.payload?.roster)) {
        harness.roster = delivered.payload.roster;
      }
      for (const fn of harness.clientHandlers.get(delivered.type) ?? []) fn(delivered);
    },
    /** Resolves the real acquisition as a sole host whose own creation echo arrives. */
    resolveSole({ clientId = 'c1', nowMs = 10_000 } = {}) {
      harness.clientId = clientId;
      harness.role = 'host';
      harness.sharedNowMs = nowMs;
      this.emit('joined', { clientId, role: 'host', seq: 1, roster: [{ clientId, tabId: 't', role: 'host', joinedAt: 1 }] });
      const create = this.sent().find((env) => env.payload?.kind === 'create');
      if (!create) throw new Error('entry harness: the sole member issued no creation');
      this.deliver({ ...create, seq: 2, from: clientId, ts: { recv: nowMs + 1 } });
      return this.app.timeline();
    },
    /** Queues scripted start actions with the status their poll reports, then ticks. */
    act(actions, startState = {}) {
      Object.assign(harness.startState, startState);
      harness.pendingActions.push(...actions);
      this.tick();
    },
    /** The shape the real reducer emits: the physical park and the mapping it serves. */
    open(options) {
      this.act([{ kind: 'load', attemptId: 1, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 1000, ...options }], { startAtSharedMs: 1000 });
    },
  };
}
