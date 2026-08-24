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

import { WebSocket } from 'ws';

export const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
