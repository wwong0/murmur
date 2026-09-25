// Browser verification of the Request, range, stream and cancellation paths
// used by p2p-media-loader's HTTP loader.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, CHROME, disposeChrome, FLAGS, sleep } from './cdp.mjs';
import { assertServedBundle, createManifestFile, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { requireDelivery } from './delivery-pin.mjs';
import { FETCH_SHIM_BARS, evaluateFetchShim } from './figures/fetch-shim-bars.mjs';

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== '--qualify-red')) throw new Error('usage: node scripts/verify-fetch-shim.mjs [--qualify-red]');
const QUALIFY_RED = args.has('--qualify-red');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const SERVER_PORT = 8125;
const POLL_MS = 100;
const LINK_DEADLINE_MS = 60_000;
const PENDING_DEADLINE_MS = 2_000;
const RECEIPT_DEADLINE_MS = 2_000;
const RANGE_START = 100_000;
const SEGMENT_NAME = 'seg-00010.m4s';
const MEDIA_DIR = path.resolve(APP_DIR, process.env.APP_MEDIA_DIR ?? '../step0/content');
const SEGMENT_PATH = path.join(MEDIA_DIR, SEGMENT_NAME);
const STARTED_AT = new Date();
const ROOM = `7b-fetch-shim-${crypto.randomBytes(8).toString('hex')}`;
const RUN_NAME = `7b-fetch-shim-${STARTED_AT.toISOString().replaceAll(':', '-')}`;
const RUN_DIR = path.join(RESULTS_DIR, RUN_NAME);

const CASE_TABLE = Object.freeze([
  { key: 'a', operation: 'array-buffer', range: null },
  { key: 'b', operation: 'array-buffer', range: `bytes=${RANGE_START}-` },
  { key: 'c', operation: 'array-buffer', range: 'bytes=100-199' },
  { key: 'd', operation: 'stream' },
  { key: 'e', operation: 'abort-read' },
  { key: 'f', operation: 'reader-cancel' },
  { key: 'g', operation: 'abort-before-headers' },
]);
const CASES = CASE_TABLE.map((entry) => entry.key === 'b' && QUALIFY_RED
  ? { ...entry, range: `bytes=${RANGE_START}-${RANGE_START}` }
  : { ...entry });

const manifestBars = () => FETCH_SHIM_BARS.map((bar) => ({
  key: bar.key,
  case: bar.case,
  read: bar.read,
  pass: false,
  observed: null,
}));

prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: RUN_DIR, createParents: true });
const manifestFile = createManifestFile({
  runDir: RUN_DIR,
  initial: {
    schemaVersion: 1,
    runner: 'verify-fetch-shim',
    room: ROOM,
    startedAt: STARTED_AT.toISOString(),
    runDirectory: path.relative(RESULTS_DIR, RUN_DIR).split(path.sep).join('/'),
    qualification: {
      requested: QUALIFY_RED,
      case: QUALIFY_RED ? 'b' : null,
      range: QUALIFY_RED ? CASES.find((entry) => entry.key === 'b').range : null,
    },
    server: { port: SERVER_PORT, delivery: 'host', tracker: null },
    bars: manifestBars(),
    cases: {},
    failures: [],
  },
});
manifestFile.write();

const manifest = manifestFile.get();
const failures = [];
const children = [];
const tabs = [];
let server = null;

function recordFailure(error) {
  const text = error?.stack ?? error?.message ?? String(error);
  manifest.failures.push(text);
  console.error(`ERROR: ${error?.message ?? error}`);
  manifestFile.write();
}

async function startServer(origin) {
  try {
    await portFree(SERVER_PORT);
  } catch (error) {
    throw new Error(`refusing to run: port ${SERVER_PORT} is held (${error?.message ?? error})`);
  }
  const env = {
    ...process.env,
    APP_PORT: String(SERVER_PORT),
    APP_DELIVERY: 'host',
    APP_ICE_SERVERS: '[]',
    APP_MEDIA_DIR: MEDIA_DIR,
  };
  delete env.APP_TRACKER_URL;
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  child.on('error', (error) => stderr.push(`${error.stack ?? error}\n`));
  server = {
    child,
    output: () => fs.writeFileSync(path.join(RUN_DIR, 'server.log'), `${stdout.join('')}\n${stderr.join('')}`),
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`room server exited before ready: ${stdout.join('')}\n${stderr.join('')}`);
    try {
      const response = await fetch(`${origin}/room.html`, { cache: 'no-store' });
      if (response.ok) return server;
    } catch {}
    await sleep(100);
  }
  throw new Error(`room server did not become ready: ${stdout.join('')}\n${stderr.join('')}`);
}

