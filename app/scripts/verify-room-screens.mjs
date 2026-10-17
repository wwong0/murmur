// Browser proof for the room screens. It owns two default-paused servers.
// One window per page: a background tab renders no frames, so its sync dot would stay idle.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { attach, cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, sleep } from './cdp.mjs';
import { createResultLog } from './browser-result-log.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const ORIGIN_A = 'http://127.0.0.1:8129';
const ORIGIN_B = 'http://127.0.0.1:8130';
const WAIT_MS = 15_000;
const END_TOLERANCE_MS = 1;
const AUDIO_COMMAND = 'ffmpeg -i input.mp4 -c:v copy -c:a aac -b:a 192k output.mp4';
const KEYFRAME_COMMAND = 'ffmpeg -i input.mp4 -c:v libx264 -crf 18 -force_key_frames "expr:gte(t,n_forced*2)" -c:a copy output.mp4';
const LABELS = [
  'RS-F1 a room-less page shows the front page and joins no room',
  'RS-F2 Host joins a new room as host with a bare invite',
  'RS-F3 Join with a pasted invite opens the room as a viewer',
  'RS-S1 a new room waits for a play',
  'RS-S2 play starts the room',
  'RS-C1 a faded bar is clicked as a person would',
  'RS-C2 volume and mute change this page only',
  'RS-C3 the overlay is hidden until Stats',
  'RS-C4 the sync dot shows idle when paused, a state when playing',
  'RS-C5 a drag of the seek bar seeks once, to where it is released',
  'RS-E1 the room pauses at the title\'s end',
  'RS-E2 Ended and Watch again',
  'RS-E3 a host-controlled room ends on the host\'s pause',
  'RS-D1 an audio codec refusal shows the reason and a command',
  'RS-D2 Copy puts the command on the clipboard',
  'RS-D3 an encrypted file shows its reason only',
  'RS-D4 a file with sparse keyframes is flagged and still played',
];

const log = createResultLog({ approvedStems: [] });
const startedAt = new Date();
const runDir = path.join(RESULTS_DIR, `11b-2-room-screens-${startedAt.toISOString().replaceAll(':', '-')}`);
const servers = [];
let chrome = null;
let chromePort = null;
let chromeVersion = null;
let profile = null;
let browser = null;
let host = null;
let viewer = null;
let fileHost = null;
let builds = {};
let serverSettings = {};
let runnerFailure = null;
let cleanupFailure = null;
let clipboardRefused = false;

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

const detail = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

async function read(tab, expression) { return tab.evaluate(expression); }

async function poll(readValue, done, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!done(value) && Date.now() < deadline) {
    await sleep(100);
    value = await readValue();
  }
  return { ok: done(value), value };
}

async function until(tab, expression, done, timeoutMs = WAIT_MS) {
  return poll(() => read(tab, expression), done, timeoutMs);
}

async function clickWhenEnabled(tab, selector, timeoutMs = WAIT_MS) {
  const ready = await until(tab, `document.querySelector(${JSON.stringify(selector)})?.disabled === false`, Boolean, timeoutMs);
  if (!ready.ok) return false;
  await clickElement(tab, selector);
  return true;
}

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

