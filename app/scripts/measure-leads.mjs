// Bounded lead measurement runner. Start the server with APP_DELIVERY=http;
// it owns one fresh Chrome profile and publishes only evidence that has passed
// the reducer in lead-measurement.mjs.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach as attachTo, cdpHttp as cdpHttpOn, disposeChrome, sleep } from './cdp.mjs';
import {
  createDeadline,
  createManifestFile,
  createNdjson,
  prepareRunDirectory,
  retainedBytes as retainedBytesIn,
  runFinally,
} from './runner/core.mjs';
import { startOriginMonitor as startMonitor, stopOriginMonitor as stopMonitor } from './runner/origin-monitor.mjs';
import {
  CLOCK_ERROR_ALLOWANCE_MS,
  deliveryProbeExpression,
  deliveryProbeStartExpression,
  deliveryProbeStateExpression,
  loadInitScript,
  loadProbeExpression,
  parkProbeExpression,
  parseNdjson,
  POPULATIONS,
  reduceEvidence,
  TICK_BACKSTOP_MS,
} from './lead-measurement.mjs';
import { requireDelivery } from './delivery-pin.mjs';
import { mediaDirFrom } from '../server/media-dir.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';
const MAX_WALL_MS = 15 * 60 * 1000;
const MAX_RETAINED_BYTES = 5 * 1024 * 1024;
const SEND_INTERVAL_MS = 100;
const LOAD_TIMEOUT_MS = 20_000;
const BROWSER_ATTACH_TIMEOUT_MS = 30_000;
const QUALIFICATION_PARK_TIMEOUT_MS = 90_000;

const valueOf = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const samplesValue = Number(valueOf('--samples') ?? 150);
const samples = Number.isInteger(samplesValue) && samplesValue > 0 ? samplesValue : NaN;
const qualification = process.argv.includes('--qualification') || valueOf('--qualification') === '1';
const simulationCase = valueOf('--case');
const requestedRunDir = valueOf('--run-dir');
const startedAt = Date.now();
const startedAtIso = new Date(startedAt).toISOString();
const runDir = path.resolve(APP_DIR, requestedRunDir ?? path.join('results', `5-leads-${startedAtIso.replaceAll(':', '-')}`));
const relativeRunDir = path.relative(RESULTS_DIR, runDir).split(path.sep).join('/');
const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);
const roomName = `leads-${relativeRunDir.replaceAll(/[^a-zA-Z0-9-]/g, '-')}`;
const deadline = createDeadline({ startedAt, maxWallMs: MAX_WALL_MS });
const { deadlineAt, waitFor } = deadline;

let manifest = null;
let manifestFile = null;
let chrome = null;
let profile = null;
let tabs = [];
let retainedRecords = { delivery: [], park: [], load: [] };
let failure = null;
let cleanupFailure = null;
let originMonitor = null;

const writeManifest = () => manifestFile?.write();

function prepareRun() {
  if (!Number.isInteger(samples) || samples <= 0) throw new Error(`--samples must be a positive integer, got ${valueOf('--samples')}`);
  if (!qualification && samples === 3 && !simulationCase) throw new Error('--samples=3 requires --qualification');
  if (simulationCase && !['missing-raw', 'corrupt-raw', 'write-failure', 'cleanup-failure'].includes(simulationCase)) {
    throw new Error(`unknown qualification case: ${simulationCase}`);
  }
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  manifestFile = createManifestFile({ runDir });
  manifest = manifestFile.set({
    schemaVersion: 1,
    status: 'running',
    outcome: 'running',
    qualification: qualification || Boolean(simulationCase),
    nonAcceptance: qualification || Boolean(simulationCase),
    runDirectory: relativeRunDir,
    runStartedAt: startedAtIso,
    regime: {
      origin: ORIGIN,
      windowState: 'visible, non-occluded (Chrome automation flags)',
      flags: FLAGS,
      contentFps: null,
      mediaDir: mediaDirFrom(),
    },
    planned: {
      sendsPerSender: samples,
      deliveryRecords: samples * 4,
      parkPerPopulation: qualification || simulationCase ? samples : 30,
      loadRecords: qualification || simulationCase ? samples : 10,
    },
    exclusions: { deliveryMissingClocks: 0, parkTimeouts: {}, parkSkipped: 0, loadTimeouts: 0 },
    cleanup: { status: 'pending' },
    failures: [],
  });
  writeManifest();
  console.log(`run output directory: ${runDir}`);
}