const SEAM = `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  return {
    present: true,
    buildId: app.buildId,
    delivery: app.delivery(),
    hostLink: app.hostLink(),
    hostReceipts: app.hostReceipts(),
  };
})()`;

async function launchPage(label, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `app-fetch-shim-${label.toLowerCase()}-`));
  const cdpPort = await unusedPort();
  const child = spawn(CHROME, [
    ...FLAGS,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1100,700',
    'about:blank',
  ], { stdio: 'ignore' });
  children.push(child);
  try {
    const tab = await attach(cdpPort, 'about:blank', { label });
    await tab.send('Page.navigate', { url });
    const page = { label, child, profile, cdpPort, tab, url };
    tabs.push(page);
    return page;
  } catch (error) {
    await disposeChrome(child, profile);
    throw error;
  }
}

async function snapshot(page) {
  try { return await page.tab.evaluate(SEAM); } catch (error) { return { present: false, error: error?.message ?? String(error) }; }
}

async function waitFor(page, read, done, timeoutMs, everyMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(everyMs);
    value = await read();
  }
  return { value, ok: Boolean(done(value)) };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseContentRange(value) {
  if (!value) return null;
  const match = /^bytes (?:(?:(\d+)|)-(?:(\d+)|)|\*)\/(?:(\d+)|\*)$/.exec(value.trim());
  if (!match) return { raw: value, from: null, to: null, total: null };
  const [, from, to, total] = match;
  return { raw: value, from: from ? Number(from) : null, to: to ? Number(to) : null, total: total ? Number(total) : '*' };
}

