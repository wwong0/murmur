// Browser proof for the room design's inputs: the name prompt,
// the settings menu, and the player bar and theatre mode. It owns one default-paused server.
// Every row opens its own tabs, because the prompt's flag is per tab and a shared tab would
// let one row's flag hide another row's prompt.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { acceptLeaveDialogs, cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, rewriteWebSocketDebuggerUrl, sleep, Tab, waitBarRevealed } from './cdp.mjs';
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
const PROMPT_MS = 3_000;
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
let hostWidth = null;
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
// for an absent prompt.
const viewerCount = (roster) => (Array.isArray(roster) ? roster.filter((text) => text.includes(' · viewer · ')).length : 0);
const absentThroughout = (samples) => samples.length >= MIN_SAMPLES && samples.every((value) => value === false);
const modeChanged = (before, after) => MODES.includes(before) && MODES.includes(after) && before !== after;
const allDisabled = (items) => Array.isArray(items) && items.length > 0 && items.every((item) => item.disabled === true);
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

async function openTab(url, label) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1100, height: 700 });
  const target = await waitForTarget(targetId);
  if (!target) throw new Error(`${label} target did not appear`);
  const tab = new Tab({ ...target, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(target, chromePort) }, { label });
  await tab.ready;
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url });
  return tab;
}

async function closeTab(tab) {
  await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
}

async function withTab(url, label, body) {
  const tab = await openTab(url, label);
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
  await acceptLeaveDialogs(host);
  const built = await until(host, 'window.__app?.buildId ?? null', (value) => typeof value === 'string');
  if (!built.ok) throw new Error('the host page did not publish window.__app');
  const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: built.value });
  if (!bundle.matches || !bundle.pageIdInServed) throw new Error('the served room bundle does not match public/room.bundle.js');
  builds = { page: built.value, bundle };
  if (!await roomReady(host)) throw new Error('the host page did not render the room');
  // Below the 768px breakpoint #theatre is not drawn, so a narrow window is the runner's fault, not a row's.
  hostWidth = await read(host, 'window.innerWidth');
  if (!(hostWidth >= 768)) throw new Error(`the host tab opened ${hostWidth}px wide, under the 768px desktop layout`);
  console.log(`chrome: ${chromeVersion} · ${CHROME}`);
  console.log(`build: ${built.value} · host tab ${hostWidth}px wide`);
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

