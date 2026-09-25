import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { attach, CHROME, disposeChrome, FLAGS, sleep } from './cdp.mjs';
import { assertServedBundle, createManifestFile, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { requireDelivery } from './delivery-pin.mjs';
import { PEER_EXCHANGE_BARS, evaluatePeerExchange } from './figures/peer-exchange-bars.mjs';
import { PEER_PAGE_READING } from './peer-exchange-probe.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const SERVER_PORT = 8126;
const TRACKER_PORT = 8127;
const TRACKER_URL = `ws://127.0.0.1:${TRACKER_PORT}`;
const TRACKER_SCRIPT = path.join(APP_DIR, 'node_modules', 'bittorrent-tracker', 'bin', 'cmd.js');
const STARTED_AT = new Date();
const RUN_NAME = `7b-peer-exchange-${STARTED_AT.toISOString().replaceAll(':', '-')}`;
const RUN_DIR = path.join(RESULTS_DIR, RUN_NAME);
const LINK_DEADLINE_MS = 60_000;
const SHARING_DEADLINE_MS = 90_000;
const HEAD_START_MS = 20_000;
const RUN_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 1_000;
const ROOM_SUFFIX = crypto.randomBytes(8).toString('hex');

const coreModulePath = pathToFileURL(path.join(APP_DIR, 'node_modules', 'p2p-media-loader-core', 'lib', 'core.js')).href;
const { Core } = await import(coreModulePath);

const roomsToRun = [
  { key: 'a', roomId: `7b-iso-a-${ROOM_SUFFIX}` },
  { key: 'b', roomId: `7b-iso-b-${ROOM_SUFFIX}` },
];
const bars = () => PEER_EXCHANGE_BARS.map(({ key, read }) => ({ key, read, pass: false, status: 'not evaluated', observed: null }));

prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: RUN_DIR, createParents: true });
const manifestFile = createManifestFile({
  runDir: RUN_DIR,
  initial: {
    schemaVersion: 1,
    runner: 'verify-peer-exchange',
    startedAt: STARTED_AT.toISOString(),
    runDirectory: path.relative(RESULTS_DIR, RUN_DIR).split(path.sep).join('/'),
    server: { port: SERVER_PORT, delivery: 'host', tracker: { port: TRACKER_PORT, url: TRACKER_URL } },
    rooms: roomsToRun.map((room) => room.roomId),
    bars: bars(),
    readings: null,
    failures: [],
  },
});
manifestFile.write();

const manifest = manifestFile.get();
const failures = [];
const children = [];
const tabs = [];
const pages = [];
let server = null;
let tracker = null;
let evaluated = false;

function recordFailure(error) {
  const text = error?.stack ?? error?.message ?? String(error);
  manifest.failures.push(text);
  console.error(`ERROR: ${error?.message ?? error}`);
  manifestFile.write();
}

async function waitForPort(port, child, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before port ${port} opened`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`${label} did not open port ${port}`);
}

function captureOutput(child, name) {
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  child.on('error', (error) => stderr.push(`${error.stack ?? error}\n`));
  return () => fs.writeFileSync(path.join(RUN_DIR, name), `${stdout.join('')}\n${stderr.join('')}`);
}

async function startTracker() {
  try { await portFree(TRACKER_PORT); } catch (error) { throw new Error(`refusing to run: tracker port ${TRACKER_PORT} is held (${error?.message ?? error})`); }
  tracker = spawn(process.execPath, [
    TRACKER_SCRIPT,
    '--ws',
    '--port', String(TRACKER_PORT),
    '--http-hostname', '127.0.0.1',
    '--quiet',
  ], { cwd: APP_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(tracker);
  tracker.output = captureOutput(tracker, 'tracker.log');
  await waitForPort(TRACKER_PORT, tracker, 'tracker');
}

async function startServer(origin) {
  try { await portFree(SERVER_PORT); } catch (error) { throw new Error(`refusing to run: server port ${SERVER_PORT} is held (${error?.message ?? error})`); }
  const env = {
    ...process.env,
    APP_PORT: String(SERVER_PORT),
    APP_DELIVERY: 'host',
    APP_TRACKER_URL: TRACKER_URL,
    APP_ICE_SERVERS: '[]',
  };
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  server = { child, output: captureOutput(child, 'server.log') };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('room server exited before readiness');
    try {
      const response = await fetch(`${origin}/room.html`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('room server did not become ready');
}

async function launchPage(label, roomId, role) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `app-peer-exchange-${label.toLowerCase().replaceAll('/', '-')}-`));
  const cdpPort = await unusedPort();
  const child = spawn(CHROME, [...FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1100,700', 'about:blank'], { stdio: 'ignore' });
  children.push(child);
  try {
    const tab = await attach(cdpPort, 'about:blank', { label });
    const url = `http://127.0.0.1:${SERVER_PORT}/room.html?room=${roomId}&role=${role}&tab=${label.replaceAll('/', '-')}`;
    await tab.send('Page.navigate', { url });
    const page = { label, role, roomId, child, profile, cdpPort, tab, url };
    tabs.push(page);
    pages.push(page);
    return page;
  } catch (error) {
    await disposeChrome(child, profile);
    throw error;
  }
}

