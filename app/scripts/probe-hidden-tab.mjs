// The hidden-tab probe: one arm per run, in real desktop windows, outside the harness.
//
//   node scripts/probe-hidden-tab.mjs --arm H1|H2|H3|H4|H5|H6|Q --side left|right [--must-skip-return 2]
//
// Headed Chrome with none of cdp.mjs FLAGS' timer, backgrounding or autoplay flags, its own profile
// under the project, a host and a viewer each in its own window side by side. Occlusion detection is
// off, so a window the desktop covers stays visible. The viewer joins by a trusted click; a hide is a blank
// tab brought to the front of the subject's window, never a minimise. Readings once a second over
// CDP, which runs in a hidden page, plus the page's own event log; read by hidden-tab-readings.mjs.
// No name is typed: both prompts are answered with an empty Join.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { attach, cdpHttp, CHROME, clickElement, disposeChrome, rewriteWebSocketDebuggerUrl, sleep, Tab } from './cdp.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { startTracker } from './runner/tracker.mjs';
import { evaluateRun, landedAtMs } from './hidden-tab-readings.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const PORT = 8140;
const TRACKER_PORT = 8141;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The occlusion flag only: a covered window reads hidden without it, before any hide (post-setup, pre-result).
const CHROME_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion'];
const WINDOW = { width: 1000, height: 700 };
const BOUNDS = { host: { left: 0, top: 0, ...WINDOW }, viewer: { left: 1024, top: 0, ...WINDOW } };
const SAMPLE_MS = 1000;
const STEADY_MS = 10_000;
const STEADY_WAIT_MS = 90_000;
const OBSERVE_MS = 30_000;
const MIN_FREE_BYTES = 4 * 1024 ** 3;
const PROMPT_SUBMIT = '#name-prompt button[type="submit"]';

// The arms. `subject` is the page hidden; `during` runs at an offset into a hide.
const ARMS = {
  Q: { subject: 'viewer', script: [{ hideMs: 8000 }], observeMs: 10_000 },
  H1: { subject: 'viewer', script: [{ hideMs: 10_000 }] },
  H2: { subject: 'viewer', unmuted: true, script: [{ hideMs: 10_000 }] },
  H3: { subject: 'viewer', script: [{ hideMs: 10_000 }, { visibleMs: 20_000 }, { hideMs: 10_000 }] },
  H4: { subject: 'viewer', script: [{ hideMs: 360_000 }] },
  H5: { subject: 'viewer', harnessSeek: true, script: [{ hideMs: 10_000, during: { atMs: 3000, seekMs: 30_000 } }] },
  H6: { subject: 'host', script: [{ hideMs: 30_000 }] },
};

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Re-reads a retained run under the readings module's current rules; writes reread.json, never the report.
const rereadDir = argument('reread');
if (rereadDir) {
  const dir = path.resolve(rereadDir);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const { arm: name, side: runSide, subject: runSubject } = report.manifest;
  const result = evaluateRun({
    samples: fs.readFileSync(path.join(dir, 'samples.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    events: JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')),
    marks: report.marks, subject: runSubject, other: runSubject === 'viewer' ? 'host' : 'viewer', side: runSide,
    mustSkipReturn: report.manifest.mustSkipReturn ?? null, audible: ARMS[name]?.unmuted === true,
  });
  fs.writeFileSync(path.join(dir, 'reread.json'), `${JSON.stringify({ rereadAt: new Date().toISOString(), result }, null, 2)}\n`);
  console.log(`validity: ${result.validity.valid ? 'valid' : `INVALID — ${result.validity.reasons.join('; ')}`}`);
  process.exit(0);
}

const armName = argument('arm');
const side = argument('side');
const mustSkipReturn = argument('must-skip-return') === undefined ? null : Number(argument('must-skip-return'));
if (!ARMS[armName] || !['left', 'right'].includes(side)) {
  console.error('usage: node scripts/probe-hidden-tab.mjs --arm H1|H2|H3|H4|H5|H6|Q --side left|right [--must-skip-return n]');
  process.exit(64);
}
const arm = ARMS[armName];
const subject = arm.subject;
const other = subject === 'viewer' ? 'host' : 'viewer';
const startedAt = new Date();
const stamp = startedAt.toISOString().replaceAll(':', '-');
const runDir = path.join(RESULTS_DIR, `13a-hidden-tab-${stamp}-${armName}-${side}`);
const profile = path.join(APP_DIR, '.scratch', '13a-probe', stamp);

