// scripts/verify-host-file.mjs
//
// The browser pass for the `file` media source (change 11-2 design.md D9): a
// host tab is handed a file over CDP, prepares it, and a viewer plays it. It
// owns its room server, its Chrome and its reference directory, and removes
// all three. The verdicts are host-file-steps.mjs's; this file gathers the
// readings and calls them.
//
// TEST MACHINERY, not part of `npm run check`. `--file`'s value never reaches
// a retained record or a console line: the file is named by `--label` only.

import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { attach, cdpHttp, CHROME, disposeChrome, FLAGS, sleep } from './cdp.mjs';
import { assertServedBundle, createManifestFile, createNdjson, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { readSourceIndex } from '../public/lib/remux-index.mjs';
import { lockName, storeKey } from '../public/lib/prepared-store.mjs';
import { segmentName } from '../public/lib/remux-publish.mjs';
import { requireAutoStart } from './delivery-pin.mjs';
import { setHostFile } from './room-page-steps.mjs';
import {
  boundariesFromPlaylist,
  chooseSegments,
  exitCode,
  F10_ROWS, f10Disabled, f10Enables, f10Prepares,
  s0, s1, s2, s3, s4, s5, s6, s7a, s7g, s7f, s7b, s7c, s7d, s7e, s8, s9, s10, s11, s12, s13,
} from './host-file-steps.mjs';

const execFileAsync = promisify(execFile);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const SCRATCH_DIR = path.join(REPO_DIR, '.tmp', 'host-file-11-2');
const SERVER_PORT = 8128;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const POLL_MS = 250;
const HOST_BUNDLE = path.join(APP_DIR, 'public', 'room.bundle.js');
const WORKER_BUNDLE = path.join(APP_DIR, 'public', 'prepare.worker.bundle.js');
const REFUSED_FIXTURE = path.join(APP_DIR, 'scripts', 'check', 'remux-fixtures', 'refuse-video-codec.mp4');
const HARNESS_SEEK = 'globalThis.__waHarnessSeek = true;';
const WIRING_HEADING = "wiring only — the browser's own verdict not exercised";
const DIAGNOSTIC_HEADING = "diagnostic — added after S7a's and S7c's results (tasks.md → Decisions, 2026-10-12); earns the matrix nothing";
const WIRING = {
  codec: `${HARNESS_SEEK} (() => { const native = MediaSource.isTypeSupported.bind(MediaSource); MediaSource.isTypeSupported = (mime) => (mime.includes('avc1') ? false : native(mime)); })();`,
  storage: `${HARNESS_SEEK} navigator.storage.estimate = async () => ({ quota: 1000, usage: 0 });`,
};

// The held-lock pass (--held-lock): the host remembers a title under this key, and a second
// tab holds that title's lock. The key is the entry's sessionStorage name; the lock name is
// the store's own rule, so a change to either leaves this pass holding the wrong lock.
const F10_KEY = 'v1-f10-held';
const PREPARED_KEY_NAME = 'watchalong.prepared-key';
const F10_SAMPLE_MS = 100;
const F10_WINDOW_MS = 5_000;
const F10_RELEASE_MS = 15_000;
const CHOOSER_SAMPLE = `(() => ({
  state: globalThis.__app?.hostFile?.().state ?? null,
  disabled: document.querySelector('#host-file')?.disabled ?? null,
  button: document.querySelector('[data-testid="host-file-button"]')?.textContent ?? null,
}))()`;
const F10_PICK_POLL_MS = 25;
const PICK_SAMPLE = `(() => {
  const snapshot = globalThis.__app.hostFile();
  return { state: snapshot.state, workerCalls: snapshot.workerCalls };
})()`;
const HOLD_LOCK = `new Promise((granted) => {
  navigator.locks.request(${JSON.stringify(lockName(F10_KEY))}, () => { granted(true); return new Promise(() => {}); });
})`;

// Injected before the page's own scripts. Every presented frame, and the
// element's events with the page's own clock, so a stall is read from frames
// and not from `currentTime`.
const RECORDER = `(() => {
  const state = { frames: [], events: { waiting: [], playing: [], ended: [], error: [] } };
  globalThis.__hostFileRecorder = state;
  function install() {
    const video = document.querySelector('#video');
    if (!video) { setTimeout(install, 0); return; }
    for (const type of ['waiting', 'playing', 'ended', 'error']) video.addEventListener(type, () => state.events[type].push(performance.now()));
    const frame = (wallTime, metadata) => {
      state.frames.push({ mediaTime: metadata.mediaTime, wallTime });
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }
  install();
})()`;

// One reading of a page. `from` is how many frames the runner already holds,
// so a long run does not copy every frame on every poll.
const snapshotExpression = (from) => `(() => {
  const app = globalThis.__app;
  const recorder = globalThis.__hostFileRecorder;
  if (!app || !recorder) return { present: false };
  const video = document.querySelector('#video');
  const quality = video?.getVideoPlaybackQuality?.();
  return {
    present: true, buildId: app.buildId, hostFile: app.hostFile(), hostLink: app.hostLink(), playbackState: app.playbackState(),
    hostPreparing: (() => {
      const element = document.querySelector('#host-preparing');
      if (!element) return null;
      const fraction = element.dataset.fraction;
      return { state: element.dataset.state ?? null, fraction: fraction === '' || fraction === undefined ? null : Number(fraction) };
    })(),
    roster: [...document.querySelectorAll('#roster li')].map((li) => li.textContent),
    playDisabled: document.querySelector('#play')?.disabled ?? null,
    notices: [...document.querySelectorAll('#notices li')].map((li) => li.textContent),
    videoError: video?.error ? { code: video.error.code } : null,
    quality: quality ? { corruptedVideoFrames: quality.corruptedVideoFrames, totalVideoFrames: quality.totalVideoFrames } : null,
    webkitAudioDecodedByteCount: video?.webkitAudioDecodedByteCount ?? null,
    element: video ? { currentTime: video.currentTime, duration: video.duration, ended: video.ended, paused: video.paused, readyState: video.readyState, playbackRate: video.playbackRate, buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) } : null,
    newFrames: recorder.frames.slice(${from}), events: recorder.events,
    poll: { wallTime: performance.now(), playing: video ? !video.paused : false, bufferedLength: video?.buffered?.length ?? null, frameCount: recorder.frames.length },
  };
})()`;

const LIST_COPY = (key) => `(async () => {
  const root = await navigator.storage.getDirectory();
  const directory = await (await root.getDirectoryHandle('prepared')).getDirectoryHandle(${JSON.stringify(key)});
  const rows = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file') continue;
    const bytes = await (await handle.getFile()).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    rows.push({ name, size: bytes.byteLength, sha256: [...digest].map((value) => value.toString(16).padStart(2, '0')).join('') });
  }
  return rows.sort((a, b) => (a.name < b.name ? -1 : 1));
})()`;

const LIST_PREPARED = `(async () => {
  const root = await navigator.storage.getDirectory();
  let prepared;
  try { prepared = await root.getDirectoryHandle('prepared'); } catch (error) { if (error.name === 'NotFoundError') return []; throw error; }
  const names = [];
  for await (const [name] of prepared.entries()) names.push(name);
  return names.sort();
})()`;

function valueAfter(args, index) {
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`missing value for ${args[index]}`);
  return args[index + 1];
}

