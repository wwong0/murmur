// Browser proof for the player's inputs: the sync dot
// with one member and two, the keys, a click and a right click on the video, the fullscreen
// button, the seek thumb after a drag, theatre's animation, and the leave warning. It owns one
// default-paused server; a host and a viewer share one room. Records carry booleans, counts,
// media positions in ms and volumes; nothing is typed but one `k`, which is never sent.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acceptLeaveDialogs, clickElement, sleep } from './cdp.mjs';
import { createPageDriver, poll, present, read, SHORT_MS, until, watch } from './runner/page-driver.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = createPageDriver({ appDir: APP_DIR, runStem: '12e-player-inputs', port: 8138 });
const { origin: ORIGIN } = driver;
const ROOM = `pk-${crypto.randomBytes(6).toString('hex')}`;
const ROOM_URL = (role, tab) => `${ORIGIN}/room.html?room=${ROOM}&role=${role}&tab=${tab}`;
const PLAYBACK = '(window.__app?.playbackState?.() ?? null)';
const SEEK_LOADED = "Number(document.querySelector('#seek')?.max) > 0";
const DURATION = "Number(document.querySelector('#seek')?.max)";
const SEEKABLE = "document.querySelector('#back-10')?.disabled === false";
const ROSTER_COUNT = "document.querySelectorAll('#roster li').length";
const ANIMATING = "(document.getElementById('player')?.getAnimations().length ?? 0)";
const THEATRE_ON = "document.querySelector('.layout')?.hasAttribute('data-theatre') === true";
const FULLSCREEN = "document.fullscreenElement?.id ?? null";
const LABEL = "document.querySelector('#fullscreen')?.textContent.trim() ?? null";
const SAME_VIDEO = "document.getElementById('video')?.__pkMark === true";
const SETTLE_MS = 1_000;
const POSITION_MS = 250;
const SNAP_MS = 5_000;
const DIALOG_MS = 5_000;
const KEYS = {
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  k: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'k' },
  j: { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, text: 'j' },
  l: { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, text: 'l' },
  m: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
  f: { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' },
  t: { key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, text: 't' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
};

let host = null;
let viewer = null;
let hostDialogs = null;

// A held key is one keyDown, `repeats` auto-repeated keyDowns, then the keyUp.
async function press(tab, name, { repeats = 0 } = {}) {
  const { text, ...key } = KEYS[name];
  const down = { type: text ? 'keyDown' : 'rawKeyDown', ...key, ...(text ? { text } : {}) };
  await tab.send('Input.dispatchKeyEvent', down);
  for (let i = 0; i < repeats; i += 1) {
    await sleep(40);
    await tab.send('Input.dispatchKeyEvent', { ...down, autoRepeat: true });
  }
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

// No control holds focus when a key row presses, so a key reaches the page, not a button.
const blur = (tab) => read(tab, 'document.activeElement?.blur?.(), true');

const both = () => Promise.all([read(host, PLAYBACK), read(viewer, PLAYBACK)]);
const bothAgree = (wanted, timeoutMs) => poll(both, ([a, b]) => a !== null && b !== null && wanted(a) && wanted(b), timeoutMs);

// The shown play or pause control is enabled only once the last change's scheduled instant has
// passed, and a key or a video click before then is ignored as the button is. So a row's first
// press waits for it.
const TOGGLE_READY = "[...document.querySelectorAll('#play, #pause')].some((button) => !button.hidden && button.disabled === false)";

async function setPlaying(wanted) {
  if ((await read(host, `${PLAYBACK}?.playing`)) !== wanted) {
    const button = wanted ? '#play' : '#pause';
    if (!(await until(host, `document.querySelector('${button}')?.disabled === false`, Boolean)).ok) return false;
    await clickElement(host, button);
    if (!(await bothAgree((state) => state.playing === wanted)).ok) return false;
    await blur(host);
  }
  return (await until(host, TOGGLE_READY, Boolean)).ok;
}

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

async function pausedAt(positionMs) {
  if (!await setPlaying(false)) return false;
  if (!(await until(host, SEEKABLE, Boolean)).ok) return false;
  await setRange(host, '#seek', positionMs);
  const there = await bothAgree((state) => !state.playing && Math.abs(state.positionMs - positionMs) <= 1);
  return there.ok && (await until(host, SEEKABLE, Boolean)).ok;
}

const version = async () => (await read(host, PLAYBACK))?.version ?? null;

// One operation, read when both pages agree on it and again a second later, so a held key's
// second operation is counted if it comes.
async function afterKey(name, wanted, options) {
  const before = await version();
  await blur(host);
  await press(host, name, options);
  const agreed = await bothAgree((state) => before !== null && state.version > before && wanted(state));
  await sleep(SETTLE_MS);
  const [a, b] = await both();
  return { agreed: agreed.ok, delta: (a?.version ?? before) - before, viewerDelta: (b?.version ?? before) - before, hostMs: a?.positionMs ?? null, viewerMs: b?.positionMs ?? null, playing: a?.playing ?? null };
}

async function openRoom() {
  host = await driver.openTab(ROOM_URL('host', 'pk-h'), 'host');
  await driver.freshness(host);
  if (!(await until(host, present('#message-input'), Boolean)).ok) throw new Error('the host page did not render the room');
  const width = await read(host, 'window.innerWidth');
  if (!(width >= 768)) throw new Error(`the host tab opened ${width}px wide, under the 768px desktop layout`);
  await read(host, "document.getElementById('video').__pkMark = true");
}

async function rowFreshness() {
  const { bundle } = await driver.freshness(host);
  const chromeRecorded = typeof driver.state.chromeVersion === 'string';
  return { exercised: true, ok: bundle.matches === true && bundle.pageIdInServed === true && chromeRecorded, detail: { bundleMatches: bundle.matches === true, pageIdInServed: bundle.pageIdInServed === true, chromeRecorded } };
}

const DOT = `(() => {
  const dot = document.querySelector('#sync-dot');
  return dot ? { hidden: dot.hidden, figure: dot.getAttribute('data-figure'), title: dot.hasAttribute('title') } : null;
})()`;

async function rowDot() {
  if (!(await until(host, SEEK_LOADED, Boolean)).ok) return { exercised: false, detail: 'the title did not load' };
  if (!(await until(host, ROSTER_COUNT, (count) => count === 1)).ok) return { exercised: false, detail: 'the host was not alone' };
  if (!(await until(host, "document.querySelector('#play')?.disabled === false", Boolean)).ok) return { exercised: false, detail: 'play stayed disabled' };
  await clickElement(host, '#play');
  const playing = await until(host, `${PLAYBACK}?.playing === true`, Boolean);
  if (!playing.ok) return { exercised: false, detail: 'the room did not play' };
  await sleep(3_000);
  const alone = await watch(host, DOT, 2_000);
  viewer = await driver.openTab(ROOM_URL('viewer', 'pk-v'), 'viewer');
  const two = await until(host, ROSTER_COUNT, (count) => count === 2);
  const joined = await until(host, DOT, (dot) => dot?.hidden === false && typeof dot.figure === 'string' && dot.figure.length > 0 && dot.title === false);
  const hiddenAlone = alone.length > 0 && alone.every((dot) => dot?.hidden === true);
  return {
    exercised: two.ok,
    ok: hiddenAlone && joined.ok,
    detail: { aloneSamples: alone.length, aloneHidden: alone.filter((dot) => dot?.hidden === true).length, joinedHidden: joined.value?.hidden ?? null, joinedFigure: typeof joined.value?.figure === 'string' && joined.value.figure.length > 0, joinedTitle: joined.value?.title ?? null },
  };
}

async function rowSpace() {
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const first = await afterKey('Space', (state) => state.playing === true, { repeats: 3 });
  if (first.agreed) await until(host, TOGGLE_READY, Boolean);
  const second = first.agreed ? await afterKey('Space', (state) => state.playing === false) : null;
  return { exercised: true, ok: first.agreed && first.delta === 1 && second?.agreed === true && second.delta === 1, detail: { held: first, again: second } };
}

async function rowK() {
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  const result = await afterKey('k', (state) => state.playing === false);
  return { exercised: true, ok: result.agreed && result.delta === 1, detail: result };
}

const near = (target) => (state) => Math.abs(state.positionMs - target) <= POSITION_MS;

function rowSeekKeys(forward, back, stepMs, repeats) {
  return async () => {
    const duration = await until(host, DURATION, (value) => Number.isFinite(value) && value > 90_000);
    if (!duration.ok) return { exercised: false, detail: { durationMs: duration.value } };
    const start = 60_000;
    if (!await pausedAt(start)) return { exercised: false, detail: 'the room would not rest paused at 60 s' };
    const ahead = await afterKey(forward, near(start + stepMs), { repeats });
    await until(host, SEEKABLE, Boolean);
    const behind = await afterKey(back, near(start));
    const landed = (result, target) => result.agreed && result.delta === 1 && Math.abs(result.hostMs - target) <= POSITION_MS && Math.abs(result.viewerMs - target) <= POSITION_MS;
    return { exercised: true, ok: landed(ahead, start + stepMs) && landed(behind, start), detail: { forward: ahead, back: behind } };
  };
}

const MUTED = "document.getElementById('video')?.muted ?? null";

async function rowMute() {
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const [before, viewerBefore, v0] = [await read(host, MUTED), await read(viewer, MUTED), await version()];
  if (typeof before !== 'boolean') return { exercised: false, detail: 'no media element' };
  await blur(host);
  await press(host, 'm');
  const flipped = await until(host, MUTED, (value) => value === !before, SHORT_MS);
  await press(host, 'm');
  const back = await until(host, MUTED, (value) => value === before, SHORT_MS);
  const [viewerAfter, v1] = [await read(viewer, MUTED), await version()];
  return { exercised: true, ok: flipped.ok && back.ok && viewerAfter === viewerBefore && v1 === v0, detail: { flipped: flipped.ok, back: back.ok, viewerUnchanged: viewerAfter === viewerBefore, operations: v1 - v0 } };
}

const VOLUME = "document.getElementById('video')?.volume ?? null";
const close = (value, target) => typeof value === 'number' && Math.abs(value - target) <= 0.001;

async function rowVolume() {
  const v0 = await version();
  await setRange(host, '#volume', 0.5);
  if (!(await until(host, VOLUME, (value) => close(value, 0.5), SHORT_MS)).ok) return { exercised: false, detail: 'the volume did not take 0.5' };
  await blur(host);
  await press(host, 'ArrowUp');
  const up = await until(host, VOLUME, (value) => close(value, 0.55), SHORT_MS);
  await press(host, 'ArrowDown', { repeats: 3 });
  const down = await until(host, VOLUME, (value) => close(value, 0.35), SHORT_MS);
  const v1 = await version();
  await setRange(host, '#volume', 1);
  return { exercised: true, ok: up.ok && down.ok && v1 === v0, detail: { up: up.value, down: down.value, operations: v1 - v0 } };
}

async function rowFullscreenKey() {
  const v0 = await version();
  await blur(host);
  await press(host, 'f');
  const entered = await until(host, FULLSCREEN, (id) => id === 'player', SHORT_MS);
  await press(host, 'f');
  const left = await until(host, FULLSCREEN, (id) => id === null, SHORT_MS);
  const [same, v1] = [await read(host, SAME_VIDEO), await version()];
  return { exercised: true, ok: entered.ok && left.ok && same === true && v1 === v0, detail: { entered: entered.ok, left: left.ok, sameVideo: same === true, operations: v1 - v0 } };
}

async function waitStill(tab) {
  return until(tab, ANIMATING, (count) => count === 0, SHORT_MS);
}

async function rowTheatreKey() {
  const v0 = await version();
  await blur(host);
  await press(host, 't');
  const on = await until(host, THEATRE_ON, Boolean, SHORT_MS);
  await waitStill(host);
  await press(host, 't');
  const off = await until(host, THEATRE_ON, (value) => value === false, SHORT_MS);
  await waitStill(host);
  const [same, v1] = [await read(host, SAME_VIDEO), await version()];
  return { exercised: true, ok: on.ok && off.ok && same === true && v1 === v0, detail: { on: on.ok, off: off.ok, sameVideo: same === true, operations: v1 - v0 } };
}

async function rowKInField() {
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  const v0 = await version();
  await clickElement(host, '#message-input');
  const focused = await read(host, "document.activeElement?.id === 'message-input'");
  if (focused !== true) return { exercised: false, detail: 'the message input did not take focus' };
  await press(host, 'k');
  await sleep(1_500);
  const [a, b] = await both();
  const typed = await read(host, "document.querySelector('#message-input')?.value.length ?? null");
  await host.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  const cleared = await read(host, "document.querySelector('#message-input')?.value.length ?? null");
  await blur(host);
  return { exercised: true, ok: a?.playing === true && b?.playing === true && a.version === v0 && typed === 1 && cleared === 0, detail: { hostPlaying: a?.playing ?? null, viewerPlaying: b?.playing ?? null, operations: (a?.version ?? v0) - v0, typedLength: typed, clearedLength: cleared } };
}

const VIDEO_CENTRE = `(() => {
  const video = document.getElementById('video');
  if (!video) return null;
  const r = video.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return { x, y, hit: document.elementFromPoint(x, y) === video };
})()`;

async function clickVideo(button = 'left') {
  const point = await read(host, VIDEO_CENTRE);
  if (!point?.hit) return null;
  await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  for (const type of ['mousePressed', 'mouseReleased']) await host.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, clickCount: 1 });
  return point;
}