const samples = [];
const events = [];
const marks = [];
const manifest = { change: '13a', arm: armName, side, subject, startedAt: startedAt.toISOString(), chromeFlags: CHROME_FLAGS, bounds: BOUNDS, ports: { server: PORT, tracker: TRACKER_PORT }, mustSkipReturn };
let server = null;
let tracker = null;
let chrome = null;
let chromePort = null;
let browser = null;
const tabs = {};
let sampling = false;
let samplingDone = Promise.resolve();
let runnerFailure = null;
const cleanup = [];

class BrowserConnection {
  constructor(endpoint) {
    const url = new URL(endpoint);
    url.hostname = '127.0.0.1';
    this.ws = new WebSocket(url.toString());
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { this.ws.close(); }
}

// Installed before any page script: the visibility log and the element's events, on the page clock.
const recorder = (harnessSeek) => `(() => {
  const events = [];
  const now = () => performance.timeOrigin + performance.now();
  window.__probe = { events };
  try { performance.setResourceTimingBufferSize(100000); } catch {}
  document.addEventListener('visibilitychange', () => events.push({ target: 'document', type: 'visibilitychange', state: document.visibilityState, pageMs: now() }));
  for (const type of ['pause', 'play', 'playing', 'waiting', 'stalled']) {
    document.addEventListener(type, (event) => {
      if (event.target?.id === 'video') events.push({ target: 'video', type, pageMs: now(), paused: event.target.paused, readyState: event.target.readyState });
    }, true);
  }
  ${harnessSeek ? 'window.__waHarnessSeek = true;' : ''}
})()`;

// One sample. `cursor` is how far this page's event log and receipts were read.
const sampleExpression = (cursor) => `(() => {
  const pageMs = performance.timeOrigin + performance.now();
  const visibility = document.visibilityState;
  const app = window.__app;
  const video = document.getElementById('video');
  const probe = window.__probe;
  const newEvents = probe ? probe.events.slice(${cursor.events}) : [];
  if (!app || !video) return { ok: false, pageMs, visibility, why: !app ? 'no-app' : 'no-video', newEvents };
  const playback = app.playback();
  const state = app.playbackState();
  const clock = app.clock();
  const controller = app.controller();
  const placementMs = app.placement()?.placementMs;
  const sharedMs = Number.isFinite(clock?.offsetMs) ? pageMs + clock.offsetMs : null;
  const timelineMediaMs = state && Number.isFinite(sharedMs)
    ? (state.playing && sharedMs >= state.atSharedMs ? state.positionMs + (sharedMs - state.atSharedMs) : state.positionMs) : null;
  const elementMediaMs = Number.isFinite(placementMs) ? video.currentTime * 1000 - placementMs : null;
  let bufferedAheadMs = 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime + 0.05 && video.buffered.end(i) > video.currentTime) bufferedAheadMs = (video.buffered.end(i) - video.currentTime) * 1000;
  }
  const receipts = app.hostReceipts(${cursor.receiptSeq});
  const media = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/media/'));
  return {
    ok: true, pageMs, visibility, newEvents,
    video: { paused: video.paused, readyState: video.readyState, muted: video.muted, ended: video.ended, currentTimeMs: video.currentTime * 1000, bufferedAheadMs },
    elementMediaMs, timelineMediaMs,
    positionGapMs: Number.isFinite(elementMediaMs) && Number.isFinite(timelineMediaMs) ? elementMediaMs - timelineMediaMs : null,
    ticks: app.ticks(), callbacks: playback.callbacks, samplingFrames: playback.sampling,
    playing: playback.playing, roomPlaying: state?.playing ?? null, skips: playback.skips ?? 0,
    lastSkipAbandonedMs: playback.lastSkipAbandonedMs, missing: playback.missing ?? null, waiting: playback.waiting ?? null,
    clock: { sampleCount: clock?.sampleCount ?? null, ageMs: clock?.ageMs ?? null, offsetMs: clock?.offsetMs ?? null, probesIssued: clock?.probes?.issued ?? null },
    controller: { mode: controller?.mode ?? null, reason: controller?.reason ?? null, rate: controller?.rate ?? null, estimateMs: controller?.estimateMs ?? null },
    newReceipts: receipts ? receipts.records.map((r) => ({ seq: r.seq, bytes: r.bodyBytes ?? 0 })) : [],
    httpMedia: { count: media.length, bytes: media.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) },
    roster: document.querySelectorAll('#roster li').length,
  };
})()`;

const cursors = { host: { events: 0, receiptSeq: 0, count: 0, bytes: 0 }, viewer: { events: 0, receiptSeq: 0, count: 0, bytes: 0 } };

async function sampleOnce(page) {
  const atWallMs = Date.now();
  const cursor = cursors[page];
  let reading;
  try { reading = await tabs[page].evaluate(sampleExpression(cursor)); } catch (error) { reading = { ok: false, why: error?.message ?? String(error) }; }
  for (const event of reading?.newEvents ?? []) events.push({ page, ...event });
  cursor.events += reading?.newEvents?.length ?? 0;
  for (const receipt of reading?.newReceipts ?? []) {
    cursor.receiptSeq = Math.max(cursor.receiptSeq, receipt.seq);
    cursor.count += 1;
    cursor.bytes += receipt.bytes;
  }
  const { newEvents, newReceipts, ...rest } = reading ?? {};
  const sample = { page, atWallMs, ...rest, receipts: { count: cursor.count, bytes: cursor.bytes } };
  samples.push(sample);
  return sample;
}

function startSampling() {
  sampling = true;
  samplingDone = (async () => {
    while (sampling) {
      const next = Date.now() + SAMPLE_MS;
      await sampleOnce('host');
      await sampleOnce('viewer');
      await sleep(Math.max(0, next - Date.now()));
    }
  })();
}

async function read(tab, expression) {
  try { return await tab.evaluate(expression); } catch { return null; }
}

async function until(tab, expression, done, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read(tab, expression);
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${label} not reached within ${timeoutMs} ms`);
    await sleep(200);
  }
}

async function startServers() {
  for (const port of [PORT, TRACKER_PORT]) await portFree(port).catch((error) => { throw new Error(`port ${port} is held: ${error.message}`); });
  tracker = startTracker({ port: TRACKER_PORT, hostname: '127.0.0.1', cwd: APP_DIR, env: process.env, stdio: ['ignore', 'ignore', 'ignore'] }).child;
  const env = { ...process.env };
  for (const key of ['APP_AUTO_START', 'APP_MEDIA_SOURCE', 'APP_MEDIA_DIR', 'APP_HOST_GRACE_MS', 'APP_ICE_SERVERS']) delete env[key];
  Object.assign(env, { APP_PORT: String(PORT), APP_DELIVERY: 'host', APP_TRACKER_URL: `ws://127.0.0.1:${TRACKER_PORT}` });
  server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error('the room server exited');
    try { if ((await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error('the room server did not start');
    await sleep(100);
  }
  manifest.settings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
}

async function setupTab(tab, page) {
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: recorder(page === 'host' && arm.harnessSeek === true) });
  tabs[page] = tab;
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: tab.targetId });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: BOUNDS[page] });
  return windowId;
}