async function snapshot(page) {
  try { return await page.tab.evaluate(PEER_PAGE_READING); } catch (error) { return { present: false, error: error?.message ?? String(error) }; }
}

async function waitFor(label, read, done, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) throw new Error(`${label} not reached before ${timeoutMs}ms`);
    await sleep(Math.min(everyMs, Math.max(1, deadline - Date.now())));
    value = await read();
  }
  return value;
}

async function waitPresent(page) {
  return waitFor(`${page.label} seam`, () => snapshot(page), (value) => value?.present === true, LINK_DEADLINE_MS);
}

async function waitPlaying(page) {
  const first = await waitFor(`${page.label} playing`, () => snapshot(page), (value) => value?.playback?.playing === true, LINK_DEADLINE_MS);
  const startedAt = first.currentTime;
  await sleep(2_000);
  const second = await snapshot(page);
  if (!(Number.isFinite(startedAt) && Number.isFinite(second.currentTime) && (second.currentTime - startedAt) * 1000 >= 2_000)) {
    throw new Error(`${page.label} did not advance at least 2s while playing`);
  }
  return second;
}

async function runRoom(room) {
  const host = await launchPage(`${room.key}/host`, room.roomId, 'host');
  const v1 = await launchPage(`${room.key}/v1`, room.roomId, 'viewer');
  await Promise.all([waitPresent(host), waitPlaying(v1)]);
  await sleep(HEAD_START_MS);
  const v2 = await launchPage(`${room.key}/v2`, room.roomId, 'viewer');
  await Promise.all([waitPresent(v2), waitPlaying(v2)]);
  return { ...room, host, viewers: [v1, v2] };
}

function roomReadings(plans) {
  return Promise.all(plans.map(async (room) => ({
    roomId: room.roomId,
    host: await snapshot(room.host),
    viewers: await Promise.all(room.viewers.map((page) => snapshot(page))),
  })));
}

async function captureReadings(plans) {
  const readings = { rooms: plans.length ? await roomReadings(plans) : [] };
  manifest.readings = readings;
  fs.writeFileSync(path.join(RUN_DIR, 'readings.json'), `${JSON.stringify(readings, null, 2)}\n`);
  return readings;
}

function coreDefaults() {
  return {
    defaultStreamConfig: Core.DEFAULT_STREAM_CONFIG,
    defaultCommonConfig: Core.DEFAULT_COMMON_CORE_CONFIG,
    trackerUrl: TRACKER_URL,
    iceServers: [],
  };
}

async function evaluate(readings) {
  const result = evaluatePeerExchange({ ...readings, defaults: coreDefaults() });
  manifest.bars = result.bars;
  evaluated = true;
  const failed = result.bars.filter((bar) => !bar.pass).map((bar) => `${bar.key}${bar.status === 'not exercised' ? ' (not exercised)' : ''}`);
  for (const bar of result.bars) console.log(`${bar.pass ? 'PASS' : 'FAIL'}  ${bar.key} (${bar.status})`);
  if (failed.length) failures.push(`peer-exchange bars failed: ${failed.join(', ')}`);
  manifestFile.write();
  return result;
}

