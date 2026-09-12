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
]);
const SPIES = Object.freeze({
  './lib/drift-controller.mjs': path.join(HERE, 'entry-controller-spy.mjs'),
  './lib/frame-sampler.mjs': path.join(HERE, 'entry-sampler-spy.mjs'),
});

/** Substitutes the entry's own imports only; `hits` lets a test prove all fired. */
export function entryFakesPlugin({ spies, hits = [] }) {
  const entry = path.resolve(ENTRY_POINT);
  return {
    name: 'entry-harness-fakes',
    setup(build) {
      build.onResolve({ filter: /^\.\/lib\// }, (args) => {
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
    plugins: [entryFakesPlugin({ spies: true, hits })],
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
  const state = { pitch: initial, rate: 1, written: false, readThrows: false, rateWritesFail: false };
  const note = (kind, value) => {
    log.push({ kind, value });
    onEvent(kind, value);
  };
  const video = {
    paused,
    get playbackRate() { return state.rate; },
    set playbackRate(value) {
      note('rate-write', value);
      if (state.rateWritesFail) throw new Error('rate write refused');
      state.rate = value;
    },
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
    addEventListener() {},
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
    pitchWrites: () => log.filter((entry) => entry.kind === 'pitch-write'),
    rateWrites: () => log.filter((entry) => entry.kind === 'rate-write').map((entry) => entry.value),
  };
  return { video: element, control };
}

function fakeElement(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    classList: { add() {} },
    appendChild(child) { this.children.push(child); },
  };
}

/**
 * Runs a bundle once, as a page load, against a fakeVideo built from
 * `videoOptions` whose writes land in the same ordered event list as the
 * page's own. `onLoad`/`onReopen` receive the element's control.
 */
export function runEntry(code, { videoOptions = {}, search = '?room=r&tab=t', onReopen, onLoad } = {}) {
  const events = [];
  const intervals = [];
  const elements = new Map();
  const log = (kind, detail) => events.push({ kind, detail });
  const { video, control } = fakeVideo({ ...videoOptions, onEvent: log });
  const harness = {
    clock: { offsetMs: null, halfWidthMs: null, sampleCount: 0, counters: { reanchors: 0 } },
    playing: false,
    pendingOpen: null,
    onReopen: onReopen && (() => onReopen(control)),
    onLoad: onLoad && (() => onLoad(control)),
    log,
  };
  const context = {
    __entryHarness: harness,
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    location: { search, protocol: 'http:', host: '127.0.0.1:8100' },
    performance: { timeOrigin: 1_700_000_000_000, now: () => events.length },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    document: {
      getElementById(id) {
        if (id === 'video') return video;
        if (!elements.has(id)) elements.set(id, fakeElement(id));
        return elements.get(id);
      },
      createElement: () => fakeElement('li'),
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return {
    events,
    video,
    control,
    app: context.__app,
    remedy: () => context.__remedyBrowser ?? null,
    notices: () => (elements.get('notices')?.children ?? []).map((li) => li.textContent),
    controllerLine: () => elements.get('controller-line')?.textContent ?? null,
    kinds: () => events.map((event) => event.kind),
    count: (kind) => events.filter((event) => event.kind === kind).length,
    /** One page tick, exactly the entry's own 250 ms interval body. */
    tick() {
      for (const fn of intervals) fn();
    },
    open(options) {
      harness.pendingOpen = { positionMs: 0, epochMs: 0, reopen: false, ...options };
      this.tick();
    },
  };
}