async function launchChrome() {
  chromePort = await unusedPort();
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn(CHROME, [...CHROME_FLAGS, '--new-window', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`,
    `--window-position=${BOUNDS.host.left},${BOUNDS.host.top}`, `--window-size=${WINDOW.width},${WINDOW.height}`, 'about:blank'], { stdio: 'ignore' });
  const version = await cdpHttp(chromePort, '/json/version');
  manifest.chrome = { version: version.Browser ?? null, path: CHROME };
  browser = new BrowserConnection(version.webSocketDebuggerUrl);
  manifest.windows = { host: await setupTab(await attach(chromePort, 'about:blank', { label: null }), 'host') };
}

async function openViewer(url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, ...BOUNDS.viewer });
  let target = null;
  const deadline = Date.now() + 20_000;
  while (!target && Date.now() < deadline) {
    target = (await cdpHttp(chromePort, '/json/list')).find((entry) => entry.id === targetId && entry.webSocketDebuggerUrl) ?? null;
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('viewer target did not appear');
  const tab = new Tab({ ...target, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(target, chromePort) });
  await tab.ready;
  manifest.windows.viewer = await setupTab(tab, 'viewer');
  await tab.send('Page.navigate', { url });
  return tab;
}

const present = (selector) => `document.querySelector(${JSON.stringify(selector)}) !== null`;

// The prompt's Join, by a trusted click and with no name: the click is the page's user activation.
async function joinByClick(tab, label) {
  try {
    await until(tab, `(() => { const b = document.querySelector(${JSON.stringify(PROMPT_SUBMIT)}); return b !== null && !b.disabled; })()`, Boolean, 20_000, `${label} name prompt`);
  } catch (error) {
    const seen = await read(tab, "({ route: location.search.replace(/[?&](room|tab)=[^&]*/g, ''), prompt: document.querySelector('#name-prompt') !== null, dialogs: document.querySelectorAll('[role=dialog]').length, buttons: [...document.querySelectorAll('button')].map((b) => b.id || b.type).slice(0, 20) })");
    throw new Error(`${error.message}; page: ${JSON.stringify(seen)}`);
  }
  await sleep(300);
  await clickElement(tab, PROMPT_SUBMIT);
  await until(tab, present('#name-prompt'), (value) => value === false, 5_000, `${label} name prompt closed`);
}

function mark(name, extra = {}) {
  marks.push({ name, atWallMs: Date.now(), ...extra });
}

async function hide(page, ms, during) {
  const tab = tabs[page];
  mark('hide-start', { subject: page });
  await tab.send('Page.bringToFront');
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const blankWindow = (await browser.send('Browser.getWindowForTarget', { targetId })).windowId;
  if (blankWindow !== manifest.windows[page]) {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    throw new Error(`the blank tab opened in window ${blankWindow}, not the ${page}'s ${manifest.windows[page]}`);
  }
  mark('hidden');
  const hiddenAt = Date.now();
  if (during) {
    await sleep(Math.max(0, hiddenAt + during.atMs - Date.now()));
    mark('seek', { seekMs: during.seekMs, result: await read(tabs.host, `JSON.stringify(window.__app.harnessSeek(${during.seekMs}))`) });
  }
  await sleep(Math.max(0, hiddenAt + ms - Date.now()));
  mark('return-start');
  await tab.send('Page.bringToFront');
  mark('visible');
  await browser.send('Target.closeTarget', { targetId }).catch(() => {});
}

async function waitSteady() {
  const deadline = Date.now() + STEADY_WAIT_MS;
  for (;;) {
    const fromMs = Date.now() - 4 * SAMPLE_MS;
    const recent = (page) => samples.filter((s) => s.page === page && s.ok && s.atWallMs >= fromMs - SAMPLE_MS);
    if (['host', 'viewer'].every((page) => landedAtMs(recent(page), fromMs) !== null)) return;
    if (Date.now() >= deadline) throw new Error(`no steady sync within ${STEADY_WAIT_MS} ms`);
    await sleep(SAMPLE_MS);
  }
}

async function run() {
  const free = os.freemem();
  manifest.freeMemoryBytes = free;
  if (free < MIN_FREE_BYTES) throw new Error(`free memory ${(free / 1024 ** 3).toFixed(1)} GB is under 4 GB`);
  await startServers();
  await launchChrome();
  console.log(`chrome: ${manifest.chrome.version}`);
  const room = `13a-${crypto.randomBytes(4).toString('hex')}`;
  await tabs.host.send('Page.navigate', { url: `${ORIGIN}/room.html` });
  await until(tabs.host, present('#host'), Boolean, 20_000, 'front page');
  await clickElement(tabs.host, '#host');
  try {
    await until(tabs.host, "location.search.includes('role=host')", Boolean, 5_000, 'host route');
  } catch (error) {
    const seen = await read(tabs.host, "(() => { const r = document.querySelector('#host').getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { visibility: document.visibilityState, focus: document.hasFocus(), rect: [r.left, r.top, r.width, r.height], at: at ? (at.id || at.tagName) : null, inner: [innerWidth, innerHeight] }; })()");
    throw new Error(`${error.message}; page: ${JSON.stringify(seen)}`);
  }
  await joinByClick(tabs.host, 'host');
  const invite = await until(tabs.host, "document.querySelector('#invite')?.href ?? null", (value) => typeof value === 'string' && value.includes('room='), 20_000, 'invite');
  manifest.room = room;
  await openViewer(invite);
  await joinByClick(tabs.viewer, 'viewer');
  const buildIds = {};
  for (const page of ['host', 'viewer']) buildIds[page] = await until(tabs[page], 'window.__app?.buildId ?? null', (value) => typeof value === 'string', 20_000, `${page} build`);
  manifest.build = { pages: buildIds, bundle: await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: buildIds.host }) };
  if (buildIds.host !== buildIds.viewer || !manifest.build.bundle.matches || !manifest.build.bundle.pageIdInServed) throw new Error('the pages do not run the bundle on disk');
  await until(tabs.host, "document.querySelectorAll('#roster li').length", (value) => value === 2, 20_000, 'both in the roster');
  if (arm.unmuted) {
    await clickElement(tabs.viewer, '#mute');
    await until(tabs.viewer, "document.getElementById('video').muted", (value) => value === false, 5_000, 'viewer unmuted');
  }
  await until(tabs.host, "document.querySelector('#play')?.disabled === false", Boolean, 30_000, 'play enabled');
  startSampling();
  await clickElement(tabs.host, '#play');
  mark('play');
  await waitSteady();
  mark('steady');
  await sleep(STEADY_MS);
  for (const step of arm.script) {
    if (step.hideMs) await hide(subject, step.hideMs, step.during);
    else await sleep(step.visibleMs);
  }
  await sleep(arm.observeMs ?? OBSERVE_MS);
  mark('end');
}

