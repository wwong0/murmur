// Browser verification for the host-origin delivery path (change 7a, §8).
//
// This runner owns the 8124 server and its Chrome processes.  It records every
// acceptance bar in the manifest before teardown so a partial run is evidence,
// not an unexplained empty results directory.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, CHROME, disposeChrome, FLAGS, sleep } from './cdp.mjs';
import { assertServedBundle, createManifestFile, prepareRunDirectory } from './runner/core.mjs';
import { requireDelivery } from './delivery-pin.mjs';

const CASES = new Set(['direct', 'http-control', 'relay']);
const CASE = process.argv[2] ?? 'direct';
if (!CASES.has(CASE)) throw new Error(`usage: node scripts/verify-host-origin.mjs <${[...CASES].join('|')}>`);

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const TURN_COMPOSE = path.join(APP_DIR, 'harness', 'turn.compose.yaml');
const SERVER_PORT = 8124;
const POLL_MS = 100;
const LINK_DEADLINE_MS = 60_000;
const RELOAD_DEADLINE_MS = 30_000;
const PLAY_ADVANCE_MS = 12_000;
const ROOM = `7a-host-origin-${crypto.randomBytes(8).toString('hex')}`;
const STARTED_AT = new Date();
const RUN_NAME = `7a-host-origin-${CASE}-${STARTED_AT.toISOString().replaceAll(':', '-')}`;
const RUN_DIR = path.join(RESULTS_DIR, RUN_NAME);

prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: RUN_DIR, createParents: true });
const manifestFile = createManifestFile({
  runDir: RUN_DIR,
  initial: {
    schemaVersion: 1,
    case: CASE,
    room: ROOM,
    startedAt: STARTED_AT.toISOString(),
    runDirectory: path.relative(RESULTS_DIR, RUN_DIR).split(path.sep).join('/'),
    server: { port: SERVER_PORT, delivery: CASE === 'http-control' ? 'http' : 'host' },
    bars: [],
    observations: {},
    failures: [],
  },
});
manifestFile.write();

const manifest = manifestFile.get();
const failures = [];
const children = [];
const tabs = [];
let server = null;
let turnStarted = false;

function recordBar(key, pass, observed, detail = null) {
  const bar = { key, pass: Boolean(pass), observed, detail };
  manifest.bars.push(bar);
  manifest.observations[key] = observed;
  if (!pass) failures.push(key);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${key}${detail ? ` — ${detail}` : ''}`);
  manifestFile.write();
  return pass;
}

function recordFailure(error) {
  const text = error?.stack ?? error?.message ?? String(error);
  manifest.failures.push(text);
  console.error(`ERROR: ${error?.message ?? error}`);
  manifestFile.write();
}

function portFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve(true)));
  });
}

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function childOutput(child, name) {
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  child.on('error', (error) => stderr.push(`${error.stack ?? error}\n`));
  return {
    write() {
      fs.writeFileSync(path.join(RUN_DIR, name), `${stdout.join('')}\n${stderr.join('')}`);
    },
    text() { return `${stdout.join('')}\n${stderr.join('')}`; },
  };
}

async function startServer(origin, delivery, iceServers) {
  try {
    await portFree(SERVER_PORT);
  } catch (error) {
    throw new Error(`refusing to run: port ${SERVER_PORT} is held (${error?.message ?? error})`);
  }
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      APP_PORT: String(SERVER_PORT),
      APP_DELIVERY: delivery,
      APP_ICE_SERVERS: JSON.stringify(iceServers),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const output = childOutput(child, 'server.log');
  server = { child, output, origin };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`room server exited before ready: ${output.text()}`);
    try {
      const response = await fetch(`${origin}/room.html`, { cache: 'no-store' });
      if (response.ok) {
        const settings = await (await fetch(`${origin}/app-settings`, { cache: 'no-store' })).json();
        if (settings.delivery === delivery) return server;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`room server did not become ready: ${output.text()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (child.pid) {
    try {
      const listed = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (listed.status === 0 && new RegExp(`\\b${child.pid}\\b`).test(listed.stdout ?? '')) {
        try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
      }
    } catch {}
  }
}

const SEAM = `(() => {
  const app = window.__app;
  const video = document.querySelector('video');
  if (!app) return { present: false };
  return {
    present: true,
    buildId: app.buildId,
    delivery: app.delivery(),
    tabId: new URLSearchParams(location.search).get('tab'),
    role: new URLSearchParams(location.search).get('role'),
    hostLink: app.hostLink(),
    playback: app.playback(),
    currentTime: video ? video.currentTime : null,
    paused: video ? video.paused : null,
    readyState: video ? video.readyState : null,
  };
})()`;

async function launchPage(label, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `app-host-origin-${label.toLowerCase()}-`));
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

