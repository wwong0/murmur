// scripts/verify-app-shell.mjs
//
// The app-shell browser step. It needs a running `npm run dev` server on 8100,
// Chrome, and one headed tab; the offline protocol check deliberately does not
// import or run it.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach, cdpHttp, clickElement, disposeChrome, sleep } from './cdp.mjs';
import { createResultLog } from './browser-result-log.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { requireAutoStart } from './delivery-pin.mjs';
import { APP_KEYS, appKeysEqual } from './app-shell-keys.mjs';

const PORT = 9226;
const ORIGIN = 'http://127.0.0.1:8100';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const STARTED_AT = new Date();
const RUN_DIR = path.join(RESULTS_DIR, `11b-app-shell-${STARTED_AT.toISOString().replaceAll(':', '-')}`);
const WAIT_MS = 15_000;
const PRELOAD = `(() => {
  const probe = {
    assignments: 0,
    screensChildrenAtAssignment: null,
    video: null,
    keys: null,
    buildId: null,
    screensChildren: null,
  };
  globalThis.__shellProbe = probe;
  Object.defineProperty(window, '__app', {
    configurable: true,
    enumerable: true,
    get() { return undefined; },
    set(value) {
      probe.assignments += 1;
      if (probe.assignments === 1) {
        probe.screensChildrenAtAssignment = document.getElementById('screens')?.childElementCount ?? -1;
        probe.video = document.querySelector('video');
      }
      Object.defineProperty(window, '__app', {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
      setTimeout(() => {
        const app = window.__app;
        probe.keys = app ? Object.keys(app) : null;
        probe.buildId = app?.buildId ?? null;
        probe.screensChildren = document.getElementById('screens')?.childElementCount ?? -1;
      }, 0);
    },
  });
})();`;

const identityExpression = `(() => {
  const video = document.querySelector('video');
  return document.querySelectorAll('video').length === 1
    && video === globalThis.__shellProbe?.video
    && video?.isConnected === true;
})()`;

const snapshotExpression = `(() => {
  const probe = globalThis.__shellProbe;
  return {
    assignments: probe?.assignments ?? null,
    screensChildrenAtAssignment: probe?.screensChildrenAtAssignment ?? null,
    keys: probe?.keys ?? null,
    buildId: probe?.buildId ?? null,
    screensChildren: probe?.screensChildren ?? null,
    videoConnected: probe?.video?.isConnected === true,
  };
})()`;

const log = createResultLog({ approvedStems: [] });
let chrome = null;
let tab = null;
let bundleIdentity = null;
let chromeVersion = null;
let room = null;

function detail(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function row(label, condition, value = null) {
  log.expect(label, Boolean(condition), value === null ? undefined : detail(value));
}

function timeoutRow(label, observation) {
  if (observation.ok) return false;
  log.rowNotExercised(label, observation.reason);
  return true;
}

async function read(tabToRead, expression) {
  return tabToRead.evaluate(expression);
}

async function until(tabToRead, expression, predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await read(tabToRead, expression);
    if (predicate(value)) return { ok: true, value };
    await sleep(100);
  }
  return { ok: false, value, reason: `timed out after ${timeoutMs}ms` };
}

async function clickWhenEnabled(selector) {
  const ready = await until(tab, `document.querySelector(${JSON.stringify(selector)})?.disabled === false`, Boolean);
  if (!ready.ok) return ready;
  await clickElement(tab, selector);
  return { ok: true, value: true };
}

// A play or pause is scheduled, and controlsReady keeps both buttons disabled until the
// room reaches its instant. The watcher samples every 10 ms from before the click: its first
// read after the flag flips lands inside that lead, and its settled read comes one 250 ms
// tick plus margin after the instant, so the renderer has run.
const SETTLE_MS = 300;
const transitionWatcher = (playing) => `(() => {
  const watch = { first: null, settled: null };
  window.__s3watch = watch;
  const id = setInterval(() => {
    const state = window.__app?.playbackState?.();
    if (!state || state.playing !== ${playing}) return;
    const clock = window.__app?.clock?.();
    const sharedNowMs = clock && Number.isFinite(clock.offsetMs) ? clock.atMs + clock.offsetMs : null;
    const sample = {
      state, sharedNowMs,
      playDisabled: document.querySelector('#play')?.disabled ?? null,
      pauseDisabled: document.querySelector('#pause')?.disabled ?? null,
    };
    if (!watch.first) watch.first = sample;
    if (sharedNowMs !== null && sharedNowMs >= state.atSharedMs + ${SETTLE_MS}) {
      watch.settled = sample;
      clearInterval(id);
    }
  }, 10);
  return true;
})()`;

