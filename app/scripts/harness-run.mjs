import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDeadline, createManifestFile, createNdjson, prepareRunDirectory, retainedBytes, runFinally } from './runner/core.mjs';
import { startOriginMonitor, stopOriginMonitor } from './runner/origin-monitor.mjs';
import { recomputeRunDirectory } from './harness-figures.mjs';
import { isPublishedFigure } from './figures/publication.mjs';
import { attachClockJoinRecorder, attachPresenceRecorder, attachTabTakenDetector, boundaryExpression, createRequestRecorder, installStallRecorder, pollExpression } from './harness/cdp-records.mjs';
import { urlsForDelivery } from './harness/topology.mjs';
import { maybeInjectDisturbance } from './harness/disturbance.mjs';
import {
  beginLinkQualification as defaultBeginLinkQualification, finishLinkQualification as defaultFinishLinkQualification,
  hostEstimateNear, qualifyCdpBytes as defaultQualifyCdpBytes,
} from './harness/qualification.mjs';
import { evaluateRefusals } from './harness/refusals.mjs';
import { armFor, clientTags } from './harness/arms.mjs';
import { validateEngineWindows } from '../public/lib/engine-windows.mjs';
import { validateHeadroomFraction } from '../public/lib/send-pace.mjs';
import { parseRate, parseSize, parseTime } from '../harness/apply-qdisc.mjs';
import {
  capacityBeforeReadings, issuedSeekEvidence, landedSeekEvidence, restartedSeekEvidence, stepThenSeek,
  waitForAppliedSeek,
} from './harness/seek-sequence.mjs';
import { startCpuSampler } from './harness/cpu-sampler.mjs';
import { createControlEvidence, recordingEndForSeek } from './harness/control-evidence.mjs';
import { timebaseJoin } from './figures/control-figures.mjs';
import { assignmentControlReason, recordControls } from './harness/assignment-control.mjs';
import { capacityScheduleReason, recordSchedule, scheduleLengthMs } from './harness/capacity-schedule.mjs';
import { createAskEvidence, recordHostStats } from './harness/ask-evidence.mjs';
import { finalizeRosterEvent, isHeldJoin, issueRosterEvent, rosterEventTarget } from './harness/roster-event.mjs';
import { viewerOrder } from '../public/lib/edge-assignment.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const CONDITIONS_PATH = path.join(APP_DIR, 'harness', 'conditions.json');
const MAX_RETAINED_BYTES = 200 * 1024 * 1024;
const POLL_INTERVAL_MS = 125;
const DRAIN_INTERVAL_MS = 15_000;
const ECHO_INTERVAL_MS = 250;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function conditionValidationReason(condition = {}) {
  const peer = condition.peerExchange === true;
  if (peer && condition.delivery !== 'host') return 'peer-exchange-requires-host-delivery';
  if (peer && Object.prototype.hasOwnProperty.call(condition.bars ?? {}, 'peerFractionAbsMax')) {
    return 'peer-condition-declares-peer-fraction-bar';
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'engineWindows')
    && validateEngineWindows(condition.engineWindows).error) return 'engine-windows-invalid';
  if (Object.prototype.hasOwnProperty.call(condition, 'headroomFraction')) {
    if (condition.delivery !== 'host') return 'headroom-fraction-requires-host-delivery';
    if (validateHeadroomFraction(condition.headroomFraction).error) return 'headroom-fraction-invalid';
  }
  if (assignmentControlReason(condition)) return assignmentControlReason(condition);
  if (capacityScheduleReason(condition)) return capacityScheduleReason(condition);
  if (Object.prototype.hasOwnProperty.call(condition, 'seek')) {
    const seek = condition.seek;
    const keys = object(seek) ? Object.keys(seek).sort().join(',') : '';
    if (!object(seek) || keys !== 'appliedTimeoutMs,deltaMs,issueAfterReadyMs'
      || !Number.isFinite(seek.issueAfterReadyMs)
      || seek.issueAfterReadyMs < 0
      || seek.issueAfterReadyMs !== condition.excludedPrefixMs
      || !Number.isFinite(seek.deltaMs)
      || seek.deltaMs <= 0
      || !Number.isFinite(seek.appliedTimeoutMs)
      || seek.appliedTimeoutMs <= 0) return 'seek-invalid';
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'capacityStep')) {
    const step = condition.capacityStep;
    const params = step?.params;
    const stepKeys = object(step) ? Object.keys(step).sort().join(',') : '';
    const keys = object(params) ? Object.keys(params).sort().join(',') : '';
    const parsed = object(params) && keys === 'burst,latency,rate'
      ? [parseRate(params.rate), parseSize(params.burst), parseTime(params.latency)] : [];
    if (!object(step) || stepKeys !== 'container,discipline,network,params' || step.container !== 'origin' || step.network !== 'wa-media'
      || step.discipline !== 'tbf' || keys !== 'burst,latency,rate'
      || Object.values(params ?? {}).some((value) => typeof value !== 'string' || value.length === 0)
      || parsed.some((value) => !Number.isFinite(value) || value <= 0)
      || condition.seek === undefined) return 'capacity-step-invalid';
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'machineTest')) {
    const machine = condition.machineTest;
    const machineKeys = object(machine) ? Object.keys(machine).sort().join(',') : '';
    const bars = machine?.bars;
    const barKeys = object(bars) ? Object.keys(bars).sort().join(',') : '';
    if (!object(machine) || machineKeys !== 'bars,cpuSampleIntervalMs,pageEvaluationIntervalMs'
      || !Number.isInteger(machine.cpuSampleIntervalMs) || machine.cpuSampleIntervalMs <= 0
      || machine.pageEvaluationIntervalMs !== 250 || barKeys !== 'droppedFrameFractionMax,evaluationShortfallMax,realtimeMin'
      || Object.values(bars).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      return 'machine-test-invalid';
    }
  }
  if (!Object.prototype.hasOwnProperty.call(condition, 'positionOffsetMsByClient')) return null;
  const offsets = condition.positionOffsetMsByClient;
  if (!peer || !offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return 'position-offset-invalid';
  const tags = clientTags(condition);
  const keys = Object.keys(offsets);
  if (keys.length !== tags.length || keys.some((tag) => !tags.includes(tag))) return 'position-offset-invalid';
  if (tags.some((tag) => !Object.prototype.hasOwnProperty.call(offsets, tag)
    || !Number.isSafeInteger(offsets[tag]) || offsets[tag] < 0 || offsets[tag] > 600_000)) return 'position-offset-invalid';
  return null;
}

