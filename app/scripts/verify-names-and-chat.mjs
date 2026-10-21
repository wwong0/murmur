// Browser proof for names and chat (change 12d, design.md D7 and D9). It owns one default-paused
// server whose chat allowance refills in a minute, so the rate row does not depend on typing
// speed, and it holds that server's output in memory only: the last row reads it for the run's
// marker and nothing of it is written. Every name and text carries one random marker; the report
// and the console record booleans and counts, never a name, a text or the marker.

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
import { evaluateRow, inOrder, lineIndex, ROW_IDS, STATUS } from './names-and-chat-steps.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const PORT = 8136;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BURST = 5;
const REFILL_MS = 60_000;
const WAIT_MS = 15_000;
const SHORT_MS = 3_000;
const SAMPLE_MS = 100;
const MARK = crypto.randomBytes(4).toString('hex');
const NAMES = { host: `h-${MARK}`, viewer: `v-${MARK}`, renamed: `v2-${MARK}` };
const TEXTS = { hello: `${MARK}-hello`, hi: `${MARK}-hi`, markup: `<b>${MARK}</b>`, word: `${MARK}x`.repeat(40).slice(0, 300) };
const PROMPT = '#name-prompt';
const LINES = "[...document.querySelectorAll('.room-activity p')].map((p) => p.textContent)";
const LABELS = "[...document.querySelectorAll('.participants-list .participant-label')].map((s) => s.textContent)";
const LIST_SHOWN = "(document.querySelector('.participants-list')?.getClientRects().length ?? 0) > 0";
const KEYS = { Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } };

const log = createResultLog({ approvedStems: [] });
const startedAt = new Date();
const runDir = path.join(RESULTS_DIR, `12d-names-and-chat-${startedAt.toISOString().replaceAll(':', '-')}`);
const evidence = {};
const rows = [];
const serverOutput = [];
let server = null;
let serverSettings = null;
let chrome = null;
let chromePort = null;
let chromeVersion = null;
let profile = null;
let browser = null;
let builds = {};
let hostTab = null;
let viewerTab = null;
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

async function watch(tab, expression, windowMs) {
  const samples = [];
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    samples.push(await read(tab, expression));
    await sleep(SAMPLE_MS);
  }
  return samples;
}

// `keyDown` with text is what makes Enter a keypress, so a form submits.
async function pressEnter(tab) {
  const { code, windowsVirtualKeyCode, text } = KEYS.Enter;
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code, windowsVirtualKeyCode, text });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code, windowsVirtualKeyCode });
}

async function selectAll(tab) {
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
}