async function scheduledTransition(selector, playing, { pressed = true } = {}) {
  await read(tab, transitionWatcher(playing));
  if (pressed) {
    const click = await clickWhenEnabled(selector);
    if (!click.ok) return click;
  }
  const watched = await until(tab, `window.__s3watch`, (watch) => watch?.settled != null);
  if (!watched.ok) return watched;
  const { first, settled } = watched.value;
  const inLead = first.sharedNowMs !== null && first.sharedNowMs < first.state.atSharedMs ? first : null;
  return { ok: true, value: { inLead, settled } };
}

async function userGestureEvaluate(expression) {
  const response = await tab.send('Runtime.evaluate', {
    expression,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate failed');
  return response.result?.value;
}

// A held room shows #play in the bar's one slot and keeps #pause enabled under it for drivers,
// so a pointer cannot reach it there and the press is a script click under a user gesture.
async function pressPause() {
  if (await read(tab, `document.querySelector('#pause')?.hidden === true`) !== true) return clickWhenEnabled('#pause');
  await userGestureEvaluate(`document.querySelector('#pause').click()`);
  return { ok: true, value: true };
}

async function recordIdentity(label, step) {
  if (timeoutRow(label, step)) return;
  try {
    row(label, await read(tab, identityExpression));
  } catch (error) {
    row(label, false, error.message);
  }
}

async function runS1() {
  // At least one assignment, or the read can land after navigation and before the bundle ran.
  const assigned = await until(tab, snapshotExpression, (probe) => probe?.assignments >= 1);
  if (timeoutRow('S1 window.__app is assigned once', assigned)) {
    log.rowNotExercised('S1 the screens are empty when window.__app is assigned', assigned.reason);
    log.rowNotExercised(`S1 window.__app has its ${APP_KEYS.length} keys in the first task after the bundle ran`, assigned.reason);
    log.rowNotExercised('S1 the screens are drawn in the first task after the bundle ran', assigned.reason);
    log.rowNotExercised('S1 the page\'s build id is the served bundle\'s', assigned.reason);
    return;
  }
  row('S1 window.__app is assigned once', assigned.value.assignments === 1, assigned.value);
  row('S1 the screens are empty when window.__app is assigned', assigned.value.screensChildrenAtAssignment === 0, assigned.value);

  const firstTask = await until(tab, snapshotExpression, (probe) => Array.isArray(probe?.keys));
  if (timeoutRow(`S1 window.__app has its ${APP_KEYS.length} keys in the first task after the bundle ran`, firstTask)) {
    log.rowNotExercised('S1 the screens are drawn in the first task after the bundle ran', firstTask.reason);
    log.rowNotExercised('S1 the page\'s build id is the served bundle\'s', firstTask.reason);
    return;
  }
  row(`S1 window.__app has its ${APP_KEYS.length} keys in the first task after the bundle ran`, appKeysEqual(firstTask.value.keys), firstTask.value.keys);
  row('S1 the screens are drawn in the first task after the bundle ran', firstTask.value.screensChildren === 4, firstTask.value);

  try {
    const pageBuildId = firstTask.value.buildId;
    bundleIdentity = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId });
    row('S1 the page\'s build id is the served bundle\'s', bundleIdentity.matches && bundleIdentity.pageIdInServed, bundleIdentity);
  } catch (error) {
    row('S1 the page\'s build id is the served bundle\'s', false, error.message);
  }
}