async function main() {
  const origin = `http://127.0.0.1:${SERVER_PORT}`;
  manifest.config = { origin, serverPort: SERVER_PORT, trackerPort: TRACKER_PORT, linkDeadlineMs: LINK_DEADLINE_MS, headStartMs: HEAD_START_MS, sharingDeadlineMs: SHARING_DEADLINE_MS, pollMs: POLL_MS, rooms: roomsToRun };
  await startTracker();
  await startServer(origin);
  const settings = await requireDelivery(origin, 'host');
  if (settings.trackerUrl !== TRACKER_URL) throw new Error(`trackerUrl is ${settings.trackerUrl}, expected ${TRACKER_URL}`);
  manifest.settings = settings;
  const preTabsBundle = await assertServedBundle({ origin, bundlePath: BUNDLE_PATH, pageBuildId: null });
  manifest.build = { preTabs: preTabsBundle };
  if (!preTabsBundle.matches) throw new Error('served bundle does not match the on-disk build');

  let deadlineTimer;
  const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error(`run exceeded ${RUN_DEADLINE_MS}ms`)), RUN_DEADLINE_MS); });
  let roomPlans;
  try {
    roomPlans = await Promise.race([Promise.all(roomsToRun.map(runRoom)), deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
  const firstHost = await snapshot(roomPlans[0].host);
  const postTabsBundle = await assertServedBundle({ origin, bundlePath: BUNDLE_PATH, pageBuildId: firstHost.buildId });
  manifest.build.postTabs = { ...postTabsBundle, pageBuildId: firstHost.buildId };
  if (!postTabsBundle.matches || !postTabsBundle.pageIdInServed) throw new Error('page is not running the served bundle');

  await waitFor('peer bytes in every room', async () => {
    const readings = await roomReadings(roomPlans);
    return readings;
  }, (readings) => readings.every((room) => room.viewers.some((page) => Number(page.peerBytes?.kept?.peerBytes) > 0)), SHARING_DEADLINE_MS, POLL_MS);
}

try {
  await main();
} catch (error) {
  recordFailure(error);
  failures.push(error?.message ?? String(error));
} finally {
  let readings;
  try {
    const plans = roomsToRun.map((room) => ({ ...room, host: pages.find((page) => page.roomId === room.roomId && page.role === 'host'), viewers: pages.filter((page) => page.roomId === room.roomId && page.role === 'viewer') }));
    readings = await captureReadings(plans.filter((room) => room.host && room.viewers.length));
    if (!evaluated) await evaluate(readings);
  } catch (error) {
    recordFailure(error);
    failures.push(error?.message ?? String(error));
  }
  manifest.endedAt = new Date().toISOString();
  manifest.failures.push(...failures.filter((failure) => !manifest.failures.includes(failure)));
  manifest.outcome = failures.length === 0 && manifest.failures.length === 0 && manifest.bars.every((bar) => bar.pass) ? 'pass' : 'failed';
  manifest.status = manifest.outcome === 'pass' ? 'complete' : 'aborted';
  manifestFile.write();
  for (const page of tabs.reverse()) {
    try { await disposeChrome(page.child, page.profile); } catch (error) { manifest.failures.push(`Chrome cleanup ${page.label}: ${error?.message ?? error}`); }
  }
  for (const child of children.reverse()) {
    try { await stopChild(child); } catch (error) { manifest.failures.push(`child cleanup: ${error?.message ?? error}`); }
  }
  server?.output?.();
  tracker?.output?.();
  manifestFile.write();
  console.log(`\n${manifest.outcome === 'pass' ? 'ALL PASS' : `${failures.length || manifest.failures.length} FAILURE(S)`}`);
  console.log(`evidence: ${RUN_DIR}`);
  process.exitCode = manifest.outcome === 'pass' ? 0 : 1;
}