async function userGestureEvaluate(tab, expression) {
  const response = await tab.send('Runtime.evaluate', {
    expression, userGesture: true, awaitPromise: true, returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate refused');
  return response.result?.value;
}

const roomSnapshot = `(() => {
  const video = document.querySelector('#video');
  const state = globalThis.__app?.playbackState?.() ?? null;
  return {
    state,
    video: video ? { currentTime: video.currentTime, paused: video.paused, volume: video.volume, muted: video.muted, ended: video.ended } : null,
    url: location.href,
    buildId: globalThis.__app?.buildId ?? null,
  };
})()`;

const fileSnapshot = `(() => ({
  state: globalThis.__app?.hostFile?.() ?? null,
  reason: document.querySelector('#file-reason')?.textContent ?? '',
  command: document.querySelector('#file-command')?.textContent ?? '',
  notice: document.querySelector('#keyframe-notice')?.textContent ?? '',
}))()`;

async function startServer(name, port, values) {
  await portFree(port).catch((error) => { throw new Error(`${name} port ${port} is held: ${error.message}`); });
  const env = { ...process.env };
  delete env.APP_AUTO_START;
  Object.assign(env, { APP_PORT: String(port), ...values });
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
    cwd: APP_DIR, env, stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  const up = await poll(async () => {
    try { return (await fetch(`${origin}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
  }, (value) => value || child.exitCode !== null, WAIT_MS);
  if (!up.ok || child.exitCode !== null) throw new Error(`${name} room server did not start`);
  const settings = await (await fetch(`${origin}/app-settings`, { cache: 'no-store' })).json();
  if (settings.autoStart !== false) throw new Error(`${name} reports autoStart ${JSON.stringify(settings.autoStart)}`);
  const server = { name, port, origin, child, settings };
  servers.push(server);
  serverSettings[name] = settings;
  return server;
}

async function openPages(a, b) {
  chromePort = await unusedPort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-screens-'));
  chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, '--window-size=1100,700', `${a.origin}/room.html?seed=host`], { stdio: 'ignore' });
  const version = await cdpHttp(chromePort, '/json/version');
  chromeVersion = version.Browser ?? null;
  browser = new BrowserConnection(version.webSocketDebuggerUrl);
  host = await attach(chromePort, `${a.origin}/room.html`, { label: 'A/host' });
  await host.send('Page.enable');
  await browser.send('Target.createTarget', { url: `${a.origin}/room.html?seed=viewer`, newWindow: true, width: 1100, height: 700 });
  viewer = await attach(chromePort, `${a.origin}/room.html`, { label: 'A/viewer', exclude: new Set([host.targetId]) });
  await viewer.send('Page.enable');
  await browser.send('Target.createTarget', { url: `${b.origin}/room.html?seed=file`, newWindow: true, width: 1100, height: 700 });
  fileHost = await attach(chromePort, `${b.origin}/room.html`, { label: 'B/host' });
  await fileHost.send('Page.enable');
  await fileHost.send('DOM.enable');
  const present = await Promise.all([host, viewer, fileHost].map((tab) => until(tab, 'typeof window.__app?.buildId === "string"', Boolean)));
  if (present.some((entry) => !entry.ok)) throw new Error('a page did not publish window.__app');
  const pageBuilds = await Promise.all([host, viewer, fileHost].map((tab) => read(tab, 'window.__app.buildId')));
  const [aHostBuild, aViewerBuild, bBuild] = pageBuilds;
  const [aHostBundle, aViewerBundle, bBundle] = await Promise.all([
    assertServedBundle({ origin: a.origin, bundlePath: BUNDLE_PATH, pageBuildId: aHostBuild }),
    assertServedBundle({ origin: a.origin, bundlePath: BUNDLE_PATH, pageBuildId: aViewerBuild }),
    assertServedBundle({ origin: b.origin, bundlePath: BUNDLE_PATH, pageBuildId: bBuild }),
  ]);
  if (![aHostBundle, aViewerBundle, bBundle].every((bundle) => bundle.matches && bundle.pageIdInServed)) {
    throw new Error('a served room bundle does not match public/room.bundle.js');
  }
  builds = { A: { host: aHostBuild, viewer: aViewerBuild, bundle: aHostBundle }, B: { host: bBuild, bundle: bBundle } };
  console.log(`chrome: ${chromeVersion} · ${CHROME}`);
  console.log(`build: A ${aHostBuild} · ${aViewerBuild} · B ${bBuild}`);
}

async function runRow(label, body) {
  try {
    const result = await body();
    if (!result?.exercised) log.rowNotExercised(label, result?.detail ?? 'precondition did not happen');
    else log.expect(label, result.ok, result.detail === undefined ? undefined : detail(result.detail));
  } catch (error) {
    log.expect(label, false, error?.message ?? String(error));
  }
}

// The title's end (joint D1 F1): one millisecond past the element's end where that lies past
// the playlist's, else the playlist's. Read from the host's element, as the end pause is.
async function titleEndMs(tab, playlistEndMs) {
  const elementS = await read(tab, "document.querySelector('#video')?.duration ?? null");
  return Number.isFinite(elementS) ? Math.max(playlistEndMs, Math.floor(elementS * 1000) + 1) : playlistEndMs;
}

async function roomStates() { return Promise.all([read(host, roomSnapshot), read(viewer, roomSnapshot)]); }

async function waitRoomStates(done, timeoutMs = WAIT_MS) {
  return poll(roomStates, done, timeoutMs);
}

async function setPlaying(wanted) {
  if ((await roomStates()).every(({ state, video }) => state?.playing === wanted && video?.paused === !wanted)) return true;
  const selector = wanted ? '#play' : '#pause';
  if (!await clickWhenEnabled(host, selector)) return false;
  return (await waitRoomStates((states) => states.every(({ state, video }) => state?.playing === wanted && video?.paused === !wanted))).ok;
}

async function setFileInput(filename) {
  const { root } = await fileHost.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await fileHost.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#host-file' });
  if (!nodeId) throw new Error('host file input is missing');
  await fileHost.send('DOM.setFileInputFiles', { nodeId, files: [filename] });
}

// Keyed on the inspect count, so a second file is not judged by the first file's refusal.
async function prepareFile(filename) {
  const inspected = await read(fileHost, 'window.__app.hostFile()?.workerCalls?.inspect ?? 0');
  await setFileInput(filename);
  return (await until(fileHost, 'window.__app.hostFile()', (snapshot) => snapshot?.workerCalls?.inspect > inspected && ['refused', 'ready', 'failed'].includes(snapshot?.state), 60_000)).value;
}

async function runRows() {
  const noRoom = await poll(async () => read(host, `(() => ({
    host: document.querySelector('#host') !== null,
    join: document.querySelector('#join') !== null,
    room: new URL(location.href).searchParams.has('room'),
    roster: document.querySelectorAll('#roster li').length,
    state: window.__app?.playbackState?.() ?? null,
  }))()`), (value) => value?.host === true && value?.join === true, 2_000);
  await sleep(2_000);
  noRoom.value = await read(host, `(() => ({
    host: document.querySelector('#host') !== null,
    join: document.querySelector('#join') !== null,
    room: new URL(location.href).searchParams.has('room'),
    roster: document.querySelectorAll('#roster li').length,
    state: window.__app?.playbackState?.() ?? null,
  }))()`);
  await runRow(LABELS[0], async () => ({
    exercised: noRoom.ok,
    ok: noRoom.ok && !noRoom.value.room && noRoom.value.roster === 0 && noRoom.value.state === null,
    detail: noRoom.value,
  }));

  await runRow(LABELS[1], async () => {
    if (!noRoom.ok) return { exercised: false };
    await clickElement(host, '#host');
    const joined = await until(host, `(() => {
      const params = new URL(location.href).searchParams;
      const invite = document.querySelector('#invite');
      return { room: params.get('room'), role: params.get('role'), tab: params.get('tab'), invite: invite?.href ?? null };
    })()`, (value) => /^[0-9a-f]{32}$/.test(value?.room ?? '') && value.role === 'host' && Boolean(value.tab) && Boolean(value.invite));
    const value = joined.value;
    const inviteParams = value?.invite ? new URL(value.invite).searchParams : null;
    const ok = joined.ok && inviteParams?.get('room') === value.room && [...inviteParams.keys()].length === 1;
    return { exercised: true, ok, detail: value };
  });

  const invite = await read(host, "document.querySelector('#invite')?.href ?? null");
  await runRow(LABELS[2], async () => {
    if (!invite) return { exercised: false };
    await viewer.evaluate("document.querySelector('#join-input')?.focus()");
    await viewer.send('Input.insertText', { text: invite });
    await clickElement(viewer, '#join');
    const joined = await until(viewer, `(() => {
      const params = new URL(location.href).searchParams;
      return { room: params.get('room'), role: params.get('role'), roster: [...document.querySelectorAll('#roster li')].map((li) => li.textContent) };
    })()`, (value) => /^[0-9a-f]{32}$/.test(value?.room ?? '') && value.role === null);
    const roster = await until(host, `[...document.querySelectorAll('#roster li')].map((li) => li.textContent)`, (value) => value.some((text) => text.includes('· viewer ·')));
    return { exercised: true, ok: joined.ok && roster.ok && joined.value.room === new URL(invite).searchParams.get('room'), detail: { joined: joined.value, roster: roster.value } };
  });

  await runRow(LABELS[3], async () => {
    const states = await roomStates();
    await sleep(3_000);
    const after = await roomStates();
    const ok = states.every(({ state }) => state !== null) && after.every(({ state, video }) => state?.playing === false && state.positionMs === 0 && state.held === false && video?.currentTime < 0.1 && video.paused);
    return { exercised: states.every(({ state }) => state !== null), ok, detail: after };
  });

  await runRow(LABELS[4], async () => {
    const clicked = await clickWhenEnabled(host, '#play');
    const playing = await waitRoomStates((states) => states.every(({ state, video }) => state?.playing === true && video?.paused === false));
    return { exercised: clicked, ok: clicked && playing.ok, detail: playing.value };
  });

  await runRow(LABELS[5], async () => {
    await sleep(3_500);
    const faded = await read(host, "document.querySelector('#control-bar')?.dataset.faded === 'true'");
    if (!faded) return { exercised: false };
    const clicked = await clickWhenEnabled(host, '#pause');
    const paused = await waitRoomStates((states) => states.every(({ state, video }) => state?.playing === false && video?.paused === true));
    return { exercised: true, ok: clicked && paused.ok, detail: { faded, states: paused.value } };
  });

  await setPlaying(false);
  await runRow(LABELS[6], async () => {
    const before = await roomStates();
    const volume = await setRange(host, '#volume', 0.3);
    const mutedBefore = before[0].video?.muted;
    const viewerBefore = before[1].video;
    await clickElement(host, '#mute');
    await sleep(250);
    const after = await roomStates();
    const ok = Math.abs((after[0].video?.volume ?? 0) - 0.3) < 0.001
      && after[0].video?.muted === !mutedBefore
      && after[1].video?.volume === viewerBefore?.volume
      && after[1].video?.muted === viewerBefore?.muted
      && after[0].state?.version === before[0].state?.version
      && after[1].state?.version === before[1].state?.version;
    return { exercised: volume !== null, ok, detail: { before, after } };
  });

  await runRow(LABELS[7], async () => {
    const before = await read(host, "({ hidden: document.querySelector('#overlay')?.hidden, drift: document.querySelector('#drift-line')?.textContent ?? '' })");
    await clickElement(host, '#stats');
    const clicked = true;
    const after = await until(host, "document.querySelector('#overlay')?.hidden === false", Boolean);
    return { exercised: before?.hidden === true && Boolean(before.drift), ok: clicked && after.ok, detail: { before, visible: after.value } };
  });

  await runRow(LABELS[8], async () => {
    const paused = await read(host, "document.querySelector('#sync-dot')?.dataset.state === 'idle'");
    const clicked = await clickWhenEnabled(host, '#play');
    await sleep(5_000);
    const dot = await read(host, "({ state: document.querySelector('#sync-dot')?.dataset.state, title: document.querySelector('#sync-dot')?.title ?? '' })");
    return { exercised: paused, ok: paused && clicked && ['in-sync', 'correcting'].includes(dot.state) && dot.title.endsWith(' ms'), detail: dot };
  });

  // Joint D1 F4: a real pointer drag. Each move fires `input`; the release fires `change`.
  await runRow(LABELS[9], async () => {
    if (!await setPlaying(false)) return { exercised: false };
    const track = await read(host, `(() => {
      const element = document.querySelector('#seek');
      if (!element || element.disabled || !(Number(element.max) > 0)) return null;
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { left: rect.left, width: rect.width, y: rect.top + rect.height / 2 };
    })()`);
    if (!track) return { exercised: false };
    const before = (await roomStates())[0].state;
    const at = (fraction) => ({ x: track.left + track.width * fraction, y: track.y, button: 'left' });
    await host.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0.2), clickCount: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await sleep(150);
      await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(0.2 + step * 0.05), buttons: 1 });
    }
    await host.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(0.6), clickCount: 1 });
    const released = await read(host, "Number(document.querySelector('#seek')?.value)");
    const settled = await waitRoomStates((states) => states.every(({ state }) => state && Math.abs(state.positionMs - released) <= 1));
    await sleep(1_000);
    const after = await roomStates();
    const versions = after.map(({ state }) => (state?.version ?? 0) - (before?.version ?? 0));
    const ok = settled.ok && versions.every((delta) => delta === 1)
      && after.every(({ state }) => Math.abs(state.positionMs - released) <= 1);
    return { exercised: Number.isFinite(released) && released > 0, ok, detail: { released, versions, states: after } };
  });

  await runRow(LABELS[10], async () => {
    if (!await setPlaying(false)) return { exercised: false };
    const duration = await until(host, "Number(document.querySelector('#seek')?.max)", (value) => Number.isFinite(value) && value > 6_000);
    if (!duration.ok) return { exercised: false };
    const target = duration.value - 6_000;
    const seekValue = await setRange(host, '#seek', target);
    const sought = await waitRoomStates((states) => states.every(({ state }) => state && Math.abs(state.positionMs - target) <= 1));
    const clicked = await clickWhenEnabled(host, '#play');
    const endMs = await titleEndMs(host, duration.value);
    const ended = await waitRoomStates((states) => states.every(({ state, video }) => state?.playing === false && Math.abs(state.positionMs - endMs) <= END_TOLERANCE_MS && video?.ended === true), 20_000);
    const states = ended.value;
    const identity = states.length === 2 && states[0].state?.lineage === states[1].state?.lineage && states[0].state?.version === states[1].state?.version;
    return { exercised: true, ok: seekValue !== null && sought.ok && clicked && ended.ok && identity, detail: { duration: duration.value, endMs, states } };
  });

  await runRow(LABELS[11], async () => {
    const ended = await until(host, "({ time: document.querySelector('#time')?.textContent, play: document.querySelector('#play')?.textContent })", (value) => value.time === 'Ended' && value.play === 'Watch again', 5_000);
    if (!ended.ok) return { exercised: false };
    const watched = await clickWhenEnabled(host, '#play');
    const reset = await waitRoomStates((states) => states.every(({ state }) => state?.playing === false && state.positionMs === 0 && state.held === false));
    const played = await clickWhenEnabled(host, '#play') && (await waitRoomStates((states) => states.every(({ state, video }) => state?.playing === true && !video.paused))).ok;
    return { exercised: true, ok: watched && reset.ok && played, detail: { ended: ended.value, reset: reset.value } };
  });

  await runRow(LABELS[12], async () => {
    const mode = await until(host, "window.__app.timeline()?.controlMode ?? null", (value) => value === 'open');
    if (!mode.ok) return { exercised: false };
    const modeClick = await clickWhenEnabled(host, '#control-mode');
    const hostMode = await until(host, "window.__app.timeline()?.controlMode ?? null", (value) => value === 'host');
    if (!modeClick || !hostMode.ok || !await setPlaying(false)) return { exercised: false };
    const duration = await read(host, "Number(document.querySelector('#seek')?.max)");
    const beforeRejected = (await read(viewer, "window.__app.timeline()?.rejected?.notPermitted ?? null")) ?? 0;
    const beforeNotices = await read(host, "[...document.querySelectorAll('#notices li')].map((li) => li.textContent)");
    await setRange(host, '#seek', duration - 6_000);
    const sought = await waitRoomStates((states) => states.every(({ state }) => state && Math.abs(state.positionMs - (duration - 6_000)) <= 1));
    const played = await clickWhenEnabled(host, '#play');
    const endMs = await titleEndMs(host, duration);
    const ended = await waitRoomStates((states) => states.every(({ state }) => state?.playing === false && Math.abs(state.positionMs - endMs) <= END_TOLERANCE_MS), 20_000);
    const rejection = await until(viewer, "window.__app.timeline()?.rejected?.notPermitted ?? null", (value) => value === beforeRejected + 1, 5_000);
    const afterRejected = rejection.value;
    const notices = await read(host, "[...document.querySelectorAll('#notices li')].map((li) => li.textContent)");
    const noRejectedPause = notices.slice(beforeNotices.length).every((text) => !text.includes('pause was rejected'));
    return { exercised: true, ok: sought.ok && played && ended.ok && afterRejected === beforeRejected + 1 && noRejectedPause, detail: { ended: ended.value, beforeRejected, afterRejected, notices: notices.slice(beforeNotices.length) } };
  });

  const fixture = (name) => path.join(APP_DIR, 'scripts', 'check', 'remux-fixtures', name);
  await clickElement(fileHost, '#host');
  await until(fileHost, "window.__app.hostFile()?.state === 'awaiting-file'", Boolean, WAIT_MS);
  await runRow(LABELS[13], async () => {
    const state = await prepareFile(fixture('refuse-audio-codec.mp4'));
    const snapshot = await read(fileHost, fileSnapshot);
    const ok = state?.state === 'refused' && Boolean(snapshot.reason) && snapshot.command === AUDIO_COMMAND && !snapshot.command.includes('refuse') && !snapshot.command.includes('audio-codec');
    return { exercised: true, ok, detail: snapshot };
  });

  await runRow(LABELS[14], async () => {
    // The clipboard read needs a focused document; A's windows were driven last.
    await fileHost.send('Page.bringToFront');
    await browser.send('Browser.grantPermissions', { origin: ORIGIN_B, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await clickElement(fileHost, '#file-copy');
    let clipboard;
    try {
      clipboard = await userGestureEvaluate(fileHost, 'navigator.clipboard.readText()');
    } catch (error) {
      clipboardRefused = true;
      return { exercised: true, ok: false, detail: `clipboard read refused: ${error.message}` };
    }
    const command = await read(fileHost, "document.querySelector('#file-command')?.textContent ?? ''");
    return { exercised: true, ok: clipboard === command, detail: { command, clipboard } };
  });
  if (clipboardRefused) throw new Error('clipboard read refused with the requested permissions');

  await runRow(LABELS[15], async () => {
    const state = await prepareFile(fixture('refuse-encrypted.mp4'));
    const snapshot = await read(fileHost, fileSnapshot);
    return { exercised: true, ok: state?.state === 'refused' && Boolean(snapshot.reason) && snapshot.command === '', detail: snapshot };
  });

  await runRow(LABELS[16], async () => {
    const state = await prepareFile(fixture('varying.mp4'));
    const snapshot = await read(fileHost, fileSnapshot);
    const ok = state?.state === 'ready' && /5 s/.test(snapshot.notice) && snapshot.notice.includes(KEYFRAME_COMMAND);
    return { exercised: true, ok, detail: snapshot };
  });
}

async function main() {
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  const a = await startServer('A', 8129, { APP_DELIVERY: 'http', APP_TRACKER_URL: '' });
  const b = await startServer('B', 8130, {
    APP_MEDIA_SOURCE: 'file', APP_DELIVERY: 'host', APP_TRACKER_URL: '', APP_ICE_SERVERS: '[]', APP_SEGMENT_TARGET_S: '2',
  });
  serverSettings = { A: a.settings, B: b.settings };
  await openPages(a, b);
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
  for (const server of servers.reverse()) {
    try { await stopChild(server.child); } catch (error) { cleanupFailure ??= error?.message ?? String(error); }
  }
  try {
    fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), chrome: { version: chromeVersion, path: CHROME },
      builds, servers: serverSettings, rows: log.results.map(({ label, status, detail: rowDetail, qualifier }) => ({ label, status, detail: rowDetail ?? qualifier ?? null })),
      runnerFailure, cleanupFailure,
    }, null, 2)}\n`);
  } catch (error) {
    if (!runnerFailure) { runnerFailure = error?.message ?? String(error); process.exitCode = 2; }
  }
}