const BROWSER_CASE = async (spec) => {
  const app = window.__app;
  const parseRange = (value) => {
    if (!value) return null;
    const match = /^bytes (?:(?:(\d+)|)-(?:(\d+)|)|\*)\/(?:(\d+)|\*)$/.exec(value.trim());
    if (!match) return { raw: value, from: null, to: null, total: null };
    const [, from, to, total] = match;
    return { raw: value, from: from ? Number(from) : null, to: to ? Number(to) : null, total: total ? Number(total) : '*' };
  };
  const beforeLink = app.hostLink();
  const beforeReceipts = app.hostReceipts() ?? { latestSeq: 0, records: [] };
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const headers = new Headers();
  if (spec.range) headers.set('Range', spec.range);
  const request = new Request(spec.absUrl, { headers, signal: controller.signal });
  const base = {
    key: spec.key,
    request: { input: 'Request', range: spec.range },
    status: null,
    headers: { contentLength: null, contentRange: null },
    bodyBytes: 0,
    chunkCount: 0,
    bodyHash: null,
    hashMatches: false,
    settlement: { kind: null, errorName: null },
    receipt: null,
    pendingBefore: beforeLink?.requests ?? null,
    pendingAfter: null,
    pendingCleared: false,
    requestsUnchanged: false,
    startedAtMs,
    endedAtMs: null,
  };

  const digest = async (bytes) => {
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const responseShape = (response) => {
    base.status = response.status;
    base.headers.contentLength = response.headers.get('Content-Length');
    base.headers.contentRange = parseRange(response.headers.get('Content-Range'));
  };
  // Per path, not hostLink().requests: that count includes the page's own
  // player traffic, which settled during case g in the qualification run.
  const sentBefore = beforeLink?.requestsByPath?.[spec.path] ?? 0;
  const pathState = () => {
    const sent = (app.hostLink()?.requestsByPath?.[spec.path] ?? 0) - sentBefore;
    const settled = (app.hostReceipts(beforeReceipts.latestSeq)?.records ?? []).filter((entry) => entry.url === spec.path).length;
    return { sent, settled, pending: sent - settled };
  };
  const settlePending = async () => {
    const deadline = Date.now() + spec.pendingDeadlineMs;
    let path = pathState();
    while (Date.now() < deadline && path.pending !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      path = pathState();
    }
    base.pendingAfter = app.hostLink()?.requests ?? null;
    base.path = path;
    base.pendingCleared = path.pending === 0;
    base.requestsUnchanged = path.sent === 0;
  };
  const receiptFor = async () => {
    const deadline = Date.now() + spec.receiptDeadlineMs;
    let result = app.hostReceipts(beforeReceipts.latestSeq);
    while (Date.now() < deadline) {
      const record = result?.records?.filter((entry) => entry.url === spec.path && entry.startMs >= startedAtMs).at(-1);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = app.hostReceipts(beforeReceipts.latestSeq);
    }
    return result?.records?.filter((entry) => entry.url === spec.path && entry.startMs >= startedAtMs).at(-1) ?? null;
  };
  const finish = async () => {
    base.receipt = await receiptFor();
    await settlePending();
    base.endedAtMs = Date.now();
    return base;
  };

  if (spec.key === 'g') {
    controller.abort();
    try {
      await window.fetch(request);
      base.settlement = { kind: 'fetch-resolved', errorName: null };
    } catch (error) {
      base.settlement = { kind: 'fetch-rejected', errorName: error?.name ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return finish();
  }

  let response;
  try {
    response = await window.fetch(request);
    responseShape(response);
    if (spec.key === 'a' || spec.key === 'b' || spec.key === 'c') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      base.bodyBytes = bytes.byteLength;
      base.chunkCount = bytes.byteLength > 0 ? 1 : 0;
      base.bodyHash = await digest(bytes);
      base.hashMatches = base.bodyHash === spec.expectedHash;
      base.settlement = { kind: 'complete', errorName: null };
    } else if (spec.key === 'd') {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('streamed case response has no reader');
      const chunks = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        base.bodyBytes += next.value.byteLength;
      }
      const bytes = new Uint8Array(base.bodyBytes);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      base.chunkCount = chunks.length;
      base.bodyHash = await digest(bytes);
      base.hashMatches = base.bodyHash === spec.expectedHash;
      base.settlement = { kind: 'complete', errorName: null };
    } else if (spec.key === 'e') {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('abort case response has no reader');
      const first = await reader.read();
      if (!first.done) { base.bodyBytes = first.value.byteLength; base.chunkCount = 1; }
      controller.abort();
      try {
        await reader.read();
        base.settlement = { kind: 'abort-read-resolved', errorName: null };
      } catch (error) {
        base.settlement = { kind: 'abort-read-rejected', errorName: error?.name ?? null };
      }
    } else if (spec.key === 'f') {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('cancel case response has no reader');
      const first = await reader.read();
      if (!first.done) { base.bodyBytes = first.value.byteLength; base.chunkCount = 1; }
      try {
        await reader.cancel();
        base.settlement = { kind: 'cancel-resolved', errorName: null };
      } catch (error) {
        base.settlement = { kind: 'cancel-rejected', errorName: error?.name ?? null };
      }
    }
  } catch (error) {
    base.settlement = { kind: 'fetch-rejected', errorName: error?.name ?? null };
  }
  return finish();
};

async function runCase(page, entry, context) {
  const result = await page.tab.evaluate(`(${BROWSER_CASE.toString()})(${JSON.stringify({ ...entry, ...context })})`);
  if (!result || result.key !== entry.key) throw new Error(`case ${entry.key} returned no observation`);
  manifest.cases[entry.key] = result;
  manifestFile.write();
  return result;
}

async function main() {
  if (!fs.existsSync(SEGMENT_PATH)) throw new Error(`known-size segment is missing: ${SEGMENT_PATH}`);
  const bytes = fs.readFileSync(SEGMENT_PATH);
  const length = bytes.byteLength;
  if (length <= 256 * 1024) throw new Error(`known-size segment must exceed 256 KiB, got ${length}`);
  const expected = {
    length,
    openRange: { start: RANGE_START, end: length - 1, length: length - RANGE_START },
  };
  const hashes = {
    whole: sha256(bytes),
    openRange: sha256(bytes.subarray(RANGE_START)),
    closedRange: sha256(bytes.subarray(100, 200)),
  };
  manifest.media = { path: SEGMENT_PATH, name: SEGMENT_NAME, length, sha256: hashes.whole };
  manifest.config = {
    origin: `http://127.0.0.1:${SERVER_PORT}`,
    linkDeadlineMs: LINK_DEADLINE_MS,
    pendingDeadlineMs: PENDING_DEADLINE_MS,
    receiptDeadlineMs: RECEIPT_DEADLINE_MS,
    rangeStart: RANGE_START,
    caseTable: CASES,
  };
  const origin = manifest.config.origin;
  await startServer(origin);
  const settings = await requireDelivery(origin, 'host');
  manifest.settings = settings;

  const hostPage = await launchPage('host', `${origin}/room.html?room=${ROOM}&role=host&tab=host`);
  const viewerPage = await launchPage('viewer', `${origin}/room.html?room=${ROOM}&role=viewer&tab=viewer`);
  const host = await waitFor(hostPage, () => snapshot(hostPage), (value) => value?.present === true, 20_000);
  const viewer = await waitFor(viewerPage, () => snapshot(viewerPage), (value) => value?.present === true, 20_000);
  manifest.pages = { host: host.value, viewer: viewer.value };
  const bundle = await assertServedBundle({ origin, bundlePath: BUNDLE_PATH, pageBuildId: host.value.buildId });
  manifest.build = { ...bundle, pageBuildId: host.value.buildId };
  if (!bundle.matches || !bundle.pageIdInServed) throw new Error('served bundle does not match the on-disk build');
  const opened = await waitFor(viewerPage, () => snapshot(viewerPage), (value) => value?.hostLink?.state === 'open', LINK_DEADLINE_MS);
  manifest.link = opened.value;
  if (!opened.ok) throw new Error(`viewer host link did not open within ${LINK_DEADLINE_MS}ms`);

  for (const entry of CASES) {
    const expectedHash = entry.key === 'a' || entry.key === 'd' || entry.key === 'e' || entry.key === 'f'
      ? hashes.whole
      : entry.key === 'b' ? hashes.openRange : hashes.closedRange;
    await runCase(viewerPage, entry, {
      absUrl: `${origin}/media/${SEGMENT_NAME}`,
      path: `/media/${SEGMENT_NAME}`,
      expectedHash,
      pendingDeadlineMs: PENDING_DEADLINE_MS,
      receiptDeadlineMs: RECEIPT_DEADLINE_MS,
    });
  }

  const result = evaluateFetchShim(manifest.cases, {
    length,
    openRange: expected.openRange,
  });
  manifest.bars = result.bars;
  manifest.outcome = result.pass ? 'pass' : 'failed';
  manifestFile.write();
  for (const bar of result.bars) console.log(`${bar.pass ? 'PASS' : 'FAIL'}  ${bar.key} (${bar.read})`);
  if (!result.pass) {
    const failedBars = result.bars.filter((bar) => !bar.pass).map((bar) => bar.key);
    throw new Error(`fetch shim bars failed: ${failedBars.join(', ')}`);
  }
}

try {
  await main();
} catch (error) {
  recordFailure(error);
  failures.push(error?.message ?? String(error));
} finally {
  manifest.endedAt = new Date().toISOString();
  manifest.outcome = failures.length === 0 && manifest.failures.length === 0 ? 'pass' : 'failed';
  manifest.status = manifest.outcome === 'pass' ? 'complete' : 'aborted';
  manifest.failures.push(...failures.filter((failure) => !manifest.failures.includes(failure)));
  manifestFile.write();
  for (const page of tabs.reverse()) {
    try { await disposeChrome(page.child, page.profile); } catch (error) { manifest.failures.push(`Chrome cleanup ${page.label}: ${error?.message ?? error}`); }
  }
  for (const child of children.reverse()) {
    if (child === server?.child) await stopChild(child);
  }
  server?.output();
  manifestFile.write();
  console.log(`\n${manifest.outcome === 'pass' ? 'ALL PASS' : `${failures.length || manifest.failures.length} FAILURE(S)`}`);
  console.log(`evidence: ${RUN_DIR}`);
  process.exitCode = manifest.outcome === 'pass' ? 0 : 1;
}