async function rowClickVideo() {
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const v0 = await version();
  if (!await clickVideo()) return { exercised: false, detail: 'the video centre is covered' };
  const played = await bothAgree((state) => state.version > v0 && state.playing === true);
  await sleep(SETTLE_MS);
  const v1 = await version();
  await until(host, "document.querySelector('#pause')?.disabled === false", Boolean);
  await clickVideo();
  const paused = await bothAgree((state) => state.version > v1 && state.playing === false);
  const v2 = await version();
  return { exercised: true, ok: played.ok && v1 - v0 === 1 && paused.ok && v2 - v1 === 1, detail: { played: played.ok, playOperations: v1 - v0, paused: paused.ok, pauseOperations: v2 - v1 } };
}

// A cancellable contextmenu event dispatched at the video's centre, read after it has bubbled
// through the player. A trusted right click would open Chrome's own menu on a page that does
// not cancel it, and that menu holds the window's input until it is dismissed.
const MENU_PREVENTED = `(() => {
  const video = document.getElementById('video');
  const r = video.getBoundingClientRect();
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  return video.dispatchEvent(event) === false;
})()`;

async function rowContextMenu() {
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const paused = await read(host, MENU_PREVENTED);
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  const playing = await read(host, MENU_PREVENTED);
  return { exercised: paused !== null && playing !== null, ok: paused === true && playing === true, detail: { pausedPrevented: paused, playingPrevented: playing } };
}

