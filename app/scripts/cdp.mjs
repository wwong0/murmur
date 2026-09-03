// scripts/cdp.mjs
//
// Driving Chrome over CDP: the flag set, the HTTP endpoint, one tab, and
// finding a page target. Shared by the two dev aids that need a real browser —
// verify-browser.mjs and verify-frames.mjs — because they had a copy each and
// the copies had already begun to differ.
//
// TEST MACHINERY. Nothing in the product imports this, and it is not part of
// `npm run check`: it needs Chrome and a running server, which is the whole
// reason the protocol check exists next to it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { WebSocket } from 'ws';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

/**
 * End THIS RUN'S Chrome AND NOTHING ELSE, then take its profile directory with
 * it. Never widen either kill to `/IM chrome.exe`: that ends every Chrome on the
 * machine, the developer's own windows included, mid-run and with no warning.
 *
 * Two scopes, both narrow. The tree rooted at the process we spawned is the run
 * — the extra `--new-window` launches hand their window to that same browser
 * process and exit, so `/T` reaches them. The profile sweep is the backstop for a
 * browser that outlived its launcher, and it can only ever match this run because
 * the `--user-data-dir` is a throwaway directory made for it.
 *
 * The wait belongs here: a Chrome still holding files in the profile is what
 * makes the removal fail, so whoever ends the browser owns the settling time. A
 * profile that will not delete is not worth failing a dev aid over.
 *
 * Windows-only, like `CHROME` above.
 */
export async function disposeChrome(child, profile) {
  if (child && child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: 'ignore' }
  );
  await sleep(1500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

/**
 * Autoplay without a gesture, and every throttle Chrome applies to a window it
 * thinks nobody is looking at. A measurement taken through a throttled
 * compositor is a measurement of the throttle (step0's flag set, carried).
 */
export const FLAGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--no-first-run',
  '--no-default-browser-check',
];

/** The CDP HTTP endpoint, retried until Chrome is up. `/json/close` answers in plain text. */
export async function cdpHttp(port, pathname) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`CDP not reachable at ${pathname}`);
}

/**
 * One page target. Give it a `label` to forward that page's console and
 * exceptions to this one's — CLAUDE.md records that every defect in the
 * host-origin spike was found that way. Without a label it stays quiet.
 */
export class Tab {
  constructor(target, { label = null } = {}) {
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.targetId = target.id;
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    this.ready = new Promise((resolve) => this.ws.once('open', resolve));
    this.ws.on('error', () => {});
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg.result);
        return;
      }
      if (!label) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type))).join(' ');
        console.log(`  [${label}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log(`  [${label}] EXCEPTION ${msg.params.exceptionDetails.text}`);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${this.label ?? 'tab'}: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
}

/**
 * Wait for the page target serving `url` and connect to it.
 *
 * `exclude` is the set of target ids that were already open — pass it when the
 * window is about to be spawned, so an existing page at the same url cannot be
 * mistaken for the new one. OMIT IT when Chrome was launched with the url:
 * that target already exists, and excluding it finds nothing, forever.
 */
export async function attach(port, url, { label = null, exclude = null } = {}) {
  for (let i = 0; i < 80; i++) {
    const list = await cdpHttp(port, '/json/list');
    const found = list.find((t) => t.type === 'page' && !exclude?.has(t.id) && t.url.startsWith(url.split('?')[0]));
    if (found && found.webSocketDebuggerUrl) {
      const tab = new Tab(found, { label });
      await tab.ready;
      await tab.send('Runtime.enable');
      return tab;
    }
    await sleep(250);
  }
  throw new Error(`window for ${label ?? url} never appeared`);
}
