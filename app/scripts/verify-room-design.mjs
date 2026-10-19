// Browser proof for the room design's inputs: the name prompt, the name and message inputs,
// and the settings menu (change 12b, design.md D11 and D19). It owns one default-paused server.
// Every row opens its own tabs, because the prompt's flag is per tab and a shared tab would
// let one row's flag hide another row's prompt.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, rewriteWebSocketDebuggerUrl, sleep, Tab } from './cdp.mjs';
import { createResultLog } from './browser-result-log.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { toggleControlMode } from './room-page-steps.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const PORT = 8135;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOM = `rd-${crypto.randomBytes(6).toString('hex')}`;
const INVITE = `${ORIGIN}/room.html?room=${ROOM}`;
const WAIT_MS = 15_000;
const CLOSE_MS = 3_000;
const ABSENT_MS = 3_000;
const SAMPLE_MS = 100;
const MIN_SAMPLES = 20;
const MODES = ['open', 'host'];
const PROMPT = '#name-prompt';
const ROSTER = "[...document.querySelectorAll('#roster li')].map((li) => li.textContent)";
const CONTROL_MODE = 'window.__app.timeline()?.controlMode ?? null';
const MODE_ITEMS = `[...document.querySelectorAll('#control-mode [data-mode]')].map((element) => ({
  mode: element.dataset.mode,
  disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
  pressed: element.getAttribute('aria-pressed'),
}))`;
const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
};

const log = createResultLog({ approvedStems: [] });
const startedAt = new Date();
const runDir = path.join(RESULTS_DIR, `12b-room-design-${startedAt.toISOString().replaceAll(':', '-')}`);
const rows = [];
let server = null;
let serverSettings = null;
let chrome = null;
let chromePort = null;
let chromeVersion = null;
let profile = null;
let browser = null;
let host = null;
let builds = {};
let runnerFailure = null;
let cleanupFailure = null;

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

// What each row decides from what it read. A `null` read is "no value": it is never taken
// for an absent prompt or a clean frame list.
const viewerCount = (roster) => (Array.isArray(roster) ? roster.filter((text) => text.includes(' · viewer · ')).length : 0);
const absentThroughout = (samples) => samples.length >= MIN_SAMPLES && samples.every((value) => value === false);
const carrying = (values, marker) => values.filter((value) => String(value).includes(marker)).length;
const modeChanged = (before, after) => MODES.includes(before) && MODES.includes(after) && before !== after;
const allDisabled = (items) => Array.isArray(items) && items.length > 0 && items.every((item) => item.disabled === true);
const stayedOnPage = (before, after) => before !== null && after !== null && after.href === before.href && after.token === before.token;
const sampleSummary = (samples) => ({
  samples: samples.length, present: samples.filter((value) => value === true).length, unread: samples.filter((value) => value === null).length,
});

const detail = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

async function read(tab, expression) {
  try { return await tab.evaluate(expression); } catch { return null; }
}

const present = (selector) => `document.querySelector(${JSON.stringify(selector)}) !== null`;

async function poll(readValue, done, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!done(value) && Date.now() < deadline) {
    await sleep(SAMPLE_MS);
    value = await readValue();
  }
  return { ok: done(value), value };
}

const until = (tab, expression, done, timeoutMs) => poll(() => read(tab, expression), done, timeoutMs);

async function watch(tab, expression, windowMs = ABSENT_MS) {
  const samples = [];
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    samples.push(await read(tab, expression));
    await sleep(SAMPLE_MS);
  }
  return samples;
}

// `keyDown` with text is what makes Enter a keypress, so a form would submit.
async function pressKey(tab, key) {
  const { code, windowsVirtualKeyCode, text } = KEYS[key];
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}