// The host's page keeps its document when Host is pressed, so its prompt comes from the front
// route, not the URL; the joiner navigates to a plain invite. The host stays open while the
// joiner arrives, because the invite is the host's own room.
async function rowFrontHostAndJoinShowPrompt() {
  return withTab(`${ORIGIN}/room.html`, 'N4/host', async (hostTab) => {
    const hostFront = await until(hostTab, present('#host'), Boolean);
    if (!hostFront.ok) return { exercised: false, detail: 'the front page did not render' };
    await clickElement(hostTab, '#host');
    const hostUrlRole = await until(hostTab, "new URLSearchParams(location.search).get('role')", (value) => value === 'host');
    const hostShown = await until(hostTab, present(PROMPT), Boolean, PROMPT_MS);
    await pressKey(hostTab, 'Escape');
    const invite = await until(hostTab, "document.querySelector('#invite')?.href ?? null", (value) => typeof value === 'string' && value.length > 0);
    if (!invite.ok) return { exercised: true, ok: false, detail: { hostShown: hostShown.ok, hostUrlRole: hostUrlRole.value, joinShown: null, arrived: false } };
    const inviteRoom = new URL(invite.value).searchParams.get('room');
    return withTab(`${ORIGIN}/room.html`, 'N4/join', async (joinTab) => {
      const joinFront = await until(joinTab, present('#join-input'), Boolean);
      if (!joinFront.ok) return { exercised: false, detail: 'the second front page did not render' };
      const typed = await typeInto(joinTab, '#join-input', invite.value);
      await clickElement(joinTab, '#join');
      const arrived = await until(joinTab, `new URLSearchParams(location.search).get('room') === ${JSON.stringify(inviteRoom)} && ${present('#message-input')}`, Boolean);
      const joinShown = await until(joinTab, present(PROMPT), Boolean, PROMPT_MS);
      return {
        exercised: typed === true && arrived.ok,
        ok: hostUrlRole.ok && hostShown.ok && joinShown.ok && arrived.ok,
        detail: { hostShown: hostShown.ok, hostUrlRole: hostUrlRole.value, joinShown: joinShown.ok, arrived: arrived.ok },
      };
    });
  });
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

// The bar and theatre rows act on the host page. The room starts paused, so a row that needs it
// playing presses #play and leaves no mouse movement until the bar has faded.
const PLAYBACK = '(window.__app?.playbackState?.() ?? null)';
const FADED = "document.querySelector('#control-bar')?.dataset.faded ?? null";
// Faded and at rest: `data-faded` flips at the fade's start, so a box read then sits partway
// down the slide (post-result, P2-guard-B3).
const FADE_SETTLED = "(() => { const bar = document.querySelector('#control-bar'); return bar?.dataset.faded === 'true' && bar.getAnimations({ subtree: true }).length === 0; })()";
const THEATRE = "document.querySelector('.layout')?.dataset.theatre ?? null";
const THEATRE_STORED = "sessionStorage.getItem('watchalong.theatre')";
const BAR_SLIDE = `(() => {
  const bar = document.querySelector('#control-bar');
  const pause = document.querySelector('#pause');
  if (!bar || !pause) return null;
  return { slidePx: parseFloat(getComputedStyle(bar).getPropertyValue('--bar-slide')), pauseHeight: pause.getBoundingClientRect().height };
})()`;
const MOUSE = { button: 'left', clickCount: 1 };
const VIEWPORTS = [
  { label: '1536x1024', width: 1536, height: 1024, scale: 1, mobile: false },
  { label: '390x844', width: 390, height: 844, scale: 2, mobile: true },
];
const FADE_WAIT_MS = 10_000;
const REVEAL_WAIT_MS = 2_000;
const MISS_WAIT_MS = 1_000;
const OUTSIDE_CLICK_MS = 500;
const FLUSH_PX = 1;
const ROW_CENTRE_PX = 2;

const boxOf = (selector, { scroll = false } = {}) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return null;
  ${scroll ? "element.scrollIntoView({ block: 'center' });" : ''}
  const r = element.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

// Every control the row shows: a closed one (`hidden`, or `display: none` on a narrow page)
// has no client rects and is not in the row.
const BAR_ROW = `(() => {
  const shown = (element) => element.getClientRects().length > 0;
  const row = [...document.querySelectorAll('#control-bar button:not([hidden]), #time, #volume')].filter(shown);
  return {
    centres: row.map((element) => {
      const r = element.getBoundingClientRect();
      return { id: element.id || element.tagName, cy: r.top + r.height / 2 };
    }),
    volume: { mounted: document.querySelector('#volume') !== null, shown: [...document.querySelectorAll('#volume')].some(shown) },
    theatreShown: [...document.querySelectorAll('#theatre')].some(shown),
  };
})()`;

const pressAt = async (tab, point) => {
  for (const type of ['mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...MOUSE });
};
const moveTo = (tab, point) => tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
const tapAt = async (tab, point) => {
  await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
  await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const revealed = (tab) => waitBarRevealed(tab).then(() => true, () => false);

async function setPlaying(wanted) {
  if ((await read(host, `${PLAYBACK}?.playing`)) === wanted) return true;
  const button = wanted ? '#play' : '#pause';
  const enabled = await until(host, `document.querySelector('${button}')?.disabled === false`, Boolean);
  if (!enabled.ok) return false;
  await clickElement(host, button);
  return (await until(host, `${PLAYBACK}?.playing === ${wanted}`, Boolean)).ok;
}

async function playUntilFaded() {
  if (!await roomReady(host)) return 'the host did not render the room';
  if (!await setPlaying(true)) return 'the room did not play';
  const faded = await until(host, FADED, (value) => value === 'true', FADE_WAIT_MS);
  return faded.ok ? null : `the bar read ${faded.value} while playing`;
}

const restPaused = () => setPlaying(false).catch(() => false);

// A native range is moved by its value setter and an input and change event, as a drag leaves it.
async function setRange(tab, selector, value) {
  return read(tab, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, String(${JSON.stringify(value)}));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return Number(element.value);
  })()`);
}

const SEEK_LOADED = "Number(document.querySelector('#seek')?.max) > 0";
const SYNC_DOT = `(() => {
  const dot = document.querySelector('#sync-dot');
  if (!dot) return null;
  const r = dot.getBoundingClientRect();
  return { hidden: dot.hidden, width: r.width, height: r.height, state: dot.getAttribute('data-state'), figure: dot.getAttribute('data-figure') };
})()`;

// Paused with a title loaded the dot is shown, idle and without a figure; RS-P4 reads the
// playing side. A missing element or a zero box is a failed row, never a read that passes.
async function rowSyncDotShowsIdle() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const loaded = await until(host, SEEK_LOADED, Boolean);
  if (!loaded.ok) return { exercised: false, detail: 'the title did not load: #seek.max stayed 0' };
  // The dot is hidden while the room holds one member, so a viewer joins.
  return withTab(`${ORIGIN}/room.html?room=${ROOM}&role=viewer&tab=rd-s1`, 'S1/viewer', async () => {
    const joined = await until(host, "document.querySelectorAll('#roster li').length", (count) => count === 2, 15_000);
    const members = joined.value;
    // The page shows the dot on its next tick after the roster changes, so wait for it.
    const idle = await until(host, SYNC_DOT, (value) => value?.state === 'idle' && value.hidden === false, CLOSE_MS);
    const dot = idle.value;
    return {
      exercised: true,
      ok: dot !== null && dot.hidden === false && dot.width > 0 && dot.height > 0 && dot.state === 'idle' && dot.figure === 'no figure',
      detail: { box: dot === null ? null : { width: dot.width, height: dot.height }, hidden: dot?.hidden ?? null, state: dot?.state ?? null, figure: dot?.figure ?? null, members },
    };
  });
}

async function rowFadedBoxMisses() {
  const failure = await playUntilFaded();
  if (failure) return { exercised: false, detail: failure };
  try {
    const slide = await read(host, BAR_SLIDE);
    const slideOk = Number.isFinite(slide?.slidePx) && slide.pauseHeight > 0 && slide.slidePx > slide.pauseHeight / 2;
    const fadedBefore = (await until(host, FADE_SETTLED, Boolean, REVEAL_WAIT_MS)).ok;
    const oldBox = await read(host, boxOf('#pause'));
    const before = await read(host, PLAYBACK);
    await moveTo(host, oldBox);
    const startedAt = Date.now();
    const settled = await revealed(host);
    const revealMs = Date.now() - startedAt;
    const newBox = await read(host, boxOf('#pause'));
    await pressAt(host, oldBox);
    await sleep(MISS_WAIT_MS);
    const afterMiss = await read(host, PLAYBACK);
    await clickElement(host, '#pause');
    const paused = await until(host, `${PLAYBACK}?.playing === false`, Boolean);
    const afterClick = paused.value === true ? await read(host, PLAYBACK) : null;
    const moved = oldBox !== null && newBox !== null && (oldBox.y < newBox.top || oldBox.y > newBox.bottom);
    return {
      exercised: fadedBefore && oldBox !== null && before !== null,
      ok: slideOk && settled && moved && afterMiss?.version === before.version && afterMiss?.playing === true
        && afterClick?.playing === false && afterClick.version === before.version + 1,
      detail: {
        slidePx: slide?.slidePx ?? null, pauseHeight: slide?.pauseHeight ?? null, fadedBefore, revealMs, oldBox, newBox,
        versionBefore: before?.version ?? null, versionAfterMiss: afterMiss?.version ?? null, versionAfterClick: afterClick?.version ?? null,
        playingAfterMiss: afterMiss?.playing ?? null,
      },
    };
  } finally {
    await restPaused();
  }
}

async function rowOutsideClickDoesNotWait() {
  const failure = await playUntilFaded();
  if (failure) return { exercised: false, detail: failure };
  try {
    const startedAt = Date.now();
    await clickElement(host, '#stats');
    const clickMs = Date.now() - startedAt;
    const barAfter = await read(host, FADED);
    const opened = await read(host, "document.querySelector('#stats')?.getAttribute('aria-expanded')");
    await clickElement(host, '#stats');
    const closed = await until(host, "document.querySelector('#stats')?.getAttribute('aria-expanded')", (value) => value === 'false', CLOSE_MS);
    return {
      exercised: opened === 'true',
      ok: clickMs < OUTSIDE_CLICK_MS && barAfter === 'true' && closed.ok,
      detail: { clickMs, barAfter, panelOpened: opened, panelClosed: closed.ok },
    };
  } finally {
    await restPaused();
  }
}

// The second tap lands inside the three seconds the first one's reveal holds the bar up.
async function rowFirstTouchOnlyReveals() {
  const failure = await playUntilFaded();
  if (failure) return { exercised: false, detail: failure };
  try {
    await host.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const fadedBox = await read(host, boxOf('#pause', { scroll: true }));
    const before = await read(host, PLAYBACK);
    await tapAt(host, fadedBox);
    const unfaded = await until(host, FADED, (value) => value === 'false', MISS_WAIT_MS);
    await sleep(MISS_WAIT_MS);
    const afterFirst = await read(host, PLAYBACK);
    const settled = await revealed(host);
    const shownBox = await read(host, boxOf('#pause'));
    await tapAt(host, shownBox);
    const paused = await until(host, `${PLAYBACK}?.playing === false`, Boolean);
    const afterSecond = await read(host, PLAYBACK);
    return {
      exercised: fadedBox !== null && before !== null,
      ok: unfaded.ok && settled && afterFirst?.version === before.version && afterFirst?.playing === true
        && paused.ok && afterSecond?.version === before.version + 1,
      detail: {
        revealedByFirstTap: unfaded.ok, versionBefore: before?.version ?? null, versionAfterFirst: afterFirst?.version ?? null,
        playingAfterFirst: afterFirst?.playing ?? null, pausedBySecond: paused.ok, versionAfterSecond: afterSecond?.version ?? null,
      },
    };
  } finally {
    await host.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await restPaused();
  }
}

// The player animates its theatre move and #theatre moves with it, so each
// toggle waits for the move to end before the next read or click.
const PLAYER_STILL = "document.getElementById('player').getAnimations().length === 0";
async function toggleTheatre(tab, wanted) {
  await clickElement(tab, '#theatre');
  const flipped = await until(tab, THEATRE, wanted, CLOSE_MS);
  await until(tab, PLAYER_STILL, Boolean, CLOSE_MS);
  return flipped;
}

async function rowTheatreKeepsMedia() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const mark = `rd-t1-${crypto.randomBytes(6).toString('hex')}`;
  await read(host, `document.querySelector('video').__rdMark = ${JSON.stringify(mark)}`);
  const before = await read(host, PLAYBACK);
  const on = await toggleTheatre(host, (value) => value === 'true');
  const off = await toggleTheatre(host, (value) => value === null);
  const kept = await read(host, `({ mark: document.querySelector('video').__rdMark ?? null, same: document.querySelector('video') === document.getElementById('video'), videos: document.querySelectorAll('video').length })`);
  const after = await read(host, PLAYBACK);
  return {
    exercised: on.ok && before !== null,
    ok: off.ok && kept?.mark === mark && kept.same === true && kept.videos === 1 && after?.version === before.version && after?.lineage === before.lineage,
    detail: { onAfterFirst: on.ok, offAfterSecond: off.ok, markSurvived: kept?.mark === mark, sameElement: kept?.same ?? null, videos: kept?.videos ?? null, versionBefore: before?.version ?? null, versionAfter: after?.version ?? null },
  };
}

async function rowTheatreIsRemembered() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  try {
    const on = await toggleTheatre(host, (value) => value === 'true');
    const stored = await read(host, THEATRE_STORED);
    await read(host, 'window.__rdLoaded = true');
    await host.send('Page.reload');
    const reloaded = await until(host, `window.__rdLoaded === undefined && ${present('#message-input')}`, Boolean);
    const afterReload = reloaded.ok ? await until(host, THEATRE, (value) => value === 'true', CLOSE_MS) : { ok: false, value: null };
    const off = await toggleTheatre(host, (value) => value === null);
    const storedAfterOff = await read(host, THEATRE_STORED);
    return {
      exercised: on.ok && reloaded.ok,
      ok: stored === '1' && afterReload.ok && off.ok && storedAfterOff === null,
      detail: { onAfterToggle: on.ok, stored, reloaded: reloaded.ok, onAfterReload: afterReload.ok, offAfterToggle: off.ok, storedAfterOff },
    };
  } finally {
    if ((await read(host, THEATRE)) !== null) await toggleTheatre(host, (value) => value === null).catch(() => {});
  }
}

// A `display: none` element has no client rects, so "mounted" and "displayed" read apart: theatre
// must close the header and the Stats row without unmounting them. Theatre has no `#settings`
// at all, so its count is read, and the dot ends the top group.
const THEATRE_SURFACE = `(() => {
  const state = (selector) => {
    const element = document.querySelector(selector);
    return { mounted: element !== null, displayed: element !== null && element.getClientRects().length > 0 };
  };
  const settings = [...document.querySelectorAll('#settings')];
  return {
    header: state('.room-header'),
    stats: state('#stats'),
    settings: settings.length,
    settingsInPlayer: settings.length === 1 ? document.getElementById('player').contains(settings[0]) : null,
    topEndLast: document.querySelector('.player-top-end')?.lastElementChild?.id ?? null,
  };
})()`;
const closedButMounted = (part) => part?.mounted === true && part.displayed === false;
const displayedAndMounted = (part) => part?.mounted === true && part.displayed === true;

async function rowTheatreHidesChrome() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  try {
    const on = await toggleTheatre(host, (value) => value === 'true');
    if (!on.ok) return { exercised: false, detail: { theatre: on.value } };
    const inTheatre = await read(host, THEATRE_SURFACE);
    const off = await toggleTheatre(host, (value) => value === null);
    const after = await read(host, THEATRE_SURFACE);
    const reachable = off.ok && after?.settings === 1;
    if (reachable) await clickElement(host, '#settings');
    const opened = reachable ? await until(host, present('#control-mode'), Boolean, REVEAL_WAIT_MS) : { ok: false };
    if (opened.ok) await pressKey(host, 'Escape');
    const closed = opened.ok ? await until(host, present('#control-mode'), (value) => value === false, CLOSE_MS) : { ok: false };
    return {
      exercised: true,
      ok: closedButMounted(inTheatre?.header) && closedButMounted(inTheatre?.stats)
        && inTheatre.settings === 0 && inTheatre.topEndLast === 'sync-dot'
        && off.ok && displayedAndMounted(after?.header) && displayedAndMounted(after?.stats) && after.settings === 1 && after.settingsInPlayer === false
        && opened.ok && closed.ok,
      detail: { inTheatre, theatreOff: off.ok, after, controlModeOpened: opened.ok, controlModeClosedByEscape: closed.ok },
    };
  } finally {
    if (await read(host, present('#control-mode'))) await pressKey(host, 'Escape').catch(() => {});
    if ((await read(host, THEATRE)) !== null) await toggleTheatre(host, (value) => value === null).catch(() => {});
  }
}

async function readBarAt(viewport) {
  const { width, height, scale, mobile } = viewport;
  await host.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  const laidOut = await until(host, `window.innerWidth === ${width}`, Boolean, CLOSE_MS);
  const settled = laidOut.ok && await revealed(host);
  const player = await read(host, boxOf('#player'));
  const bar = await read(host, boxOf('#control-bar'));
  const row = await read(host, BAR_ROW);
  return { laidOut: laidOut.ok, settled, player, bar, row };
}

const centreSpread = (row) => {
  const centres = row?.centres.map((entry) => entry.cy) ?? [];
  return centres.length > 0 ? Math.max(...centres) - Math.min(...centres) : null;
};
const flushWithin = ({ player, bar }) => player !== null && bar !== null
  && Math.abs(bar.left - player.left) <= FLUSH_PX && Math.abs(bar.right - player.right) <= FLUSH_PX && Math.abs(bar.bottom - player.bottom) <= FLUSH_PX;

async function rowBarIsFlushAndOneRow() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const readings = {};
  try {
    for (const viewport of VIEWPORTS) readings[viewport.label] = await readBarAt(viewport);
  } finally {
    await host.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  const wide = readings['1536x1024'];
  const narrow = readings['390x844'];
  const sound = (reading) => reading.laidOut && reading.settled && flushWithin(reading) && centreSpread(reading.row) !== null && centreSpread(reading.row) <= ROW_CENTRE_PX;
  const detailOf = (reading) => ({ player: reading.player, bar: reading.bar, centres: reading.row?.centres ?? null, centreSpread: centreSpread(reading.row), volume: reading.row?.volume ?? null, theatreShown: reading.row?.theatreShown ?? null });
  return {
    exercised: Object.values(readings).every((reading) => reading.laidOut && reading.player !== null && reading.bar !== null && reading.row !== null),
    ok: sound(wide) && sound(narrow)
      && wide.row.volume.shown && wide.row.theatreShown
      && narrow.row.volume.mounted && !narrow.row.volume.shown && !narrow.row.theatreShown,
    detail: { '1536x1024': detailOf(wide), '390x844': detailOf(narrow) },
  };
}

// The title's end as S does it (RS-E1): seek close to the end, press play, and the room pauses
// there. The centred button and `#time` both follow the replicated state, so both are waited for.
const SEEK_RANGE = "(() => { const seek = document.querySelector('#seek'); return seek ? { max: Number(seek.max), disabled: seek.disabled } : null; })()";
const END_STATE = `({ time: document.querySelector('#time')?.textContent ?? null, again: ${present('[data-testid="watch-again"]')} })`;
const WATCH_AGAIN = '[data-testid="watch-again"]';
const END_LEAD_MS = 3_000;
const END_WAIT_MS = 20_000;
const PRESS_WAIT_MS = 10_000;

async function endTitle() {
  const range = await until(host, SEEK_RANGE, (value) => value !== null && Number.isFinite(value.max) && value.max > 2 * END_LEAD_MS && value.disabled === false);
  if (!range.ok) return { ok: false, detail: { range: range.value } };
  // A seek inside the last operation's transition lead is refused; #back-10 is enabled once one is accepted.
  const seekable = await until(host, "document.querySelector('#back-10')?.disabled === false", Boolean);
  if (!seekable.ok) return { ok: false, detail: { range: range.value, seekable: false } };
  const target = range.value.max - END_LEAD_MS;
  await setRange(host, '#seek', target);
  const sought = await until(host, PLAYBACK, (state) => state !== null && Math.abs(state.positionMs - target) <= 1);
  const enabled = sought.ok && (await until(host, "document.querySelector('#play')?.disabled === false", Boolean)).ok;
  if (!enabled) return { ok: false, detail: { range: range.value, sought: sought.ok, playEnabled: enabled } };
  await clickElement(host, '#play');
  const ended = await until(host, END_STATE, (value) => value?.time === 'Ended' && value.again === true, END_WAIT_MS);
  return { ok: ended.ok, detail: { range: range.value, ended: ended.value } };
}

// One press of an ended title's button, and whether the room went back to the start. The page's
// end is read as the press lands, not carried over from the wait before it.
async function pressWatchAgain(selector) {
  const [before, endState] = [await read(host, PLAYBACK), await read(host, END_STATE)];
  await clickElement(host, selector);
  const after = await until(host, PLAYBACK, (state) => before !== null && state !== null && state.positionMs === 0 && state.version > before.version, PRESS_WAIT_MS);
  const ended = endState?.time === 'Ended' && endState.again === true;
  return { ok: ended && after.ok, ended, versionBefore: before?.version ?? null, versionAfter: after.value?.version ?? null, positionMs: after.value?.positionMs ?? null };
}

async function rowWatchAgainSeeksToZero() {
  if (!await roomReady(host)) return { exercised: false, detail: 'the host did not render the room' };
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  try {
    const firstEnd = await endTitle();
    if (!firstEnd.ok) return { exercised: false, detail: { end: 'first', ...firstEnd.detail } };
    const centred = await pressWatchAgain(WATCH_AGAIN);
    const secondEnd = await endTitle();
    if (!secondEnd.ok) return { exercised: false, detail: { end: 'second', centred, ...secondEnd.detail } };
    const bar = await pressWatchAgain('#play');
    return { exercised: true, ok: centred.ok && bar.ok, detail: { centred, bar } };
  } finally {
    await restPaused();
  }
}

async function runRows() {
  await runRow('RD-N1a plain invite shows the name prompt and joins the room behind it', rowInviteJoinsBehindPrompt);
  await runRow('RD-N2 the prompt closes on Escape and stays closed after a reload', rowEscapeClosesAndReloadStaysClosed);
  await runRow('RD-N3 a role and tab URL shows no prompt', rowRoleAndTabShowNoPrompt);
  await runRow('RD-N4 a front-page host and a front-page join each show the name prompt', rowFrontHostAndJoinShowPrompt);
  await runRow('RD-M1 the settings menu changes the control mode for the host and is disabled for a viewer', rowSettingsMenuControlMode);
  await runRow('RD-S1 the sync dot shows while paused, in its idle state', rowSyncDotShowsIdle);
  await runRow("RD-B1 a faded control's box read before the reveal misses, and the shipped click lands", rowFadedBoxMisses);
  await runRow('RD-B2 a click outside the bar while faded does not wait', rowOutsideClickDoesNotWait);
  await runRow('RD-B3 a first touch on a faded bar only reveals it', rowFirstTouchOnlyReveals);
  await runRow('RD-T1 theatre mode issues no operation and keeps the media element', rowTheatreKeepsMedia);
  await runRow('RD-T2 theatre mode is remembered for the tab', rowTheatreIsRemembered);
  await runRow('RD-T3 theatre hides the header, the Stats row and the settings button, and settings opens once theatre ends', rowTheatreHidesChrome);
  await runRow('RD-L1 the bar is flush with the player and stays one row', rowBarIsFlushAndOneRow);
  await runRow('RD-W1 both Watch again buttons seek to 0', rowWatchAgainSeeksToZero);
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
      builds, hostWidth, server: serverSettings, rows, runnerFailure, cleanupFailure,
    }, null, 2)}\n`);
  } catch (error) {
    if (!runnerFailure) { runnerFailure = error?.message ?? String(error); process.exitCode = 2; }
  }
}