// A trusted click focuses the field as a person would; the answer says whether the text landed.
async function typeInto(tab, selector, text) {
  await clickElement(tab, selector);
  await selectAll(tab);
  await tab.send('Input.insertText', { text });
  return read(tab, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`);
}

async function startServer() {
  await portFree(PORT).catch((error) => { throw new Error(`port ${PORT} is held: ${error.message}`); });
  const env = { ...process.env };
  delete env.APP_AUTO_START;
  Object.assign(env, { APP_PORT: String(PORT), APP_DELIVERY: 'http', APP_TRACKER_URL: '', APP_CHAT_BURST: String(BURST), APP_CHAT_REFILL_MS: String(REFILL_MS) });
  server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => serverOutput.push(chunk.toString()));
  const up = await poll(async () => {
    try { return (await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
  }, (value) => value || server.exitCode !== null);
  if (!up.ok || server.exitCode !== null) throw new Error('the room server did not start');
  serverSettings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
}

async function launchChrome() {
  chromePort = await unusedPort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'names-and-chat-'));
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

const closeTab = (tab) => browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});

async function answerPrompt(tab, name) {
  const shown = await until(tab, present(PROMPT), Boolean);
  if (!shown.ok) return false;
  if (await typeInto(tab, `${PROMPT} input`, name) !== true) return false;
  await pressEnter(tab);
  return (await until(tab, present(PROMPT), (value) => value === false, SHORT_MS)).ok;
}

async function labelsOf(tab) {
  if (!await read(tab, LIST_SHOWN)) {
    await clickElement(tab, '.participants-trigger');
    await until(tab, LIST_SHOWN, Boolean, SHORT_MS);
  }
  return (await read(tab, LABELS)) ?? [];
}

const marked = (items, needle = MARK) => items.filter((item) => item.includes(needle)).length;
const linesOf = async (tab) => (await read(tab, LINES)) ?? [];

async function bothLists(wanted) {
  return poll(async () => [await labelsOf(hostTab), await labelsOf(viewerTab)], ([a, b]) => wanted(a) && wanted(b));
}

async function send(tab, text) {
  const typed = await typeInto(tab, '#message-input', text);
  await pressEnter(tab);
  return typed === true;
}

async function bothShow(text) {
  const shows = (lines) => lineIndex(lines, text) >= 0;
  return poll(async () => [await linesOf(hostTab), await linesOf(viewerTab)], ([a, b]) => shows(a) && shows(b), SHORT_MS * 2);
}

async function pageBuild(tab) {
  const built = await until(tab, 'window.__app?.buildId ?? null', (value) => typeof value === 'string');
  if (!built.ok) throw new Error('a page did not publish window.__app');
  if (builds.page !== undefined && built.value !== builds.page) throw new Error('a page runs another build than the first');
  return built.value;
}

async function rowFreshness() {
  const probe = await openTab(`${ORIGIN}/room.html?room=nc0-probe&role=host&tab=nc0`, 'NC0');
  try {
    const id = await pageBuild(probe);
    const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: id });
    builds = { page: id, bundle };
    return { bundleMatches: bundle.matches === true, pageIdInServed: bundle.pageIdInServed === true, chromeRecorded: typeof chromeVersion === 'string' };
  } finally {
    await closeTab(probe);
  }
}

async function rowPrompts() {
  hostTab = await openTab(`${ORIGIN}/room.html`, 'host');
  const front = await until(hostTab, present('#host'), Boolean);
  if (!front.ok) throw new Error('the front page did not render');
  await clickElement(hostTab, '#host');
  const hostAnswered = await answerPrompt(hostTab, NAMES.host);
  const invite = await until(hostTab, "document.querySelector('#invite')?.href ?? null", (value) => typeof value === 'string' && value.length > 0);
  if (!invite.ok) throw new Error('the host page showed no invite');
  viewerTab = await openTab(invite.value, 'viewer');
  const viewerAnswered = await answerPrompt(viewerTab, NAMES.viewer);
  await pageBuild(hostTab);
  await pageBuild(viewerTab);
  const lists = await bothLists((labels) => marked(labels) === 2);
  const roster = (await read(hostTab, "[...document.querySelectorAll('#roster li')].map((li) => li.textContent)")) ?? [];
  return {
    hostAnswered,
    viewerAnswered,
    hostListNames: marked(lists.value[0]),
    viewerListNames: marked(lists.value[1]),
    rosterRows: roster.length,
    rosterShaped: roster.filter((text) => /^.+ · (host|viewer) · .+$/.test(text)).length,
    rosterNameHits: marked(roster),
  };
}

async function rowRename() {
  await labelsOf(viewerTab);
  await clickElement(viewerTab, '.participant-self');
  const renameAnswered = await answerPrompt(viewerTab, NAMES.renamed);
  const renamed = (lines) => lines.filter((line) => line.includes(' is now ') && line.includes(NAMES.renamed)).length;
  const seen = await poll(async () => [renamed(await linesOf(hostTab)), renamed(await linesOf(viewerTab))], ([a, b]) => a > 0 && b > 0, SHORT_MS * 2);
  await sleep(500);
  return { renameAnswered, hostRenameLines: renamed(await linesOf(hostTab)), viewerRenameLines: renamed(await linesOf(viewerTab)), settled: seen.ok };
}

async function rowReload() {
  await read(viewerTab, 'window.__ncLoaded = true');
  await viewerTab.send('Page.reload');
  const reloaded = await until(viewerTab, `window.__ncLoaded === undefined && ${present('#message-input')}`, Boolean);
  const samples = reloaded.ok ? await watch(viewerTab, present(PROMPT), SHORT_MS) : [];
  const storagePresent = await read(viewerTab, "sessionStorage.getItem('watchalong.name') !== null");
  const hasName = (labels) => marked(labels, NAMES.renamed) >= 1;
  const lists = await bothLists((labels) => hasName(labels));
  return {
    reloaded: reloaded.ok,
    renamed: evidence.NC2?.renameAnswered === true,
    promptSamplesShown: samples.filter((value) => value === true).length,
    storagePresent: storagePresent === true,
    hostListHasName: hasName(lists.value[0]),
    viewerListHasName: hasName(lists.value[1]),
  };
}

async function rowOrder() {
  const sent = (await send(hostTab, TEXTS.hello)) && (await bothShow(TEXTS.hello)).ok && (await send(viewerTab, TEXTS.hi));
  const shown = await bothShow(TEXTS.hi);
  const [hostLines, viewerLines] = shown.value ?? [[], []];
  return { sent, hostOrdered: inOrder(hostLines, TEXTS.hello, TEXTS.hi), viewerOrdered: inOrder(viewerLines, TEXTS.hello, TEXTS.hi) };
}

const FITS = "(() => { const a = document.querySelector('.room-activity'); return a !== null && a.clientWidth > 0 && a.scrollWidth <= a.clientWidth + 1; })()";
const BOLD = "document.querySelectorAll('.room-activity b').length";

const CHAT_LINES = "document.querySelectorAll('.room-activity .activity-chat').length";

// Arrival is read as one more chat line on both pages, whatever it renders as, so a page that
// turns the markup into an element reads FAIL, not unexercised (post-result, coordinator A).
async function bothGrew(before) {
  const counts = async () => [await read(hostTab, CHAT_LINES), await read(viewerTab, CHAT_LINES)];
  return poll(counts, ([a, b]) => a === before[0] + 1 && b === before[1] + 1, SHORT_MS * 2);
}

async function sendAndArrive(text) {
  const before = [await read(hostTab, CHAT_LINES), await read(viewerTab, CHAT_LINES)];
  if (!before.every(Number.isInteger)) return false;
  return (await send(hostTab, text)) && (await bothGrew(before)).ok;
}

async function rowMarkup() {
  const sent = (await sendAndArrive(TEXTS.markup)) && (await sendAndArrive(TEXTS.word));
  const shown = await bothShow(TEXTS.word);
  const [hostLines, viewerLines] = shown.value ?? [[], []];
  return {
    sent,
    literalOnHost: lineIndex(hostLines, TEXTS.markup) >= 0,
    literalOnViewer: lineIndex(viewerLines, TEXTS.markup) >= 0,
    boldElements: (await read(hostTab, BOLD)) + (await read(viewerTab, BOLD)),
    fitsOnHost: await read(hostTab, FITS) === true,
    fitsOnViewer: await read(viewerTab, FITS) === true,
  };
}

const WARNED = "[...document.querySelectorAll('.room-activity p')].filter((p) => p.textContent.includes('sending too fast')).length";
const INPUT = "(() => { const field = document.querySelector('#message-input'); return { value: field?.value ?? null }; })()";

async function rowRate() {
  let sends = 0;
  let lastText = null;
  let warned = 0;
  while (warned === 0 && sends < BURST + 2) {
    lastText = `${MARK}-r${sends + 1}`;
    if (!await send(viewerTab, lastText)) break;
    sends += 1;
    const settled = await until(viewerTab, `({ warned: ${WARNED}, empty: ${INPUT}.value === '' })`, (value) => value !== null && (value.warned > 0 || value.empty), SHORT_MS);
    if (!settled.ok) break;
    warned = settled.value.warned;
  }
  await sleep(500);
  const hostLines = await linesOf(hostTab);
  return {
    sends,
    burst: BURST,
    warnedViewer: (await read(viewerTab, WARNED)) ?? 0,
    warnedHost: (await read(hostTab, WARNED)) ?? 0,
    inputHolds: lastText !== null && (await read(viewerTab, INPUT))?.value === lastText,
    hostHasRefused: lastText === null || lineIndex(hostLines, lastText) >= 0,
  };
}

const HITS = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((li) => li.textContent.includes(${JSON.stringify(MARK)})).length`;

async function rowNothingElsewhere() {
  const output = serverOutput.join('').split('\n').filter((line) => line.trim() !== '');
  const both = async (selector) => (await read(hostTab, HITS(selector))) + (await read(viewerTab, HITS(selector)));
  return {
    noticeHits: await both('#notices li'),
    rosterHits: await both('#roster li'),
    serverHits: output.filter((line) => line.includes(MARK)).length,
    serverLines: output.length,
  };
}

const ROW_BODIES = {
  NC0: rowFreshness, NC1: rowPrompts, NC2: rowRename, NC3: rowReload, NC4: rowOrder, NC5: rowMarkup, NC6: rowRate, NC7: rowNothingElsewhere,
};

async function runRows() {
  for (const id of ROW_IDS) {
    let collected;
    try { collected = await ROW_BODIES[id](); } catch { collected = undefined; }
    evidence[id] = collected;
    const { label, status } = evaluateRow(id, collected);
    const detail = JSON.stringify(collected ?? null);
    if (status === STATUS.NOT_EXERCISED) log.rowNotExercised(label, detail);
    else log.expect(label, status === STATUS.PASS, status === STATUS.PASS ? detail : `${status} ${detail}`);
    rows.push({ id, label, status, evidence: collected ?? null });
  }
}

async function main() {
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  await startServer();
  await launchChrome();
  console.log(`chrome: ${chromeVersion} · ${CHROME}`);
  await runRows();
  console.log(log.summary());
  if (rows.some((row) => row.status !== STATUS.PASS)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  runnerFailure = error?.message ?? String(error);
  console.error(`runner failure: ${runnerFailure}`);
  process.exitCode = 2;
} finally {
  for (const tab of [hostTab, viewerTab]) if (tab) await closeTab(tab);
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