// A trusted click focuses the field as a person would; a click that a backdrop took leaves
// the field empty, and the answer says so.
async function typeInto(tab, selector, text) {
  await clickElement(tab, selector);
  await tab.send('Input.insertText', { text });
  return read(tab, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`);
}

async function startServer() {
  await portFree(PORT).catch((error) => { throw new Error(`port ${PORT} is held: ${error.message}`); });
  const env = { ...process.env };
  delete env.APP_AUTO_START;
  Object.assign(env, { APP_PORT: String(PORT), APP_DELIVERY: 'http', APP_TRACKER_URL: '' });
  server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: 'ignore' });
  const up = await poll(async () => {
    try { return (await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
  }, (value) => value || server.exitCode !== null);
  if (!up.ok || server.exitCode !== null) throw new Error('the room server did not start');
  serverSettings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
  if (serverSettings.autoStart !== false) throw new Error(`the server reports autoStart ${JSON.stringify(serverSettings.autoStart)}`);
}

async function launchChrome() {
  chromePort = await unusedPort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-design-'));
  chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, '--window-size=1100,700', 'about:blank'], { stdio: 'ignore' });
  const version = await cdpHttp(chromePort, '/json/version');
  chromeVersion = version.Browser ?? null;
  browser = new BrowserConnection(version.webSocketDebuggerUrl);
}

async function waitForTarget(targetId) {
  const found = await poll(async () => (await cdpHttp(chromePort, '/json/list')).find((target) => target.id === targetId && target.webSocketDebuggerUrl), Boolean, 20_000);
  return found.value;
}

// The tab is created blank and navigated last, so `frames` (the array that receives every
// websocket frame the page sends) is listening before the page's first frame, its join.
async function openTab(url, label, { frames = null } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1100, height: 700 });
  const target = await waitForTarget(targetId);
  if (!target) throw new Error(`${label} target did not appear`);
  const tab = new Tab({ ...target, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(target, chromePort) }, { label });
  await tab.ready;
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  if (frames) {
    await tab.send('Network.enable');
    tab.on('Network.webSocketFrameSent', ({ response }) => frames.push(response.payloadData));
  }
  await tab.send('Page.navigate', { url });
  return tab;
}

async function closeTab(tab) {
  await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
}

async function withTab(url, label, body, options) {
  const tab = await openTab(url, label, options);
  try { return await body(tab); } finally { await closeTab(tab); }
}

// The room is rendered once the message input is in the page; a page that never rendered
// proves nothing by showing no prompt. A page on another build is a failed run, not a row.
async function roomReady(tab) {
  const rendered = await until(tab, present('#message-input'), Boolean);
  if (!rendered.ok) return false;
  const buildId = await read(tab, 'window.__app?.buildId ?? null');
  if (builds.page !== undefined && buildId !== builds.page) throw new Error(`a page runs build ${buildId}, not ${builds.page}`);
  return true;
}

async function openRoom() {
  host = await openTab(`${ORIGIN}/room.html?room=${ROOM}&role=host&tab=rd-host`, 'host');
  const built = await until(host, 'window.__app?.buildId ?? null', (value) => typeof value === 'string');
  if (!built.ok) throw new Error('the host page did not publish window.__app');
  const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: built.value });
  if (!bundle.matches || !bundle.pageIdInServed) throw new Error('the served room bundle does not match public/room.bundle.js');
  builds = { page: built.value, bundle };
  if (!await roomReady(host)) throw new Error('the host page did not render the room');
  console.log(`chrome: ${chromeVersion} · ${CHROME}`);
  console.log(`build: ${built.value}`);
}

async function runRow(label, body) {
  let row;
  try {
    const result = await body();
    if (!result?.exercised) {
      row = { label, status: 'not-exercised', detail: result?.detail ?? 'precondition did not happen' };
      log.rowNotExercised(label, detail(row.detail));
    } else {
      row = { label, status: result.ok ? 'pass' : 'fail', detail: result.detail ?? null };
      log.expect(label, result.ok, result.detail === undefined ? undefined : detail(result.detail));
    }
  } catch (error) {
    row = { label, status: 'fail', detail: { error: error?.message ?? String(error) } };
    log.expect(label, false, row.detail.error);
  }
  rows.push(row);
}

async function rowInviteJoinsBehindPrompt() {
  const before = viewerCount(await read(host, ROSTER));
  return withTab(INVITE, 'N1/viewer', async (tab) => {
    const shown = await until(tab, present(PROMPT), Boolean);
    const joined = await until(host, ROSTER, (roster) => viewerCount(roster) > before);
    const stillOpen = await read(tab, present(PROMPT));
    return {
      exercised: true,
      ok: shown.ok && joined.ok && stillOpen === true,
      detail: { shown: shown.value, viewersBefore: before, viewersAfter: viewerCount(joined.value), promptStillOpen: stillOpen },
    };
  });
}

async function rowEscapeClosesAndReloadStaysClosed() {
  return withTab(INVITE, 'N2', async (tab) => {
    const shown = await until(tab, present(PROMPT), Boolean);
    await pressKey(tab, 'Escape');
    const closed = await until(tab, present(PROMPT), (value) => value === false, CLOSE_MS);
    await read(tab, 'window.__rdLoaded = true');
    await tab.send('Page.reload');
    const reloaded = await until(tab, `window.__rdLoaded === undefined && ${present('#message-input')}`, Boolean);
    const samples = reloaded.ok ? await watch(tab, present(PROMPT)) : [];
    return {
      exercised: shown.ok,
      ok: closed.ok && reloaded.ok && absentThroughout(samples),
      detail: { closedByEscape: closed.ok, reloaded: reloaded.ok, afterReload: sampleSummary(samples) },
    };
  });
}

async function rowRoleAndTabShowNoPrompt() {
  return withTab(`${ORIGIN}/room.html?room=${ROOM}&role=viewer&tab=rd-n3`, 'N3', async (tab) => {
    const rendered = await roomReady(tab);
    const samples = rendered ? await watch(tab, present(PROMPT)) : [];
    return { exercised: rendered, ok: absentThroughout(samples), detail: { rendered, ...sampleSummary(samples) } };
  });
}

async function rowFrontJoinShowsNoPrompt() {
  return withTab(`${ORIGIN}/room.html`, 'N4', async (tab) => {
    const front = await until(tab, present('#join-input'), Boolean);
    if (!front.ok) return { exercised: false, detail: 'the front page did not render' };
    const typed = await typeInto(tab, '#join-input', INVITE);
    await clickElement(tab, '#join');
    const arrived = await until(tab, `new URLSearchParams(location.search).get('room') === ${JSON.stringify(ROOM)} && ${present('#message-input')}`, Boolean);
    const samples = arrived.ok ? await watch(tab, present(PROMPT)) : [];
    return { exercised: typed === true && arrived.ok, ok: absentThroughout(samples), detail: { typed, arrived: arrived.ok, ...sampleSummary(samples) } };
  });
}

const pageMark = (marker) => `(() => { window.__rdToken = ${JSON.stringify(marker)}; return { href: location.href, token: window.__rdToken }; })()`;
const PAGE_NOW = '({ href: location.href, token: window.__rdToken ?? null })';
const STORAGE_DUMP = 'JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)])';

async function closePrompt(tab) {
  const closedByEnter = (await until(tab, present(PROMPT), (value) => value === false, CLOSE_MS)).ok;
  if (closedByEnter) return { closedByEnter };
  await pressKey(tab, 'Escape');
  return { closedByEnter, closedByEscape: (await until(tab, present(PROMPT), (value) => value === false, CLOSE_MS)).ok };
}

async function rowInputsSendNothing() {
  const marker = `rd-n5-${crypto.randomBytes(6).toString('hex')}`;
  const frames = { front: [], invite: [] };
  const front = await openTab(`${ORIGIN}/room.html`, 'N5/front', { frames: frames.front });
  const invite = await openTab(INVITE, 'N5/invite', { frames: frames.invite });
  try {
    const ready = [await until(front, present('#front-name'), Boolean), await until(invite, present(PROMPT), Boolean)];
    if (!ready.every((entry) => entry.ok)) return { exercised: false, detail: 'a page did not render its input' };
    const before = { front: await read(front, pageMark(marker)), invite: await read(invite, pageMark(marker)) };
    const typed = { front: await typeInto(front, '#front-name', marker) };
    await pressKey(front, 'Enter');
    typed.prompt = await typeInto(invite, `${PROMPT} input`, marker);
    await pressKey(invite, 'Enter');
    const prompt = await closePrompt(invite);
    typed.message = await typeInto(invite, '#message-input', marker);
    await pressKey(invite, 'Enter');
    const messageKept = await read(invite, `document.querySelector('#message-input')?.value === ${JSON.stringify(marker)}`);
    await sleep(1_000);
    const after = { front: await read(front, PAGE_NOW), invite: await read(invite, PAGE_NOW) };
    const storage = [await read(front, STORAGE_DUMP), await read(invite, STORAGE_DUMP)];
    const hits = { frames: carrying(frames.front, marker) + carrying(frames.invite, marker), storage: storage.filter((text) => text?.includes(marker)).length };
    const stayed = stayedOnPage(before.front, after.front) && stayedOnPage(before.invite, after.invite);
    // The join frame proves the capture works: an invite page that sent nothing was not watched.
    const exercised = Object.values(typed).every((value) => value === true) && frames.invite.length > 0 && storage.every((text) => text !== null);
    return {
      exercised,
      ok: hits.frames === 0 && hits.storage === 0 && stayed,
      detail: { typed, prompt, messageKept, framesSeen: { front: frames.front.length, invite: frames.invite.length }, hits, stayedOnPage: stayed },
    };
  } finally {
    await closeTab(front);
    await closeTab(invite);
  }
}

async function rowSettingsMenuControlMode() {
  return withTab(`${ORIGIN}/room.html?room=${ROOM}&role=viewer&tab=rd-m1`, 'M1/viewer', async (viewer) => {
    if (!await roomReady(viewer)) return { exercised: false, detail: 'the viewer did not render the room' };
    const modes = async () => [await read(host, CONTROL_MODE), await read(viewer, CONTROL_MODE)];
    const settled = await poll(modes, (value) => MODES.includes(value[0]) && value[0] === value[1]);
    if (!settled.ok) return { exercised: false, detail: { modes: settled.value } };
    const initial = settled.value[0];
    await toggleControlMode(host);
    const changed = await poll(modes, (value) => value.every((mode) => modeChanged(initial, mode)));
    await clickElement(viewer, '#settings');
    const menu = await until(viewer, present('#control-mode'), Boolean, CLOSE_MS);
    const items = await read(viewer, MODE_ITEMS);
    if (menu.ok) await clickElement(viewer, '#control-mode [data-mode][aria-pressed="false"]');
    await sleep(1_000);
    const after = { modes: await modes(), items: await read(viewer, MODE_ITEMS) };
    await pressKey(viewer, 'Escape');
    const unchanged = after.modes.every((mode) => mode === changed.value[0]) && detail(after.items) === detail(items);
    return {
      exercised: menu.ok,
      ok: changed.ok && allDisabled(items) && unchanged,
      detail: { initial, changed: changed.value, items, afterViewerClick: after },
    };
  });
}

async function runRows() {
  await runRow('RD-N1 a plain invite shows the name prompt and joins the room behind it', rowInviteJoinsBehindPrompt);
  await runRow('RD-N2 the prompt closes on Escape and stays closed after a reload', rowEscapeClosesAndReloadStaysClosed);
  await runRow('RD-N3 a role and tab URL shows no prompt', rowRoleAndTabShowNoPrompt);
  await runRow('RD-N4 a front-page join shows no prompt', rowFrontJoinShowsNoPrompt);
  await runRow('RD-N5 the name and message inputs send nothing', rowInputsSendNothing);
  await runRow('RD-M1 the settings menu changes the control mode for the host and is disabled for a viewer', rowSettingsMenuControlMode);
}

async function main() {
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  await startServer();
  await launchChrome();
  await openRoom();
  await runRows();
  console.log(log.summary());
  if (log.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  runnerFailure = error?.stack ?? error?.message ?? String(error);
  console.error(`runner failure: ${error?.message ?? error}`);
  process.exitCode = 2;
} finally {
  if (browser) browser.close();
  if (chrome) {
    try { await disposeChrome(chrome, profile); } catch (error) { cleanupFailure = error?.message ?? String(error); }
  }
  if (server) {
    try { await stopChild(server); } catch (error) { cleanupFailure ??= error?.message ?? String(error); }
  }
  try {
    fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), chrome: { version: chromeVersion, path: CHROME },
      builds, server: serverSettings, rows, runnerFailure, cleanupFailure,
    }, null, 2)}\n`);
  } catch (error) {
    if (!runnerFailure) { runnerFailure = error?.message ?? String(error); process.exitCode = 2; }
  }
}