async function runS2() {
  await recordIdentity('S2 the media element is unchanged after load', await until(tab, identityExpression, Boolean));

  const joined = await until(tab, `document.getElementById('status-line')?.textContent ?? ''`, (status) => status.startsWith('connected'));
  await recordIdentity('S2 the media element is unchanged after join', joined);

  // In a held room #play is enabled before the pause is pressed, so wait for the
  // pause itself to land (paused, unheld, a later version) before reading #play. The version is
  // read once #pause is enabled: before that the room may not have created its state.
  const pauseEnabled = await until(tab, `document.querySelector('#pause')?.disabled === false`, Boolean);
  const beforePause = pauseEnabled.ok ? await read(tab, `window.__app.playbackState()?.version ?? null`) : null;
  const pauseReady = pauseEnabled.ok ? await pressPause() : pauseEnabled;
  let pauseStep = pauseReady;
  if (pauseReady.ok) {
    const landed = await until(tab, `window.__app.playbackState()`, (state) => state?.playing === false
      && state.held === false && Number.isInteger(beforePause) && state.version > beforePause);
    pauseStep = landed.ok
      ? await until(tab, `document.querySelector('#play')?.disabled === false`, Boolean)
      : landed;
  }
  await recordIdentity('S2 the media element is unchanged after pause', pauseStep);

  // Wait for the scheduled play's instant, as S3 does.
  const playStep = await scheduledTransition('#play', true);
  await recordIdentity('S2 the media element is unchanged after play', playStep);

  const backReady = await clickWhenEnabled('#back-10');
  await recordIdentity('S2 the media element is unchanged after back 10s', backReady);
  const forwardReady = await clickWhenEnabled('#forward-10');
  await recordIdentity('S2 the media element is unchanged after forward 10s', forwardReady);

  let enteredFullscreen = false;
  try {
    await userGestureEvaluate("document.getElementById('player').requestFullscreen()");
    const fullscreen = await until(tab, `document.fullscreenElement?.id ?? null`, (id) => id === 'player');
    if (fullscreen.ok) {
      enteredFullscreen = true;
      row('S2 fullscreen is on #player', fullscreen.value === 'player', fullscreen.value);
      await recordIdentity('S2 the media element is unchanged after fullscreen', fullscreen);
    } else {
      row('S2 fullscreen is on #player', false, fullscreen.reason);
      log.rowNotExercised('S2 the media element is unchanged after fullscreen', fullscreen.reason);
    }
  } catch (error) {
    row('S2 fullscreen is on #player', false, error.message);
    log.rowNotExercised('S2 the media element is unchanged after fullscreen', error.message);
  }

  if (enteredFullscreen) {
    try {
      await userGestureEvaluate('document.exitFullscreen()');
      const exited = await until(tab, 'document.fullscreenElement?.id ?? null', (id) => id === null);
      await recordIdentity('S2 the media element is unchanged after fullscreen exit', exited);
    } catch (error) {
      row('S2 the media element is unchanged after fullscreen exit', false, error.message);
    }
  } else {
    log.rowNotExercised('S2 the media element is unchanged after fullscreen exit', 'fullscreen was not entered');
  }

  const muteBefore = await read(tab, `document.querySelector('#mute')?.textContent ?? ''`);
  const muteClick = await clickWhenEnabled('#mute');
  let rerender = muteClick;
  if (muteClick.ok) {
    rerender = await until(tab, `(() => {
      const video = document.querySelector('video');
      return { muted: video?.muted ?? null, text: document.querySelector('#mute')?.textContent ?? '' };
    })()`, (value) => value?.text !== muteBefore && value?.text === (value.muted ? 'unmute' : 'mute'));
  }
  if (muteBefore === null) rerender = { ok: false, reason: 'mute control was not readable' };
  await recordIdentity('S2 the media element is unchanged after re-render', rerender);
}

// The positive control replaces the element, so it runs after every other read.
async function runS2c() {
  try {
    await read(tab, `(() => {
      const video = document.querySelector('video');
      video.replaceWith(video.cloneNode(true));
      return true;
    })()`);
    const replaced = await until(tab, identityExpression, (same) => same === false);
    if (replaced.ok) row('S2c the identity read fails for a replaced element', replaced.value === false, replaced.value);
    else log.rowNotExercised('S2c the identity read fails for a replaced element', replaced.reason);
  } catch (error) {
    row('S2c the identity read fails for a replaced element', false, error.message);
  }
}