const { check: checkDeadline, bounded } = deadline;

function withOriginMonitor(promise) {
  return originMonitor ? Promise.race([promise, originMonitor.promise]) : promise;
}

async function evaluate(tab, expression, label, timeoutMs = 30_000) {
  return withOriginMonitor(bounded(tab.evaluate(expression), timeoutMs, label));
}

function readContentFrameRate() {
  const mediaDir = manifest.regime.mediaDir;
  const temporaryPath = path.join(os.tmpdir(), `measure-leads-${process.pid}-${Date.now()}.mp4`);
  const init = fs.readFileSync(path.join(mediaDir, 'init.mp4'));
  const segment = fs.readFileSync(path.join(mediaDir, 'seg-00000.m4s'));
  fs.writeFileSync(temporaryPath, Buffer.concat([init, segment]));
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=nw=1:nk=1', temporaryPath,
    ], { timeout: 10_000 }).toString().trim();
    const match = /^(\d+)\/(\d+)$/.exec(output);
    if (!match) throw new Error(`unparseable content frame rate: ${JSON.stringify(output)}`);
    const fps = Number(match[1]) / Number(match[2]);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid content frame rate: ${output}`);
    return fps;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function tabUrl(room, tabId, role = 'viewer') {
  return `${ORIGIN}/room.html?room=${encodeURIComponent(room)}&role=${role}&tab=${encodeURIComponent(tabId)}`;
}

async function openTab(label, url, alreadyOpen = false) {
  if (alreadyOpen) return withOriginMonitor(bounded(attachTo(PORT, url, { label }), BROWSER_ATTACH_TIMEOUT_MS, `${label} attach`));
  const before = new Set((await cdpHttp('/json/list')).map((target) => target.id));
  const child = spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', url], { stdio: 'ignore' });
  child.once('error', (error) => { if (!failure) failure = new Error(`${label} Chrome launch failed: ${error.message}`); });
  return withOriginMonitor(bounded(attachTo(PORT, url, { label, exclude: before }), BROWSER_ATTACH_TIMEOUT_MS, `${label} attach`));
}

async function openBlankTab(label) {
  const before = new Set((await cdpHttp('/json/list')).map((target) => target.id));
  spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', 'about:blank'], { stdio: 'ignore' });
  return withOriginMonitor(bounded(attachTo(PORT, 'about:blank', { label, exclude: before }), BROWSER_ATTACH_TIMEOUT_MS, `${label} attach`));
}

async function cdpSend(tab, method, params, label, timeoutMs = 10_000) {
  return withOriginMonitor(bounded(tab.send(method, params), timeoutMs, label));
}

async function awaitPlaying(tab, label) {
  const expression = `(() => ({ playing: window.__app?.playback?.().playing === true, clock: window.__app?.clock?.() ?? null }))()`;
  return waitFor(`${label} playing and clock`, () => evaluate(tab, expression, `${label} readiness`, 5000), (value) => value.playing && Number.isFinite(value.clock?.offsetMs), 60_000);
}

function startOriginMonitor() {
  const healthUrl = `${ORIGIN}/room.html?room=${encodeURIComponent(roomName)}&role=viewer&tab=lead-monitor`;
  originMonitor = startMonitor({
    healthUrl,
    deadlineAt,
    maxWallMs: MAX_WALL_MS,
    onFailure: ({ startedAt: monitorStartedAt, endpoint, failureDetectedAt, failureReason }) => {
      manifest.serverMonitor = { startedAt: monitorStartedAt, endpoint, failureDetectedAt, failureReason };
      writeManifest();
    },
  });
}

async function stopOriginMonitor() {
  const monitor = originMonitor;
  originMonitor = null;
  await stopMonitor(monitor);
}

const writeNdjson = (name, records) => createNdjson(runDir).write(name, records);

function syntheticEvidence() {
  const delivery = [];
  for (const sender of ['P', 'Q']) {
    for (let i = 0; i < samples; i += 1) {
      for (const receiver of ['P', 'Q']) {
        const sent = 1000 + i * 10 + (sender === 'Q' ? 1 : 0);
        delivery.push({ sender, i, receiver, sentSharedMs: sent, recvSharedMs: sent + 10 + i, halfWidthSendMs: 2, halfWidthRecvMs: 3, tsRecv: sent + 5 });
      }
    }
  }
  const park = [];
  for (const population of POPULATIONS) {
    for (let i = 0; i < samples; i += 1) {
      const writeAtMs = 100 + i;
      park.push({ population, currentMs: 1000, targetMs: 2000, durationMs: 7_200_000, bufferedRanges: [], writeAtMs, readyAtMs: writeAtMs + 20 + i, readyState: 4, event: 'seeked', timedOut: false, skipped: false });
    }
  }
  const load = Array.from({ length: samples }, (_, i) => ({ startAtMs: i, readyAtMs: i + 30, readyState: 4, event: 'canplay', timedOut: false }));
  return { delivery, park, load };
}

function validateWriterFields(evidence) {
  const requiredDelivery = ['sender', 'i', 'receiver', 'sentSharedMs', 'recvSharedMs', 'halfWidthSendMs', 'halfWidthRecvMs', 'tsRecv'];
  for (const [index, record] of evidence.delivery.entries()) {
    if (!record || !requiredDelivery.every((field) => field in record)) throw new Error(`delivery.ndjson record ${index + 1} is missing a mapped field`);
  }
  for (const [index, record] of evidence.park.entries()) {
    if (!record || typeof record.population !== 'string' || !('timedOut' in record)) throw new Error(`park.ndjson record ${index + 1} is missing mapped fields`);
  }
  for (const [index, record] of evidence.load.entries()) {
    if (!record || !('startAtMs' in record) || !('readyAtMs' in record) || !('timedOut' in record)) throw new Error(`load.ndjson record ${index + 1} is missing mapped fields`);
  }
}

function readEvidence() {
  const names = { delivery: 'delivery.ndjson', park: 'park.ndjson', load: 'load.ndjson' };
  const evidence = {};
  for (const [key, name] of Object.entries(names)) {
    const file = path.join(runDir, name);
    if (!fs.existsSync(file)) throw new Error(`missing raw evidence: ${name}`);
    evidence[key] = parseNdjson(fs.readFileSync(file, 'utf8'), name);
  }
  validateWriterFields(evidence);
  return evidence;
}

function publishEvidence() {
  const evidence = readEvidence();
  if (simulationCase === 'write-failure') throw new Error('simulated publication write failure');
  const reduced = reduceEvidence({ delivery: evidence.delivery, park: evidence.park, load: evidence.load, samplesPerSender: samples, enforceMinimums: !qualification && !simulationCase });
  if (!reduced.delivery.complete) {
    throw new Error(`delivery evidence incomplete: missing=${reduced.delivery.missing.join(',')}; duplicates=${reduced.delivery.duplicates.join(',')}; unexpected=${reduced.delivery.unexpected.join(',')}`);
  }
  if (reduced.stops.length) throw new Error(`S-LEADS: ${reduced.stops.join(', ')}`);
  const first = reduced.delivery.usable[0];
  const hand = first ? {
    key: `${first.sender}:${first.i}:${first.receiver}`,
    latencyMs: first.recvSharedMs - first.sentSharedMs,
    upperMs: (first.recvSharedMs - first.sentSharedMs) + first.halfWidthSendMs + first.halfWidthRecvMs,
  } : null;
  if (!hand || hand.latencyMs !== first.latencyMs || hand.upperMs !== first.upperMs) throw new Error('hand calculation did not reproduce the first delivery sample');
  const summary = {
    schemaVersion: 1,
    nonAcceptance: qualification || Boolean(simulationCase),
    delivery: reduced.delivery.stats,
    park: Object.fromEntries(POPULATIONS.map((population) => [population, reduced.park[population].stats])),
    load: reduced.load.stats,
    exclusions: {
      deliveryMissingClocks: reduced.delivery.excludedCount,
      deliveryMissingEvidence: reduced.delivery.missing.length,
      deliveryDuplicates: reduced.delivery.duplicates.length,
      parkTimeouts: Object.fromEntries(POPULATIONS.map((population) => [population, reduced.park[population].timedOut])),
      parkSkipped: Object.fromEntries(POPULATIONS.map((population) => [population, reduced.park[population].skipped])),
      loadTimeouts: reduced.load.timedOut,
    },
    minima: {
      deliveryExpected: reduced.delivery.expectedCount,
      deliveryUsable: reduced.delivery.usable.length,
      parkUsable: Object.fromEntries(POPULATIONS.map((population) => [population, reduced.park[population].usableCount])),
      loadUsable: reduced.load.usableCount,
    },
    derived: {
      TRANSITION_LEAD_MS: reduced.transitionLeadMs,
      PREPARE_LEAD_MS: reduced.prepareLeadMs,
      MAX_FUTURE_MS: reduced.maxFutureMs,
      CLOCK_ERROR_ALLOWANCE_MS,
      TICK_BACKSTOP_MS,
    },
    handCalculation: { ...hand, verified: true },
    reducer: { acceptance: reduced.acceptance, stops: reduced.stops },
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  manifest.status = 'published';
  manifest.outcome = 'pass';
  manifest.summary = summary;
  manifest.exclusions = summary.exclusions;
  writeManifest();
  return summary;
}

async function acquireBrowserEvidence() {
  manifest.regime.contentFps = readContentFrameRate();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-leads-'));
  const urlP = tabUrl(roomName, 'P', 'host');
  const urlQ = tabUrl(roomName, 'Q');
  chrome = spawn(CHROME, [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', urlP], { stdio: 'ignore' });
  chrome.once('error', (error) => { throw new Error(`Chrome launch failed: ${error.message}`); });
  const p = await bounded(openTab('P/host', urlP, true), BROWSER_ATTACH_TIMEOUT_MS, 'P/host attach');
  tabs.push(p);
  const q = await openTab('Q/viewer', urlQ);
  tabs.push(q);
  await Promise.all([awaitPlaying(p, 'P'), awaitPlaying(q, 'Q')]);
  console.log('both measured windows are playing with finite clock estimates');
  manifest.observed = { playbackReadyAt: new Date().toISOString(), pages: ['P/host', 'Q/viewer'] };
  writeManifest();
  startOriginMonitor();

  await Promise.all([
    evaluate(p, deliveryProbeExpression({ room: roomName, tabId: 'P', samples, intervalMs: SEND_INTERVAL_MS }), 'P delivery setup', 10_000),
    evaluate(q, deliveryProbeExpression({ room: roomName, tabId: 'Q', samples, intervalMs: SEND_INTERVAL_MS }), 'Q delivery setup', 10_000),
  ]);
  await waitFor(
    'both delivery probes joined',
    () => Promise.all([
      evaluate(p, deliveryProbeStateExpression(), 'P delivery state', 5000),
      evaluate(q, deliveryProbeStateExpression(), 'Q delivery state', 5000),
    ]),
    (states) => {
      if (states.some((state) => state.error && !state.joined)) throw new Error(`delivery probe setup failed: ${states.map((state) => state.error).filter(Boolean).join('; ')}`);
      return states.every((state) => state.joined);
    },
    30_000,
  );
  const [probeP, probeQ] = await Promise.all([
    evaluate(p, deliveryProbeStartExpression(), 'P delivery probe', samples * SEND_INTERVAL_MS + 15_000).catch((error) => ({ records: [], sent: 0, error: error.message })),
    evaluate(q, deliveryProbeStartExpression(), 'Q delivery probe', samples * SEND_INTERVAL_MS + 15_000).catch((error) => ({ records: [], sent: 0, error: error.message })),
  ]);
  retainedRecords.delivery = [...probeP.records, ...probeQ.records];
  writeNdjson('delivery.ndjson', retainedRecords.delivery);
  manifest.observed.deliveryRecords = retainedRecords.delivery.length;
  manifest.observed.deliveryRecordedAt = new Date().toISOString();
  writeManifest();
  if (probeP.sent !== samples || probeQ.sent !== samples) throw new Error(`delivery acquisition incomplete: P sent ${probeP.sent}/${samples}, Q sent ${probeQ.sent}/${samples}`);
  if (probeP.error || probeQ.error) throw new Error(`delivery acquisition aborted: ${probeP.error ?? probeQ.error}`);

  const parkTimeoutMs = qualification ? QUALIFICATION_PARK_TIMEOUT_MS : Math.min(240_000, samples * 2 * 30_000 + 30_000);
  retainedRecords.park = await evaluate(
    p,
    parkProbeExpression({ samplesPerPopulation: manifest.planned.parkPerPopulation }),
    'park readiness probe',
    parkTimeoutMs,
  );
  writeNdjson('park.ndjson', retainedRecords.park);
  manifest.observed.parkRecords = retainedRecords.park.length;
  writeManifest();

  const loadTab = await openBlankTab('R/load');
  tabs.push(loadTab);
  await cdpSend(loadTab, 'Network.enable', {}, 'R/load Network.enable');
  await cdpSend(loadTab, 'Network.setCacheDisabled', { cacheDisabled: true }, 'R/load cache disable');
  await cdpSend(loadTab, 'Page.enable', {}, 'R/load Page.enable');
  await cdpSend(loadTab, 'Page.addScriptToEvaluateOnNewDocument', { source: loadInitScript() }, 'R/load init script');
  retainedRecords.load = [];
  for (let i = 0; i < (qualification ? samples : 10); i += 1) {
    checkDeadline('first-load acquisition');
    const url = tabUrl(`leads-load-${roomName}-${i}`, 'R');
    await cdpSend(loadTab, 'Page.navigate', { url }, `first-load ${i} navigate`);
    const load = await evaluate(loadTab, loadProbeExpression(LOAD_TIMEOUT_MS), `first-load ${i}`, LOAD_TIMEOUT_MS + 5000);
    retainedRecords.load.push(load);
  }
  writeNdjson('load.ndjson', retainedRecords.load);
  manifest.observed.loadRecords = retainedRecords.load.length;
  writeManifest();
}

async function runSimulation() {
  const evidence = syntheticEvidence();
  if (simulationCase === 'missing-raw') {
    writeNdjson('delivery.ndjson', evidence.delivery);
    writeNdjson('park.ndjson', evidence.park);
    return;
  }
  if (simulationCase === 'corrupt-raw') {
    fs.writeFileSync(path.join(runDir, 'delivery.ndjson'), '{not-json}\n');
    writeNdjson('park.ndjson', evidence.park);
    writeNdjson('load.ndjson', evidence.load);
    return;
  }
  writeNdjson('delivery.ndjson', evidence.delivery);
  writeNdjson('park.ndjson', evidence.park);
  writeNdjson('load.ndjson', evidence.load);
}

const retainedBytes = () => retainedBytesIn(runDir);

async function cleanup() {
  if (simulationCase === 'cleanup-failure') throw new Error('simulated Chrome cleanup failure');
  if (!chrome && !profile) return;
  try {
    await disposeChrome(chrome, profile);
    manifest.cleanup = { status: 'passed', profileRemoved: !fs.existsSync(profile), tabs: tabs.length };
  } catch (error) {
    throw new Error(`Chrome cleanup failed: ${error.message}`);
  }
}

async function main() {
  try {
    prepareRun();
    if (simulationCase) {
      await runSimulation();
    } else {
      await requireDelivery(ORIGIN, 'http');
      await acquireBrowserEvidence();
    }
    const summary = publishEvidence();
    if (retainedBytes() > MAX_RETAINED_BYTES) throw new Error(`retained evidence exceeds ${MAX_RETAINED_BYTES} bytes`);
    console.log(`derived leads: TRANSITION_LEAD_MS=${summary.derived.TRANSITION_LEAD_MS} PREPARE_LEAD_MS=${summary.derived.PREPARE_LEAD_MS} MAX_FUTURE_MS=${summary.derived.MAX_FUTURE_MS}`);
  } catch (error) {
    failure = error;
    console.error(`ERROR: ${error.stack ?? error}`);
  } finally {
    await stopOriginMonitor();
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = error;
      console.error(`CLEANUP ERROR: ${error.message}`);
    }
    runFinally({ manifest: manifestFile, failure, cleanupFailure, startedAt, runDir, tabs });
  }
  if (failure || cleanupFailure) process.exitCode = 1;
}

await main();
