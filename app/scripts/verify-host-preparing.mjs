import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as CdpWebSocket } from 'ws';

import { attach, cdpHttp, CHROME, clickElement, disposeChrome, FLAGS, rewriteWebSocketDebuggerUrl, sleep, Tab } from './cdp.mjs';
import { createResultLog } from './browser-result-log.mjs';
import { assertServedBundle, createManifestFile, prepareRunDirectory } from './runner/core.mjs';
import { portFree, stopChild, unusedPort } from './runner/local-processes.mjs';
import { closeNamePrompt, waitHostFileEnabled } from './room-page-steps.mjs';
import { buildClientEnvelope, buildJoinEnvelope } from '../public/lib/envelope.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const SERVER_PORT = 8131;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const POLL_MS = 100;
const LABELS = [
  'HP1 a viewer that joins before the file is chosen lists the host and waits',
  "HP2 a viewer's ready report is not believed",
  'HP3 preparation reports rise to ready, never decreasing, no two more than 2 s apart',
  "HP4 a viewer that arrives mid-preparation shows the host's last fraction",
  'HP5 play becomes usable for every member at ready, paused at 0',
  'HP6 viewers request the media only after ready',
  'HP7 play starts the room',
];

const log = createResultLog({ approvedStems: [], print: () => {} });
const startedAt = new Date();
const room = `r${crypto.randomBytes(6).toString('hex')}`;
const runDir = path.join(RESULTS_DIR, `11b-3-host-preparing-${startedAt.toISOString().replaceAll(':', '-')}`);
const polls = [];
const history = { host: [], v1: [], v2: [] };
const rows = [];
let pollNumber = 0;
let manifestFile = null;
let manifest = null;
let server = null;
let chrome = null;
let browser = null;
let chromePort = null;
let profile = null;
let host = null;
let v1 = null;
let v2 = null;
let forger = null;
let runnerFailure = null;
let cleanupFailure = null;

class BrowserConnection {
  constructor(endpoint) {
    const url = new URL(endpoint);
    url.hostname = '127.0.0.1';
    this.ws = new CdpWebSocket(url.toString());
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

const snapshotExpression = `(() => {
  const app = globalThis.__app;
  const line = document.querySelector('#host-preparing');
  const parseNumber = (value) => value === '' || value === undefined ? null : Number(value);
  const state = globalThis.__app?.playbackState?.() ?? null;
  const link = globalThis.__app?.hostLink?.();
  const file = globalThis.__app?.hostFile?.() ?? null;
  return {
    present: Boolean(app && line),
    buildId: app?.buildId ?? null,
    hostPreparing: line ? {
      state: line.dataset.state ?? null,
      fraction: parseNumber(line.dataset.fraction),
      received: parseNumber(line.dataset.received),
      lastAt: parseNumber(line.dataset.lastAt),
      disbelieved: parseNumber(line.dataset.disbelieved),
    } : null,
    controls: {
      play: document.querySelector('#play')?.disabled ?? null,
      back: document.querySelector('#back-10')?.disabled ?? null,
      forward: document.querySelector('#forward-10')?.disabled ?? null,
    },
    roster: [...document.querySelectorAll('#roster li')].map((li) => li.textContent),
    requestsByPath: { ...(link?.requestsByPath ?? {}) },
    playbackState: state,
    hostFile: file,
  };
})()`;

async function poll(read, done, timeoutMs, everyMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(everyMs);
    value = await read();
  }
  return { ok: done(value), value };
}

async function waitForTarget(targetId) {
  return (await poll(async () => (await cdpHttp(chromePort, '/json/list')).find((target) => target.id === targetId && target.webSocketDebuggerUrl), Boolean, 20_000, 100)).value;
}

async function openTarget(url, label) {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true, width: 1100, height: 700 });
  const target = await waitForTarget(targetId);
  if (!target) throw new Error(`${label} target did not appear`);
  const tab = new Tab({ ...target, webSocketDebuggerUrl: rewriteWebSocketDebuggerUrl(target, chromePort) }, { label });
  await tab.ready;
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  return tab;
}

async function pageReady(page, tag) {
  const result = await poll(async () => readPage(page, tag, 'ready'), (value) => value.present === true && typeof value.buildId === 'string', 20_000);
  if (!result.ok) throw new Error(`${tag} did not publish window.__app`);
  return result.value;
}

function writePolls() {
  fs.writeFileSync(path.join(runDir, 'polls.json'), `${JSON.stringify(polls, null, 2)}\n`);
}