export function validateCondition(condition = {}, name = condition.name) {
  const reason = conditionValidationReason(condition);
  if (reason) throw new Error(`${reason}${name ? `: ${name}` : ''}`);
  return condition;
}

export function loadConditions(filePath = CONDITIONS_PATH) {
  const matrix = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const [name, condition] of Object.entries(matrix)) {
    if (name === 'schemaVersion') continue;
    if (name === 'shakedown') {
      for (const [arm, value] of Object.entries(condition ?? {})) validateCondition(value, `shakedown/${arm}`);
    } else validateCondition(condition, name);
  }
  return freeze(matrix);
}

export const conditions = loadConditions();

export function conditionForName(name, matrix = conditions) {
  if (matrix[name]) return validateCondition(matrix[name], name);
  const [group, arm] = String(name).split('/');
  if (group === 'shakedown' && matrix.shakedown?.[arm]) return validateCondition(matrix.shakedown[arm], name);
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

function defaultRunDir(conditionName, condition = conditionForName(conditionName)) {
  const prefix = armFor(condition).runDirPrefix;
  return path.join(RESULTS_DIR, `${prefix}-${safeName(conditionName)}-${new Date().toISOString().replaceAll(':', '-')}`);
}

function newSession(tag, role) {
  return { tag, role, records: [], polls: [], driftLogMissed: 0, cursor: 0, maxDrainGapMs: 0,
    lastDrainAt: null, stallEpoch: crypto.randomUUID(), tabCollision: false, endPlayback: null,
    active: false, expectedEvent: false, measureLoops: [], controlLoop: null };
}

function clientDeclaration(tags, roles) {
  return Object.fromEntries(tags.map((tag, index) => [tag, {
    tag,
    role: roles[index],
    requestTimebase: 'measure-window',
    boundaries: { start: null, end: null },
  }]));
}

function streamNames(tag, streams) {
  return streams.map((kind) => `client-${tag}.${kind}.ndjson`);
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

function initialManifest(condition, runDir, startedAt, { tags, hostTag, declaredTags, declaredRoles }) {
  // Provisional until the clients are ready; `placeWindow` re-places it then.
  const { clientsReadyAtMs: _provisional, ...window } = placeWindow(condition, startedAt);
  return {
    schemaVersion: 1,
    byteAccountingMethod: armFor(condition).byteAccountingMethod,
    runId: path.basename(runDir),
    status: 'running',
    outcome: 'running',
    startedAt: new Date(startedAt).toISOString(),
    condition: JSON.parse(JSON.stringify(condition)),
    declaredClientTags: tags,
    clientTags: tags,
    clients: clientDeclaration(declaredTags, declaredRoles),
    ...(hostTag ? { originTab: { tag: hostTag, role: 'host', container: 'origin' } } : {}),
    window,
    content: JSON.parse(JSON.stringify(condition.content)),
    regime: JSON.parse(JSON.stringify(condition)),
    cadence: null,
    cdpQualification: null,
    disturbance: condition.disturbance ?? null,
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

export function requireDeclaredDelivery(condition, name = condition?.name) {
  if (condition?.delivery === undefined) throw new Error(`condition ${name} declares no delivery path`);
  armFor(condition);
}

export function mergeVerifiedContext(manifest, seam = {}) {
  const next = { ...manifest };
  for (const field of ['content', 'regime', 'cadence', 'cdpQualification']) {
    if (seam[field] !== undefined) next[field] = seam[field];
  }
  return next;
}

// The ready merge keeps what prepare recorded: a host run's control-UDP drop and
// default-route read-backs are manifest evidence (7a2 acceptance A7), and a host
// topology missing either aborts the run before any client starts.
export function readyTopology(prepared, qdiscs, condition) {
  return armFor(condition).readyTopology({ ...prepared, status: 'ready', qdiscs: qdiscs ?? condition.qdiscs }, condition);
}

/**
 * How long a viewer's page may take to become ready. A host run's later viewers
 * load the bundle over a shaped link the earlier viewers already fill, and 30 s
 * aborted a capped arm (7a2 design.md D3). The wait is before `placeWindow`, so
 * no figure sees it; each client's wait is recorded as `pageReadyMs`.
 */
export function clientReadyTimeoutMs(condition) {
  return armFor(condition).clientReadyTimeoutMs(condition);
}

async function prepareClient(session, url, deadline, readyTimeoutMs = 30_000, options = {}) {
  const tab = session.tab;
  const recorder = createRequestRecorder(tab);
  session.recorder = recorder;
  await tab.send('Network.enable');
  await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
  await tab.send('Page.enable');
  const pageClock = await tab.evaluate('({ wallMs: Date.now(), performanceNowMs: performance.now() })');
  recorder.setPageMapping(pageClock);
  session.removeCollisionListener = attachTabTakenDetector(tab, () => { session.tabCollision = true; });
  session.clockJoinRecorder = attachClockJoinRecorder(tab);
  session.presenceRecorder = attachPresenceRecorder(tab);
  const navigatedAt = Date.now();
  await options.beforeNavigate?.(session);
  await tab.send('Page.navigate', { url });
  await deadline.waitFor(`client ${session.tag}`, () => tab.evaluate('Boolean(document.body && window.__app)'), Boolean, readyTimeoutMs, 100);
  session.pageReadyMs = Date.now() - navigatedAt;
  await options.afterReady?.(session, { deadline, readyTimeoutMs });
  await tab.evaluate(installStallRecorder(session.stallEpoch));
  return recorder;
}

async function prepareHostClient(session, url, deadline, options = {}) {
  await session.tab.send('Network.enable');
  await session.tab.send('Page.enable');
  session.presenceRecorder = attachPresenceRecorder(session.tab);
  await options.beforeNavigate?.(session);
  await session.tab.send('Page.navigate', { url });
  await deadline.waitFor(`host ${session.tag}`, () => session.tab.evaluate('Boolean(window.__app && __app.hostCounters())'), Boolean, 30_000, 100);
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

export async function captureBoundary(kind, sessions, originUrl, manifest, manifestFile, ndjson, snapshotReader = fetchSnapshot, options = {}, arm = armFor(manifest.condition)) {
  const snapshots = {};
  for (const session of sessions) {
    const value = await session.tab.evaluate(boundaryExpression());
    snapshots[session.tag] = value;
    manifest.clients[session.tag].boundaries[kind] = value;
  }
  const room = await snapshotReader(originUrl);
  const topology = await options.topologyBoundaryReader?.(kind, room);
  const { origin } = await arm.captureBoundaryExtras(kind, {
    room,
    sessions,
    manifestFile,
    ndjson,
    runDir: path.dirname(manifestFile.path),
    options,
  });
  if (kind === 'start') manifest.window.startMs = origin.atMs;
  else manifest.window.endMs = origin.atMs;
  manifest.window[`${kind}SnapshotAtMs`] = origin.atMs;
  if (topology) {
    const current = manifest.topology ?? {};
    manifest.topology = { ...current, boundaries: { ...(current.boundaries ?? {}), [kind]: topology } };
  }
  manifestFile.write();
  return { snapshots, origin, room, topology };
}

export async function drainClient(session, ndjson, atMs = Date.now(), options = {}) {
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

function queuedDrain(session, ndjson, arm, atMs = Date.now()) {
  session.drainChain = (session.drainChain ?? Promise.resolve()).then(() => arm.drain(session, ndjson, atMs, drainClient));
  return session.drainChain;
}

export function decideFinalization({ evaluation, recomputed, figureKinds, failure = null, recomputeError = null, retainedOverflow = false, cleanupFailure = null } = {}) {
  const hasKinds = Array.isArray(figureKinds);
  const byteAllowed = !hasKinds || figureKinds.includes('byte');
  const driftAllowed = hasKinds && figureKinds.includes('drift');
  const behindAllowed = hasKinds && figureKinds.includes('behind');
  const publishedByte = isPublishedFigure(recomputed?.publishedByte);
  const publishedDrift = isPublishedFigure(recomputed?.publishedDrift);
  const behindFigure = Array.isArray(recomputed?.behind) ? recomputed.behind : null;
  const byteEligible = evaluation?.figures?.byte
    ?? (!evaluation?.refused && !evaluation?.runRefused);
  const aborted = (reason) => ({ status: 'aborted', outcome: 'failed', exitCode: 1, writeByte: false, writeDrift: false,
    ...(behindAllowed ? { writeBehind: false } : {}), reason });
  if (failure || recomputeError || retainedOverflow) return aborted('instrument-failure');
  // A run refusal outranks a cleanup failure; a cleanup failure outranks a pass.
  if (!evaluation?.runRefused && cleanupFailure) return aborted('cleanup-failure');
  const writes = {
    writeByte: byteAllowed && byteEligible && publishedByte,
    // Refusal scopes, not the run's status, decide what is withheld: a byte-only
    // run refusal leaves drift eligible (6a design.md D5; d1-findings.md F2).
    writeDrift: driftAllowed && evaluation?.figures?.drift === true && publishedDrift,
    ...(behindAllowed ? { writeBehind: behindFigure !== null } : {}),
    // The churn readings are rows that carry their own refusals, as the behind rows do.
    ...(hasKinds && figureKinds.includes('roster-event') ? { writeRosterEvent: Array.isArray(recomputed?.rosterEvent) } : {}),
    ...(hasKinds && figureKinds.includes('distance-behind') ? { writeDistanceBehind: Boolean(recomputed?.distanceBehind) } : {}),
  };
  if (evaluation?.runRefused) return { status: 'refused', outcome: 'refused', exitCode: 1, ...writes, reason: 'run-refusal' };
  return { status: 'complete', outcome: 'pass', exitCode: 0, ...writes, reason: evaluation?.refused ? 'publication-refusal' : 'published' };
}

function clearPublishedOutputs(runDir) {
  for (const name of ['published-figures.json', 'bytes-by-client.csv', 'utilisation.csv', 'published-drift.json', 'drift-series.csv', 'drift.svg', 'published-behind.json',
    'published-roster-event.json', 'published-distance-behind.json']) {
    fs.rmSync(path.join(runDir, name), { force: true });
  }
}

export function settleFinalization({ decision, manifestFile, runDir, recomputed, evaluation, cleanupFailure, startedAt, retained, writeFile = fs.writeFileSync, renameFile = fs.renameSync }) {
  const temporary = [];
  try {
    const outputs = [];
    if (decision.writeByte) {
      if (!isPublishedFigure(recomputed?.publishedByte)) throw new Error('byte output is not a published figure');
      if (!recomputed.csv) throw new Error('published byte figure has no CSV output');
      outputs.push(...[
        ['published-figures.json', `${JSON.stringify(recomputed.publishedByte, null, 2)}\n`],
        ['bytes-by-client.csv', recomputed.csv.bytesByClient],
        ['utilisation.csv', recomputed.csv.utilisation],
      ]);
    }
    if (decision.writeDrift) {
      if (!isPublishedFigure(recomputed?.publishedDrift)) throw new Error('drift output is not a published figure');
      if (recomputed.driftCsv === undefined || recomputed.driftSvg === undefined) throw new Error('published drift figure has no plot output');
      outputs.push(...[
        ['published-drift.json', `${JSON.stringify(recomputed.publishedDrift, null, 2)}\n`],
        ['drift-series.csv', recomputed.driftCsv],
        ['drift.svg', recomputed.driftSvg],
      ]);
    }
    if (decision.writeBehind) {
      if (!Array.isArray(recomputed?.behind)) throw new Error('behind output is not an array of rows');
      outputs.push(['published-behind.json', `${JSON.stringify(recomputed.behind, null, 2)}\n`]);
    }
    if (decision.writeRosterEvent) outputs.push(['published-roster-event.json', `${JSON.stringify(recomputed.rosterEvent, null, 2)}\n`]);
    if (decision.writeDistanceBehind) outputs.push(['published-distance-behind.json', `${JSON.stringify(recomputed.distanceBehind, null, 2)}\n`]);
    for (const [name, contents] of outputs) {
      const tempPath = path.join(runDir, `.${name}.${crypto.randomUUID()}.tmp`);
      temporary.push(tempPath);
      writeFile(tempPath, contents);
    }
    for (const [name] of outputs) renameFile(temporary.shift(), path.join(runDir, name));
    const figures = {};
    if (decision.writeByte) figures.byte = recomputed.publishedByte;
    if (decision.writeDrift) figures.drift = recomputed.publishedDrift;
    if (decision.writeBehind) figures.behind = recomputed.behind;
    if (decision.writeRosterEvent) figures.rosterEvent = recomputed.rosterEvent;
    if (decision.writeDistanceBehind) figures.distanceBehind = recomputed.distanceBehind;
    manifestFile.merge({
      status: decision.status,
      outcome: decision.outcome,
      refusalReasons: evaluation?.reasons ?? [],
      figureEligibility: evaluation?.figures ?? {},
      figures,
      ...(recomputed?.publishedDrift?.published === false ? { driftPublication: recomputed.publishedDrift } : {}),
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

function evidenceFor(sessions, originStart, originEnd, manifest, runDir, hostEvidence = {}, arm = armFor(manifest.condition)) {
  const base = {
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
    startWait: manifest.startWait ?? null,
    seek: manifest.seek ?? null,
    capacityStep: manifest.capacityStep ?? null,
    capacitySchedule: manifest.capacitySchedule ?? null,
    rosterEvent: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(runDir, 'roster-event.json'), 'utf8')); } catch { return null; }
    })(),
    presence: Object.fromEntries(manifest.declaredClientTags.map((tag) => {
      try {
        return [tag, fs.readFileSync(path.join(runDir, `client-${tag}.presence.ndjson`), 'utf8')
          .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))];
      } catch { return [tag, []]; }
    })),
    topologyBoundaries: manifest.topology?.boundaries ?? null,
  };
  return { ...base, ...arm.evidence(sessions, hostEvidence, runDir) };
}

async function disposeSession(session) {
  session.removeCollisionListener?.();
  session.clockJoinRecorder?.dispose();
  session.presenceRecorder?.dispose();
  session.recorder?.dispose();
  if (session.dispose) await session.dispose();
}

export async function runHarness({ conditionName, condition = conditionForName(conditionName), runDir = null, originUrl, clientOriginUrl = originUrl, hostPageUrl = clientOriginUrl, topology = section3Topology(), clientFactory = noClientFactory, establishCadence = defaultEstablishCadence, qualifyCdpBytes = defaultQualifyCdpBytes, beginLinkQualification = defaultBeginLinkQualification, finishLinkQualification = defaultFinishLinkQualification } = {}) {
  validateCondition(condition, conditionName ?? condition.name);
  const arm = armFor(condition);
  requireDeclaredDelivery(condition, conditionName ?? condition.name);
  runDir ??= defaultRunDir(conditionName, condition);
  if (condition.backgroundLoadProtocol === 'udp' && condition.backgroundLoadMbps == null) {
    throw new Error(`UDP background load requires a declared rate for condition ${condition.name}`);
  }
  const startedAt = Date.now();
  // Who joins a run. An http run's first client is the host; a host run adds the
  // origin-side host tab c00, and every client is a viewer.
  const members = arm.members(condition);
  const { tags, roles } = members;
  const prepared = prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir });
  const manifestFile = createManifestFile({ runDir: prepared.runDir, initial: initialManifest(condition, prepared.runDir, startedAt, members) });
  const ndjson = createNdjson(prepared.runDir);
  ndjson.write('origin-link.ndjson', []);
  if (arm.hostTag) {
    ndjson.write('host-control-poll.ndjson', []);
    ndjson.write('host-pace.ndjson', []);
    ndjson.write('host-resumes.ndjson', []);
    for (const tag of tags) ndjson.write(`viewer-control-${tag}.ndjson`, []);
  }
  for (const tag of members.declaredTags) for (const name of streamNames(tag, arm.streams)) ndjson.write(name, []);
  manifestFile.write();
  const recordingTailAllowanceMs = condition.seek ? 180_000 : 0;
  const maxWallMs = Math.max(60_000, Math.max(condition.runLengthMs, scheduleLengthMs(condition)) + STARTUP_ALLOWANCE_MS + recordingTailAllowanceMs);
  const deadline = createDeadline({ startedAt, maxWallMs });
  const room = `harness-${crypto.randomUUID()}`;
  const sessions = tags.map((tag, index) => ({ ...newSession(tag, roles[index]), receiptCursor: 0, receiptLogMissed: 0, receiptLogReset: false }));
  const heldTag = isHeldJoin(condition) ? rosterEventTarget(condition) : null;
  const activeSessions = () => sessions.filter((session) => session.active === true);
  let originSession = null;
  let allSessions = sessions;
  const loops = [];
  let monitor = null;
  let failure = null;
  let cleanupFailure = null;
  let originStart;
  let originEnd;
  let injectionHarnessMs = null;
  const hostEvidence = {};
  let boundaryOptions = {};
  let seekEvidence = null;
  let cpuSampler = null;
  let controlEvidence = null;
  let askEvidence = null;
  let recordingEndTargetMs = null;
  let rosterEvent = null;
  try {
    const preparedTopology = await topology.prepare({ condition, runDir: prepared.runDir, manifest: manifestFile.get() });
    manifestFile.merge({ topology: { status: 'prepared', ...preparedTopology } });
    manifestFile.set(mergeVerifiedContext(manifestFile.get(), preparedTopology));
    manifestFile.write();
    const qdiscs = await topology.applyQdiscs({ condition, runDir: prepared.runDir, manifest: manifestFile.get() });
    manifestFile.merge({ topology: readyTopology(manifestFile.get().topology, qdiscs, condition) });
    manifestFile.write();
    if (condition.machineTest) {
      const declaredTags = clientTags(condition);
      const containers = Object.entries(preparedTopology.containers ?? {})
        .filter(([name]) => name === 'origin' || declaredTags.includes(name))
        .map(([, container]) => container);
      cpuSampler = startCpuSampler({
        runDir: prepared.runDir,
        containers,
        intervalMs: condition.machineTest.cpuSampleIntervalMs,
      });
    }
    if (!originUrl) throw new Error('origin URL is required for a harness run');
    monitor = startOriginMonitor({ healthUrl: `${originUrl}/room.html`, deadlineAt: deadline.deadlineAt, maxWallMs, onFailure: (event) => manifestFile.merge({ originFailure: event }), requestTimeoutMs: condition.monitorRequestTimeoutMs });
    monitor.promise.catch((error) => { failure ??= error; });
    originSession = await arm.openSessions({ room, clientOriginUrl, hostPageUrl, clientFactory, condition, runDir: prepared.runDir, deadline, newSession, prepareHostClient });
    allSessions = originSession ? [originSession, ...sessions] : sessions;
    if (originSession) {
      controlEvidence = createControlEvidence({ hostSession: originSession, ndjson, runDir: prepared.runDir });
      askEvidence = createAskEvidence({ ndjson, runDir: prepared.runDir });
      const hostPoll = startLoop(() => controlEvidence.pollHost(), 250, (error) => { failure ??= error; });
      loops.push(hostPoll);
    }
    boundaryOptions = arm.boundaryOptions(originSession ? [originSession, ...sessions] : sessions);
    boundaryOptions.loopbackReader = () => topology.readLoopbackCounter();
    boundaryOptions.viewerLinkReader = () => topology.readViewerLinkCounters?.() ?? null;
    boundaryOptions.topologyBoundaryReader = (kind, room) => topology.captureBoundary?.({
      kind, room, condition, runDir: prepared.runDir, manifest: manifestFile.get(),
    });
    let pendingQualification = null;
    let lastJoinAtMs = null;
    const qualifyFirst = async () => {
      const qualification = await arm.qualify(activeSessions(), {
        originSession,
        originContainer: preparedTopology.containers?.origin,
        qualifyCdpBytes,
        finishLinkQualification,
        pending: pendingQualification,
      });
      manifestFile.set(mergeVerifiedContext(manifestFile.get(), { cdpQualification: qualification }));
      if (qualification?.instants) {
        manifestFile.merge({ qualification: {
          ...qualification.instants,
          lastJoinAtMs,
          hostEstimateAtCompletion: hostEstimateNear(controlEvidence?.estimates, qualification.instants.fetchCompletedAtMs),
        } });
      }
      manifestFile.write();
    };
    const startEcho = (session) => session.startEcho?.({ room: `${room}-probe`, out: `/results/${path.basename(prepared.runDir)}/client-${session.tag}.echo.ndjson`, intervalMs: ECHO_INTERVAL_MS, condition });
    const startControlLoop = (session) => {
      if (!controlEvidence || session.controlLoop) return;
      const viewerPoll = startLoop(async () => { await controlEvidence.pollViewer(session); await askEvidence.drain(session); },
        250, (error) => { if (!session.expectedEvent) failure ??= error; });
      session.controlLoop = viewerPoll;
      loops.push(viewerPoll);
    };
    const startMeasureLoops = (session) => {
      if (session.measureLoops?.length) return;
      const poll = startLoop(async () => {
        const value = await session.tab.evaluate(pollExpression());
        session.polls.push(value);
        ndjson.append(`client-${session.tag}.poll.ndjson`, [value]);
      }, POLL_INTERVAL_MS, (error) => { if (!session.expectedEvent) failure ??= error; });
      const drain = startLoop(() => queuedDrain(session, ndjson, arm, Date.now()), DRAIN_INTERVAL_MS,
        (error) => { if (!session.expectedEvent) failure ??= error; });
      session.measureLoops = [poll, drain];
      loops.push(poll, drain);
    };
    const stopSessionLoops = async (session, { keepControl = false } = {}) => {
      for (const loop of session.measureLoops ?? []) loop.stop();
      if (!keepControl) session.controlLoop?.stop();
      await Promise.all([...(session.measureLoops ?? []), ...(keepControl ? [] : [session.controlLoop])]
        .filter(Boolean).map((loop) => loop.promise.catch(() => {})));
      session.measureLoops = [];
      if (!keepControl) session.controlLoop = null;
    };
    const activateHeldJoiner = async (session) => {
      const clientUrl = `${clientOriginUrl}/room.html?room=${encodeURIComponent(room)}&role=${session.role}&tab=${session.tag}`;
      await prepareClient(session, clientUrl, deadline, arm.clientReadyTimeoutMs(condition), arm.prepareClientOptions({
        condition, manifestFile, runDir: prepared.runDir,
      }));
      session.active = true;
      startControlLoop(session);
      startMeasureLoops(session);
      await startEcho(session);
      return { navigated: true, pageReadyMs: session.pageReadyMs };
    };
    for (const [index, session] of sessions.entries()) {
      const clientUrl = `${clientOriginUrl}/room.html?room=${encodeURIComponent(room)}&role=${session.role}&tab=${session.tag}`;
      const acquired = await clientFactory({ tag: session.tag, role: session.role, room, url: clientUrl, condition, runDir: prepared.runDir });
      Object.assign(session, acquired);
      if (session.tag === heldTag) continue;
      if (index === 0 && !session.tab) {
        manifestFile.merge({ cdpQualification: failedCdpQualification('qualification-unavailable:first-client-tab') });
        manifestFile.write();
        throw new Error('first client tab is unavailable for CDP qualification');
      }
      await prepareClient(session, clientUrl, deadline, arm.clientReadyTimeoutMs(condition), arm.prepareClientOptions({
        condition,
        manifestFile,
        runDir: prepared.runDir,
      }));
      session.active = true;
      if (controlEvidence) {
        const viewerPoll = startLoop(async () => { await controlEvidence.pollViewer(session); await askEvidence.drain(session); },
          250, (error) => { if (!session.expectedEvent) failure ??= error; });
        session.controlLoop = viewerPoll;
        loops.push(viewerPoll);
      }
      if (index === 0 && !arm.qualifyAfterJoins) await qualifyFirst();
      // Not awaited: the joins go on while the first viewer's fetch is in flight.
      if (index === 0 && arm.qualifyAfterJoins) {
        pendingQualification = Promise.resolve(arm.beginQualification(activeSessions(), { beginLinkQualification }));
        pendingQualification.catch(() => {});
      }
      if (!arm.qualifyAfterJoins) await startEcho(session);
    }
    // 8b design.md D3 (i): the host arm's room starts once its roster has been still
    // for 2 s, so its viewers all join before the first's qualification is collected.
    if (arm.qualifyAfterJoins) {
      lastJoinAtMs = Date.now();
      await qualifyFirst();
      for (const session of activeSessions()) await startEcho(session);
    }
    const readControl = async () => {
      if (!originSession) return;
      hostEvidence.assignmentControl = await recordControls({ condition, sessions: originSession ? [originSession, ...activeSessions()] : activeSessions(),
        record: hostEvidence.assignmentControl, runDir: prepared.runDir, manifestFile });
    };
    await readControl();

    // Before the measure window, and its failure ends the run: a regime whose
    // cadence cannot be established cannot produce a criterion-1 figure this
    // project may quote (design.md D6).
    await arm.openWindow({
      sessions: activeSessions(), condition, deadline, establishCadence, manifestFile, placeWindow,
      drainAll: () => Promise.all(activeSessions().map((session) => queuedDrain(session, ndjson, arm, Date.now()))),
      drainEveryMs: DRAIN_INTERVAL_MS,
    });
    manifestFile.write();

    for (const session of activeSessions()) startMeasureLoops(session);
    await waitUntil(deadline, manifestFile.get().window.startMs);
    const latestRoster = () => activeSessions().flatMap((session) => session.presenceRecorder?.snapshot?.() ?? [])
      .filter((record) => Array.isArray(record?.roster)).sort((left, right) => left.seq - right.seq).at(-1)?.roster ?? [];
    const viewerIds = () => viewerOrder(latestRoster());
    const clientIds = () => Object.fromEntries(latestRoster().map((member) => [member.tabId, member.clientId]));
    const issueEvent = async ({ client = null } = {}) => {
      const kind = condition.rosterEvent?.kind;
      const targetTag = client ?? rosterEventTarget(condition, kind);
      const target = sessions.find((session) => session.tag === targetTag);
      if (!target) throw new Error(`roster event target is unavailable: ${targetTag}`);
      target.expectedEvent = true;
      rosterEvent = await issueRosterEvent({ condition, topology, sessions, targetSession: target, room,
        client: targetTag, runDir: prepared.runDir,
        activateJoin: targetTag === heldTag ? activateHeldJoiner : undefined,
        stopSession: ['leave-clean', 'leave-first'].includes(kind)
          ? (session) => stopSessionLoops(session)
          : undefined,
        disposeSession: () => target.dispose?.(),
      });
      if (kind !== 'drop-socket') target.active = false;
      return rosterEvent;
    };
    if (condition.rosterEvent && condition.rosterEvent.kind !== 'leave-first') await issueEvent();
    const injection = await maybeInjectDisturbance(activeSessions(), condition.disturbance);
    if (injection) {
      injectionHarnessMs = injection.injectionHarnessMs;
      const disturbance = { ...condition.disturbance, ...injection };
      manifestFile.merge({ disturbance });
      fs.writeFileSync(path.join(prepared.runDir, 'disturbance.json'), `${JSON.stringify(disturbance, null, 2)}\n`);
      manifestFile.write();
    }
    const drainAll = () => Promise.all(activeSessions().map((session) => queuedDrain(session, ndjson, arm, Date.now())));
    const writeSeek = (evidence) => {
      seekEvidence = evidence;
      manifestFile.merge({ seek: seekEvidence });
      fs.writeFileSync(path.join(prepared.runDir, 'seek.json'), `${JSON.stringify(seekEvidence, null, 2)}\n`);
      manifestFile.write();
    };
    // A condition that declares no seek gets neither step nor seek back.
    const sequence = await stepThenSeek({
      condition,
      topology,
      readHostState: () => boundaryOptions.originSession.tab.evaluate('__app.playbackState()'),
      stepQdisc: topology.stepQdisc ? (capacityStep) => topology.stepQdisc({ capacityStep }) : undefined,
      seek: (deltaMs) => boundaryOptions.originSession.tab.evaluate(`__app.harnessSeek(${JSON.stringify(deltaMs)})`),
      drainAll,
    });
    if (sequence.capacityStep) {
      sequence.capacityStep.before = capacityBeforeReadings(manifestFile.get(), condition.capacityStep);
      manifestFile.merge({ capacityStep: sequence.capacityStep });
      manifestFile.write();
    }
    // The deep phase runs with the poll and drain loops already going (9b design.md D5).
    const scheduled = () => recordSchedule({ condition, window: manifestFile.get().window, tags,
      viewerPolls: controlEvidence.viewerPolls, stepQdisc: (capacityStep) => topology.stepQdisc({ capacityStep }),
      viewerIds, clientIds, onEdge: async (edge) => issueEvent({ client: edge.leaver }),
      manifestFile, runDir: prepared.runDir });
    if (condition.capacitySchedule && !condition.seek) recordingEndTargetMs = await scheduled();
    const startBoundary = await captureBoundary('start', activeSessions(), originUrl, manifestFile.get(), manifestFile, ndjson, fetchSnapshot, boundaryOptions);
    originStart = startBoundary.origin;
    Object.assign(hostEvidence, arm.boundaryEvidence('start', startBoundary));
    if (originSession) await recordHostStats({ kind: 'start', hostSession: originSession, runDir: prepared.runDir });
    if (sequence.seek) {
      const window = manifestFile.get().window;
      window.endMs = window.startMs + window.measureWindowMs;
      window.seekLagMs = window.startMs - window.declaredStartMs;
      manifestFile.write();
      const applied = await waitForAppliedSeek({
        sessions: activeSessions(),
        hostSession: boundaryOptions.originSession,
        before: sequence.seek.before,
        timeoutMs: condition.seek.appliedTimeoutMs,
        drainAll,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      seekEvidence = issuedSeekEvidence(sequence.seek, applied, activeSessions());
      if (controlEvidence && seekEvidence.host) {
        const join = timebaseJoin(controlEvidence.hostPoll);
        const tailEndMs = recordingEndForSeek({ join, seek: seekEvidence });
        recordingEndTargetMs = Math.max(manifestFile.get().window.endMs, tailEndMs ?? manifestFile.get().window.endMs);
        manifestFile.merge({ recordingTailMs: Math.max(0, recordingEndTargetMs - manifestFile.get().window.endMs) });
        manifestFile.write();
      }
      writeSeek(landedSeekEvidence(seekEvidence, activeSessions(), {
        segmentSeconds: manifestFile.get().content?.segmentSeconds ?? 4,
        highDemandTimeWindowMs: (condition.engineWindows?.highDemandTimeWindow ?? 15) * 1000,
      }));
    }
    recordingEndTargetMs ??= manifestFile.get().window.endMs;
    if (condition.capacitySchedule && condition.seek) recordingEndTargetMs = Math.max(recordingEndTargetMs, await scheduled());
    await waitUntil(deadline, recordingEndTargetMs);
    const endBoundary = await captureBoundary('end', activeSessions(), originUrl, manifestFile.get(), manifestFile, ndjson, fetchSnapshot, boundaryOptions);
    originEnd = endBoundary.origin;
    Object.assign(hostEvidence, arm.boundaryEvidence('end', endBoundary));
    await readControl();
    if (originSession) await recordHostStats({ kind: 'end', hostSession: originSession, runDir: prepared.runDir });
    for (const session of activeSessions()) session.endPlayback = endBoundary.snapshots[session.tag]?.playback;
    if (seekEvidence?.host) writeSeek(restartedSeekEvidence(seekEvidence, activeSessions(), endBoundary.snapshots));
    if (condition.disturbance && injectionHarnessMs !== null) {
      await waitUntil(deadline, injectionHarnessMs + condition.disturbance.observationMs + 2000);
    }
    await Promise.all(activeSessions().map((session) => queuedDrain(session, ndjson, arm, Date.now())));
    Object.assign(hostEvidence, await arm.finalEvidence({
      originUrl, fetchSnapshot, runDir: prepared.runDir, sessions: activeSessions(), ndjson, condition, deadline,
      window: manifestFile.get().window, originSession: boundaryOptions.originSession,
      startInstanceId: boundaryOptions.startInstanceId,
      drainAll,
    }));
  } catch (error) {
    failure ??= error;
  } finally {
    for (const loop of loops) loop.stop();
    await Promise.all(loops.map((loop) => loop.promise.catch(() => {})));
    if (controlEvidence) {
      try { hostEvidence.controlEvidence = controlEvidence.finalize(); } catch (error) { cleanupFailure ??= error; }
      try { askEvidence.finalize(); } catch (error) { cleanupFailure ??= error; }
    }
    if (cpuSampler) await cpuSampler.stop();
    if (monitor) await stopOriginMonitor(monitor);
    for (const session of allSessions) {
      try {
        const presence = session.presenceRecorder?.snapshot?.() ?? [];
        if (presence.length) ndjson.append(`client-${session.tag}.presence.ndjson`, presence);
        const requests = session.recorder?.flush() ?? [];
        if (requests.length) ndjson.append(`client-${session.tag}.requests.ndjson`, requests);
        if (session.echoRecords?.length) ndjson.append(`client-${session.tag}.echo.ndjson`, session.echoRecords);
        if (session.clockJoinRecorder) {
          fs.writeFileSync(path.join(prepared.runDir, `client-${session.tag}.clock-join.json`),
            `${JSON.stringify(session.clockJoinRecorder.snapshot(), null, 2)}\n`);
        }
        manifestFile.merge({ clients: { ...manifestFile.get().clients, [session.tag]: {
          ...manifestFile.get().clients[session.tag],
          requestTimebase: 'measure-window',
          requestTimebaseMapping: session.recorder?.mapping ?? null,
          driftLogMissed: session.driftLogMissed,
          pageReset: session.pageReset === true,
          maxDriftDrainGapMs: session.maxDrainGapMs,
          tabCollision: session.tabCollision,
          playbackEnd: session.endPlayback,
          pageReadyMs: session.pageReadyMs ?? null,
          ...arm.sessionManifest(session),
        } } });
        await disposeSession(session);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try { finalizeRosterEvent(rosterEvent, sessions, prepared.runDir); } catch (error) { cleanupFailure ??= error; }
    for (const session of allSessions) {
      try { session.presenceRecorder?.dispose?.(); } catch (error) { cleanupFailure ??= error; }
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
    // The recompute reads the manifest from disk; unwritten client fields would
    // make the stored report differ from any later recompute (6b design.md D6).
    manifestFile.write();
    recomputed = recomputeRunDirectory(prepared.runDir);
    const publicationContext = { ...manifestFile.get(), ...recomputed.figures, declaredClientTags: tags };
    evaluation = evaluateRefusals({ ...evidenceFor(sessions, originStart, originEnd, manifestFile.get(), prepared.runDir, hostEvidence, arm), publicationContext });
    if (condition.machineTest) {
      recomputed = recomputeRunDirectory(prepared.runDir, { refusalReport: evaluation, attemptHistory: manifestFile.get().attemptHistory ?? [] });
    }
    const decision = decideFinalization({
      evaluation,
      recomputed,
      figureKinds: manifestFile.get().condition?.figureKinds,
      cleanupFailure,
    });
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
  const condition = conditionForName(parsed.conditionName);
  const urls = urlsForDelivery(condition.delivery);
  const result = await runHarness({
    conditionName: parsed.conditionName,
    condition,
    runDir: parsed.runDir ? path.resolve(parsed.runDir) : undefined,
    originUrl: urls.countersUrl,
    clientOriginUrl: urls.clientOriginUrl,
    hostPageUrl: urls.hostPageUrl,
    topology: composed,
    clientFactory: (request) => composed.clientFactory(request),
  });
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