function evaluate() {
  if (!marks.some((m) => m.name === 'end')) mark('end');
  return evaluateRun({ samples, events, marks, subject, other, side, mustSkipReturn, audible: arm.unmuted === true });
}

try {
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  await run();
} catch (error) {
  runnerFailure = error?.message ?? String(error);
  console.error(`runner failure: ${runnerFailure}`);
} finally {
  sampling = false;
  await samplingDone.catch(() => {});
  for (const tab of Object.values(tabs)) await browser?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  browser?.close();
  if (chrome) {
    try { manifest.chromeDisposal = await disposeChrome(chrome, profile); } catch (error) { cleanup.push(`chrome: ${error?.message ?? error}`); }
  }
  for (const child of [server, tracker]) {
    if (child) await stopChild(child).catch((error) => cleanup.push(`child: ${error?.message ?? error}`));
  }
  let result = null;
  try { result = evaluate(); } catch (error) { runnerFailure ??= `evaluation: ${error?.message ?? error}`; }
  manifest.finishedAt = new Date().toISOString();
  if (fs.existsSync(runDir)) {
    fs.writeFileSync(path.join(runDir, 'samples.ndjson'), `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`);
    fs.writeFileSync(path.join(runDir, 'events.json'), `${JSON.stringify(events, null, 1)}\n`);
    fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({ manifest, marks, result, runnerFailure, cleanup }, null, 2)}\n`);
  }
  if (result) {
    console.log(`validity: ${result.validity.valid ? 'valid' : `INVALID — ${result.validity.reasons.join('; ')}`}`);
    console.log(`visible: ${JSON.stringify(result.visible)} · hidden tick rates: ${JSON.stringify(result.validity.hiddenTickRates)}`);
    result.readings.forEach((reading, index) => console.log(`hide ${index + 1}: ${JSON.stringify(reading)}`));
    if (result.d7) console.log(`D7: ${result.returnsPass ? 'PASS' : 'FAIL'} ${JSON.stringify(result.d7)}`);
  }
  console.log(`run directory: ${path.relative(APP_DIR, runDir)}`);
  process.exitCode = runnerFailure ? 2 : result && !result.validity.valid ? 3 : result?.returnsPass === false ? 1 : 0;
}