async function seamOf(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let value = { present: false };
  while (Date.now() < deadline) {
    try {
      value = await page.tab.evaluate(SEAM);
      if (value?.present) return value;
    } catch {}
    await sleep(POLL_MS);
  }
  return value;
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

async function snapshot(page) {
  try { return await page.tab.evaluate(SEAM); } catch (error) { return { present: false, error: error?.message ?? String(error) }; }
}

async function settingsAndFreshness(origin, expectedDelivery, host) {
  const settings = await requireDelivery(origin, expectedDelivery);
  manifest.settings = settings;
  const bundle = await assertServedBundle({ origin, bundlePath: BUNDLE_PATH, pageBuildId: host.buildId });
  manifest.build = { ...bundle, pageBuildId: host.buildId };
  recordBar('fresh served bundle hash matches on-disk bundle', bundle.matches, bundle);
  recordBar('fresh page build id occurs in served bundle', bundle.pageIdInServed, bundle);
  recordBar(`server delivery is ${expectedDelivery}`, settings.delivery === expectedDelivery, settings);
  return settings;
}

async function readCounters(origin) {
  const response = await fetch(`${origin}/harness/counters`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`counter snapshot returned HTTP ${response.status}`);
  return (await response.json()).counters;
}

function mediaFields(value) {
  return value && ['mediaBytesDelivered', 'segmentBytesDelivered', 'initBytesDelivered', 'playlistBytesDelivered', 'abortedMediaBytesDelivered', 'responses']
    .every((key) => Number(value[key] ?? 0) >= 0) ? value : null;
}

async function waitPlaying(page) {
  return waitFor(page, () => page.tab.evaluate(SEAM), (value) => value?.hostLink?.state === 'open' && value?.playback?.playing === true, LINK_DEADLINE_MS);
}

async function measureAdvance(page, durationMs, minimumMs) {
  const first = await snapshot(page);
  await sleep(durationMs);
  const last = await snapshot(page);
  const advanceMs = Number.isFinite(first.currentTime) && Number.isFinite(last.currentTime)
    ? (last.currentTime - first.currentTime) * 1000
    : null;
  return { first, last, advanceMs, pass: Number.isFinite(advanceMs) && advanceMs >= minimumMs };
}

const LINK_NOTICES = `[...document.querySelectorAll('#notices li')]
  .map((li) => /host link: ([a-z]+)/.exec(li.textContent)?.[1] ?? null)
  .filter(Boolean)`;

async function linkNotices(page) {
  try { return await page.tab.evaluate(LINK_NOTICES); } catch { return null; }
}

// The poll can miss a loopback re-link shorter than POLL_MS, so the page's own
// record of each link state change is read beside it; neither is inferred.
async function verifyHostReload(hostPage, viewerPage) {
  const before = await snapshot(viewerPage);
  const oldHostClientId = before.hostLink?.hostClientId ?? null;
  const noticesBefore = await linkNotices(viewerPage);
  await hostPage.tab.send('Page.reload', { ignoreCache: true });
  const samples = [];
  const deadline = Date.now() + RELOAD_DEADLINE_MS;
  let polledNotOpen = false;
  let reopened = null;
  while (Date.now() < deadline) {
    const reading = await snapshot(viewerPage);
    samples.push({ atMs: Date.now(), state: reading.hostLink?.state ?? null, hostClientId: reading.hostLink?.hostClientId ?? null });
    if (reading.hostLink?.state !== 'open') polledNotOpen = true;
    if (reading.hostLink?.state === 'open' && reading.hostLink.hostClientId && reading.hostLink.hostClientId !== oldHostClientId) {
      reopened = reading;
      break;
    }
    await sleep(POLL_MS);
  }
  const noticesAfter = await linkNotices(viewerPage);
  const transitions = Array.isArray(noticesBefore) && Array.isArray(noticesAfter) ? noticesAfter.slice(noticesBefore.length) : null;
  const recordedNotOpen = Array.isArray(transitions) && transitions.some((state) => state !== 'open') && transitions.at(-1) === 'open';
  const after = reopened ?? await snapshot(viewerPage);
  const advance = reopened ? await measureAdvance(viewerPage, 5_000, 5_000) : { advanceMs: null, pass: false };
  const observed = {
    oldHostClientId,
    polledNotOpen,
    transitions,
    reopenedState: after.hostLink?.state ?? null,
    newHostClientId: after.hostLink?.hostClientId ?? null,
    samples,
    advanceAfterReopenMs: advance.advanceMs,
  };
  manifest.reload = observed;
  recordBar('host reload takes the viewer link through a non-open state', polledNotOpen || recordedNotOpen, { polledNotOpen, transitions, samples: samples.length });
  recordBar('host reload reopens with a different host client id', Boolean(reopened), { oldHostClientId, newHostClientId: observed.newHostClientId });
  recordBar('viewer advances at least 5 s after host relink', advance.pass, { advanceAfterReopenMs: advance.advanceMs });
  return observed;
}

async function startTurn() {
  if (CASE !== 'relay') return;
  try {
    execFileSync('docker', ['compose', '-f', TURN_COMPOSE, 'up', '-d', 'turn'], { cwd: APP_DIR, stdio: 'inherit' });
    turnStarted = true;
  } catch (error) {
    throw new Error(`coturn unavailable: ${error?.message ?? error}`);
  }
}

async function stopTurn() {
  if (!turnStarted) return;
  try { execFileSync('docker', ['compose', '-f', TURN_COMPOSE, 'down'], { cwd: APP_DIR, stdio: 'inherit' }); } catch (error) { manifest.failures.push(`coturn cleanup: ${error?.message ?? error}`); }
}

async function main() {
  const origin = `http://127.0.0.1:${SERVER_PORT}`;
  const delivery = CASE === 'http-control' ? 'http' : 'host';
  const iceServers = CASE === 'relay'
    ? [{ urls: ['turn:127.0.0.1:3478?transport=udp'], username: 'wa', credential: 'wa' }]
    : [];
  manifest.config = { origin, delivery, iceServers, pollMs: POLL_MS, playAdvanceWindowMs: PLAY_ADVANCE_MS };
  await startTurn();
  await startServer(origin, delivery, iceServers);

  const hostPage = await launchPage('host', `${origin}/room.html?room=${ROOM}&role=host&tab=host`);
  const viewerSuffix = CASE === 'relay' ? '&iceTransportPolicy=relay' : '';
  const viewerPage = await launchPage('viewer', `${origin}/room.html?room=${ROOM}&role=viewer&tab=viewer${viewerSuffix}`);
  const host = await seamOf(hostPage);
  const viewer = await seamOf(viewerPage);
  manifest.pages = { host, viewer };
  recordBar('host page publishes its seam', host.present === true, host);
  recordBar('viewer page publishes its seam', viewer.present === true, viewer);
  await settingsAndFreshness(origin, delivery, host);

  if (CASE === 'http-control') {
    const playing = await waitFor(viewerPage, () => viewerPage.tab.evaluate(SEAM), (value) => value?.playback?.playing === true, LINK_DEADLINE_MS);
    const advance = await measureAdvance(viewerPage, PLAY_ADVANCE_MS, 10_000);
    const counters = await readCounters(origin);
    manifest.counters = counters;
    fs.writeFileSync(path.join(RUN_DIR, 'counters.json'), `${JSON.stringify(counters, null, 2)}\n`);
    manifest.pages.viewerFinal = await snapshot(viewerPage);
    fs.writeFileSync(path.join(RUN_DIR, 'host-seam.json'), `${JSON.stringify(await snapshot(hostPage), null, 2)}\n`);
    fs.writeFileSync(path.join(RUN_DIR, 'viewer-seam.json'), `${JSON.stringify(manifest.pages.viewerFinal, null, 2)}\n`);
    recordBar('http-control viewer plays', playing.ok, playing.value);
    recordBar('http-control viewer advances at least 10 s', advance.pass, { advanceMs: advance.advanceMs });
    const viewerBucket = mediaFields(counters.byClient?.viewer);
    recordBar('http-control viewer segment bytes are positive', Number(viewerBucket?.segmentBytesDelivered ?? 0) > 0, viewerBucket ?? counters.byClient?.viewer ?? null);
    return;
  }

  const playing = await waitPlaying(viewerPage);
  recordBar(`${CASE} viewer host link opens and playback starts`, playing.ok, playing.value);
  const advance = await measureAdvance(viewerPage, PLAY_ADVANCE_MS, 10_000);
  recordBar(`${CASE} viewer advances at least 10 s of media`, advance.pass, { advanceMs: advance.advanceMs, first: advance.first.currentTime, last: advance.last.currentTime });

  const counters = await readCounters(origin);
  manifest.counters = counters;
  fs.writeFileSync(path.join(RUN_DIR, 'counters.json'), `${JSON.stringify(counters, null, 2)}\n`);
  const hostBucket = mediaFields(counters.byClient?.host);
  const viewerBucket = mediaFields(counters.byClient?.viewer);
  const mediaRecords = (counters.responseRecords ?? []).filter((record) => ['playlist', 'init', 'segment'].includes(record.kind));
  recordBar(`${CASE} host source reads are positive`, Number(hostBucket?.segmentBytesDelivered ?? 0) > 0, hostBucket);
  recordBar(`${CASE} viewer media bytes are zero`, !viewerBucket || Object.values(viewerBucket).every((value) => value === 0), viewerBucket ?? null);
  recordBar(`${CASE} unattributed media bytes are zero`, counters.unattributedMediaBytesDelivered === 0, counters.unattributedMediaBytesDelivered);
  recordBar(`${CASE} media records carry only the host client tag`, mediaRecords.every((record) => record.clientTag === 'host'), mediaRecords.map((record) => ({ kind: record.kind, clientTag: record.clientTag, urlPath: record.urlPath, delivered: record.delivered })));

  const link = advance.last.hostLink;
  const paths = link?.requestsByPath ?? null;
  const hasPlaylist = paths && Object.keys(paths).some((key) => key.endsWith('.m3u8'));
  const segmentCount = paths ? Object.entries(paths).filter(([key]) => key.endsWith('.m4s')).reduce((sum, [, count]) => sum + count, 0) : 0;
  const hasInit = paths ? Object.keys(paths).some((key) => key.endsWith('init.mp4')) : null;
  recordBar(`${CASE} viewer requests playlist and at least 3 segments over host link`, Boolean(hasPlaylist && segmentCount >= 3), { paths, hasPlaylist, segmentCount });
  recordBar(`${CASE} viewer never requests init.mp4 over host link`, hasInit === false, { paths, hasInit });

  if (CASE === 'direct') await verifyHostReload(hostPage, viewerPage);
  else {
    const reading = (await snapshot(viewerPage)).hostLink ?? null;
    const pair = { relayed: reading?.relayed ?? null, candidateTypes: reading?.candidateTypes ?? null, lastError: reading?.lastError ?? null };
    manifest.relay = { pair };
    fs.writeFileSync(path.join(RUN_DIR, 'relay-pair.json'), `${JSON.stringify(pair, null, 2)}\n`);
    recordBar('relay viewer seam reports relayed === true', pair.relayed === true, pair);
    recordBar('relay manifest records local and remote candidate types', Boolean(pair.candidateTypes?.local && pair.candidateTypes?.remote), pair.candidateTypes);
  }

  manifest.pages.hostFinal = await snapshot(hostPage);
  manifest.pages.viewerFinal = await snapshot(viewerPage);
  fs.writeFileSync(path.join(RUN_DIR, 'host-seam.json'), `${JSON.stringify(manifest.pages.hostFinal, null, 2)}\n`);
  fs.writeFileSync(path.join(RUN_DIR, 'viewer-seam.json'), `${JSON.stringify(manifest.pages.viewerFinal, null, 2)}\n`);
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
  server?.output.write();
  await stopTurn();
  manifestFile.write();
  console.log(`\n${manifest.outcome === 'pass' ? 'ALL PASS' : `${failures.length || manifest.failures.length} FAILURE(S)`}`);
  console.log(`evidence: ${RUN_DIR}`);
  process.exitCode = manifest.outcome === 'pass' ? 0 : 1;
}