async function runS3() {
  const status = await until(tab, `(() => {
    const app = window.__app;
    return { actual: document.getElementById('status-line')?.textContent ?? '', expected: app ?
      \`connected (room "\${app.room}", tab "h1", role "host")\` : '' };
  })()`, (value) => value.actual === value.expected && value.actual.startsWith('connected'));
  if (!timeoutRow('S3 #status-line shows the joined status', status)) row('S3 #status-line shows the joined status', true, status.value);

  try {
    const invite = await read(tab, `(() => {
      const app = window.__app;
      return { actual: document.getElementById('invite')?.href ?? null, expected: app ?
        \`${ORIGIN}/room.html?room=\${encodeURIComponent(app.room)}\` : null };
    })()`);
    row('S3 #invite links the room', invite.actual === invite.expected, invite);
  } catch (error) {
    row('S3 #invite links the room', false, error.message);
  }

  const roster = await until(tab, `([...document.querySelectorAll('#roster li')]).map((li) => li.textContent.trim())`, (members) => members.length === 1);
  if (!timeoutRow('S3 #roster lists this tab', roster)) row('S3 #roster lists this tab', /^h1 \u00b7 host \u00b7 \S+$/.test(roster.value[0]), roster.value);

  // A seek in a room with peer exchange holds at its landing, so S2's seeks leave
  // the room paused: press play to reach the playing state this row reads.
  const notPlaying = await read(tab, `window.__app?.playbackState?.()?.playing !== true`);
  const toPlaying = await scheduledTransition('#play', true, { pressed: notPlaying });
  const toPaused = toPlaying.ok ? await scheduledTransition('#pause', false) : toPlaying;
  const followLabel = 'S3 the play and pause buttons follow the playing flag';
  const leadLabel = 'S3 both buttons are disabled inside the scheduled lead';
  if (timeoutRow(followLabel, toPlaying.ok ? toPaused : toPlaying)) {
    log.rowNotExercised(leadLabel, (toPlaying.ok ? toPaused : toPlaying).reason);
  } else {
    const playing = toPlaying.value.settled;
    const paused = toPaused.value.settled;
    const follows = playing.state.playing === true
      && playing.playDisabled === true
      && playing.pauseDisabled === false
      && paused.state.playing === false
      && paused.playDisabled === false
      && paused.pauseDisabled === true;
    row(followLabel, follows, { playing, paused });
    const leads = [toPlaying.value.inLead, toPaused.value.inLead];
    if (leads.some((sample) => sample === null)) {
      log.rowNotExercised(leadLabel, `no sample landed inside the lead: ${JSON.stringify(leads)}`);
    } else {
      row(leadLabel, leads.every((sample) => sample.playDisabled === true && sample.pauseDisabled === true), leads);
    }
  }

  try {
    const mute = await read(tab, `(() => {
      const video = document.querySelector('video');
      return { muted: video?.muted ?? null, text: document.querySelector('#mute')?.textContent ?? '' };
    })()`);
    row('S3 the mute label follows video.muted', mute.text === (mute.muted ? 'unmute' : 'mute'), mute);
  } catch (error) {
    row('S3 the mute label follows video.muted', false, error.message);
  }

  try {
    const mutations = await read(tab, `(() => new Promise((resolve) => {
      const element = document.getElementById('bytes-line');
      if (!element) { resolve(-1); return; }
      let count = 0;
      const observer = new MutationObserver((records) => { count += records.length; });
      observer.observe(element, { childList: true, characterData: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(count); }, 2000);
    }))()`);
    row('S3 #bytes-line is rewritten on every tick', mutations >= 6, mutations);
  } catch (error) {
    row('S3 #bytes-line is rewritten on every tick', false, error.message);
  }

  try {
    const overlays = await read(tab, `['clock-line', 'drift-line', 'bytes-line', 'controller-line'].map((id) => document.getElementById(id)?.textContent.trim() ?? '')`);
    row('S3 the four overlay lines are not empty', overlays.every(Boolean), overlays);
  } catch (error) {
    row('S3 the four overlay lines are not empty', false, error.message);
  }

  const notices = await until(tab, `([...document.querySelectorAll('#notices li')]).map((li) => li.textContent.trim())`, (values) => values.length > 0);
  if (!timeoutRow('S3 the notices are stamped', notices)) row('S3 the notices are stamped', /^\[.+\] /.test(notices.value[0]), notices.value[0]);
}

async function main() {
  try {
    await requireAutoStart(ORIGIN);
    console.log('autoStart: on');
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = 2;
    return;
  }
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: RUN_DIR, createParents: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-shell-'));
  room = `shell-${crypto.randomBytes(6).toString('hex')}`;
  const url = `${ORIGIN}/room.html?room=${room}&role=host&tab=h1`;
  const report = {
    startedAt: STARTED_AT.toISOString(),
    origin: ORIGIN,
    room,
    url,
    chrome: null,
    bundle: null,
    probe: null,
    rows: [],
    failures: [],
  };

  try {
    chrome = spawn(
      CHROME,
      [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1100,700', 'about:blank'],
      { stdio: 'ignore' },
    );
    chromeVersion = (await cdpHttp(PORT, '/json/version')).Browser ?? null;
    report.chrome = chromeVersion;
    console.log(`chrome: ${chromeVersion} · ${CHROME}`);

    tab = await attach(PORT, 'about:blank', { label: 'app-shell' });
    await tab.send('Page.enable');
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD });
    await tab.send('Page.navigate', { url });
    await runS1();
    await runS2();
    await runS3();
    await runS2c();
  } catch (error) {
    log.error(error?.message ?? String(error));
    console.error(`ERROR: ${error?.message ?? error}`);
  } finally {
    if (tab) {
      try { report.probe = await read(tab, snapshotExpression); } catch {}
    }
    report.bundle = bundleIdentity;
    report.rows = log.results;
    report.failures = log.failures();
    report.endedAt = new Date().toISOString();
    report.notExercised = log.notExercised();
    // Exit 0 only when every row passed: a NOT EXERCISED row earns nothing.
    report.outcome = report.failures.length === 0 && report.notExercised.length === 0 ? 'pass' : 'failed';
    fs.writeFileSync(path.join(RUN_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await disposeChrome(chrome, profile);
    console.log(log.summary());
    process.exit(report.outcome === 'pass' ? 0 : 1);
  }
}

await main();
