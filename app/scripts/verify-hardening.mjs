import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import {
  cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, pointAt, rewriteWebSocketDebuggerUrl, sleep, Tab,
} from './cdp.mjs';
import { createResultLog } from './browser-result-log.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild } from './runner/local-processes.mjs';
import { LINKS_LINE_RE } from '../public/lib/link-kinds.mjs';
import { START_WAIT_LINE_RE } from '../public/lib/start-wait.mjs';

globalThis.label = null;

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const FIXTURE_PATH = path.join(APP_DIR, 'scripts', 'check', 'remux-fixtures', 'even-1s.mp4');
const PORT = 8137;
const DEBUG_PORT = 9237;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WAIT_MS = 30_000;
const MEDIA_WAIT_MS = 180_000;
const SAMPLE_MS = 150;
const MARK = crypto.randomBytes(4).toString('hex');
const PRELOAD = `(() => {
  globalThis.__hardeningSecurityViolations = 0;
  globalThis.addEventListener('securitypolicyviolation', () => { globalThis.__hardeningSecurityViolations += 1; });
  try { globalThis.sessionStorage.setItem('watchalong.name-prompted', '1'); } catch {}
})();`;

const startedAt = new Date();
const runDir = path.join(RESULTS_DIR, `13-hardening-${startedAt.toISOString().replaceAll(':', '-')}`);
const log = createResultLog({ approvedStems: [] });
const rows = [];
const tabs = new Set();
const signals = new Map();
const serverOutput = [];
const state = { server: null, chrome: null, profile: null, browser: null, chromeVersion: null, serverSettings: null, builds: {} };
let hostTab = null;
let viewerOne = null;
let viewerTwo = null;
let investigationTab = null;
let roomEvidence = null;
let diagnostics = null;

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

async function read(tab, expression) {
  try { return await tab.evaluate(expression); } catch { return null; }
}

async function poll(readValue, done, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!done(value) && Date.now() < deadline) {
    await sleep(SAMPLE_MS);
    value = await readValue();
  }
  return { ok: done(value), value };
}

const until = (tab, expression, done, timeoutMs = WAIT_MS) => poll(() => read(tab, expression), done, timeoutMs);
const present = (selector) => `document.querySelector(${JSON.stringify(selector)}) !== null`;

function eventText(args = []) {
  return args.map((arg) => arg?.value ?? arg?.description ?? '').join(' ');
}

function attachSignals(tab) {
  const record = { console: 0, consoleRateLimited: 0, log: 0, logRateLimited: 0 };
  tab.on('Runtime.consoleAPICalled', (params) => {
    record.console += 1;
    if (eventText(params.args).toLowerCase().includes('rate-limited')) record.consoleRateLimited += 1;
  });
  tab.on('Log.entryAdded', (params) => {
    record.log += 1;
    if (String(params.entry?.text ?? '').toLowerCase().includes('rate-limited')) record.logRateLimited += 1;
  });
  signals.set(tab, record);
}

async function openTab(url, label) {
  const { targetId } = await state.browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1100, height: 700 });
  const found = await poll(async () => (await cdpHttp(state.chromePort, '/json/list')).find((target) => target.id === targetId && target.webSocketDebuggerUrl), Boolean, WAIT_MS);
  if (!found.value) throw new Error('target unavailable');
  const tab = new Tab({ ...found.value, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(found.value, state.chromePort) }, { label: null });
  await tab.ready;
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Log.enable');
  attachSignals(tab);
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD });
  await tab.send('Page.navigate', { url });
  tabs.add(tab);
  return tab;
}

async function closeTab(tab) {
  if (!tab || !state.browser) return;
  tabs.delete(tab);
  await state.browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
}

