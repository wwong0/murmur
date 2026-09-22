import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDeadline, createManifestFile, createNdjson, prepareRunDirectory, retainedBytes, runFinally } from './runner/core.mjs';
import { startOriginMonitor, stopOriginMonitor } from './runner/origin-monitor.mjs';
import { recomputeRunDirectory } from './harness-figures.mjs';
import { isPublishedFigure } from './figures/publication.mjs';
import { attachTabTakenDetector, boundaryExpression, createRequestRecorder, installStallRecorder, pollExpression } from './harness/cdp-records.mjs';
import { qualifyCdpBytes as defaultQualifyCdpBytes } from './harness/qualification.mjs';
import { evaluateRefusals } from './harness/refusals.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');
const MAX_RETAINED_BYTES = 200 * 1024 * 1024;
const POLL_INTERVAL_MS = 125;
const DRAIN_INTERVAL_MS = 15_000;
const ECHO_INTERVAL_MS = 250;

// Bringing eleven containers up, building nothing, pulling nothing, and then
// establishing the cadence takes minutes, and none of it is the run. The budget
// is the run's length plus this allowance, so the deadline still catches a
// wedged client rather than expiring on a normal start.
const STARTUP_ALLOWANCE_MS = 300_000;
const OVERRIDE = /^(?:clients?|client-count|capacity(?:-mbps)?|impairment|window|run-length|excluded-prefix|measure-window|qdisc|background-load)(?:=|$)/i;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadConditions(filePath = CONDITIONS_PATH) {
  return freeze(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export const conditions = loadConditions();

export function conditionForName(name, matrix = conditions) {
  if (matrix[name]) return matrix[name];
  const [group, arm] = String(name).split('/');
  if (group === 'shakedown' && matrix.shakedown?.[arm]) return matrix.shakedown[arm];
  throw new Error(`unknown harness condition: ${name}`);
}

export function parseHarnessArguments(argv = process.argv.slice(2)) {
  const result = { conditionName: null, runDir: null };
  for (const argument of argv) {
    if (OVERRIDE.test(argument.replace(/^--/, ''))) throw new Error(`condition declares this setting; command-line override refused: ${argument}`);
    if (argument.startsWith('--condition=')) result.conditionName = argument.slice('--condition='.length);
    else if (argument.startsWith('--run-dir=')) result.runDir = argument.slice('--run-dir='.length);
    else if (argument === '--help') return { help: true, ...result };
    else throw new Error(`unknown harness argument: ${argument}`);
  }
  if (!result.conditionName && !result.help) throw new Error('usage: node scripts/harness-run.mjs --condition=<name> [--run-dir=<dir>]');
  return result;
}

function safeName(name) {
  return name.replaceAll('/', '-').replaceAll(':', '-');
}

function defaultRunDir(conditionName) {
  return path.join(RESULTS_DIR, `6a-${safeName(conditionName)}-${new Date().toISOString().replaceAll(':', '-')}`);
}

function tagsFor(condition) {
  return Array.from({ length: condition.clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`);
}

function clientDeclaration(tags, roles) {
  return Object.fromEntries(tags.map((tag, index) => [tag, {
    tag,
    role: roles[index],
    requestTimebase: 'measure-window',
    boundaries: { start: null, end: null },
  }]));
}

function streamNames(tag) {
  return [`client-${tag}.drift.ndjson`, `client-${tag}.poll.ndjson`, `client-${tag}.requests.ndjson`, `client-${tag}.echo.ndjson`];
}

/**
 * The measure window is placed from the instant the last client was ready to
 * play, not from the instant this process started. D3's excluded prefix exists
 * to cover the controller's settling time, and settling begins at playback: a
 * prefix counted from process start is spent on `docker compose up` and the run
 * measures the convergence period it was declared to exclude. The declared
 * lengths are untouched.
 */
export function placeWindow(condition, clientsReadyAtMs) {
  const startMs = clientsReadyAtMs + condition.excludedPrefixMs;
  return {
    clientsReadyAtMs,
    startMs,
    endMs: startMs + condition.measureWindowMs,
    declaredStartMs: startMs,
    declaredEndMs: startMs + condition.measureWindowMs,
    excludedPrefixMs: condition.excludedPrefixMs,
    measureWindowMs: condition.measureWindowMs,
  };
}

function initialManifest(conditionName, condition, runDir, startedAt, tags) {
  const start = startedAt + condition.excludedPrefixMs;
  return {
    schemaVersion: 1,
    byteAccountingMethod: 'client-receipt-cohort-v1',
    runId: path.basename(runDir),
    status: 'running',
    outcome: 'running',
    startedAt: new Date(startedAt).toISOString(),
    condition: JSON.parse(JSON.stringify(condition)),
    declaredClientTags: tags,
    clientTags: tags,
    clients: clientDeclaration(tags, tags.map((tag, index) => index === 0 ? 'host' : 'viewer')),
    window: {
      startMs: start,
      endMs: start + condition.measureWindowMs,
      declaredStartMs: start,
      declaredEndMs: start + condition.measureWindowMs,
      excludedPrefixMs: condition.excludedPrefixMs,
      measureWindowMs: condition.measureWindowMs,
    },
    content: JSON.parse(JSON.stringify(condition.content)),
    regime: JSON.parse(JSON.stringify(condition)),
    cadence: null,
    cdpQualification: null,
    topology: { status: 'pending', qdiscs: condition.qdiscs },
    cleanup: { status: 'pending' },
    failures: [],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(deadline, atMs) {
  while (Date.now() < atMs) {
    deadline.check('run');
    await sleep(Math.min(1000, Math.max(1, atMs - Date.now())));
  }
}

function section3Topology() {
  return {
    async prepare() { throw new Error('Section 3 topology command seam is unavailable'); },
    async applyQdiscs() { throw new Error('Section 3 qdisc command seam is unavailable'); },
    async teardown() {},
  };
}

function noClientFactory() {
  throw new Error('Section 3 client acquisition seam is unavailable');
}

/**
 * Default to the real probe. A caller that supplies constructed evidence passes
 * its own; a caller that forgets gets the measurement, never an empty record
 * that would let the cadence gate pass for want of a reading.
 */
async function defaultEstablishCadence(sessions, options) {
  const { establishCadence } = await import('./harness-cadence.mjs');
  return establishCadence(sessions, options);
}

function failedCdpQualification(reason) {
  return { status: 'failed', reason };
}

async function qualifyFirstClient(tab, originContainer, qualifier) {
  if (!originContainer) return failedCdpQualification('qualification-unavailable:origin-container');
  if (!tab) return failedCdpQualification('qualification-unavailable:first-client-tab');
  try {
    return await qualifier(tab, { originContainer }) ?? failedCdpQualification('qualification-failed:no-result');
  } catch (error) {
    return failedCdpQualification(`qualification-error:${error?.message ?? String(error)}`);
  }
}

export function mergeVerifiedContext(manifest, seam = {}) {
  const next = { ...manifest };
  for (const field of ['content', 'regime', 'cadence', 'cdpQualification']) {
    if (seam[field] !== undefined) next[field] = seam[field];
  }
  return next;
}

async function prepareClient(session, url, deadline) {
  const tab = session.tab;
  const recorder = createRequestRecorder(tab);
  session.recorder = recorder;
  await tab.send('Network.enable');
  await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
  await tab.send('Page.enable');
  const pageClock = await tab.evaluate('({ wallMs: Date.now(), performanceNowMs: performance.now() })');
  recorder.setPageMapping(pageClock);
  session.removeCollisionListener = attachTabTakenDetector(tab, () => { session.tabCollision = true; });
  await tab.send('Page.navigate', { url });
  await deadline.waitFor(`client ${session.tag}`, () => tab.evaluate('Boolean(document.body && window.__app)'), Boolean, 30_000, 100);
  await tab.evaluate(installStallRecorder(session.stallEpoch));
  return recorder;
}

function startLoop(task, everyMs, onError) {
  let stopped = false;
  const promise = (async () => {
    while (!stopped) {
      const began = Date.now();
      try {
        await task();
      } catch (error) {
        onError(error);
        break;
      }
      if (!stopped) await sleep(Math.max(1, everyMs - (Date.now() - began)));
    }
  })();
  return { stop: () => { stopped = true; }, promise };
}

async function fetchSnapshot(originUrl) {
  if (!originUrl) throw new Error('origin URL is required for a window snapshot');
  const response = await fetch(`${originUrl}/harness/counters`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`origin counter snapshot HTTP ${response.status}`);
  return response.json();
}

export async function captureBoundary(kind, sessions, originUrl, manifest, manifestFile, ndjson, snapshotReader = fetchSnapshot) {
  const snapshots = {};
  for (const session of sessions) {
    const value = await session.tab.evaluate(boundaryExpression());
    snapshots[session.tag] = value;
    manifest.clients[session.tag].boundaries[kind] = value;
  }
  const origin = await snapshotReader(originUrl);
  fs.writeFileSync(path.join(path.dirname(manifestFile.path), `origin-counters-${kind}.json`), `${JSON.stringify(origin, null, 2)}\n`);
  if (kind === 'start') manifest.window.startMs = origin.atMs;
  else manifest.window.endMs = origin.atMs;
  manifest.window[`${kind}SnapshotAtMs`] = origin.atMs;
  manifestFile.write();
  return { snapshots, origin };
}

export async function drainClient(session, ndjson, atMs = Date.now()) {
  if (session.lastDrainAt !== null) {
    session.maxDrainGapMs = Math.max(session.maxDrainGapMs, atMs - session.lastDrainAt);
  }
  session.lastDrainAt = atMs;
  const result = await session.tab.evaluate(`__app.drift(${session.cursor})`);
  const latestSeq = Number(result?.latestSeq);
  if (Number.isFinite(latestSeq) && latestSeq < session.cursor) session.pageReset = true;
  const missed = Number(result?.missed);
  if (Number.isFinite(missed)) session.driftLogMissed += missed;
  for (const record of Array.isArray(result?.records) ? result.records : []) {
    session.records.push(record);
    ndjson.append(`client-${session.tag}.drift.ndjson`, [record]);
  }
  if (Number.isFinite(latestSeq)) session.cursor = Math.max(session.cursor, latestSeq);
  return result;
}

function queuedDrain(session, ndjson, atMs = Date.now()) {
  session.drainChain = (session.drainChain ?? Promise.resolve()).then(() => drainClient(session, ndjson, atMs));
  return session.drainChain;
}

export function decideFinalization({ evaluation, recomputed, failure = null, recomputeError = null, retainedOverflow = false, cleanupFailure = null } = {}) {
  if (failure || recomputeError || retainedOverflow) {
    return { status: 'aborted', outcome: 'failed', exitCode: 1, writeByte: false, reason: 'instrument-failure' };
  }
  if (evaluation?.runRefused) {
    return {
      status: 'refused',
      outcome: 'refused',
      exitCode: 1,
      writeByte: evaluation.figures?.byte === true && isPublishedFigure(recomputed?.publishedByte),
      reason: 'run-refusal',
    };
  }
  if (cleanupFailure) {
    return { status: 'aborted', outcome: 'failed', exitCode: 1, writeByte: false, reason: 'cleanup-failure' };
  }
  if (evaluation?.refused) {
    return {
      status: 'complete',
      outcome: 'pass',
      exitCode: 0,
      writeByte: evaluation.figures?.byte === true && isPublishedFigure(recomputed?.publishedByte),
      reason: 'publication-refusal',
    };
  }
  return {
    status: 'complete',
    outcome: 'pass',
    exitCode: 0,
    writeByte: isPublishedFigure(recomputed?.publishedByte),
    reason: 'published',
  };
}

function clearPublishedOutputs(runDir) {
  for (const name of ['published-figures.json', 'bytes-by-client.csv', 'utilisation.csv']) {
    fs.rmSync(path.join(runDir, name), { force: true });
  }
}

export function settleFinalization({ decision, manifestFile, runDir, recomputed, evaluation, cleanupFailure, startedAt, retained, writeFile = fs.writeFileSync, renameFile = fs.renameSync }) {
  const temporary = [];
  try {
    if (decision.writeByte) {
      if (!isPublishedFigure(recomputed?.publishedByte)) throw new Error('byte output is not a published figure');
      if (!recomputed.csv) throw new Error('published byte figure has no CSV output');
      const outputs = [
        ['published-figures.json', `${JSON.stringify(recomputed.publishedByte, null, 2)}\n`],
        ['bytes-by-client.csv', recomputed.csv.bytesByClient],
        ['utilisation.csv', recomputed.csv.utilisation],
      ];
      for (const [name, contents] of outputs) {
        const tempPath = path.join(runDir, `.${name}.${crypto.randomUUID()}.tmp`);
        temporary.push(tempPath);
        writeFile(tempPath, contents);
      }
      for (const [name] of outputs) renameFile(temporary.shift(), path.join(runDir, name));
    }
    manifestFile.merge({
      status: decision.status,
      outcome: decision.outcome,
      refusalReasons: evaluation?.reasons ?? [],
      figureEligibility: evaluation?.figures ?? {},
      figures: decision.writeByte ? { byte: recomputed.publishedByte } : {},
      cleanup: cleanupFailure ? { status: 'failed', error: cleanupFailure.message } : { status: 'complete' },
      failures: cleanupFailure ? [cleanupFailure.message] : [],
      runEndedAt: new Date().toISOString(),
      runWallMs: Date.now() - startedAt,
      retainedBytes: retained,
    });
    manifestFile.write();
    return decision;
  } catch (error) {
    for (const tempPath of temporary) fs.rmSync(tempPath, { force: true });
    clearPublishedOutputs(runDir);
    manifestFile.merge({
      status: 'aborted',
      outcome: 'failed',
      failures: [...(manifestFile.get()?.failures ?? []), error.message],
      runEndedAt: new Date().toISOString(),
      runWallMs: Date.now() - startedAt,
      retainedBytes: retained,
    });
    try { manifestFile.write(); } catch {}
    throw error;
  }
}

function evidenceFor(sessions, originStart, originEnd, manifest) {
  return {
    condition: manifest.condition,
    window: manifest.window,
    declaredClientTags: manifest.declaredClientTags,
    originStart,
    originEnd,
    clients: Object.fromEntries(sessions.map((session) => [session.tag, {
      records: session.records,
      polls: session.polls,
      finalPlayback: session.endPlayback,
      driftLogMissed: session.driftLogMissed,
      pageReset: session.pageReset === true,
      maxDriftDrainGapMs: session.maxDrainGapMs,
      tabCollision: session.tabCollision,
    }])),
    cdpQualification: manifest.cdpQualification,
    cadence: manifest.cadence,
  };
}

async function disposeSession(session) {
  session.removeCollisionListener?.();
  session.recorder?.dispose();
  if (session.dispose) await session.dispose();
}

export async function runHarness({ conditionName, runDir = defaultRunDir(conditionName), originUrl, clientOriginUrl = originUrl, topology = section3Topology(), clientFactory = noClientFactory, establishCadence = defaultEstablishCadence, qualifyCdpBytes = defaultQualifyCdpBytes } = {}) {
  const condition = conditionForName(conditionName);
  const startedAt = Date.now();
  const tags = tagsFor(condition);
  const roles = tags.map((tag, index) => index === 0 ? 'host' : 'viewer');
  const prepared = prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  const manifestFile = createManifestFile({ runDir: prepared.runDir, initial: initialManifest(conditionName, condition, prepared.runDir, startedAt, tags) });
  const ndjson = createNdjson(prepared.runDir);
  ndjson.write('origin-link.ndjson', []);
  for (const tag of tags) for (const name of streamNames(tag)) ndjson.write(name, []);
  manifestFile.write();
  const maxWallMs = Math.max(60_000, condition.runLengthMs + STARTUP_ALLOWANCE_MS);
  const deadline = createDeadline({ startedAt, maxWallMs });
  const room = `harness-${crypto.randomUUID()}`;
  const sessions = tags.map((tag, index) => ({ tag, role: roles[index], records: [], polls: [], driftLogMissed: 0, cursor: 0, maxDrainGapMs: 0, lastDrainAt: null, stallEpoch: crypto.randomUUID(), tabCollision: false, endPlayback: null }));
  const loops = [];
  let monitor = null;
  let failure = null;
  let cleanupFailure = null;
  let originStart;
  let originEnd;
  try {
    const preparedTopology = await topology.prepare({ condition, runDir: prepared.runDir, manifest: manifestFile.get() });
    manifestFile.merge({ topology: { status: 'prepared', ...preparedTopology } });
    manifestFile.set(mergeVerifiedContext(manifestFile.get(), preparedTopology));
    manifestFile.write();
    const qdiscs = await topology.applyQdiscs({ condition, runDir: prepared.runDir, manifest: manifestFile.get() });
    manifestFile.merge({ topology: { status: 'ready', qdiscs: qdiscs ?? condition.qdiscs } });
    manifestFile.write();
    if (!originUrl) throw new Error('origin URL is required for a harness run');
    monitor = startOriginMonitor({ healthUrl: `${originUrl}/room.html`, deadlineAt: deadline.deadlineAt, maxWallMs, onFailure: (event) => manifestFile.merge({ originFailure: event }) });
    monitor.promise.catch((error) => { failure ??= error; });
    for (const [index, session] of sessions.entries()) {
      const clientUrl = `${clientOriginUrl}/room.html?room=${encodeURIComponent(room)}&role=${session.role}&tab=${session.tag}`;
      const acquired = await clientFactory({ tag: session.tag, role: session.role, room, url: clientUrl, condition, runDir: prepared.runDir });
      Object.assign(session, acquired);
      if (index === 0 && !session.tab) {
        manifestFile.merge({ cdpQualification: failedCdpQualification('qualification-unavailable:first-client-tab') });
        manifestFile.write();
        throw new Error('first client tab is unavailable for CDP qualification');
      }
      await prepareClient(session, clientUrl, deadline);
      if (index === 0) {
        const qualification = await qualifyFirstClient(session.tab, preparedTopology.containers?.origin, qualifyCdpBytes);
        manifestFile.set(mergeVerifiedContext(manifestFile.get(), { cdpQualification: qualification }));
        manifestFile.write();
      }
      await session.startEcho?.({ room: `${room}-probe`, out: `/results/${path.basename(prepared.runDir)}/client-${session.tag}.echo.ndjson`, intervalMs: ECHO_INTERVAL_MS });
    }

    // Before the measure window, and its failure ends the run: a regime whose
    // cadence cannot be established cannot produce a criterion-1 figure this
    // project may quote (design.md D6).
    const cadence = await establishCadence(sessions, { condition, deadline });
    manifestFile.merge({ cadence, window: placeWindow(condition, Date.now()) });
    manifestFile.write();

    for (const session of sessions) {
      const poll = startLoop(async () => {
        const value = await session.tab.evaluate(pollExpression());
        session.polls.push(value);
        ndjson.append(`client-${session.tag}.poll.ndjson`, [value]);
      }, POLL_INTERVAL_MS, (error) => { failure ??= error; });
      const drain = startLoop(() => queuedDrain(session, ndjson), DRAIN_INTERVAL_MS, (error) => { failure ??= error; });
      loops.push(poll, drain);
    }
    await waitUntil(deadline, manifestFile.get().window.startMs);
    const startBoundary = await captureBoundary('start', sessions, originUrl, manifestFile.get(), manifestFile, ndjson);
    originStart = startBoundary.origin;
    await waitUntil(deadline, manifestFile.get().window.endMs);
    const endBoundary = await captureBoundary('end', sessions, originUrl, manifestFile.get(), manifestFile, ndjson);
    originEnd = endBoundary.origin;
    for (const session of sessions) session.endPlayback = endBoundary.snapshots[session.tag]?.playback;
    await Promise.all(sessions.map((session) => queuedDrain(session, ndjson)));
  } catch (error) {
    failure ??= error;
  } finally {
    for (const loop of loops) loop.stop();
    await Promise.all(loops.map((loop) => loop.promise.catch(() => {})));
    if (monitor) await stopOriginMonitor(monitor);
    for (const session of sessions) {
      try {
        const requests = session.recorder?.flush() ?? [];
        if (requests.length) ndjson.append(`client-${session.tag}.requests.ndjson`, requests);
        if (session.echoRecords?.length) ndjson.append(`client-${session.tag}.echo.ndjson`, session.echoRecords);
        manifestFile.merge({ clients: { ...manifestFile.get().clients, [session.tag]: {
          ...manifestFile.get().clients[session.tag],
          requestTimebase: 'measure-window',
          requestTimebaseMapping: session.recorder?.mapping ?? null,
          driftLogMissed: session.driftLogMissed,
          pageReset: session.pageReset === true,
          maxDriftDrainGapMs: session.maxDrainGapMs,
          tabCollision: session.tabCollision,
          playbackEnd: session.endPlayback,
        } } });
        await disposeSession(session);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try {
      await topology.teardown({ condition, runDir: prepared.runDir, manifest: manifestFile.get() });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (failure) {
    runFinally({ manifest: manifestFile, failure, cleanupFailure, startedAt, runDir: prepared.runDir, tabs: sessions, withWallAndBytes: true });
    throw failure;
  }
  let retained;
  let recomputed;
  let evaluation;
  try {
    retained = retainedBytes(prepared.runDir);
    if (retained > MAX_RETAINED_BYTES) throw new Error(`retained evidence exceeds ${MAX_RETAINED_BYTES} bytes`);
    recomputed = recomputeRunDirectory(prepared.runDir);
    const publicationContext = { ...manifestFile.get(), ...recomputed.figures, declaredClientTags: tags };
    evaluation = evaluateRefusals({ ...evidenceFor(sessions, originStart, originEnd, manifestFile.get()), publicationContext });
    const decision = decideFinalization({ evaluation, recomputed, cleanupFailure });
    const report = { ...recomputed, refusal: evaluation, finalization: decision };
    settleFinalization({ decision, manifestFile, runDir: prepared.runDir, recomputed, evaluation, cleanupFailure, startedAt, retained });
    fs.writeFileSync(path.join(prepared.runDir, 'refusal-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return { runDir: prepared.runDir, status: manifestFile.get().status, exitCode: decision.exitCode, report };
  } catch (error) {
    runFinally({ manifest: manifestFile, failure: error, cleanupFailure, startedAt, runDir: prepared.runDir, tabs: sessions, withWallAndBytes: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseHarnessArguments(argv);
  if (parsed.help) {
    console.log('usage: node scripts/harness-run.mjs --condition=<name> [--run-dir=<dir> ]');
    return 0;
  }
  const { createComposeTopology } = await import('./harness/topology.mjs');
  const composed = createComposeTopology();
  const result = await runHarness({
    conditionName: parsed.conditionName,
    runDir: parsed.runDir ? path.resolve(parsed.runDir) : undefined,
    originUrl: composed.originUrl,
    clientOriginUrl: composed.clientOriginUrl,
    topology: composed,
    clientFactory: (request) => composed.clientFactory(request),
  });
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