async function readPage(page, tag, phase) {
  const at = Date.now();
  let snapshot;
  try {
    snapshot = await page.evaluate(snapshotExpression);
  } catch (error) {
    snapshot = { present: false, error: error?.message ?? String(error) };
  }
  // polls.json is written once, in the finally: rewriting it per read would slow the
  // 100 ms poll as the file grows, and HP4 opens v2 from inside that poll.
  polls.push({ poll: pollNumber, at, phase, page: tag, snapshot });
  if (snapshot?.present) history[tag].push(snapshot);
  return snapshot;
}

async function readCounters(phase) {
  const counters = await (await fetch(`${ORIGIN}/harness/counters`, { cache: 'no-store' })).json();
  polls.push({ poll: pollNumber, at: Date.now(), phase, counters: counters.counters });
  return counters.counters;
}

async function setFileInput(page, filename) {
  await waitHostFileEnabled(page);
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#host-file' });
  if (!nodeId) throw new Error('host file input is missing');
  await page.send('DOM.setFileInputFiles', { nodeId, files: [filename] });
}

function row(index, status, detail = null) {
  const label = LABELS[index];
  const text = `${status} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(text);
  rows.push({ label, status, detail });
  if (status === 'PASS') log.expect(label, true, detail ?? undefined);
  else if (status === 'FAIL') log.expect(label, false, detail ?? undefined);
  else log.results.push({ label, status: 'not-exercised', detail, approvedStem: false, qualifier: detail });
  return status === 'PASS';
}

function hostEntry(roster) { return roster.some((entry) => typeof entry === 'string' && entry.includes(' · host · ')); }
function mediaRequested(snapshot) { return Object.keys(snapshot?.requestsByPath ?? {}).some((key) => key.startsWith('/media/')); }
function pausedAtZero(snapshot) {
  const state = snapshot?.playbackState;
  return state?.playing === false && state?.held === false && state?.positionMs === 0;
}

async function forgeReadyReport() {
  const socket = new globalThis.WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
  forger = socket;
  await new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('raw client join: no joined within 10000 ms')), 10_000).unref();
    socket.addEventListener('open', () => socket.send(JSON.stringify(buildJoinEnvelope({ room, tabId: 'forger', role: 'viewer' }))));
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (value.type === 'error') reject(new Error(`raw client join refused: ${value.payload?.code ?? value.payload?.message ?? 'error'}`));
      if (value.type === 'joined') {
        socket.send(JSON.stringify(buildClientEnvelope({ type: 'host-status', to: 'room', payload: { state: 'ready' } })));
        resolve();
      }
    });
    socket.addEventListener('error', () => reject(new Error('raw client websocket failed')));
  });
}

async function startServer() {
  await portFree(SERVER_PORT).catch(() => { throw new Error(`refusing to run: port ${SERVER_PORT} is held`); });
  const env = { ...process.env };
  delete env.APP_AUTO_START;
  Object.assign(env, { APP_PORT: String(SERVER_PORT), APP_MEDIA_SOURCE: 'file', APP_DELIVERY: 'host', APP_TRACKER_URL: '', APP_ICE_SERVERS: '[]', APP_SEGMENT_TARGET_S: '2' });
  server = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], { cwd: APP_DIR, env, stdio: 'ignore' });
  const up = await poll(async () => {
    try { return (await fetch(`${ORIGIN}/room.html`, { cache: 'no-store' })).ok; } catch { return false; }
  }, (value) => value || server.exitCode !== null, 15_000);
  if (!up.ok || server.exitCode !== null) throw new Error('the room server did not start');
  const settings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
  if (settings.autoStart !== false) throw new Error(`server reports autoStart ${JSON.stringify(settings.autoStart)}`);
  manifest.settings = settings;
}

async function openPages() {
  chromePort = await unusedPort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-preparing-'));
  const hostUrl = `${ORIGIN}/room.html?room=${room}&role=host&tab=host`;
  chrome = spawn(CHROME, [...FLAGS, '--new-window', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, '--window-size=1100,700', hostUrl], { stdio: 'ignore' });
  const version = await cdpHttp(chromePort, '/json/version');
  manifest.chrome = { version: version.Browser ?? null, path: CHROME };
  console.log(`chrome: ${version.Browser ?? null} · ${CHROME}`);
  browser = new BrowserConnection(version.webSocketDebuggerUrl);
  host = await attach(chromePort, `${ORIGIN}/room.html`, { label: 'host' });
  await host.send('DOM.enable');
  const v1Url = `${ORIGIN}/room.html?room=${room}`;
  v1 = await openTarget(v1Url, 'v1');
  console.log(`name prompt v1: ${JSON.stringify(await closeNamePrompt(v1))}`);
  const hostFirst = await pageReady(host, 'host');
  const v1First = await pageReady(v1, 'v1');
  const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: hostFirst.buildId });
  if (!bundle.matches || !bundle.pageIdInServed) throw new Error('served room bundle does not match public/room.bundle.js');
  manifest.build = { pageBuildId: hostFirst.buildId, room: bundle, viewerBuildId: v1First.buildId };
  console.log(`build: ${hostFirst.buildId}`);
}

async function runRows(file, fileBytes) {
  pollNumber += 1;
  const hp1Host = await readPage(host, 'host', 'HP1');
  const hp1Viewer = await readPage(v1, 'v1', 'HP1');
  let joined = await poll(async () => {
    pollNumber += 1;
    const hostSnapshot = await readPage(host, 'host', 'HP1');
    const viewerSnapshot = await readPage(v1, 'v1', 'HP1');
    return { hostSnapshot, viewerSnapshot };
  }, ({ hostSnapshot, viewerSnapshot }) => hostEntry(hostSnapshot?.roster ?? []) && hostEntry(viewerSnapshot?.roster ?? []), 20_000);
  if (!joined.ok) {
    row(0, 'NOT EXERCISED', 'precondition did not happen');
    for (let index = 1; index < LABELS.length; index += 1) row(index, 'NOT EXERCISED', 'precondition did not happen');
    return 1;
  }
  await sleep(3_000);
  pollNumber += 1;
  const hostBefore = await readPage(host, 'host', 'HP1');
  const viewerBefore = await readPage(v1, 'v1', 'HP1');
  const countersBefore = await readCounters('HP1');
  const hp1Ok = hostBefore.hostFile?.state === 'awaiting-file'
    && hostEntry(viewerBefore.roster)
    && viewerBefore.hostPreparing?.state === 'choosing'
    && viewerBefore.hostPreparing?.fraction === null
    && viewerBefore.controls?.play === true && viewerBefore.controls?.back === true && viewerBefore.controls?.forward === true
    && Object.keys(viewerBefore.requestsByPath ?? {}).length === 0
    && !(countersBefore?.responseRecords ?? []).some((record) => record.urlPath?.startsWith('/media/'));
  row(0, hp1Ok ? 'PASS' : 'FAIL', hp1Ok ? null : JSON.stringify({ host: hostBefore.hostFile, viewer: viewerBefore, counters: countersBefore }));

  try {
    await forgeReadyReport();
  } catch (error) {
    row(1, 'FAIL', error?.message ?? String(error));
    throw error;
  }
  await sleep(2_000);
  pollNumber += 1;
  const forged = await readPage(v1, 'v1', 'HP2');
  const hp2Opportunity = Number(forged.hostPreparing?.disbelieved) >= 1;
  if (!hp2Opportunity) row(1, 'NOT EXERCISED', 'precondition did not happen');
  else {
    const hp2Ok = forged.hostPreparing.state === 'choosing' && !mediaRequested(forged) && forged.controls.play === true;
    row(1, hp2Ok ? 'PASS' : 'FAIL', hp2Ok ? null : JSON.stringify(forged));
  }
  forger?.close();
  forger = null;

  const prepareStart = Date.now();
  await setFileInput(host, file);
  let hostReadyAt = null;
  let v1Ready = null;
  let v2First = null;
  let v2FirstAt = null;
  let v1AtV2 = null;
  let v2OpenAt = null;
  let hp4Outcome = null;
  let f0 = null;
  const reports = [];
  const coalescedReports = [];
  let previousReceived = null;
  let v1ReadyWallAt = null;
  const deadline = 60_000 + Math.ceil(fileBytes / 5_000_000) * 1_000;
  const prep = await poll(async () => {
    pollNumber += 1;
    const hostSnapshot = await readPage(host, 'host', 'HP3');
    const v1Snapshot = await readPage(v1, 'v1', 'HP3');
    if (hostReadyAt === null && hostSnapshot.hostFile?.state === 'ready') hostReadyAt = Date.now();
    // HP4: v2's first read of `preparing` within 5 s of its open, against v1 read after it.
    if (v2 && v2First === null && hp4Outcome === null) {
      const currentV2 = await readPage(v2, 'v2', 'HP4');
      if (currentV2.hostPreparing?.state === 'preparing') {
        v2First = currentV2;
        v2FirstAt = Date.now();
        v1AtV2 = await readPage(v1, 'v1', 'HP4');
      } else if (v1Snapshot.hostPreparing?.state === 'ready') hp4Outcome = 'v1 reached ready before v2 read preparing';
      else if (Date.now() - v2OpenAt > 5_000) hp4Outcome = 'timeout';
    } else if (v2) await readPage(v2, 'v2', 'HP3');
    const status = v1Snapshot.hostPreparing;
    if (Number.isFinite(previousReceived) && Number.isFinite(status?.received) && status.received - previousReceived > 1) {
      coalescedReports.push({ poll: pollNumber, previousReceived, received: status.received });
    }
    if (Number.isFinite(status?.received)) previousReceived = status.received;
    const key = JSON.stringify([status?.received, status?.lastAt, status?.state, status?.fraction]);
    if (!reports.some((entry) => entry.key === key)) reports.push({ key, status, poll: pollNumber });
    if (!v2 && status?.state === 'preparing' && Number(status.fraction) >= 0.3) {
      f0 = status.fraction;
      v2OpenAt = Date.now();
      v2 = await openTarget(`${ORIGIN}/room.html?room=${room}`, 'v2');
      console.log(`name prompt v2: ${JSON.stringify(await closeNamePrompt(v2))}`);
      await pageReady(v2, 'v2');
    }
    if (v1Snapshot.hostPreparing?.state === 'ready') {
      v1Ready = v1Snapshot;
      v1ReadyWallAt ??= Date.now();
    }
    return v1Snapshot;
  }, (value) => value.hostPreparing?.state === 'ready', deadline);
  if (hostReadyAt === null) {
    pollNumber += 1;
    const finalHost = await readPage(host, 'host', 'HP3');
    if (finalHost.hostFile?.state === 'ready') hostReadyAt = Date.now();
  }
  if (hostReadyAt !== null) manifest.prepareWallMs = hostReadyAt - prepareStart;
  manifest.prepareWallMs ??= null;
  manifest.coalescedReports = coalescedReports;
  const positive = reports.filter((entry) => entry.status?.state === 'preparing' && Number.isFinite(entry.status.fraction) && entry.status.fraction > 0);
  const firstPositive = positive[0]?.status ?? null;
  const lastReport = reports.at(-1)?.status ?? null;
  const reportReasons = [];
  if (firstPositive) {
    let previous = firstPositive.fraction;
    let previousAt = firstPositive.lastAt;
    for (const report of reports.filter((entry) => entry.status?.lastAt >= firstPositive.lastAt)) {
      const value = report.status;
      if (value.state === 'preparing' && (!(value.fraction > 0 && value.fraction <= 1) || value.fraction < previous)) reportReasons.push('preparation fraction decreased or was invalid');
      if (value.state === 'preparing') previous = value.fraction;
      if (!Number.isFinite(value.lastAt) || !Number.isFinite(previousAt) || value.lastAt - previousAt > 2_000 || value.lastAt < previousAt) reportReasons.push('receipt gap exceeded 2 s');
      previousAt = value.lastAt;
    }
  }
  if (lastReport?.state !== 'ready') reportReasons.push('last report was not ready');
  const preconditionHappened = prep.ok && Boolean(v1Ready && hostReadyAt)
    && manifest.prepareWallMs >= 10_000 && positive.length >= 5;
  if (!preconditionHappened) row(2, 'NOT EXERCISED', 'precondition did not happen');
  else row(2, reportReasons.length === 0 ? 'PASS' : 'FAIL', reportReasons.length === 0 ? null : reportReasons.join('; '));

  let hp4Status = 'NOT EXERCISED';
  let hp4Detail = 'precondition did not happen';
  if (f0 !== null && v2First) {
    // v1 read after v2 may already read ready, which is a fraction of 1.
    const v1Fraction = v1AtV2?.hostPreparing?.state === 'ready' ? 1 : Number(v1AtV2?.hostPreparing?.fraction);
    const valid = Number(v2First.hostPreparing.fraction) >= f0
      && Number(v2First.hostPreparing.fraction) <= v1Fraction
      && hostEntry(v2First.roster)
      && v2First.controls?.play === true
      && v2FirstAt - v2OpenAt <= 5_000;
    hp4Status = valid ? 'PASS' : 'FAIL';
    hp4Detail = JSON.stringify({ f0, v2: v2First.hostPreparing, v1: v1AtV2?.hostPreparing, afterOpenMs: v2FirstAt - v2OpenAt, ...(valid ? {} : { v2First }) });
  } else if (f0 !== null && hp4Outcome !== 'v1 reached ready before v2 read preparing') {
    hp4Status = 'FAIL';
    hp4Detail = `v2 did not read preparing within 5000 ms of its open (${hp4Outcome ?? 'no read'})`;
  }
  row(3, hp4Status, hp4Detail);

  let latest = null;
  const readyPoll = await poll(async () => {
    pollNumber += 1;
    const values = { host: await readPage(host, 'host', 'HP5'), v1: await readPage(v1, 'v1', 'HP5'), v2: v2 ? await readPage(v2, 'v2', 'HP5') : null };
    latest = values;
    return values;
  }, (values) => values.v2 && [values.host, values.v1, values.v2].every((value) => value?.controls?.play === false && pausedAtZero(value)), 5_000);
  const hp5Ready = Boolean(readyPoll.ok && latest?.v2);
  row(4, !v2 || !v1Ready ? 'NOT EXERCISED' : hp5Ready ? 'PASS' : 'FAIL', !v2 || !v1Ready ? 'precondition did not happen' : hp5Ready ? null : JSON.stringify(latest));

  const preReady = [...history.v1, ...history.v2].filter((snapshot) => snapshot.hostPreparing?.state !== 'ready');
  const badPreReady = preReady.find((snapshot) => Object.keys(snapshot.requestsByPath ?? {}).length > 0);
  const mediaDeadline = (v1ReadyWallAt ?? Date.now()) + 15_000;
  let mediaLatest = null;
  const mediaPoll = await poll(async () => {
    pollNumber += 1;
    mediaLatest = { v1: await readPage(v1, 'v1', 'HP6'), v2: v2 ? await readPage(v2, 'v2', 'HP6') : null };
    return mediaLatest;
  }, (values) => mediaRequested(values.v1) && mediaRequested(values.v2), Math.max(1, mediaDeadline - Date.now()));
  const hp6Ready = !badPreReady && Boolean(mediaPoll.ok && mediaLatest?.v2);
  row(5, !v2 || !v1Ready ? 'NOT EXERCISED' : hp6Ready ? 'PASS' : 'FAIL', !v2 || !v1Ready ? 'precondition did not happen' : hp6Ready ? null : JSON.stringify({ badPreReady, latest: mediaLatest }));

  const clickReady = await poll(async () => {
    pollNumber += 1;
    return await readPage(host, 'host', 'HP7');
  }, (snapshot) => pausedAtZero(snapshot) && snapshot.controls?.play === false, 10_000);
  if (!v2 || !v1Ready || !clickReady.ok) row(6, 'NOT EXERCISED', 'precondition did not happen');
  else {
    await clickElement(host, '#play');
    const played = await poll(async () => {
      pollNumber += 1;
      return { host: await readPage(host, 'host', 'HP7'), v1: await readPage(v1, 'v1', 'HP7'), v2: await readPage(v2, 'v2', 'HP7') };
    }, (values) => [values.host, values.v1, values.v2].every((value) => value.playbackState?.playing === true), 10_000);
    row(6, played.ok ? 'PASS' : 'FAIL', played.ok ? null : JSON.stringify(played.value));
  }
}

async function run(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('input is not a file');
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  manifestFile = createManifestFile({
    runDir,
    initial: { schemaVersion: 1, runner: 'verify-host-preparing', filePath: file, fileBytes: stat.size, rows: [], chrome: null, build: null, prepareWallMs: null, startedAt: startedAt.toISOString() },
  });
  manifest = manifestFile.get();
  manifestFile.write();
  writePolls();
  await startServer();
  await openPages();
  await runRows(file, stat.size);
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--file') throw new Error('usage: node scripts/verify-host-preparing.mjs --file <path>');
  return path.resolve(args[1]);
}

const file = parseArgs(process.argv.slice(2));
try {
  await run(file);
} catch (error) {
  runnerFailure = error?.stack ?? error?.message ?? String(error);
  console.error(`runner failure: ${error?.message ?? error}`);
  process.exitCode = 2;
} finally {
  if (forger) try { forger.close(); } catch {}
  if (browser) browser.close();
  if (chrome) {
    try { await disposeChrome(chrome, profile); } catch (error) { cleanupFailure = error?.message ?? String(error); }
  }
  if (server) {
    try { await stopChild(server); } catch (error) { cleanupFailure ??= error?.message ?? String(error); }
  }
  const exitCode = runnerFailure || cleanupFailure ? 2
    : rows.length === LABELS.length && rows.every((entry) => entry.status === 'PASS') ? 0 : 1;
  process.exitCode = exitCode;
  if (manifestFile) {
    manifest.rows = rows;
    manifest.runnerFailure = runnerFailure;
    manifest.cleanupFailure = cleanupFailure;
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = exitCode;
    manifest.outcome = exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'evidence missing';
    manifestFile.write();
    writePolls();
  }
  console.log(`EXIT ${exitCode} · run directory ${runDir}`);
}