async function startServer() {
  await portFree(PORT).catch(() => { throw new Error('application port is held'); });
  const env = { ...process.env };
  for (const key of [
    'APP_AUTO_START', 'APP_HARNESS_COUNTERS', 'APP_TRUSTED_PROXY', 'APP_ALLOWED_ORIGIN', 'APP_SEND_BUFFER_BYTES',
    'APP_TURN_KEY_ID', 'APP_TURN_API_TOKEN', 'APP_TURN_API_BASE', 'APP_TURN_TTL_S', 'APP_TURN_REUSE_MS',
  ]) delete env[key];
  Object.assign(env, {
    APP_PORT: String(PORT),
    APP_MEDIA_SOURCE: 'file',
    APP_DELIVERY: 'host',
    APP_TRACKER_URL: '',
    APP_ICE_SERVERS: '[]',
    APP_FRAME_CAP_BYTES: '65536',
    APP_ENVELOPE_BURST: '472',
    APP_ENVELOPE_REFILL_MS: '100',
    APP_JOIN_BURST: '30',
    APP_JOIN_REFILL_MS: '10000',
  });
  state.server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [state.server.stdout, state.server.stderr]) stream.on('data', (chunk) => serverOutput.push(chunk.toString()));
  const up = await poll(async () => {
    try { return (await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
  }, (value) => value || state.server.exitCode !== null);
  if (!up.ok || state.server.exitCode !== null) throw new Error('application server did not start');
  state.serverSettings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
}

async function launchChrome() {
  await portFree(DEBUG_PORT).catch(() => { throw new Error('Chrome debug port is held'); });
  state.chromePort = DEBUG_PORT;
  state.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
  state.chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${state.profile}`, '--window-size=1100,700', 'about:blank'], { stdio: 'ignore' });
  const version = await cdpHttp(DEBUG_PORT, '/json/version');
  state.chromeVersion = version.Browser ?? null;
  state.browser = new BrowserConnection(version.webSocketDebuggerUrl);
}

async function pageBuild(tab) {
  const built = await until(tab, 'window.__app?.buildId ?? null', (value) => typeof value === 'string');
  if (!built.ok) throw new Error('page build id unavailable');
  if (state.builds.page !== undefined && built.value !== state.builds.page) throw new Error('page build changed');
  if (state.builds.page === undefined) state.builds = { page: built.value, bundle: await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: built.value }) };
  return state.builds;
}

async function setHostFile(tab) {
  await tab.send('DOM.enable');
  const document = await tab.send('DOM.getDocument', { depth: 0 });
  const found = await tab.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#host-file' });
  if (!found.nodeId) throw new Error('host file input unavailable');
  await tab.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [FIXTURE_PATH] });
}

async function pressEnter(tab) {
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

async function typeInto(tab, selector, value) {
  await clickElement(tab, selector);
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await tab.send('Input.insertText', { text: value });
  return (await read(tab, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)) === true;
}

async function sendChat(tab, value) {
  const typed = await typeInto(tab, '#message-input', value);
  await pressEnter(tab);
  return typed;
}

async function frameCount(tab) {
  return await read(tab, `(() => {
    const video = document.querySelector('#video');
    const quality = video?.getVideoPlaybackQuality?.();
    return Number(quality?.totalVideoFrames ?? video?.webkitDecodedFrameCount ?? 0);
  })()`);
}

async function frameCounts() {
  return await Promise.all([hostTab, viewerOne, viewerTwo].map((tab) => frameCount(tab)));
}

async function lineValues() {
  return await Promise.all([hostTab, viewerOne, viewerTwo].map(async (tab) => ({
    startWait: await read(tab, "document.querySelector('#start-wait-line')?.textContent ?? null"),
    links: await read(tab, "document.querySelector('#links-line')?.textContent ?? null"),
  })));
}

function parseLinks(line) {
  const match = typeof line === 'string' ? line.match(/^host links: (\d+) direct · (\d+) relayed · (\d+) pending$/) : null;
  return match ? { direct: Number(match[1]), relayed: Number(match[2]), pending: Number(match[3]) } : null;
}

async function setupRoom() {
  await until(hostTab, present('#host'), Boolean);
  await clickElement(hostTab, '#host');
  const input = await until(hostTab, "(() => { const input = document.querySelector('#host-file'); return input !== null && input.disabled === false; })()", Boolean, WAIT_MS);
  if (!input.ok) throw new Error('host file input not ready');
  await setHostFile(hostTab);
  const prepared = await until(hostTab, "window.__app?.hostFile?.().state === 'ready'", Boolean, MEDIA_WAIT_MS);
  if (!prepared.ok) throw new Error('host file did not become ready');
  const invite = await until(hostTab, "document.querySelector('#invite')?.href ?? null", (value) => typeof value === 'string' && value.length > 0);
  if (!invite.ok) throw new Error('invite unavailable');
  viewerOne = await openTab(invite.value, 'viewer-one');
  viewerTwo = await openTab(invite.value, 'viewer-two');
  const joined = await poll(async () => await Promise.all([hostTab, viewerOne, viewerTwo].map((tab) => read(tab, "document.querySelectorAll('#roster li').length"))), (counts) => Array.isArray(counts) && counts.length === 3 && counts.every((count) => count === 3), WAIT_MS);
  if (!joined.ok) throw new Error('all members did not join');
  const play = await until(hostTab, "(() => { const play = document.querySelector('#play'); return play !== null && play.disabled === false && play.hidden === false; })()", Boolean, WAIT_MS);
  const prePlayCursor = await read(hostTab, "getComputedStyle(document.querySelector('#video')).cursor");
  const disabledTabs = await Promise.all([hostTab, viewerOne, viewerTwo].map(async (tab) => ({
    disabled: await read(tab, "document.querySelector('#play')?.disabled === true"),
    cursorPointer: await read(tab, "getComputedStyle(document.querySelector('#video')).cursor === 'pointer'"),
  })));
  if (!play.ok) throw new Error('play control did not enable');
  await clickElement(hostTab, '#play');
  const frames = await poll(frameCounts, (counts) => Array.isArray(counts) && counts.length === 3 && counts.every((count) => Number.isFinite(count) && count > 0), MEDIA_WAIT_MS);
  const startWait = await poll(lineValues, (values) => Array.isArray(values) && values.every((value) => START_WAIT_LINE_RE.test(value.startWait ?? '')), WAIT_MS);
  const links = await poll(lineValues, (values) => Array.isArray(values) && values.every((value) => LINKS_LINE_RE.test(value.links ?? '') && parseLinks(value.links)?.pending === 0), WAIT_MS);
  roomEvidence = {
    hostPrepared: prepared.ok,
    viewersJoined: joined.ok,
    frames: frames.value,
    framesPresented: frames.ok,
    prePlay: { playEnabled: play.ok, cursorPointer: prePlayCursor === 'pointer', disabledTabs },
    startWaitBeforeSeek: startWait.value.map((value) => value.startWait),
    linksAfterStart: links.value.map((value) => value.links),
  };
  return { ok: prepared.ok && joined.ok && frames.ok, detail: {
    hostPrepared: prepared.ok,
    viewersJoined: joined.ok,
    framesPresented: frames.ok,
    frameCounts: frames.value,
  } };
}

async function seekFourSeconds() {
  const ready = await until(hostTab, "(() => { const seek = document.querySelector('#seek'); return seek !== null && seek.disabled === false && Number(seek.max) > Number(seek.value); })()", Boolean, WAIT_MS);
  if (!ready.ok) return { issued: false, before: null, target: null };
  const result = await hostTab.evaluate(`(() => {
    const seek = document.querySelector('#seek');
    const before = Number(seek.value);
    const target = Math.min(Number(seek.max), before + 4000);
    seek.value = String(target);
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, target };
  })()`);
  return { issued: Number.isFinite(result?.target) && result.target > result.before, before: result?.before ?? null, target: result?.target ?? null };
}

async function collectDiagnostics() {
  const perTab = [];
  for (const [tab, record] of signals) {
    const page = await read(tab, `(() => {
      const elements = [...document.querySelectorAll('#notices li, #status-line, #join-error, .room-activity .activity-warn')];
      return {
        csp: Number(globalThis.__hardeningSecurityViolations ?? 0),
        pageRateLimited: elements.filter((element) => element.textContent.toLowerCase().includes('rate-limited')).length,
      };
    })()`);
    perTab.push({
      console: record.console,
      consoleRateLimited: record.consoleRateLimited,
      log: record.log,
      logRateLimited: record.logRateLimited,
      csp: page?.csp ?? 0,
      pageRateLimited: page?.pageRateLimited ?? 0,
    });
  }
  const sum = (key) => perTab.reduce((total, item) => total + item[key], 0);
  const serverRateLimited = (serverOutput.join('').match(/rate-limited/gi) ?? []).length;
  diagnostics = {
    perTab,
    consoleRateLimited: sum('consoleRateLimited'),
    logRateLimited: sum('logRateLimited'),
    pageRateLimited: sum('pageRateLimited'),
    cspViolations: sum('csp'),
    serverRateLimited,
  };
  return diagnostics;
}

async function runRow(id, body) {
  let result;
  try {
    result = await body();
  } catch (error) {
    result = { ok: false, detail: { error: String(error?.message ?? error).slice(0, 200) } };
  }
  const status = result?.status ?? (result?.ok === true ? 'pass' : 'fail');
  const detail = result?.detail ?? null;
  if (status === 'not-exercised') log.rowNotExercised(id, JSON.stringify(detail));
  else log.expect(id, status === 'pass', JSON.stringify(detail));
  rows.push({ id, status, evidence: detail });
  return result;
}

async function runHd3() {
  if (!roomEvidence) return { status: 'not-exercised', detail: { precondition: false } };
  const beforeFrames = await frameCounts();
  const seek = await seekFourSeconds();
  const frames = await poll(frameCounts, (counts) => Array.isArray(counts) && counts.length === 3 && counts.every((count, index) => Number.isFinite(count) && count > beforeFrames[index]), MEDIA_WAIT_MS);
  const lines = await lineValues();
  roomEvidence.startWaitAfterSeek = lines.map((value) => value.startWait);
  return { ok: seek.issued && frames.ok, detail: { seekIssued: seek.issued, requestedMs: 4000, frameCounts: frames.value, framesAfterSeek: frames.ok } };
}

async function runHd4() {
  if (!roomEvidence) return { status: 'not-exercised', detail: { precondition: false } };
  const values = [`${MARK}-one`, `${MARK}-two`, `${MARK}-three`];
  const typed = [await sendChat(hostTab, values[0]), await sendChat(viewerOne, values[1]), await sendChat(viewerTwo, values[2])];
  const chats = await poll(async () => await Promise.all([hostTab, viewerOne, viewerTwo].map((tab) => read(tab, "document.querySelectorAll('.activity-chat').length"))), (counts) => Array.isArray(counts) && counts.length === 3 && counts.every((count) => count === 3), WAIT_MS);
  return { ok: typed.every(Boolean) && chats.ok, detail: { sent: typed.filter(Boolean).length, chatCounts: chats.value, eachSeesThree: chats.ok } };
}

async function runHd7() {
  if (!roomEvidence?.startWaitAfterSeek) return { status: 'not-exercised', detail: { precondition: false } };
  const values = await lineValues();
  const starts = values.map((value) => value.startWait);
  const links = values.map((value) => value.links);
  const linkCounts = links.map(parseLinks);
  const linksShape = links.every((value) => LINKS_LINE_RE.test(value ?? ''));
  const expected = linkCounts.every((value, index) => value
    && value.pending === 0
    && value.relayed === 0
    && value.direct + value.relayed === (index === 0 ? 2 : 1));
  const startShape = starts.every((value) => START_WAIT_LINE_RE.test(value ?? ''));
  const unchanged = roomEvidence.startWaitBeforeSeek.every((value, index) => value === roomEvidence.startWaitAfterSeek[index]);
  return {
    ok: startShape && linksShape && expected && unchanged,
    detail: { startWaitMatches: startShape, startWaitUnchangedAfterSeek: unchanged, linksMatch: linksShape, linkCounts, expectedLinks: expected },
  };
}

async function runHd8() {
  if (!roomEvidence?.prePlay) return { status: 'not-exercised', detail: { precondition: false } };
  const pre = roomEvidence.prePlay;
  const disabled = pre.disabledTabs.filter((value) => value.disabled === true);
  const disabledCursorOk = disabled.length === 0 || disabled.every((value) => value.cursorPointer === false);
  return { ok: pre.playEnabled && pre.cursorPointer && disabledCursorOk, detail: { playEnabled: pre.playEnabled, hostCursorPointer: pre.cursorPointer, disabledTabs: disabled.length, disabledCursorOk } };
}

async function runHd9() {
  if (!roomEvidence) return { status: 'not-exercised', detail: { precondition: false } };
  await pointAt(hostTab, '#video');
  await sleep(3500);
  const faded = await read(hostTab, `(() => {
    const top = document.querySelector('.player-top');
    const bar = document.querySelector('.player-bar');
    return {
      playing: window.__app?.playbackState?.().playing === true,
      topFaded: top?.dataset.faded === 'true',
      barFaded: bar?.dataset.faded === 'true',
      topOpacity: Number.parseFloat(getComputedStyle(top).opacity),
      barOpacity: Number.parseFloat(getComputedStyle(bar).opacity),
    };
  })()`);
  await pointAt(hostTab, '#video');
  const revealed = await until(hostTab, `(() => {
    const top = document.querySelector('.player-top');
    const bar = document.querySelector('.player-bar');
    return top?.dataset.faded === 'false' && bar?.dataset.faded === 'false'
      && Number.parseFloat(getComputedStyle(top).opacity) >= 0.99
      && Number.parseFloat(getComputedStyle(bar).opacity) >= 0.99;
  })()`, Boolean, WAIT_MS);
  const fadedOk = faded?.playing === true && faded.topFaded === true && faded.barFaded === true && faded.topOpacity === 0 && faded.barOpacity === 0;
  return { ok: fadedOk && revealed.ok, detail: { faded: fadedOk, revealed: revealed.ok, topOpacity: faded?.topOpacity ?? null, barOpacity: faded?.barOpacity ?? null } };
}

async function runI1() {
  investigationTab = await openTab(`${ORIGIN}/room.html`, 'investigation');
  await until(investigationTab, present('#host'), Boolean);
  await clickElement(investigationTab, '#host');
  const first = await until(investigationTab, "document.querySelectorAll('#roster li').length === 1", Boolean);
  if (!first.ok) return { status: 'not-exercised', detail: { firstRoomJoined: false } };
  const roomA = await read(investigationTab, "({ urlRoom: new URL(location.href).searchParams.get('room'), appRoom: window.__app?.room ?? null })");
  await clickElement(investigationTab, '.wordmark');
  const front = await until(investigationTab, present('#front'), Boolean);
  await clickElement(investigationTab, '#host');
  const second = await until(investigationTab, "document.querySelectorAll('#roster li').length === 1", Boolean);
  if (!front.ok || !second.ok) return { status: 'not-exercised', detail: { wordmarkFront: front.ok, secondRoomJoined: second.ok } };
  const roomB = await read(investigationTab, "({ urlRoom: new URL(location.href).searchParams.get('room'), appRoom: window.__app?.room ?? null })");
  const roomBDiffersA = roomB?.urlRoom !== roomA?.urlRoom && roomB?.appRoom !== roomA?.appRoom;
  const rosterOnlySelf = (await read(investigationTab, "document.querySelectorAll('#roster li').length")) === 1;
  await investigationTab.evaluate('history.back()');
  const back = await until(investigationTab, "document.querySelector('#front') !== null || document.querySelector('#roster li') !== null", Boolean);
  const backState = await read(investigationTab, "({ front: document.querySelector('#front') !== null, room: window.__app?.room ?? null })");
  await investigationTab.send('Page.navigate', { url: `${ORIGIN}/room.html?room=${encodeURIComponent(roomB.appRoom)}&role=host` });
  await until(investigationTab, "document.querySelectorAll('#roster li').length === 1", Boolean);
  await investigationTab.send('Page.navigate', { url: `${ORIGIN}/room.html` });
  await until(investigationTab, present('#front'), Boolean);
  await clickElement(investigationTab, '#host');
  const owner = await until(investigationTab, "document.querySelectorAll('#roster li').length === 1", Boolean);
  const ownerState = await read(investigationTab, "({ urlRoom: new URL(location.href).searchParams.get('room'), appRoom: window.__app?.room ?? null })");
  return {
    ok: back.ok && owner.ok,
    detail: {
      roomUrlDiffersA: roomB?.urlRoom !== roomA?.urlRoom,
      appRoomDiffersA: roomB?.appRoom !== roomA?.appRoom,
      roomBDiffersA,
      rosterOnlySelf,
      backAtFront: backState?.front === true,
      backMatchesA: backState?.room === roomA?.appRoom,
      backMatchesB: backState?.room === roomB?.appRoom,
      ownerUrlDiffersB: ownerState?.urlRoom !== roomB?.urlRoom,
      ownerAppRoomDiffersB: ownerState?.appRoom !== roomB?.appRoom,
    },
  };
}

async function main() {
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  await startServer();
  await launchChrome();
  hostTab = await openTab(`${ORIGIN}/room.html`, 'host');
  await runRow('HD1', async () => {
    const build = await pageBuild(hostTab);
    return { ok: build.bundle.matches === true && build.bundle.pageIdInServed === true, detail: { bundleMatches: build.bundle.matches === true, pageIdInServed: build.bundle.pageIdInServed === true } };
  });
  await runRow('HD2', setupRoom);
  await runRow('HD3', runHd3);
  await runRow('HD4', runHd4);
  await runRow('HD7', runHd7);
  await runRow('HD8', runHd8);
  await runRow('HD9', runHd9);
  await runRow('I1', runI1);
  diagnostics = await collectDiagnostics();
  await runRow('HD5', async () => ({
    ok: diagnostics.consoleRateLimited === 0 && diagnostics.logRateLimited === 0 && diagnostics.pageRateLimited === 0 && diagnostics.serverRateLimited === 0,
    detail: { consoleRateLimited: diagnostics.consoleRateLimited, logRateLimited: diagnostics.logRateLimited, pageRateLimited: diagnostics.pageRateLimited, serverRateLimited: diagnostics.serverRateLimited },
  }));
  await runRow('HD6', async () => ({ ok: diagnostics.cspViolations === 0, detail: { cspViolations: diagnostics.cspViolations } }));
  if (rows.some((row) => row.status === 'fail')) process.exitCode = 1;
}

let runnerFailure = false;
let runnerError = null;
let cleanupFailure = false;
try {
  await main();
} catch (error) {
  runnerFailure = true;
  runnerError = String(error?.message ?? error).slice(0, 200);
  process.exitCode = 2;
} finally {
  if (!diagnostics) {
    try { diagnostics = await collectDiagnostics(); } catch { diagnostics = null; }
  }
  for (const tab of [...tabs]) await closeTab(tab);
  if (state.browser) state.browser.close();
  if (state.chrome) {
    try { await disposeChrome(state.chrome, state.profile); } catch { cleanupFailure = true; }
  }
  if (state.server) {
    try { await stopChild(state.server); } catch { cleanupFailure = true; }
  }
  if (fs.existsSync(runDir)) {
    fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      chrome: { available: typeof state.chromeVersion === 'string', debugPort: DEBUG_PORT },
      builds: state.builds, rows, diagnostics, runnerFailure, runnerError, cleanupFailure,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, 'rows.txt'), `${rows.map((row) => `${row.id} ${row.status.toUpperCase()} ${JSON.stringify(row.evidence)}`).join('\n')}\n`);
  }
}

