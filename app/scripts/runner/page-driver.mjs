// scripts/runner/page-driver.mjs
//
// The skeleton FP and PK share: one default-paused room server, one Chrome, tabs
// opened over the browser target, rows that read PASS, FAIL or NOT EXERCISED, and a report of
// booleans, counts and positions. RD and NC carry their own copies of the same shape; this is
// the first one written once.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { cdpHttp, CHROME, disposeChrome, FLAGS, rewriteWebSocketDebuggerUrl, sleep, Tab } from '../cdp.mjs';
import { createResultLog } from '../browser-result-log.mjs';
import { assertServedBundle, prepareRunDirectory } from './core.mjs';
import { portFree, stopChild, unusedPort } from './local-processes.mjs';

export const WAIT_MS = 15_000;
export const SHORT_MS = 3_000;
const SAMPLE_MS = 100;

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

export async function read(tab, expression) {
  try { return await tab.evaluate(expression); } catch { return null; }
}

export const present = (selector) => `document.querySelector(${JSON.stringify(selector)}) !== null`;

export async function poll(readValue, done, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!done(value) && Date.now() < deadline) {
    await sleep(SAMPLE_MS);
    value = await readValue();
  }
  return { ok: done(value), value };
}

export const until = (tab, expression, done, timeoutMs) => poll(() => read(tab, expression), done, timeoutMs);

export async function watch(tab, expression, windowMs) {
  const samples = [];
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    samples.push(await read(tab, expression));
    await sleep(SAMPLE_MS);
  }
  return samples;
}

const detailText = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

/**
 * `runStem` names the results directory; `port` is the driver's own server. Every other
 * process setting is the default room: paused, `http` delivery, the `dir` media source.
 */
export function createPageDriver({ appDir, runStem, port }) {
  const origin = `http://127.0.0.1:${port}`;
  const resultsDir = path.join(appDir, 'results');
  const bundlePath = path.join(appDir, 'public', 'room.bundle.js');
  const startedAt = new Date();
  const runDir = path.join(resultsDir, `${runStem}-${startedAt.toISOString().replaceAll(':', '-')}`);
  const log = createResultLog({ approvedStems: [] });
  const rows = [];
  const tabs = new Set();
  const state = { server: null, serverSettings: null, chrome: null, chromePort: null, chromeVersion: null, profile: null, browser: null, builds: {} };

  async function startServer() {
    await portFree(port).catch((error) => { throw new Error(`port ${port} is held: ${error.message}`); });
    const env = { ...process.env };
    delete env.APP_AUTO_START;
    delete env.APP_MEDIA_SOURCE;
    Object.assign(env, { APP_PORT: String(port), APP_DELIVERY: 'http', APP_TRACKER_URL: '' });
    state.server = spawn(process.execPath, [path.join(appDir, 'server', 'room-server.mjs')], { cwd: appDir, env, stdio: 'ignore' });
    const up = await poll(async () => {
      try { return (await fetch(`${origin}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
    }, (value) => value || state.server.exitCode !== null);
    if (!up.ok || state.server.exitCode !== null) throw new Error('the room server did not start');
    state.serverSettings = await (await fetch(`${origin}/app-settings`, { cache: 'no-store' })).json();
    if (state.serverSettings.autoStart !== false) throw new Error(`the server reports autoStart ${JSON.stringify(state.serverSettings.autoStart)}`);
  }

  async function launchChrome() {
    state.chromePort = await unusedPort();
    state.profile = fs.mkdtempSync(path.join(os.tmpdir(), `${runStem}-`));
    state.chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${state.chromePort}`, `--user-data-dir=${state.profile}`, '--window-size=1100,700', 'about:blank'], { stdio: 'ignore' });
    const version = await cdpHttp(state.chromePort, '/json/version');
    state.chromeVersion = version.Browser ?? null;
    state.browser = new BrowserConnection(version.webSocketDebuggerUrl);
  }

  async function openTab(url, label, { beforeNavigate = null } = {}) {
    const { targetId } = await state.browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1100, height: 700 });
    const found = await poll(async () => (await cdpHttp(state.chromePort, '/json/list')).find((target) => target.id === targetId && target.webSocketDebuggerUrl), Boolean, 20_000);
    if (!found.value) throw new Error(`${label} target did not appear`);
    const tab = new Tab({ ...found.value, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(found.value, state.chromePort) }, { label });
    await tab.ready;
    await tab.send('Runtime.enable');
    await tab.send('Page.enable');
    if (beforeNavigate) await beforeNavigate(tab);
    await tab.send('Page.navigate', { url });
    tabs.add(tab);
    return tab;
  }

  async function closeTab(tab) {
    tabs.delete(tab);
    await state.browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }

  async function withTab(url, label, body, options) {
    const tab = await openTab(url, label, options);
    try { return await body(tab); } finally { await closeTab(tab); }
  }

  /** The page's build against the bundle on disk and the one served; a mismatch ends the run. */
  async function freshness(tab) {
    const built = await until(tab, 'window.__app?.buildId ?? null', (value) => typeof value === 'string');
    if (!built.ok) throw new Error('a page did not publish window.__app');
    if (state.builds.page !== undefined) {
      if (built.value !== state.builds.page) throw new Error(`a page runs build ${built.value}, not ${state.builds.page}`);
      return state.builds;
    }
    const bundle = await assertServedBundle({ origin, bundlePath, pageBuildId: built.value });
    state.builds = { page: built.value, bundle };
    return state.builds;
  }

  async function runRow(label, body) {
    let row;
    try {
      const result = await body();
      if (!result?.exercised) {
        row = { label, status: 'not-exercised', detail: result?.detail ?? 'precondition did not happen' };
        log.rowNotExercised(label, detailText(row.detail));
      } else {
        row = { label, status: result.ok ? 'pass' : 'fail', detail: result.detail ?? null };
        log.expect(label, result.ok, result.detail === undefined ? undefined : detailText(result.detail));
      }
    } catch (error) {
      row = { label, status: 'fail', detail: { error: error?.message ?? String(error) } };
      log.expect(label, false, row.detail.error);
    }
    rows.push(row);
  }

  async function run(rowsBody) {
    let runnerFailure = null;
    let cleanupFailure = null;
    try {
      prepareRunDirectory({ appDir, resultsDir, runDir });
      await startServer();
      await launchChrome();
      console.log(`chrome: ${state.chromeVersion} · ${CHROME}`);
      await rowsBody();
      console.log(`build: ${state.builds.page ?? 'none'}`);
      console.log(log.summary());
      if (rows.some((row) => row.status !== 'pass')) process.exitCode = 1;
    } catch (error) {
      runnerFailure = error?.stack ?? error?.message ?? String(error);
      console.error(`runner failure: ${error?.message ?? error}`);
      process.exitCode = 2;
    } finally {
      for (const tab of [...tabs]) await closeTab(tab);
      if (state.browser) state.browser.close();
      if (state.chrome) {
        try { await disposeChrome(state.chrome, state.profile); } catch (error) { cleanupFailure = error?.message ?? String(error); }
      }
      if (state.server) {
        try { await stopChild(state.server); } catch (error) { cleanupFailure ??= error?.message ?? String(error); }
      }
      try {
        fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({
          startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), chrome: { version: state.chromeVersion, path: CHROME },
          builds: state.builds, server: state.serverSettings, rows, runnerFailure, cleanupFailure,
        }, null, 2)}\n`);
      } catch (error) {
        if (!runnerFailure) { console.error(`runner failure: ${error?.message ?? error}`); process.exitCode = 2; }
      }
    }
  }

  return { origin, state, openTab, closeTab, withTab, freshness, runRow, run };
}