async function rowFullscreenButton() {
  const label0 = await read(host, LABEL);
  await clickElement(host, '#fullscreen');
  const entered = await until(host, FULLSCREEN, (id) => id === 'player', SHORT_MS);
  const label1 = await until(host, LABEL, (text) => text === 'exit fullscreen', SHORT_MS);
  await clickElement(host, '#fullscreen');
  const left = await until(host, FULLSCREEN, (id) => id === null, SHORT_MS);
  if (!left.ok) await read(host, 'document.exitFullscreen?.(), true');
  const label2 = await until(host, LABEL, (text) => text === 'fullscreen', SHORT_MS);
  const same = await read(host, SAME_VIDEO);
  await blur(host);
  return {
    exercised: true,
    ok: label0 === 'fullscreen' && entered.ok && label1.ok && left.ok && label2.ok && same === true,
    detail: { labelBefore: label0 === 'fullscreen', entered: entered.ok, labelInside: label1.ok, left: left.ok, labelAfter: label2.ok, sameVideo: same === true },
  };
}

// The sampler reads the thumb every frame from the release until the room is at the target.
const SAMPLER = `(() => {
  const seek = document.getElementById('seek');
  window.__pkThumb = [];
  const tick = () => {
    if (!window.__pkThumb) return;
    window.__pkThumb.push(Number(seek.value));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;
const SAMPLES = "(() => { const samples = window.__pkThumb ?? []; window.__pkThumb = null; return samples; })()";

async function rowThumbHolds() {
  const duration = await until(host, DURATION, (value) => Number.isFinite(value) && value > 90_000);
  if (!duration.ok) return { exercised: false, detail: { durationMs: duration.value } };
  if (!await pausedAt(10_000)) return { exercised: false, detail: 'the room would not rest at 10 s' };
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  await sleep(1_000);
  const track = await read(host, `(() => {
    const element = document.querySelector('#seek');
    element.scrollIntoView({ block: 'center' });
    const r = element.getBoundingClientRect();
    return { left: r.left, width: r.width, y: r.top + r.height / 2 };
  })()`);
  const old = await read(host, "Number(document.querySelector('#seek')?.value)");
  if (!track || !Number.isFinite(old)) return { exercised: false, detail: 'no seek track' };
  const at = (fraction) => ({ x: track.left + track.width * fraction, y: track.y, button: 'left' });
  await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(0.5) });
  await host.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0.5), clickCount: 1 });
  for (let step = 1; step <= 6; step += 1) {
    await sleep(120);
    await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(0.5 + step * 0.05), buttons: 1 });
  }
  await read(host, SAMPLER);
  await host.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(0.8), clickCount: 1 });
  const targetMs = await read(host, "Number(document.querySelector('#seek')?.value)");
  const applied = await until(host, PLAYBACK, (state) => state !== null && Math.abs(state.positionMs - targetMs) <= 2_000 && state.playing === true, SNAP_MS);
  await sleep(500);
  const samples = (await read(host, SAMPLES)) ?? [];
  const snapped = samples.filter((value) => Math.abs(value - old) <= SNAP_MS).length;
  return {
    exercised: applied.ok && Number.isFinite(targetMs) && Math.abs(targetMs - old) > 3 * SNAP_MS,
    ok: samples.length >= 10 && snapped === 0,
    detail: { fromMs: Math.round(old), targetMs, applied: applied.ok, samples: samples.length, nearOld: snapped, minSample: samples.length ? Math.min(...samples) : null },
  };
}

async function theatreToggle(reduce) {
  await clickElement(host, '#theatre');
  const samples = [];
  const end = Date.now() + 600;
  let started = null;
  while (Date.now() < end) {
    const count = await read(host, ANIMATING);
    samples.push(count);
    if (started === null && count > 0) started = Date.now();
    if (!reduce && started !== null && count === 0) break;
    await sleep(20);
  }
  const still = await waitStill(host);
  return { animated: samples.some((count) => count > 0), firstSeen: started, samples: samples.length, still: still.ok };
}

async function rowTheatreAnimates() {
  if (await read(host, THEATRE_ON)) return { exercised: false, detail: 'theatre was on before the row' };
  const into = await theatreToggle(false);
  const on = await read(host, THEATRE_ON);
  const out = await theatreToggle(false);
  const off = (await read(host, THEATRE_ON)) === false;
  return { exercised: on === true && off, ok: into.animated && into.still && out.animated && out.still, detail: { in: into, out } };
}

async function rowTheatreReduced() {
  await host.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    const reduced = await read(host, "matchMedia('(prefers-reduced-motion: reduce)').matches");
    const before = await read(host, "document.getElementById('player').getBoundingClientRect().width");
    const into = await theatreToggle(true);
    const width = await read(host, "document.getElementById('player').getBoundingClientRect().width");
    await sleep(300);
    const settled = await read(host, "document.getElementById('player').getBoundingClientRect().width");
    const on = await read(host, THEATRE_ON);
    const out = await theatreToggle(true);
    return {
      exercised: reduced === true && on === true,
      ok: !into.animated && !out.animated && Math.abs(width - settled) <= 1 && Math.abs(width - before) > 1,
      detail: { in: into, out, widthBefore: before, widthAfter: width, widthSettled: settled },
    };
  } finally {
    await host.send('Emulation.setEmulatedMedia', { features: [] });
  }
}

// The two pages a warning would be wrong for: a viewer reloading while the room plays, and the
// host reloading while it is paused. Each has sticky activation, so Chrome would ask if the
// page asked it to.
async function reloadDialogs(tab, label) {
  const dialogs = await acceptLeaveDialogs(tab);
  await read(tab, `window.${label} = true`);
  await tab.send('Page.reload');
  const reloaded = await until(tab, `window.${label} === undefined && ${present('#message-input')}`, Boolean);
  await sleep(SETTLE_MS);
  dialogs.stop();
  return { reloaded: reloaded.ok, dialogs: dialogs.count };
}

const ACTIVE = 'navigator.userActivation.hasBeenActive';

async function rowNoWarning() {
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  await clickElement(viewer, '#stats');
  await clickElement(viewer, '#stats');
  const viewerActive = await read(viewer, ACTIVE);
  const viewerReload = await reloadDialogs(viewer, '__pkViewer');
  if (!await setPlaying(false)) return { exercised: false, detail: 'the room would not pause' };
  const hostActive = await read(host, ACTIVE);
  const hostReload = await reloadDialogs(host, '__pkHost');
  await until(host, SEEK_LOADED, Boolean);
  return {
    exercised: viewerActive === true && hostActive === true && viewerReload.reloaded && hostReload.reloaded,
    ok: viewerReload.dialogs === 0 && hostReload.dialogs === 0,
    detail: { viewerActive, viewerReload, hostActive, hostReload },
  };
}

async function rowHostWarned() {
  if (!(await until(host, SEEK_LOADED, Boolean)).ok) return { exercised: false, detail: 'the title did not load after the reload' };
  if (!await setPlaying(true)) return { exercised: false, detail: 'the room would not play' };
  const active = await read(host, ACTIVE);
  const link = await read(host, present('.room-header a[href]'));
  if (link !== true) return { exercised: true, ok: false, detail: { active, headerLink: false } };
  hostDialogs = await acceptLeaveDialogs(host);
  await clickElement(host, '.room-header a[href]');
  const left = await until(host, `location.pathname === '/' && ${present('#host')}`, Boolean, DIALOG_MS * 2);
  await sleep(SETTLE_MS);
  hostDialogs.stop();
  return { exercised: active === true, ok: hostDialogs.count === 1 && left.ok, detail: { active, headerLink: true, dialogs: hostDialogs.count, frontPage: left.ok } };
}

await driver.run(async () => {
  await openRoom();
  await driver.runRow('PK0 the served bundle is the build, in a recorded Chrome', rowFreshness);
  await driver.runRow('PK1 the sync dot is hidden while the host is alone and shows once a viewer joins', rowDot);
  if (!viewer) viewer = await driver.openTab(ROOM_URL('viewer', 'pk-v'), 'viewer');
  await driver.runRow('PK2 Space plays and pauses the room, and a held Space acts once', rowSpace);
  await driver.runRow('PK3 K pauses the room', rowK);
  await driver.runRow('PK4 a held L seeks ten seconds once, and J ten seconds back', rowSeekKeys('l', 'j', 10_000, 3));
  await driver.runRow('PK5 the right and left arrows seek five seconds', rowSeekKeys('ArrowRight', 'ArrowLeft', 5_000, 0));
  await driver.runRow('PK6 M mutes and unmutes the page and issues no operation', rowMute);
  await driver.runRow('PK7 the up and down arrows change the volume, a held arrow repeats, and no operation is issued', rowVolume);
  await driver.runRow('PK8 F enters and leaves fullscreen', rowFullscreenKey);
  await driver.runRow('PK9 T enters and leaves theatre and issues no operation', rowTheatreKey);
  await driver.runRow('PK10 k typed in the message input does nothing to the player', rowKInField);
  await driver.runRow('PK11 a click on the video plays the paused room', rowClickVideo);
  await driver.runRow('PK12 a right click on the player opens no menu, paused and playing', rowContextMenu);
  await driver.runRow('PK13 the fullscreen button enters and leaves fullscreen and says which', rowFullscreenButton);
  await driver.runRow('PK14 the seek thumb does not snap back after a drag while playing', rowThumbHolds);
  await driver.runRow('PK15 theatre animates in and out', rowTheatreAnimates);
  await driver.runRow('PK16 under reduced motion theatre changes with no animation', rowTheatreReduced);
  await driver.runRow("PK17 no leave warning for a viewer's reload while playing, nor for the host's while paused", rowNoWarning);
  await driver.runRow('PK18 the playing host following the header link is warned once, and leaves when accepted', rowHostWarned);
});