function parseArgs(args) {
  const options = { file: null, label: null, target: null, wiringRefusals: false, mutationControl: false, expectHeAac: false, heldLock: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file') { options.file = valueAfter(args, i); i += 1; }
    else if (args[i] === '--label') { options.label = valueAfter(args, i); i += 1; }
    else if (args[i] === '--target') { options.target = Number(valueAfter(args, i)); i += 1; }
    else if (args[i] === '--wiring-refusals') options.wiringRefusals = true;
    else if (args[i] === '--mutation-control') options.mutationControl = true;
    else if (args[i] === '--expect-he-aac') options.expectHeAac = true;
    else if (args[i] === '--held-lock') options.heldLock = true;
    else throw new Error(`unknown option ${args[i]}`);
  }
  if (!options.file || !options.label || !Number.isFinite(options.target) || options.target <= 0) {
    throw new Error('usage: node scripts/verify-host-file.mjs --file <path> --label <label> --target <seconds> [--wiring-refusals] [--mutation-control] [--expect-he-aac] [--held-lock]');
  }
  if (options.heldLock && (options.wiringRefusals || options.mutationControl || options.expectHeAac)) {
    throw new Error('--held-lock runs its own rows and cannot be combined with --wiring-refusals, --mutation-control or --expect-he-aac');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.label)) throw new Error('label must contain only letters, numbers, underscore or hyphen');
  return options;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const getJson = async (urlPath) => (await fetch(`${ORIGIN}${urlPath}`, { cache: 'no-store' })).json();

/** A string naming the file is replaced whole: a partial mask still leaks its neighbours. */
function redact(value, forbidden) {
  if (typeof value === 'string') return forbidden.some((text) => value.includes(text)) ? '<redacted>' : value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, forbidden));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, forbidden)]));
  return value;
}

/** The manifest keeps a step's readings; the frames themselves are in the ndjson. */
function slim(value, key = '') {
  if (Array.isArray(value)) {
    if (key === 'frames') return { count: value.length, firstMediaTime: value[0]?.mediaTime ?? null, lastMediaTime: value.at(-1)?.mediaTime ?? null };
    if (key === 'polls') return { count: value.length, bufferedLengths: [...new Set(value.map((poll) => poll?.bufferedLength))], playing: [...new Set(value.map((poll) => poll?.playing))] };
    return value.map((entry) => slim(entry));
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, slim(entry, name)]));
  return value;
}

async function sourceIndexOf(filename) {
  const handle = await fs.promises.open(filename, 'r');
  try {
    const { size } = await handle.stat();
    return await readSourceIndex({
      size,
      async read(offset, length) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      },
    });
  } finally {
    await handle.close();
  }
}

function referenceListing(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name, size: bytes.byteLength, sha256: sha256(bytes) };
  });
}

async function servedBundle(urlPath, diskPath) {
  const served = await (await fetch(`${ORIGIN}${urlPath}`, { cache: 'no-store' })).text();
  return { servedSha256: sha256(served), diskSha256: sha256(fs.readFileSync(diskPath, 'utf8')) };
}

/** Polls until `done` or the deadline, and returns the last reading either way: a miss is the verdict's to call. */
async function poll(read, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(POLL_MS);
    value = await read();
  }
  return value;
}

const click = (page, selector) => page.tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const pageNow = (page) => page.tab.evaluate('performance.now()');
const framesAfter = (page, wallTime) => page.frames.filter((frame) => frame.wallTime >= wallTime);
const lastMediaTime = (page) => page.frames.at(-1)?.mediaTime ?? null;
const hasFrame = (frames, lower, upper) => frames.some((frame) => frame.mediaTime >= lower && frame.mediaTime < upper);

