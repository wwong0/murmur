import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as CdpWebSocket } from 'ws';

import {
  attach, cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, rewriteWebSocketDebuggerUrl, sleep, Tab,
} from './cdp.mjs';
import { assertServedBundle, createManifestFile, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { startTracker } from './runner/tracker.mjs';
import { closeNamePrompt, setHostFile } from './room-page-steps.mjs';
import { fileIdentity } from '../public/lib/file-identity.mjs';
import {
  exitCode, grace, rc0, rc1, rc2, rc3, rc4, rc5, rc6, rc7, rc8,
} from './room-continuity-steps.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const F_PORT = 8132;
const TRACKER_PORT = 8133;
const D_PORT = 8134;
const F_ORIGIN = `http://127.0.0.1:${F_PORT}`;
const D_ORIGIN = `http://127.0.0.1:${D_PORT}`;
const TRACKER_URL = `ws://127.0.0.1:${TRACKER_PORT}`;
const TITLE_A = path.join(APP_DIR, '.scratch', '12a-c2', 'titles', 'title-a.mp4');
const TITLE_B = path.join(APP_DIR, '.scratch', '12a-c2', 'titles', 'title-b.mp4');
const REFUSED = path.join(APP_DIR, 'scripts', 'check', 'remux-fixtures', 'refuse-audio-codec.mp4');
const POLL_MS = 50;
const HOST_WAIT_MS = 60_000;
const ROOM_WAIT_MS = 30_000;
const GRACE_WAIT_MS = 8_000;
const FIXTURE_NAMES = Object.freeze({ a: 'title-a.mp4', b: 'title-b.mp4' });

class BrowserConnection {
  constructor(endpoint) {
    const url = new URL(endpoint);
    url.hostname = '127.0.0.1';
    this.ws = new CdpWebSocket(url.toString());
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

const RECORDER = `(() => {
  const state = { frames: [] };
  globalThis.__roomContinuityRecorder = state;
  function install() {
    const video = document.querySelector('#video');
    if (!video || typeof video.requestVideoFrameCallback !== 'function') { setTimeout(install, 0); return; }
    const frame = (wallTime, metadata) => {
      state.frames.push({ mediaTime: metadata.mediaTime, wallTime });
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }
  install();
})()`;

const snapshotExpression = (afterPeerSeq = 0) => `(() => {
  const app = globalThis.__app;
  const video = document.querySelector('#video');
  const recorder = globalThis.__roomContinuityRecorder;
  if (!app || !recorder) return { present: false };
  const line = document.querySelector('#host-preparing');
  const status = document.querySelector('#host-file-status');
  const link = app.hostLink?.();
  const file = app.hostFile?.();
  return {
    present: true,
    buildId: app.buildId,
    title: app.title(),
    titleName: document.querySelector('#title-name')?.textContent ?? null,
    state: app.playbackState(),
    grace: app.hostGrace(),
    hostFile: file ? { state: file.state ?? null, fraction: file.fraction ?? null, origin: file.origin ?? null, workerCalls: file.workerCalls ?? null } : null,
    hostFileStatus: status?.textContent ?? null,
    hostPreparing: line ? { state: line.dataset.state ?? null, fraction: line.dataset.fraction === '' ? null : Number(line.dataset.fraction), text: line.textContent ?? '' } : null,
    bodyText: document.body.innerText,
    playDisabled: document.querySelector('#play')?.disabled ?? null,
    forwardDisabled: document.querySelector('#forward-10')?.disabled ?? null,
    controlMode: app.timeline?.()?.controlMode ?? null,
    roster: [...document.querySelectorAll('#roster li')].map((li) => li.textContent),
    hostLink: link ? { state: link.state ?? null, requestsByPath: { ...(link.requestsByPath ?? {}) } } : null,
    // The bundled p2p-media-loader keeps swarmId in the per-stream config, not at the top of core.
    swarmId: app.peerEngineConfig?.()?.mainStream?.swarmId ?? null,
    peerBytes: app.peerBytes?.(${afterPeerSeq}),
    sharedNowMs: (() => { const c = app.clock?.(); return c && c.offsetMs !== null ? c.atMs + c.offsetMs : null; })(),
    frames: recorder.frames.slice(),
    video: video ? { paused: video.paused, currentTime: video.currentTime } : null,
  };
})()`;

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--run-dir' || args[1].startsWith('--')) throw new Error('usage: node scripts/verify-room-continuity.mjs --run-dir results/12a-room-continuity-<ISO>');
  return path.resolve(APP_DIR, args[1]);
}

async function sourceFor(filename) {
  const handle = await fs.promises.open(filename, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    },
    close: () => handle.close(),
  };
}

async function fixture(filename, name) {
  let stat;
  try { stat = await fs.promises.stat(filename); } catch { throw new Error(`fixture is missing: ${name}`); }
  if (!stat.isFile()) throw new Error(`fixture is not a file: ${name}`);
  const source = await sourceFor(filename);
  try { return { name, bytes: source.size, identity: await fileIdentity(source) }; }
  finally { await source.close(); }
}

async function waitForPort(port, child, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited before port ${port} opened`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch { await sleep(100); }
  }
  throw new Error(`${label} did not open port ${port}`);
}

function capture(child, file) {
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()));
  child.on('error', (error) => output.push(`${error.stack ?? error}\n`));
  return () => fs.writeFileSync(file, output.join(''));
}

function hostInRoster(snapshot) {
  return Array.isArray(snapshot?.roster) && snapshot.roster.some((entry) => typeof entry === 'string' && entry.includes(' · host · '));
}

function reportReady(snapshot, identity) {
  return snapshot?.title?.reportIdentity === identity;
}

function hostIds(snapshot) {
  return (Array.isArray(snapshot?.roster) ? snapshot.roster : [])
    .map((entry) => (typeof entry === 'string' ? entry.split(' · ') : []))
    .filter((parts) => parts[1] === 'host').map((parts) => parts[2]);
}

// After a reload the old host may still be listed until its socket closes; only a new client id counts.
function newHostIn(snapshot, oldIds) {
  return hostIds(snapshot).some((id) => !oldIds.includes(id));
}

function memberOf(snapshot) {
  return { title: snapshot?.title ?? null, titleName: snapshot?.titleName ?? null, state: snapshot?.state ?? null, videoPaused: snapshot?.video?.paused ?? null };
}

// The distinct state versions a page observed, in order, over the given phases.
function versionTrail(page, phases, seed = []) {
  const seen = [...seed, ...page.polls.filter((entry) => phases.includes(entry.phase) && entry.snapshot?.state)
    .map((entry) => ({ version: entry.snapshot.state.version, title: entry.snapshot.title?.title ?? null }))];
  return seen.filter((entry, index) => index === 0 || entry.version !== seen[index - 1].version);
}

function framesAfter(page, mark) {
  return page.frames.slice(mark);
}

function safeError(error) {
  const text = error?.message ?? String(error);
  return text.replaceAll(TITLE_A, FIXTURE_NAMES.a).replaceAll(TITLE_B, FIXTURE_NAMES.b).replaceAll(REFUSED, 'refuse-audio-codec.mp4');
}

// post-result diagnostic (12b C2, T10)
const RC7_PLAY_READ = `(() => {
  const play = document.querySelector('#play');
  const box = play?.getBoundingClientRect() ?? null;
  const style = play ? getComputedStyle(play) : null;
  const x = box ? box.left + box.width / 2 : null;
  const y = box ? box.top + box.height / 2 : null;
  const hit = box ? document.elementFromPoint(x, y) : null;
  return {
    box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    disabled: play?.disabled ?? null,
    visibility: style?.visibility ?? null,
    display: style?.display ?? null,
    opacity: style?.opacity ?? null,
    hit: hit ? { tag: hit.tagName, id: hit.id, class: hit.getAttribute('class'), insidePlay: play.contains(hit) } : null,
    pointInViewport: box ? x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight : null,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    playbackState: window.__app?.playbackState?.() ?? null,
  };
})()`;

async function main(runDir) {
  const startedAt = new Date();
  const fixtures = { a: await fixture(TITLE_A, FIXTURE_NAMES.a), b: await fixture(TITLE_B, FIXTURE_NAMES.b), refused: { name: 'refuse-audio-codec.mp4', bytes: (await fs.promises.stat(REFUSED)).size } };
  const manifestFile = createManifestFile({
    runDir,
    initial: {
      schemaVersion: 1, runner: 'verify-room-continuity', startedAt: startedAt.toISOString(),
      fixtures, reloads: [], counters: null, rows: [], chrome: null, build: null, grace: null, failures: [],
      servers: { f: { port: F_PORT, origin: F_ORIGIN }, d: { port: D_PORT, origin: D_ORIGIN }, tracker: { port: TRACKER_PORT, url: TRACKER_URL } },
    },
  });
  const manifest = manifestFile.get();
  manifestFile.write();
  const outputLines = [];
  const rows = [];
  const children = [];
  const pages = [];
  const polls = new Map();
  const frames = new Map();
  let serverF = null;
  let serverD = null;
  let tracker = null;
  let chrome = null;
  let browser = null;
  let chromePort = null;
  let profile = null;
  let host = null;
  let v1 = null;
  let v2 = null;
  let host2 = null;
  let runnerFailure = null;
  let cleanupFailure = null;

  const emit = (line) => { outputLines.push(line); console.log(line); };
  const writeManifest = () => manifestFile.write();
  const record = (value) => {
    rows.push(value);
    manifest.rows = rows;
    writeManifest();
    emit(`${value.row} ${value.verdict} ${value.detail}`);
  };
  const evaluate = (fn, reading) => {
    try { return fn(reading); }
    catch (error) { return { row: fn.name.toUpperCase(), verdict: 'UNESTABLISHED', detail: `evaluation error: ${safeError(error)}` }; }
  };

  async function getJson(origin, pathname) {
    const response = await fetch(`${origin}${pathname}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
    return response.json();
  }

  async function startTrackerProcess() {
    tracker = startTracker({ port: TRACKER_PORT, hostname: '127.0.0.1', cwd: APP_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).child;
    children.push(tracker);
    const write = capture(tracker, path.join(runDir, 'tracker.log'));
    await waitForPort(TRACKER_PORT, tracker, 'tracker');
    tracker._writeOutput = write;
  }

  async function startServer(kind, port, overrides, deletions = []) {
    const env = { ...process.env };
    for (const key of deletions) delete env[key];
    Object.assign(env, overrides, { APP_PORT: String(port) });
    const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const write = capture(child, path.join(runDir, `${kind}-server.log`));
    await waitForPort(port, child, `${kind} server`);
    const origin = kind === 'F' ? F_ORIGIN : D_ORIGIN;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${kind} server exited before readiness`);
      try { if ((await fetch(`${origin}/room.html`, { cache: 'no-store' })).ok) { child._writeOutput = write; return child; } } catch {}
      await sleep(100);
    }
    throw new Error(`${kind} server did not become ready`);
  }

  async function setupTab(tab, label) {
    await tab.send('Runtime.enable');
    await tab.send('Page.enable');
    await tab.send('DOM.enable');
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    const page = { tag: label, tab, frames: [], peerAfterSeq: 0, polls: [], closed: false };
    pages.push(page);
    polls.set(label, page.polls);
    frames.set(label, page.frames);
    return page;
  }

  async function navigate(page, url) {
    page.frames.length = 0;
    page.peerAfterSeq = 0;
    await page.tab.send('Page.navigate', { url });
  }

  async function openPage(label, url) {
    if (pages.filter((page) => !page.closed).length >= 4) throw new Error('N1 exceeded the four-target limit');
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1100, height: 700 });
    const target = await waitForTarget(targetId);
    if (!target) throw new Error(`${label} target did not appear`);
    const tab = new Tab({ ...target, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(target, chromePort) }, { label });
    await tab.ready;
    const page = await setupTab(tab, label);
    await navigate(page, url);
    return page;
  }

  async function waitForTarget(targetId) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const list = await cdpHttp(chromePort, '/json/list');
      const target = Array.isArray(list) && list.find((entry) => entry.id === targetId && entry.webSocketDebuggerUrl);
      if (target) return target;
      await sleep(100);
    }
    return null;
  }

  async function read(page, phase) {
    let snapshot;
    try { snapshot = await page.tab.evaluate(snapshotExpression(page.peerAfterSeq)); }
    catch (error) { snapshot = { present: false, error: safeError(error) }; }
    if (snapshot?.present) {
      const prior = page.frames.length;
      page.frames.push(...(snapshot.frames ?? []).slice(prior));
      if (snapshot.peerBytes?.latestSeq !== undefined && page.peerAfterSeq === 0 && phase === 'B-load-mark') page.peerAfterSeq = snapshot.peerBytes.latestSeq;
    }
    page.polls.push({ atMs: Date.now(), phase, snapshot });
    return snapshot;
  }

  async function waitUntil(label, readValue, predicate, timeoutMs, everyMs = POLL_MS) {
    const deadline = Date.now() + timeoutMs;
    let value = await readValue();
    while (!predicate(value)) {
      if (Date.now() >= deadline) throw new Error(`${label} was not reached within ${timeoutMs} ms`);
      await sleep(Math.min(everyMs, Math.max(1, deadline - Date.now())));
      value = await readValue();
    }
    return value;
  }

  async function closePage(page) {
    if (!page || page.closed) return;
    page.closed = true;
    await browser.send('Target.closeTarget', { targetId: page.tab.targetId });
  }

  async function buildInfo(origin, pageBuildId) {
    const disk = fs.readFileSync(BUNDLE_PATH, 'utf8');
    const bundle = await assertServedBundle({ origin, bundlePath: BUNDLE_PATH, pageBuildId });
    return { ...bundle, pageBuildId, pageIdInDisk: disk.includes(pageBuildId) };
  }

  async function launchBrowser(room) {
    chromePort = await unusedPort();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-continuity-'));
    chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, '--window-size=1100,700', 'about:blank'], { stdio: 'ignore' });
    const version = await cdpHttp(chromePort, '/json/version');
    manifest.chrome = { version: version.Browser ?? null, path: CHROME };
    emit(`chrome: ${version.Browser ?? null} · ${CHROME}`);
    browser = new BrowserConnection(version.webSocketDebuggerUrl);
    const tab = await attach(chromePort, 'about:blank', { label: 'host' });
    host = await setupTab(tab, 'host');
    await navigate(host, `${F_ORIGIN}/room.html?room=${room}&role=host&tab=host`);
  }

  try {
    await startTrackerProcess();
    serverF = await startServer('F', F_PORT, { APP_MEDIA_SOURCE: 'file', APP_DELIVERY: 'host', APP_AUTO_START: '1', APP_HOST_GRACE_MS: '3000', APP_SEGMENT_TARGET_S: '2', APP_ICE_SERVERS: '[]', APP_TRACKER_URL: TRACKER_URL });
    serverD = await startServer('D', D_PORT, { APP_DELIVERY: 'http' }, ['APP_AUTO_START', 'APP_MEDIA_SOURCE', 'APP_HOST_GRACE_MS']);
    const settingsF = await getJson(F_ORIGIN, '/app-settings');
    const settingsD = await getJson(D_ORIGIN, '/app-settings');
    const room = `12a-${Math.random().toString(16).slice(2)}`;
    await launchBrowser(room);
    const fStart = await waitUntil('host page', () => read(host, 'start'), (value) => value.present === true && typeof value.buildId === 'string', ROOM_WAIT_MS);
    const dProbe = await openPage('d-probe', `${D_ORIGIN}/room.html?room=${room}-probe`);
    console.log(`name prompt d-probe: ${JSON.stringify(await closeNamePrompt(dProbe.tab))}`);
    const dStart = await waitUntil('D probe page', () => read(dProbe, 'start'), (value) => value.present === true && typeof value.buildId === 'string', ROOM_WAIT_MS);
    await closePage(dProbe);
    const f1 = { pageBuildId: fStart.buildId, settings: settingsF, bundle: await buildInfo(F_ORIGIN, fStart.buildId) };
    const dBundle = await buildInfo(D_ORIGIN, dStart.buildId);
    manifest.build = { f: f1.bundle, d: dBundle, pageBuildId: { f: fStart.buildId, d: dStart.buildId } };
    record(evaluate(rc0, { f: f1, d: { pageBuildId: dStart.buildId, bundle: dBundle } }));
    record(evaluate(rc1, { expectedDGraceMs: 10000, f: { settings: settingsF }, d: { settings: settingsD } }));

    v1 = await openPage('v1', `${F_ORIGIN}/room.html?room=${room}`);
    console.log(`name prompt v1: ${JSON.stringify(await closeNamePrompt(v1.tab))}`);
    v2 = await openPage('v2', `${F_ORIGIN}/room.html?room=${room}`);
    console.log(`name prompt v2: ${JSON.stringify(await closeNamePrompt(v2.tab))}`);
    await waitUntil('viewer pages', async () => ({ host: await read(host, 'join'), v1: await read(v1, 'join'), v2: await read(v2, 'join') }), (value) => value.v1.present && value.v2.present && hostInRoster(value.v1) && hostInRoster(value.v2), ROOM_WAIT_MS);
    const beforeCounters = await getJson(F_ORIGIN, '/harness/counters');
    await setHostFile(host.tab, REFUSED);
    const refused = await waitUntil('refused fixture', async () => ({ host: await read(host, 'RC2'), v1: await read(v1, 'RC2'), v2: await read(v2, 'RC2') }), (value) => value.host.hostFile?.state === 'refused' && value.v1.hostPreparing?.state === 'choosing' && value.v2.hostPreparing?.state === 'choosing', 15_000);
    const afterCounters = await getJson(F_ORIGIN, '/harness/counters');
    manifest.counters = afterCounters.counters ?? afterCounters;
    const rc2Reading = {
      host: { hostFileStatus: refused.host.hostFileStatus },
      viewers: [refused.v1, refused.v2].map((value) => ({ hostPreparing: value.hostPreparing, bodyText: value.bodyText, playDisabled: value.playDisabled, requestsByPath: value.hostLink?.requestsByPath ?? {} })),
      counters: afterCounters.counters,
      beforeCounters: beforeCounters.counters ?? beforeCounters,
    };
    record(evaluate(rc2, rc2Reading));

    await setHostFile(host.tab, TITLE_A);
    const titleAReady = await waitUntil('title A', async () => ({ host: await read(host, 'RC3'), v1: await read(v1, 'RC3'), v2: await read(v2, 'RC3') }), (value) => value.host.hostFile?.state === 'ready' && [value.host, value.v1, value.v2].every((entry) => entry.title?.title === fixtures.a.identity), HOST_WAIT_MS);
    const stablePolls = [];
    const stableStart = Date.now();
    while (Date.now() - stableStart < 3_000) {
      const value = { host: await read(host, 'RC3-stable'), v1: await read(v1, 'RC3-stable'), v2: await read(v2, 'RC3-stable') };
      stablePolls.push({ members: [value.host, value.v1, value.v2].map(memberOf) });
      await sleep(250);
    }
    record(evaluate(rc3, { expected: { identity: fixtures.a.identity, name: FIXTURE_NAMES.a }, members: [titleAReady.host, titleAReady.v1, titleAReady.v2].map(memberOf), stableMs: Date.now() - stableStart, stablePolls }));

    const playMarks = [v1, v2].map((page) => page.frames.length);
    await clickElement(host.tab, '#play');
    const playing = await waitUntil('title A playback', async () => ({ v1: await read(v1, 'RC4'), v2: await read(v2, 'RC4') }), (value) => [v1, v2].every((page, index) => {
      const entries = framesAfter(page, playMarks[index]);
      return entries.length > 1 && Math.max(...entries.map((entry) => entry.mediaTime)) - Math.min(...entries.map((entry) => entry.mediaTime)) >= 5;
    }), 30_000);
    const swarmIds = [playing.v1.swarmId, playing.v2.swarmId];
    record(evaluate(rc4, { frames: [framesAfter(v1, playMarks[0]), framesAfter(v2, playMarks[1])], swarmIds, expectedSwarmId: `${room}:${fixtures.a.identity}` }));

    const reloads = [];
    for (let index = 0; index < 5; index += 1) {
      const before = await read(v1, 'RC5-before');
      const oldHostIds = hostIds(before);
      const sentAtMs = Date.now();
      await host.tab.send('Page.reload', { ignoreCache: true });
      const pollReadings = [];
      let rejoinAtMs = null;
      let readyAtMs = null;
      let sawHostless = false;
      let latest = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = { host: await read(host, 'RC5'), v1: await read(v1, 'RC5'), v2: await read(v2, 'RC5') };
        latest = value;
        if (value.v1.present && value.v2.present && value.v1.state && value.v2.state) {
          pollReadings.push({ viewers: [{ state: value.v1.state }, { state: value.v2.state }] });
          if (!hostInRoster(value.v1) || !hostInRoster(value.v2)) sawHostless = true;
          if (rejoinAtMs === null && newHostIn(value.v1, oldHostIds) && newHostIn(value.v2, oldHostIds)) rejoinAtMs = Date.now();
          if (readyAtMs === null && rejoinAtMs !== null && value.host.hostFile?.state === 'ready' && reportReady(value.v1, fixtures.a.identity) && reportReady(value.v2, fixtures.a.identity)) readyAtMs = Date.now();
        }
        if (readyAtMs !== null) break;
        await sleep(POLL_MS);
      }
      if (!latest || readyAtMs === null || rejoinAtMs === null) throw new Error(`reload ${index + 1} did not rejoin and become ready`);
      await sleep(2_000);
      const after = { v1: await read(v1, 'RC5-after'), v2: await read(v2, 'RC5-after') };
      const entry = {
        sentAtMs, rejoinAtMs, readyAtMs, reloadToRejoinMs: rejoinAtMs - sentAtMs, reloadToReadyMs: readyAtMs - sentAtMs,
        sawHostless, preIdentity: { lineage: before.state?.lineage, version: before.state?.version }, polls: pollReadings,
        rejoined: { viewers: [{ rosterHasHost: newHostIn(latest.v1, oldHostIds), reportReady: reportReady(latest.v1, fixtures.a.identity) }, { rosterHasHost: newHostIn(latest.v2, oldHostIds), reportReady: reportReady(latest.v2, fixtures.a.identity) }] },
        hostFileState: latest.host.hostFile?.state,
        after: { viewers: [after.v1, after.v2].map(memberOf) },
      };
      manifest.reloads.push({ sentAtMs, rejoinAtMs, readyAtMs, reloadToRejoinMs: entry.reloadToRejoinMs, reloadToReadyMs: entry.reloadToReadyMs, sawHostless });
      reloads.push(entry);
      writeManifest();
    }
    record(evaluate(rc5, { expected: { identity: fixtures.a.identity, name: FIXTURE_NAMES.a }, reloads }));
    // state.positionMs is the anchor at the last transition; the room's position is projected on the shared clock.
    await waitUntil('RC6 position', () => read(v1, 'RC6-pre'), (value) => value.state?.playing === true && value.sharedNowMs !== null
      && value.state.positionMs + (value.sharedNowMs - value.state.atSharedMs) >= 20_000, 30_000);
    const beforeClose = { v1: await read(v1, 'RC6-pre'), v2: await read(v2, 'RC6-pre') };
    await closePage(host);
    host = null;
    const leavePolls = { v1: [], v2: [] };
    let leaveLatest = null;
    await waitUntil('host grace pause', async () => {
      const value = { v1: await read(v1, 'RC6'), v2: await read(v2, 'RC6') };
      leaveLatest = value;
      leavePolls.v1.push({ atSharedMs: value.v1.sharedNowMs, state: value.v1.state });
      leavePolls.v2.push({ atSharedMs: value.v2.sharedNowMs, state: value.v2.state });
      return value;
    }, (value) => [value.v1, value.v2].every((entry) => entry.hostPreparing?.state === 'absent' && entry.state?.playing === false), GRACE_WAIT_MS);
    record(evaluate(rc6, {
      graceMs: 3000,
      gracePauses: (leaveLatest.v1.grace?.pauses ?? NaN) + (leaveLatest.v2.grace?.pauses ?? NaN),
      viewers: [v1, v2].map((page, index) => ({
        prev: beforeClose[page.tag].state,
        versions: versionTrail(page, ['RC6-pre', 'RC6']).map((entry) => entry.version),
        grace: leaveLatest[page.tag].grace,
        polls: leavePolls[page.tag].filter((poll) => poll.state && poll.atSharedMs !== null),
        paused: leaveLatest[page.tag].state,
        hostPreparing: { state: leaveLatest[page.tag].hostPreparing?.state, text: leaveLatest[page.tag].hostPreparing?.text },
        playDisabled: leaveLatest[page.tag].playDisabled,
      })),
    }));

    host2 = await openPage('host2', `${F_ORIGIN}/room.html?room=${room}&role=host&tab=host2`);
    await waitUntil('returning host', async () => ({ host: await read(host2, 'RC7-choosing'), v1: await read(v1, 'RC7-choosing'), v2: await read(v2, 'RC7-choosing') }), (value) => value.host.present && value.host.hostFile?.state === 'awaiting-file'
      && value.v1.hostPreparing?.state === 'choosing' && value.v2.hostPreparing?.state === 'choosing', ROOM_WAIT_MS);
    await setHostFile(host2.tab, TITLE_B);
    const bMark = { v1: null, v2: null };
    const bReady = await waitUntil('title B', async () => {
      const pre = { v1: v1.frames.length, v2: v2.frames.length };
      const value = { host: await read(host2, 'RC7'), v1: await read(v1, 'RC7'), v2: await read(v2, 'RC7') };
      // The no-old-frame window opens at the first poll on which either viewer shows title B.
      if (bMark.v1 === null && [value.v1, value.v2].some((entry) => entry.title?.title === fixtures.b.identity)) {
        bMark.v1 = pre.v1;
        bMark.v2 = pre.v2;
      }
      return value;
    }, (value) => [value.host, value.v1, value.v2].every((entry) => entry.hostFile?.state === 'ready' || entry.title?.title === fixtures.b.identity) && value.v1.title?.title === fixtures.b.identity && value.v2.title?.title === fixtures.b.identity, HOST_WAIT_MS);
    for (const page of [v1, v2]) page.peerAfterSeq = bReady[page.tag].peerBytes?.latestSeq ?? 0;
    await sleep(500);
    await read(v1, 'B-load-mark');
    await read(v2, 'B-load-mark');
    const playBMarks = { v1: v1.frames.length, v2: v2.frames.length };
    const playRead = await host2.tab.evaluate(RC7_PLAY_READ).catch((error) => ({ error: safeError(error) }));
    await clickElement(host2.tab, '#play');
    try {
      await waitUntil('title B playback', async () => ({ v1: await read(v1, 'RC7-play'), v2: await read(v2, 'RC7-play') }), (value) => [v1, v2].every((page) => {
        const entries = framesAfter(page, playBMarks[page.tag]);
        return entries.length > 1 && Math.max(...entries.map((entry) => entry.mediaTime)) - Math.min(...entries.map((entry) => entry.mediaTime)) >= 5;
      }), 30_000);
    } catch (error) {
      const after = await host2.tab.evaluate(RC7_PLAY_READ).catch((readError) => ({ error: safeError(readError) }));
      const afterRead = after.error ? after : { playbackState: after.playbackState, disabled: after.disabled, hit: after.hit };
      console.log(`RC7 play diagnostic: ${JSON.stringify({ before: playRead, after: afterRead })}`);
      throw error;
    }
    // peerId stays the first engine's; the current (title B) engine is the last of peerIds (12a D1 F4).
    const bPeer = [v1, v2].map((page) => ({ peerId: page.polls.at(-1)?.snapshot?.peerBytes?.peerIds?.at(-1) ?? null, priorPeerIds: leaveLatest[page.tag].peerBytes?.peerIds ?? null, records: page.polls.filter((entry) => entry.phase === 'B-load-mark' || entry.phase === 'RC7-play').flatMap((entry) => entry.snapshot?.peerBytes?.records ?? []).filter((record) => typeof record.source === 'string').filter((record, index, all) => all.findIndex((candidate) => candidate.seq === record.seq) === index) }));
    record(evaluate(rc7, {
      precondition: { noOldFrame: (leaveLatest.v1.state?.positionMs ?? 0) >= 20_000 },
      expected: { identity: fixtures.b.identity, name: FIXTURE_NAMES.b, version: (leaveLatest.v1.state?.version ?? 0) + 1, swarmId: `${room}:${fixtures.b.identity}` },
      previousSwarmId: swarmIds[0], members: [bReady.host, bReady.v1, bReady.v2].map(memberOf),
      oldFrames: [v1.frames.slice(bMark.v1, playBMarks.v1), v2.frames.slice(bMark.v2, playBMarks.v2)], playFrames: [framesAfter(v1, playBMarks.v1), framesAfter(v2, playBMarks.v2)],
      swarmIds: [bReady.v1.swarmId, bReady.v2.swarmId], peerBytes: bPeer,
      stateChanges: [v1, v2].map((page) => versionTrail(page, ['RC7-choosing', 'RC7', 'B-load-mark'],
        [{ version: leaveLatest[page.tag].state?.version, title: leaveLatest[page.tag].state ? fixtures.a.identity : null }])),
    }));

    await closePage(v2);
    await closePage(host2);
    host2 = null;
    await navigate(v1, `${D_ORIGIN}/room.html?room=${room}-dir`);
    console.log(`name prompt D viewer: ${JSON.stringify(await closeNamePrompt(v1.tab))}`);
    await sleep(1_000);
    const created = await waitUntil('D viewer', () => read(v1, 'RC8'), (value) => value.present && value.state !== null && value.forwardDisabled === false, ROOM_WAIT_MS);
    for (const positionMs of [10_000, 20_000, 30_000]) {
      // A seek disables forward-10 until it lands; a click before then does nothing (12a D1 F6).
      await waitUntil('D forward enabled', () => read(v1, 'RC8-seek'), (value) => value.forwardDisabled === false, 5_000);
      await clickElement(v1.tab, '#forward-10');
      await waitUntil('D forward seek', () => read(v1, 'RC8-seek'), (value) => value.state?.playing === false && value.state.positionMs === positionMs, 5_000);
    }
    const seeked = await waitUntil('D seek', () => read(v1, 'RC8-seek'), (value) => value.state?.playing === false && value.state.positionMs === 30_000, 15_000);
    await v1.tab.send('Page.reload', { ignoreCache: true });
    const reloaded = await waitUntil('D reload', () => read(v1, 'RC8-reload'), (value) => value.state?.playing === false && value.state.positionMs === 30_000, 15_000);
    await navigate(v1, `${D_ORIGIN}/room.html`);
    const noRoom = await waitUntil('no-room route', () => v1.tab.evaluate('({ sessionStorage: sessionStorage.getItem("watchalong.playback-state"), url: location.href })'), (value) => value && value.sessionStorage === null, ROOM_WAIT_MS);
    record(evaluate(rc8, { created: created.state, seeked: { ...seeked.state, controlMode: seeked.controlMode }, reloaded: { ...reloaded.state, controlMode: reloaded.controlMode }, noRoom }));
    manifest.grace = grace(manifest.reloads);
    writeManifest();
  } catch (error) {
    runnerFailure = safeError(error);
    emit(`runner failure: ${runnerFailure}`);
  } finally {
    for (const page of pages) {
      const safe = page.tag.replaceAll('/', '-');
      fs.writeFileSync(path.join(runDir, `frames-${safe}.json`), `${JSON.stringify(page.frames, null, 2)}\n`);
      fs.writeFileSync(path.join(runDir, `polls-${safe}.json`), `${JSON.stringify(page.polls, null, 2)}\n`);
    }
    const knownRows = new Set(rows.map((row) => row.row));
    for (const row of ['RC0', 'RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6', 'RC7', 'RC8']) {
      if (!knownRows.has(row)) rows.push({ row, verdict: 'UNESTABLISHED', detail: runnerFailure ? `runner failure: ${runnerFailure}` : 'evidence is missing or malformed' });
    }
    rows.sort((left, right) => left.row.localeCompare(right.row));
    manifest.rows = rows;
    if (manifest.reloads.length > 0) manifest.grace = grace(manifest.reloads);
    if (runnerFailure) manifest.failures.push(runnerFailure);
    if (cleanupFailure) manifest.failures.push(cleanupFailure);
    manifest.endedAt = new Date().toISOString();
    manifestFile.write();
    fs.writeFileSync(path.join(runDir, 'rows.txt'), `${rows.map((row) => `${row.row} ${row.verdict} ${row.detail}`).join('\n')}\n`);
    fs.writeFileSync(path.join(runDir, 'N1.log'), `${outputLines.join('\n')}\n`);
    for (const page of pages.slice().reverse()) {
      try { if (!page.closed) await closePage(page); } catch (error) { cleanupFailure ??= safeError(error); }
    }
    if (browser) browser.close();
    if (chrome) {
      try { await disposeChrome(chrome, profile); } catch (error) { cleanupFailure ??= safeError(error); }
    }
    for (const child of children.slice().reverse()) {
      try { await stopChild(child); } catch (error) { cleanupFailure ??= safeError(error); }
      try { child._writeOutput?.(); } catch {}
    }
    manifest.failures = [...new Set(manifest.failures)];
    manifest.status = runnerFailure || cleanupFailure ? 'aborted' : 'complete';
    manifest.outcome = runnerFailure || cleanupFailure ? 'failed' : exitCode(rows) === 0 ? 'pass' : 'failed';
    manifest.exitCode = runnerFailure || cleanupFailure ? 2 : exitCode(rows);
    manifestFile.write();
    process.exitCode = manifest.exitCode;
  }
}

const runDir = parseArgs(process.argv.slice(2));
let preflightFailure = null;
try {
  if (fs.existsSync(runDir)) throw new Error(`run output directory already exists: ${runDir}`);
  for (const port of [F_PORT, TRACKER_PORT, D_PORT]) await portFree(port).catch(() => { throw new Error(`refusing to run: port ${port} is held`); });
  await fs.promises.stat(TITLE_A);
  await fs.promises.stat(TITLE_B);
  await fs.promises.stat(REFUSED);
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
} catch (error) {
  preflightFailure = error;
}
if (preflightFailure) {
  console.error(`runner refusal: ${safeError(preflightFailure)}`);
  process.exitCode = 2;
} else {
  try { await main(runDir); }
  catch (error) { console.error(`runner failure: ${safeError(error)}`); process.exitCode = 2; }
}