async function runPass(options) {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const runDir = path.join(RESULTS_DIR, `11-2-host-file-${options.label}-${stamp}`);
  const referenceDir = path.join(SCRATCH_DIR, `${options.label}-ref`);
  const profile = path.join(SCRATCH_DIR, `${options.label}-profile`);
  const forbidden = [path.basename(options.file), path.dirname(options.file)];
  if (fs.existsSync(profile) || fs.existsSync(referenceDir)) throw new Error('a throwaway directory of this label already exists');
  await portFree(SERVER_PORT).catch(() => { throw new Error(`refusing to run: port ${SERVER_PORT} is held`); });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  const manifestFile = createManifestFile({
    runDir,
    initial: {
      schemaVersion: 1, runner: 'verify-host-file', label: options.label, target: options.target, fileBytes: null,
      options: { wiringRefusals: options.wiringRefusals, mutationControl: options.mutationControl, expectHeAac: options.expectHeAac, heldLock: options.heldLock },
      startedAt: startedAt.toISOString(), steps: [], failures: [],
    },
  });
  const manifest = manifestFile.get();
  manifestFile.write();
  const ndjson = createNdjson(runDir);
  const pages = [];
  let server = null;
  let chrome = null;
  let chromePort = null;

  const record = (id, name, result, extra = {}) => {
    const safe = redact(slim(result), forbidden);
    manifest.steps.push({ id, name, ...extra, status: safe.status, reasons: safe.reasons, observed: safe.observed });
    manifestFile.write();
    console.log(`${result.status.toUpperCase()} ${id} ${name} [${options.label}]${result.status === 'pass' ? '' : ` — ${safe.reasons.join('; ')}`}`);
    return result;
  };
  // A step that throws has no reading: that is missing evidence, and the steps after it still run.
  const step = async (id, name, body, extra) => {
    let result;
    try {
      result = await body();
    } catch (error) {
      result = { status: 'evidence missing', observed: null, reasons: [`runner error: ${error?.message ?? String(error)}`] };
    }
    return record(id, name, result, extra);
  };
  const passed = (...results) => results.every((result) => result.status === 'pass');

  // `url` opens a plain same-origin page instead of a room: the RECORDER loops while there is no
  // `#video`, so a page without one must not get it.
  async function open(tag, role, room, globals = '', { url = null } = {}) {
    const before = new Set((await cdpHttp(chromePort, '/json/list')).map((target) => target.id));
    spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=900,650', 'about:blank'], { stdio: 'ignore' });
    const tab = await attach(chromePort, 'about:blank', { exclude: before });
    const page = { tab, tag, load: 0, frames: [], exceptions: [], network: { bodyCount: 0, nonGetCount: 0, requests: 0 } };
    tab.on('Runtime.exceptionThrown', (details) => page.exceptions.push(details?.exceptionDetails?.exception?.description ?? details?.exceptionDetails?.text ?? 'page exception'));
    tab.on('Network.requestWillBeSent', ({ request }) => {
      if (!request?.url?.startsWith(ORIGIN)) return;
      page.network.requests += 1;
      if (request.hasPostData || request.postData) page.network.bodyCount += 1;
      if (request.method !== 'GET') page.network.nonGetCount += 1;
    });
    await tab.send('Page.enable');
    await tab.send('Network.enable');
    await tab.send('DOM.enable');
    if (!url) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `${globals}\n${RECORDER}` });
    await tab.send('Page.navigate', { url: url ?? `${ORIGIN}/room.html?room=${room}&role=${role}&tab=${tag}` });
    pages.push(page);
    return page;
  }

  async function read(page) {
    let snapshot;
    try {
      snapshot = await page.tab.evaluate(snapshotExpression(page.frames.length));
    } catch (error) {
      return { present: false, error: error?.message ?? String(error) };
    }
    if (!snapshot?.present) return { present: false };
    if (snapshot.newFrames.length > 0) {
      page.frames.push(...snapshot.newFrames);
      ndjson.append(`frames-${page.tag}.ndjson`, snapshot.newFrames.map((frame) => ({ load: page.load, ...frame })));
    }
    return snapshot;
  }
  const until = (page, done, timeoutMs) => poll(() => read(page), (value) => value.present === true && done(value), timeoutMs);
  const settled = (page) => until(page, (value) => !['off', 'starting'].includes(value.hostFile?.state), 20_000);
  const listCopy = (page, key) => page.tab.evaluate(LIST_COPY(key));
  const listPrepared = (page) => page.tab.evaluate(LIST_PREPARED);
  const linkOf = (snapshot) => snapshot.hostLink ?? null;

  // The held-lock pass (--held-lock; executor-spec T15): a host that remembers a title whose lock
  // another tab holds, then the same host once that tab is gone. A setup that fails leaves every
  // row without a reading, which is missing evidence and not a verdict on the chooser.
  async function heldLockRows(fileBytes) {
    let failure = null;
    let host = null;
    let holder = null;
    try {
      host = await open('host', 'host', `r${crypto.randomBytes(6).toString('hex')}`);
      const pageBuildId = (await settled(host)).buildId ?? null;
      manifest.build = { pageBuildId, room: await assertServedBundle({ origin: ORIGIN, bundlePath: HOST_BUNDLE, pageBuildId }) };
      manifest.heldLock = { key: F10_KEY, lockName: lockName(F10_KEY) };
      await host.tab.evaluate(`sessionStorage.setItem(${JSON.stringify(PREPARED_KEY_NAME)}, ${JSON.stringify(F10_KEY)})`);
      holder = await open('holder', 'host', '', '', { url: `${ORIGIN}/app-settings` });
      await poll(() => holder.tab.evaluate('location.origin').catch(() => null), (origin) => origin === ORIGIN, 10_000);
      if ((await holder.tab.evaluate(HOLD_LOCK)) !== true) throw new Error('the second tab was not granted the lock');
    } catch (error) {
      failure = error;
    }
    const requireSetup = () => { if (failure) throw failure; };
    const chooser = (page) => page.tab.evaluate(CHOOSER_SAMPLE);

    await step('F10-1', F10_ROWS['F10-1'], async () => {
      requireSetup();
      host.load += 1;
      host.frames = [];
      const startedMs = Date.now();
      await host.tab.send('Page.reload', { ignoreCache: true });
      const samples = [];
      while (Date.now() - startedMs < F10_WINDOW_MS) {
        // A page between documents has no reading; the gap is left in the samples.
        try { samples.push({ atMs: Date.now() - startedMs, ...(await chooser(host)) }); } catch { /* no reading */ }
        await sleep(F10_SAMPLE_MS);
      }
      return f10Disabled({ samples });
    });

    await step('F10-2', F10_ROWS['F10-2'], async () => {
      requireSetup();
      await holder.tab.send('Page.close');
      await poll(async () => (await cdpHttp(chromePort, '/json/list')).some((target) => target.id === holder.tab.targetId), (open) => !open, 10_000);
      const releasedMs = Date.now();
      const reading = await poll(() => chooser(host).catch(() => null), (value) => value?.state === 'awaiting-file' && value.disabled === false, F10_RELEASE_MS);
      if (!reading) throw new Error('the host page gave no reading after the lock was released');
      return f10Enables({ state: reading.state, disabled: reading.disabled, waitedMs: Date.now() - releasedMs });
    });

    await step('F10-3', F10_ROWS['F10-3'], async () => {
      requireSetup();
      await setHostFile(host.tab, options.file);
      const deadline = Date.now() + 60_000 + Math.ceil(fileBytes / 5_000_000) * 1000;
      const states = [];
      let latest = null;
      while (Date.now() < deadline) {
        try { latest = await host.tab.evaluate(PICK_SAMPLE); } catch { latest = null; }
        if (latest && states.at(-1) !== latest.state) states.push(latest.state);
        if (latest && ['ready', 'refused', 'failed'].includes(latest.state)) break;
        await sleep(F10_PICK_POLL_MS);
      }
      return f10Prepares({ states, final: latest?.state ?? null, workerCalls: latest?.workerCalls ?? {} });
    });
  }

  try {
    const stat = fs.statSync(options.file);
    if (!stat.isFile()) throw new Error('input is not a file');
    manifest.fileBytes = stat.size;
    const sourceIndex = await sourceIndexOf(options.file);
    if (options.expectHeAac && !['mp4a.40.5', 'mp4a.40.29'].includes(sourceIndex.audio?.codec)) {
      throw new Error(`evidence missing: the file's audio is ${sourceIndex.audio?.codec ?? 'absent'}, not HE-AAC`);
    }
    const sampleTicks = [...sourceIndex.video.durations].sort((a, b) => a - b);
    const frame = sampleTicks[Math.floor(sampleTicks.length / 2)] / sourceIndex.video.timescale;
    if (!(frame > 0)) throw new Error('the frame interval could not be read from the source');

    await execFileAsync(process.execPath, [path.join(APP_DIR, 'scripts', 'remux-file.mjs'), options.file, '--out', referenceDir, '--target', String(options.target)], { cwd: APP_DIR, maxBuffer: 16 * 1024 * 1024 })
      .catch(() => { throw new Error('the reference remux failed'); });
    const referenceManifest = JSON.parse(fs.readFileSync(path.join(referenceDir, 'content-manifest.json'), 'utf8'));
    const boundaries = boundariesFromPlaylist(fs.readFileSync(path.join(referenceDir, 'master.m3u8'), 'utf8'));
    const count = referenceManifest.segmentCount;
    if (!boundaries || boundaries.length !== count || count < 3) throw new Error('the reference playlist does not give this pass its boundaries');
    const reference = { listing: referenceListing(referenceDir), videoCodec: referenceManifest.tracks.video.codec, audioCodec: referenceManifest.tracks.audio?.codec ?? null, duration: referenceManifest.duration };
    const expectedKey = storeKey({ identity: referenceManifest.identity, targetSeconds: options.target });
    Object.assign(manifest, { boundaries, frame, segmentCount: count, referenceDuration: reference.duration, tracks: referenceManifest.tracks });

    server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
      cwd: APP_DIR,
      env: { ...process.env, APP_PORT: String(SERVER_PORT), APP_MEDIA_SOURCE: 'file', APP_DELIVERY: 'host', APP_AUTO_START: '1', APP_HOST_GRACE_MS: '30000', APP_SEGMENT_TARGET_S: String(options.target), APP_ICE_SERVERS: '[]', APP_TRACKER_URL: '' },
      stdio: 'ignore',
    });
    const up = await poll(async () => {
      try { return (await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
    }, (ok) => ok || server.exitCode !== null, 15_000);
    if (!up || server.exitCode !== null) throw new Error('the room server did not start');
    await requireAutoStart(ORIGIN);
    console.log('autoStart: on');

    chromePort = await unusedPort();
    fs.mkdirSync(profile, { recursive: true });
    chrome = spawn(CHROME, [...FLAGS, `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, '--window-size=900,650', 'about:blank'], { stdio: 'ignore' });
    manifest.chromeVersion = (await cdpHttp(chromePort, '/json/version')).Browser ?? null;
    console.log(`chrome: ${manifest.chromeVersion} · ${CHROME}`);
    manifest.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR, encoding: 'utf8' }).trim();
    manifest.gitDirty = execFileSync('git', ['status', '--porcelain', '--', 'app/public', 'app/server', 'app/scripts'], { cwd: REPO_DIR, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;

    // The reference remux above still ran: --held-lock takes the server and Chrome, and none of the S rows.
    if (options.heldLock) {
      await heldLockRows(stat.size);
    } else {
      // S0, first half: what is being served, before any page is trusted (rule 9).
      const settings = await getJson('/app-settings');
      const workerBundle = await servedBundle('/prepare.worker.bundle.js', WORKER_BUNDLE);

      const room = `r${crypto.randomBytes(6).toString('hex')}`;
      const viewer = await open('viewer', 'viewer', room);
      await until(viewer, () => true, 20_000);
      const host = await open('host', 'host', room, HARNESS_SEEK);
      const hostStart = await settled(host);
      const pageBuildId = hostStart.buildId ?? null;
      const roomBundle = await assertServedBundle({ origin: ORIGIN, bundlePath: HOST_BUNDLE, pageBuildId });
      manifest.settings = settings;
      manifest.build = { pageBuildId, room: roomBundle, worker: workerBundle };
      const fresh = s0({ target: options.target, pageBuildId, workerBuildId: pageBuildId, settings, roomBundle, workerBundle });
      if (fresh.status !== 'pass') {
        record('S0', 'freshness', fresh);
        throw new Error('the pass is not talking to the build on disk; nothing after S0 was run');
      }

      const r1 = await step('S1', 'viewers wait', async () => {
        await sleep(5_000);
        const hostNow = await read(host);
        const viewerNow = await read(viewer);
        return s1({
          host: hostNow.hostFile,
          viewer: { roster: viewerNow.roster, hostPreparing: viewerNow.hostPreparing, playDisabled: viewerNow.playDisabled, requestsByPath: viewerNow.hostLink?.requestsByPath },
          counters: (await getJson('/harness/counters')).counters,
        });
      });

      let prepared = null;
      const r2 = await step('S2', 'prepare', async () => {
        await setHostFile(host.tab, options.file);
        const deadlineMs = 60_000 + Math.ceil(stat.size / 5_000_000) * 1000;
        const startedMs = Date.now();
        prepared = await until(host, (value) => ['ready', 'refused', 'failed'].includes(value.hostFile?.state), deadlineMs);
        manifest.prepareWallMs = Date.now() - startedMs;
        return s2({ target: options.target, fileBytes: stat.size, host: prepared.hostFile });
      });
      const key = prepared?.hostFile?.key ?? null;
      const r0 = record('S0', 'freshness', s0({ target: options.target, pageBuildId, workerBuildId: prepared?.hostFile?.workerBuildId, settings, roomBundle, workerBundle }));

      let tabListing = null;
      const r3 = await step('S3', 'the same bytes', async () => {
        if (!passed(r0, r2) || !key) return s3({ precondition: false });
        tabListing = await listCopy(host, key);
        return s3({ tab: tabListing, reference: reference.listing, key, expectedKey });
      });

      // The first member of a room creates it playing from 0, so by now the room is
      // wherever the viewer's wait and the preparation left it. Every seek is made
      // paused: the room's position is then the one read, and the delta is exact.
      // A click made before the page holds the room's state is dropped, so the button is pressed until the state says so.
      const setPlaying = async (wanted) => {
        const reached = await poll(async () => {
          if ((await read(host)).playbackState?.playing === wanted) return true;
          await click(host, wanted ? '#play' : '#pause');
          await sleep(500);
          return false;
        }, (done) => done, 15_000);
        if (!reached) throw new Error(`the room did not become ${wanted ? 'playing' : 'paused'} within 15 s`);
      };
      const seekTo = async (targetSeconds) => {
        let mark = null;
        let fromSeconds = null;
        let last = null;
        const issued = await poll(async () => {
          const state = (await read(host)).playbackState;
          last = state;
          if (!state || state.playing !== false || !Number.isFinite(state.positionMs)) return false;
          fromSeconds = state.positionMs / 1000;
          mark = await pageNow(viewer);
          return (await host.tab.evaluate(`window.__app.harnessSeek(${targetSeconds * 1000 - state.positionMs})`))?.issued === true;
        }, (done) => done, 10_000);
        if (!issued) throw new Error(`the host issued no seek within 10 s of the pause; its room state was ${JSON.stringify(last)}`);
        return { mark, fromSeconds };
      };
      const shown = (mark, lower, upper) => until(viewer, () => hasFrame(framesAfter(viewer, mark), lower, upper), 30_000);
      const rewind = async () => {
        await setPlaying(false);
        const { mark } = await seekTo(0);
        await until(viewer, (value) => hasFrame(framesAfter(viewer, mark), 0, 1.5 * frame) && value.poll.bufferedLength === 1, 15_000);
      };

      // S4 and S5 share one loop from the play click, so the viewer's window has no gap in its polls.
      const k = Math.min(3, count - 1) - 1;
      const boundaryIndexes = Array.from({ length: k + 1 }, (_, index) => index);
      const viewerPolls = [];
      let viewerNow = null;
      let hostMark = null;
      let viewerMark = null;
      let played = false;
      if (passed(r2)) {
        try {
          await rewind();
          hostMark = await pageNow(host);
          viewerMark = await pageNow(viewer);
          await setPlaying(true);
          played = true;
          const hostDeadline = Date.now() + 30_000;
          const viewerDeadline = Date.now() + (boundaries[k] + 60) * 1000;
          let hostDone = false;
          let viewerDone = false;
          while (!(hostDone && viewerDone)) {
            if (!hostDone) {
              await read(host);
              hostDone = hasFrame(framesAfter(host, hostMark), boundaries[0], Infinity) || Date.now() >= hostDeadline;
            }
            viewerNow = await read(viewer);
            if (viewerNow.present && framesAfter(viewer, viewerMark).length > 0) viewerPolls.push(viewerNow.poll);
            viewerDone = hasFrame(framesAfter(viewer, viewerMark), boundaries[k] + 0.25, Infinity) || Date.now() >= viewerDeadline;
            if (!(hostDone && viewerDone)) await sleep(POLL_MS);
          }
        } catch (error) {
          manifest.failures.push(`the rewind before S4: ${redact(error?.message ?? String(error), forbidden)}`);
        }
      }
      const since = (list, mark) => (list ?? []).filter((wallTime) => wallTime >= mark);
      const r4 = await step('S4', 'the host plays', async () => (played
        ? s4({ frames: framesAfter(host, hostMark), boundaries, frame })
        : s4({ precondition: false })));
      const r5 = await step('S5', 'a viewer plays across boundaries', async () => (played
        ? s5({ frames: framesAfter(viewer, viewerMark), boundaryIndexes, boundaries, frame, polls: viewerPolls, events: { waiting: since(viewerNow?.events?.waiting, viewerMark).map((wallTime) => ({ wallTime })) }, firstPlayingWallTime: since(viewerNow?.events?.playing, viewerMark)[0] ?? null })
        : s5({ precondition: false })));
      const audioAfterS5 = viewerNow?.webkitAudioDecodedByteCount ?? null;
      // Where the title's first presented frame sits against the playlist's zero, as the element buffered it.
      const presentedOffset = viewerNow?.element?.buffered?.[0]?.[0] ?? null;

      const r6 = await step('S6', 'reload', async () => {
        if (!passed(r5)) return s6({ precondition: false });
        host.load += 1;
        host.frames = [];
        await host.tab.send('Page.reload', { ignoreCache: true });
        const reloaded = await until(host, (value) => value.hostFile?.state === 'ready', 30_000);
        const afterListing = await listCopy(host, key);
        await read(viewer);
        let mark = await pageNow(viewer);
        let from = lastMediaTime(viewer);
        const rewound = reference.duration - from < 10;
        if (rewound) {
          await rewind();
          mark = await pageNow(viewer);
          from = 0;
          await setPlaying(true);
        }
        const latest = () => framesAfter(viewer, mark).at(-1)?.mediaTime ?? from;
        const crossed = () => boundaries.some((boundary) => boundary > from && boundary <= latest());
        await until(viewer, () => latest() - from >= 5 && crossed(), 30_000);
        return s6({ host: reloaded.hostFile, key, beforeListing: tabListing, afterListing, frames: viewer.frames, boundaries, minimumAdvance: 5, mediaAdvance: latest() - from, crossedBoundary: crossed(), fromMediaTime: from, rewound });
      });

      let choice = null;
      const r7a = await step('S7a', "seek to a segment's first frame", async () => {
        if (!passed(r2)) return s7a({ precondition: false });
        await setPlaying(false);
        const paused = await until(host, (value) => value.playbackState?.playing === false, 10_000);
        choice = chooseSegments({ boundaries, count, position: (paused.playbackState?.positionMs ?? NaN) / 1000 });
        if (!choice) throw new Error('no segment could be chosen for the seeks');
        const target = boundaries[choice.j - 1];
        const requestsBefore = linkOf(await read(viewer))?.requestsByPath;
        const { mark, fromSeconds } = await seekTo(target);
        const after = await shown(mark, target - 1.5 * frame, target + 1.5 * frame);
        const seg = (index) => `/media/${segmentName(index)}`;
        return s7a({ position: fromSeconds, target, frame, afterWallTime: mark, frames: framesAfter(viewer, mark), longFile: choice.longFile, segment: choice.j, targetPath: seg(choice.j), previousPath: seg(choice.j - 1), requestsBefore, requestsAfter: linkOf(after)?.requestsByPath, element: after.element ?? null });
      });
      await step('S7g', 'two loads report one frame at one media time', async () => {
        if (!passed(r2)) return s7g({ precondition: false });
        await setPlaying(false);
        const { mark } = await seekTo(3.0);
        await shown(mark, 3.0 - 1.5 * frame, 3.0 + 1.5 * frame);
        const v2 = await open('g2', 'viewer', room);
        try {
          const opens = (page) => page.tab.evaluate('window.__app?.playback?.().opens ?? 0').catch(() => 0);
          await poll(async () => (await read(v2)).notices?.some((notice) => /playback opened at/.test(notice)) && (await opens(v2)) >= 1, (done) => done, 30_000);
          // v2 shows the paused room's frame before the room plays, or there is no mid-title load to compare.
          await until(v2, () => hasFrame(v2.frames, 3.0 - 1.5 * frame, 3.0 + 1.5 * frame), 30_000);
          if (!hasFrame(v2.frames, 3.0 - 1.5 * frame, 3.0 + 1.5 * frame)) {
            throw new Error(`v2 showed no frame within 1.5 frames of 3.0 s before play; its frames: ${JSON.stringify(v2.frames.slice(0, 6).map((f) => f.mediaTime))}`);
          }
          await setPlaying(true);
          const reached = (page) => poll(() => page.tab.evaluate('window.__app.drift(0).records.some((record) => record.mediaMs >= 5600)').catch(() => false), (done) => done, 30_000);
          await reached(viewer);
          await reached(v2);
          await setPlaying(false);
          const reading = async (page) => ({
            records: await page.tab.evaluate('window.__app.drift(0).records.map((record) => ({ mediaMs: record.mediaMs }))'),
            placement: await page.tab.evaluate('window.__app.placement?.() ?? null'),
            opens: await opens(page),
            notices: (await read(page)).notices ?? [],
          });
          return s7g({ frame, viewer: await reading(viewer), v2: await reading(v2) });
        } finally {
          await v2.tab.send('Page.close').catch(() => {});
          await poll(async () => (await cdpHttp(chromePort, '/json/list')).some((target) => target.id === v2.tab.targetId), (open) => !open, 10_000);
        }
      });
      await step('S7f', "seek to a segment's first presented frame", async () => {
        if (!passed(r2) || !choice) return s7f({ precondition: false });
        if (!choice.longFile) return s7f({ precondition: false, reason: 'short file' });
        const index = boundaries.findIndex((boundary, i) => i < count - 1 && boundary >= boundaries[choice.j - 1] + 150);
        if (index === -1) throw new Error("no segment 150 s past S7a's");
        await setPlaying(false);
        const zero = (await seekTo(0)).mark;
        await shown(zero, 0, 1);
        const delta = framesAfter(viewer, zero)[0]?.mediaTime ?? null;
        const segment = index + 1;
        const target = boundaries[index] + delta;
        // Without the settle, prefetch from the seek to 0 counts as an earlier segment the seek requested.
        const requestKey = async () => JSON.stringify(linkOf(await read(viewer))?.requestsByPath ?? null);
        for (let previous = await requestKey(), i = 0; i < 15; i += 1) {
          await sleep(1_000);
          const current = await requestKey();
          if (current === previous) break;
          previous = current;
        }
        const requestsBefore = linkOf(await read(viewer))?.requestsByPath;
        const { mark } = await seekTo(target);
        const after = await shown(mark, target - 1.5 * frame, target + 1.5 * frame);
        return s7f({ delta, target, segment, frame, mediaTime: framesAfter(viewer, mark)[0]?.mediaTime ?? null, requestsBefore, requestsAfter: linkOf(after)?.requestsByPath, element: after.element ?? null });
      });
      await step('S7e', "seek to a segment's first presented frame", async () => {
        if (!passed(r2) || !choice) return s7e({ precondition: false });
        if (!choice.longFile) return s7e({ precondition: false, reason: 'short file' });
        const index = boundaries.findIndex((boundary, i) => i < count - 1 && boundary >= boundaries[choice.j - 1] + 300);
        if (index === -1 || !Number.isFinite(presentedOffset)) throw new Error('no far segment or no presented offset for the diagnostic seek');
        const segment = index + 1;
        const target = boundaries[index] + presentedOffset;
        const seg = (n) => `/media/${segmentName(n)}`;
        const requestsBefore = linkOf(await read(viewer))?.requestsByPath;
        const { mark } = await seekTo(target);
        const after = await shown(mark, target - 1.5 * frame, target + 1.5 * frame);
        return s7e({ target, offset: presentedOffset, playlistBoundary: boundaries[index], frame, afterWallTime: mark, frames: framesAfter(viewer, mark), segment, targetPath: seg(segment), previousPath: seg(segment - 1), requestsBefore, requestsAfter: linkOf(after)?.requestsByPath, element: after.element ?? null });
      }, { diagnostic: true, heading: DIAGNOSTIC_HEADING });
      const r7b = await step('S7b', "seek to a segment's last frame", async () => {
        if (!passed(r2) || !choice) return s7b({ precondition: false });
        const target = boundaries[choice.m];
        const { mark } = await seekTo(target - frame / 2);
        await shown(mark, target - 1.5 * frame, target);
        return s7b({ target, frame, afterWallTime: mark, segment: choice.m, frames: framesAfter(viewer, mark) });
      });
      const r7c = await step('S7c', 'seek to the last segment, play to the end', async () => {
        if (!passed(r2) || !choice) return s7c({ precondition: false });
        const target = boundaries[count - 2];
        const { mark } = await seekTo(target);
        await shown(mark, target - 1.5 * frame, target + 1.5 * frame);
        await setPlaying(true);
        const endedSince = (value) => (value.events?.ended ?? []).filter((wallTime) => wallTime >= mark).length;
        const ending = await until(viewer, (value) => endedSince(value) >= 1, (reference.duration - target) * 1000 + 20_000);
        await sleep(1_000);
        const ended = await read(viewer);
        return s7c({ target, duration: reference.duration, frame, afterWallTime: mark, frames: framesAfter(viewer, mark), events: { ended: endedSince(ended.present ? ended : ending) }, room: ended.playbackState ?? null, element: ended.element ?? null, start: await viewer.tab.evaluate('(() => { const p = window.__app.playback(); return { ...p, starts: p.starts.slice(-3) }; })()').catch(() => null), notices: (ended.notices ?? []).slice(-6) });
      });

      await step('S7d', 'play to the end from 4 s or more before it', async () => {
        if (!passed(r2)) return s7d({ precondition: false });
        const target = [0, ...boundaries].filter((boundary) => reference.duration - boundary >= 4).at(-1);
        await setPlaying(false);
        const { mark } = await seekTo(target);
        await shown(mark, target - 1.5 * frame, target + 1.5 * frame);
        await setPlaying(true);
        const endedSince = (value) => (value.events?.ended ?? []).filter((wallTime) => wallTime >= mark).length;
        await until(viewer, (value) => endedSince(value) >= 1, (reference.duration - target) * 1000 + 20_000);
        await sleep(1_000);
        const ended = await read(viewer);
        return s7d({ target, duration: reference.duration, frame, afterWallTime: mark, frames: framesAfter(viewer, mark), events: { ended: endedSince(ended) }, room: ended.playbackState ?? null, element: ended.element ?? null });
      }, { diagnostic: true, heading: DIAGNOSTIC_HEADING });

      const r8 = await step('S8', 'no media reached the server', async () => {
        // Under --mutation-control the pages are expected not to play, and the first reading is the point (G7).
        if (!options.mutationControl && !passed(r4, r5)) return s8({ precondition: false });
        const before = await getJson('/harness/counters');
        fs.writeFileSync(path.join(runDir, 'counters-before.json'), `${JSON.stringify(before, null, 2)}\n`);
        const control = await fetch(`${ORIGIN}/media/master.m3u8`, { headers: { 'x-app-tab': 'pass-control' }, cache: 'no-store' });
        await control.arrayBuffer();
        await sleep(250);
        const after = await getJson('/harness/counters');
        fs.writeFileSync(path.join(runDir, 'counters-after.json'), `${JSON.stringify(after, null, 2)}\n`);
        const network = { bodyCount: host.network.bodyCount + viewer.network.bodyCount, nonGetCount: host.network.nonGetCount + viewer.network.nonGetCount, requests: { host: host.network.requests, viewer: viewer.network.requests } };
        if (host.network.requests === 0 || viewer.network.requests === 0) throw new Error('Network recorded no request for a page, so its silence proves nothing');
        return s8({ before: before.counters, after: after.counters, control: { status: control.status }, network, bodies: network.bodyCount });
      });

      await step('S9', 'health', async () => {
        if (!passed(r2)) return s9({ precondition: false });
        const health = (snapshot) => ({ notices: snapshot.notices, videoError: snapshot.videoError, quality: snapshot.quality, webkitAudioDecodedByteCount: snapshot.webkitAudioDecodedByteCount });
        const viewerHealth = health(await read(viewer));
        return s9({ host: health(await read(host)), viewer: { ...viewerHealth, audioDecodedAfterS5: audioAfterS5 }, expectHeAac: options.expectHeAac });
      });

      let h3 = null;
      const r10 = await step('S10', "another tab's title is kept, a closed tab's is removed", async () => {
        if (!passed(r6)) return s10({ precondition: false });
        const h2 = await open('h2', 'host', `r${crypto.randomBytes(6).toString('hex')}`, HARNESS_SEEK);
        const h2Start = await settled(h2);
        const h2Listing = await listCopy(h2, key);
        await host.tab.send('Page.close');
        await poll(async () => (await cdpHttp(chromePort, '/json/list')).some((target) => target.id === host.tab.targetId), (open) => !open, 10_000);
        await sleep(1_000);
        h3 = await open('h3', 'host', `r${crypto.randomBytes(6).toString('hex')}`, HARNESS_SEEK);
        const h3Start = await settled(h3);
        return s10({ key, h2: { state: h2Start.hostFile?.state, swept: h2Start.hostFile?.swept, beforeListing: tabListing, listing: h2Listing }, h3: { state: h3Start.hostFile?.state, swept: h3Start.hostFile?.swept, prepared: await listPrepared(h3) } });
      });

      await step('S11', 'a refused file leaves the title unready', async () => {
        if (!passed(r10)) return s11({ precondition: false });
        const room3 = new URL(await h3.tab.evaluate('location.href')).searchParams.get('room');
        const v2 = await open('v2', 'viewer', room3);
        await until(v2, () => true, 20_000);
        await setHostFile(h3.tab, REFUSED_FIXTURE);
        const refused = await until(h3, (value) => ['refused', 'failed', 'ready'].includes(value.hostFile?.state), 30_000);
        await sleep(5_000);
        const refusedViewer = await read(v2);
        return s11({
          host: refused.hostFile,
          viewer: { roster: refusedViewer.roster, hostPreparing: refusedViewer.hostPreparing, playDisabled: refusedViewer.playDisabled, requestsByPath: refusedViewer.hostLink?.requestsByPath },
          prepared: await listPrepared(h3),
        });
      });

      if (options.wiringRefusals) {
        const wired = async (tag, kind) => {
          const page = await open(tag, 'host', `r${crypto.randomBytes(6).toString('hex')}`, WIRING[kind]);
          await settled(page);
          await setHostFile(page.tab, options.file);
          const refused = await until(page, (value) => ['refused', 'failed', 'ready'].includes(value.hostFile?.state), 60_000);
          return { host: refused.hostFile, prepared: await listPrepared(page) };
        };
        await step('S12', 'codec refusal', async () => s12({ ...(await wired('s12', 'codec')), reference: { videoCodec: reference.videoCodec } }), { heading: WIRING_HEADING });
        await step('S13', 'storage refusal', async () => s13({ ...(await wired('s13', 'storage')), fileBytes: stat.size }), { heading: WIRING_HEADING });
      }
      void r1; void r3; void r7a; void r7b; void r7c; void r8;
    }
  } catch (error) {
    manifest.failures.push(redact(error?.message ?? String(error), forbidden));
  } finally {
    manifest.exceptions = Object.fromEntries(pages.map((page) => [page.tag, { count: page.exceptions.length, text: redact(page.exceptions.slice(0, 20), forbidden) }]));
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = manifest.failures.length > 0 ? 2 : exitCode(manifest.steps, { mutationControl: options.mutationControl });
    manifest.outcome = manifest.exitCode === 0 ? 'pass' : manifest.exitCode === 1 ? 'fail' : 'evidence missing';
    manifestFile.write();
    if (chrome) {
      try { await disposeChrome(chrome, profile); } catch (error) { manifest.failures.push(`Chrome cleanup failed: ${redact(error?.message ?? String(error), forbidden)}`); }
    }
    if (server) await stopChild(server).catch(() => manifest.failures.push('server cleanup failed'));
    try { fs.rmSync(referenceDir, { recursive: true, force: true }); } catch { manifest.failures.push('reference cleanup failed'); }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { manifest.failures.push('profile cleanup failed'); }
    manifestFile.write();
  }
  console.log(`${options.label}: exit ${manifest.exitCode} (${manifest.outcome}) — ${path.relative(APP_DIR, runDir).split(path.sep).join('/')}`);
  for (const failure of manifest.failures) console.log(`  runner: ${failure}`);
  return manifest.exitCode;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  return runPass({ ...options, file: path.resolve(options.file) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message ?? String(error)); process.exitCode = 2; });
}
