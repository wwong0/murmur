// Bounded scheduled-start diagnostic runner.
// External servers must run with APP_DELIVERY=http; the owned-server case sets
// it too. One fresh Chrome profile drives eight starts over the two conditions,
// publishes only what `reduceCapture` in start-timing.mjs decided.
//
// Structure copied from measure-leads.mjs, not imported: run-dir refusal before
// anything else, a manifest written at every stage, NDJSON per stream, the
// origin monitor that fails the run when the server it does not own goes away,
// `bounded()` around every CDP call, `disposeChrome` in a `finally`, non-zero
// exit with `status: 'aborted'` and partial streams retained on any failure.
//
// ZERO RETRIES AND ZERO ADAPTIVE EXTENSIONS. On timeout, missing evidence,
// cleanup failure or an unusable start this retains everything, writes
// `status: 'aborted'` and exits non-zero. Whether anything runs again is a
// person's decision taken against that evidence, not a decision this makes.

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
import { refreshFrom } from './drift-figures.mjs';
import {
  CONDITIONS, PHASES, RESIDUAL_POPULATION,
  captureBoundary, drainExpression, latticeExpression, parseNdjson, probeHostExpression,
  probeSeekExpression, probeStateExpression, progressExpression,
  rateShimScript, rateShimStateExpression, reduceCapture, reduceLattice, reduceStart, reduceTreated,
  startSatisfied, uncertaintyMs, decisionToleranceMs,
} from './start-timing.mjs';
import { startLead } from './start-residual.mjs';
import { PRESENTATION_ADVANCE_MS } from '../public/lib/playback-leads.mjs';
import { requireDelivery } from './delivery-pin.mjs';
import { mediaDirFrom } from '../server/media-dir.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const PORT = 9224;
const MAX_WALL_MS = 10 * 60 * 1000;
const MAX_RETAINED_BYTES = 100 * 1024 * 1024;
const BROWSER_ATTACH_TIMEOUT_MS = 30_000;
const LATTICE_PLAY_MS = 3000;
/** Step 5/6's lead. 1000 > PREPARE_LEAD_MS (350) and 1200 < MAX_FUTURE_MS (1300). */
const SEEK_LEAD_MS = 1000;
const ADOPT_LEAD_MS = 1200;
/** Frames between one phase target and the next, so four targets are distinct. */
const TARGET_SEPARATION_FRAMES = 12;
const SIMULATION_CASES = ['missing-raw', 'corrupt-raw', 'write-failure', 'cleanup-failure', 'server-loss', 'rate-shim', 'late-first-read'];
/** How long `--case=late-first-read` waits before its first read of a fresh document. */
const LATE_FIRST_READ_MS = 1500;
/**
 * The cases that drive the real browser. Every other case manufactures a
 * publication fault over a synthetic acquisition and never opens Chrome — a
 * case in the wrong list runs the wrong path and measures nothing, which is
 * what `late-first-read` did on its first invocation.
 */
const BROWSER_CASES = ['server-loss', 'cleanup-failure', 'late-first-read'];
/**
 * How far a baseline target may sit from its intended phase on THIS run's
 * measured lattice before the two populations stop being matched (§13.1).
 */
const MATCHED_PHASE_TOLERANCE = 0.01;

const valueOf = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const integerOf = (name, fallback) => {
  const raw = valueOf(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
};

const qualification = process.argv.includes('--qualification') || valueOf('--qualification') === '1';
const simulationCase = valueOf('--case');
const requestedCondition = valueOf('--condition') ?? 'both';
const startsPerCondition = integerOf('--starts-per-condition', 4);
const framesPerStart = integerOf('--frames-per-start', 72);
const planFrom = valueOf('--plan-from');
/**
 * A treated run requires the compiled advance on every action, so a page built
 * without it is refused rather than averaged in. A baseline requires nothing.
 */
const expectedAdvanceMs = planFrom ? PRESENTATION_ADVANCE_MS : null;
/** The baseline's frozen figures and plan, read once in `prepareRun`. */
let frozen = null;
const startedAt = Date.now();
const startedAtIso = new Date(startedAt).toISOString();
const runDir = path.resolve(APP_DIR, valueOf('--run-dir') ?? path.join('results', `5-start-diagnostic-${startedAtIso.replaceAll(':', '-')}`));
const relativeRunDir = path.relative(RESULTS_DIR, runDir).split(path.sep).join('/');
const slug = relativeRunDir.replaceAll(/[^a-zA-Z0-9-]/g, '-');
const deadline = createDeadline({ startedAt, maxWallMs: MAX_WALL_MS });
const { deadlineAt, check: checkDeadline, bounded, waitFor } = deadline;
const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);

// Only `--case=server-loss` owns a server, and only that case may stop one.
const ownedServerPort = simulationCase === 'server-loss' ? 8123 : null;
const ORIGIN = `http://127.0.0.1:${ownedServerPort ?? Number(process.env.APP_PORT ?? 8100)}`;

const conditions = requestedCondition === 'both' ? [...CONDITIONS] : [requestedCondition];
const plannedStarts = conditions.length * startsPerCondition;
const phases = PHASES.slice(0, startsPerCondition);

let manifest = null;
let manifestFile = null;
let chrome = null;
let profile = null;
let ownedServer = null;
let tabs = [];
let retained = { events: [], records: [], frames: [] };
let failure = null;
let cleanupFailure = null;
let originMonitor = null;

// ---------------------------------------------------------------------------
// Run directory, manifest, budget
// ---------------------------------------------------------------------------

const writeManifest = () => manifestFile?.write();

function prepareRun() {
  if (requestedCondition !== 'both' && !CONDITIONS.includes(requestedCondition)) {
    throw new Error(`--condition must be both or one of ${CONDITIONS.join(', ')}, got ${JSON.stringify(requestedCondition)}`);
  }
  if (startsPerCondition > PHASES.length) throw new Error(`--starts-per-condition cannot exceed the ${PHASES.length} phases`);
  if (simulationCase && !SIMULATION_CASES.includes(simulationCase)) throw new Error(`unknown qualification case: ${simulationCase}`);
  if (simulationCase && !qualification) throw new Error('--case requires --qualification');
  if (framesPerStart !== 72 && !qualification) throw new Error('--frames-per-start below 72 requires --qualification');
  // Read before anything runs: a treated run that cannot find its frozen
  // baseline must not spend ten minutes discovering it.
  frozen = frozenTolerance();
  prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir, createParents: true });
  manifestFile = createManifestFile({ runDir });
  manifest = manifestFile.set({
    schemaVersion: 1,
    status: 'running',
    outcome: 'running',
    // baseline is what task 11 captures; treated is task 14's, and it reads its
    // plan and Um from the baseline rather than recomputing either.
    condition: planFrom ? 'treated' : 'baseline',
    qualification,
    nonAcceptance: true,
    case: simulationCase ?? null,
    runDirectory: relativeRunDir,
    runStartedAt: startedAtIso,
    budget: { maxWallMs: MAX_WALL_MS, maxRetainedBytes: MAX_RETAINED_BYTES, retries: 0, adaptiveExtensions: 0 },
    regime: {
      origin: ORIGIN,
      windowState: 'visible, non-occluded (Chrome automation flags)',
      flags: FLAGS,
      windowSize: '700x500',
      windowPosition: '0,0',
      contentFps: null,
      frameIntervalMs: null,
      displayCadenceMs: null,
      buildId: null,
      servedBundleSha256: null,
      onDiskBundleSha256: null,
      mediaDir: mediaDirFrom(),
      ownedServerPort,
    },
    planned: {
      conditions,
      startsPerCondition,
      startsTotal: plannedStarts,
      framesPerStart,
      residualPopulation: Math.min(RESIDUAL_POPULATION, framesPerStart),
      phases,
      planFrom: planFrom ?? null,
    },
    lattice: null,
    plan: null,
    observed: { starts: [] },
    exclusions: { unusableStarts: [], telemetryMissed: 0, telemetryDropped: 0 },
    cleanup: { status: 'pending' },
    failures: [],
  });
  writeManifest();
  console.log(`run output directory: ${runDir}`);
}

function withOriginMonitor(promise) {
  return originMonitor ? Promise.race([promise, originMonitor.promise]) : promise;
}

async function evaluate(tab, expression, label, timeoutMs = 30_000) {
  return withOriginMonitor(bounded(tab.evaluate(expression), timeoutMs, label));
}

async function cdpSend(tab, method, params, label, timeoutMs = 10_000) {
  return withOriginMonitor(bounded(tab.send(method, params), timeoutMs, label));
}

// ---------------------------------------------------------------------------
// Regime
// ---------------------------------------------------------------------------

/**
 * Kept aligned with verify-browser.mjs by hand, same comment: the content's own
 * frame rate, read from the media every time. ffprobe absent aborts the run;
 * no constant is substituted (S-CADENCE).
 */
function readContentFrameRate() {
  const mediaDir = manifest.regime.mediaDir;
  const temporaryPath = path.join(os.tmpdir(), `measure-start-${process.pid}-${Date.now()}.mp4`);
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

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function recordBundleIdentity(pageBuildId) {
  const served = await (await fetch(`${ORIGIN}/room.bundle.js`, { cache: 'no-store' })).text();
  const onDisk = fs.readFileSync(path.join(APP_DIR, 'public', 'room.bundle.js'), 'utf8');
  manifest.regime.buildId = pageBuildId;
  manifest.regime.servedBundleSha256 = sha256(served);
  manifest.regime.onDiskBundleSha256 = sha256(onDisk);
  if (sha256(served) !== sha256(onDisk)) throw new Error('the served bundle is not the bundle on disk');
  if (typeof pageBuildId !== 'string' || !served.includes(pageBuildId)) {
    throw new Error(`the page reports a build id the served bundle does not carry: ${pageBuildId}`);
  }
  writeManifest();
}

// ---------------------------------------------------------------------------
// The two windows
// ---------------------------------------------------------------------------

const measuredUrl = (room) => `${ORIGIN}/room.html?room=${encodeURIComponent(room)}&role=host&tab=M&startTiming=1`;

async function openWindow(label, url) {
  const before = new Set((await cdpHttp('/json/list')).map((target) => target.id));
  const child = spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', url], { stdio: 'ignore' });
  child.once('error', (error) => { if (!failure) failure = new Error(`${label} Chrome launch failed: ${error.message}`); });
  return withOriginMonitor(bounded(attachTo(PORT, url, { label, exclude: before }), BROWSER_ATTACH_TIMEOUT_MS, `${label} attach`));
}

const REFRESH_PROBE = `(() => new Promise((resolve) => {
  const stamps = [];
  let finished = false;
  const finish = () => { if (!finished) { finished = true; clearTimeout(guard); resolve(stamps.slice()); } };
  const guard = setTimeout(finish, 4000);
  const frame = (atMs) => {
    if (finished) return;
    stamps.push(atMs);
    if (stamps.length >= 121) finish();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}))()`;

/** The buffered ranges M holds, in milliseconds, so a seek target can be checked. */
const BUFFERED_EXPRESSION = `(() => {
  const video = document.querySelector('video');
  if (!video) return { present: false, ranges: [], currentMs: null, durationMs: null };
  const ranges = [];
  for (let i = 0; i < video.buffered.length; i += 1) ranges.push([video.buffered.start(i) * 1000, video.buffered.end(i) * 1000]);
  return { present: true, ranges, currentMs: video.currentTime * 1000, durationMs: video.duration * 1000 };
})()`;

async function awaitPlaying(tab, label) {
  return waitFor(
    `${label} playing with a finite clock`,
    () => evaluate(tab, `(() => ({ playing: window.__app?.playback?.().playing === true, buildId: window.__app?.buildId ?? null, offsetMs: window.__app?.clock?.().offsetMs ?? null }))()`, `${label} readiness`, 5000),
    (value) => value.playing && Number.isFinite(value.offsetMs),
    90_000,
  );
}

function startOriginMonitor() {
  const healthUrl = `${ORIGIN}/room.html?room=${encodeURIComponent(`${slug}-monitor`)}&role=viewer&tab=start-monitor`;
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

const appendNdjson = (name, records) => createNdjson(runDir).append(name, records);

// ---------------------------------------------------------------------------
// One start
// ---------------------------------------------------------------------------

/**
 * Wait out one start, drain both streams, retain them and reduce. `arm` opens
 * the start and returns what the probe reported; nothing here retries it.
 *
 * `freshDocument` is the whole difference between the two conditions' windows,
 * and `captureBoundary` — not this function — decides what it means.
 */
async function runStart({ m, label, condition, phase, requestedTargetMs, frameIntervalMs, latticeOffsetMs, freshDocument = false }, arm) {
  const before = await evaluate(m, progressExpression(0), `${label} cursor`, 10_000);
  const boundary = captureBoundary({
    freshDocument, latestSeq: before.latestSeq, startCount: before.startCount, dropped: before.dropped,
  });
  const armed = await arm({ before });

  const progress = await waitFor(
    `${label} start opened and ${framesPerStart} records accepted`,
    () => evaluate(m, progressExpression(boundary.cursor, boundary.pick), `${label} progress`, 10_000),
    (value) => startSatisfied(boundary, { startCount: value.startCount, recordCount: value.recordCount, framesPerStart }),
    120_000,
  );

  const drained = await evaluate(m, drainExpression(boundary.cursor, progress.chosen.afterSeq), `${label} drain`, 30_000);
  const shim = await evaluate(m, rateShimStateExpression(), `${label} rate shim`, 10_000);

  const labelled = (record) => ({ label, condition, phase, ...record });
  retained.events.push(...drained.events.map(labelled));
  retained.records.push(...drained.records.map(labelled));
  retained.frames.push(...drained.events.filter((event) => event.kind === 'frame').map(labelled));
  appendNdjson('events.ndjson', drained.events.map(labelled));
  appendNdjson('records.ndjson', drained.records.map(labelled));
  appendNdjson('frames.ndjson', drained.events.filter((event) => event.kind === 'frame').map(labelled));

  const droppedDelta = drained.dropped - boundary.droppedBaseline;
  const reduced = reduceStart({
    label, condition, phase, requestedTargetMs,
    events: drained.events, records: drained.records, start: progress.chosen,
    nextAfterSeq: Infinity, frameIntervalMs, latticeOffsetMs,
    telemetry: { missed: drained.missed, droppedDelta },
    nativeRateReadback: shim.nativeReadback,
    framesPerStart, residualPopulation: manifest.planned.residualPopulation,
    expectedAdvanceMs,
  });

  manifest.observed.starts.push({
    label, condition, phase, requestedTargetMs,
    armed, boundary: { ...boundary, latestSeqAtFirstRead: before.latestSeq, startCountAtFirstRead: before.startCount },
    afterSeq: progress.chosen.afterSeq, attemptId: progress.chosen.attemptId,
    opens: progress.opens, begun: progress.begun, retargets: progress.retargets,
    eventCount: drained.events.length, recordCount: drained.records.length,
    telemetryMissed: drained.missed, telemetryDroppedDelta: droppedDelta,
    nativeRateReadback: shim.nativeReadback, commandedWrites: shim.writes?.length ?? null,
    unusable: reduced.unusable,
  });
  manifest.exclusions.telemetryMissed += drained.missed;
  manifest.exclusions.telemetryDropped += droppedDelta;
  if (reduced.unusable.length > 0) manifest.exclusions.unusableStarts.push({ label, reasons: reduced.unusable });
  writeManifest();
  console.log(`  ${label}: residual ${reduced.residual.medianMs}ms over ${reduced.residual.count}, dispatch ${reduced.dispatchMs}ms, achievedPhase ${reduced.achievedPhase}${reduced.unusable.length ? ` UNUSABLE ${reduced.unusable.join(',')}` : ''}`);
  return reduced;
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

async function acquire() {
  const contentFps = readContentFrameRate();
  const frameIntervalMs = 1000 / contentFps;
  manifest.regime.contentFps = contentFps;
  manifest.regime.frameIntervalMs = frameIntervalMs;
  writeManifest();

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-start-'));
  const hostUrl = `${ORIGIN}/__probe-host`;
  chrome = spawn(CHROME, [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', hostUrl], { stdio: 'ignore' });
  chrome.once('error', (error) => { throw new Error(`Chrome launch failed: ${error.message}`); });
  const h = await bounded(attachTo(PORT, hostUrl, { label: 'H/probe-host' }), BROWSER_ATTACH_TIMEOUT_MS, 'H attach');
  tabs.push(h);

  // The shape before the figures. H must be a document on the measured
  // origin with no player of its own, or nothing it sends means what it says.
  // Waited for rather than read once: a tab attached before its first
  // navigation commits is still on about:blank, whose origin serialises to the
  // string "null" and would fail this for the wrong reason.
  const host = await waitFor('H on the measured origin', () => evaluate(h, probeHostExpression({ origin: ORIGIN }), 'H origin probe', 10_000),
    (value) => value.matches === true, 30_000);
  if (!host.matches) throw new Error(`H is on ${host.origin}, not ${ORIGIN}`);
  if (host.hasVideo) throw new Error('H carries a video element; it is not a bare raw-socket host');

  // The measured window opens blank so the rate pin is installed before its
  // document runs, then navigates.
  const m = await openWindow('M/measured', 'about:blank');
  tabs.push(m);
  await cdpSend(m, 'Page.enable', {}, 'M Page.enable');
  await cdpSend(m, 'Page.addScriptToEvaluateOnNewDocument', { source: rateShimScript() }, 'M rate pin');
  const resumeRoom = `start-${slug}-resume`;
  await cdpSend(m, 'Page.navigate', { url: measuredUrl(resumeRoom) }, 'M navigate');
  const ready = await awaitPlaying(m, 'M');
  await recordBundleIdentity(ready.buildId);

  const enabled = await evaluate(m, `window.__app.startTiming(0)`, 'M telemetry reading', 10_000);
  if (enabled.enabled !== true) throw new Error('M reports the start telemetry disabled; startTiming=1 did not take');
  const shim = await evaluate(m, rateShimStateExpression(), 'M rate shim', 10_000);
  if (shim.installed !== true) throw new Error(`the rate pin did not install: ${shim.reason}`);

  manifest.observed.playbackReadyAt = new Date().toISOString();
  manifest.observed.captureReachedAt = new Date().toISOString();
  writeManifest();
  startOriginMonitor();

  // Display cadence, from this window's own vsync.
  const refresh = refreshFrom(await evaluate(m, REFRESH_PROBE, 'M refresh probe', 15_000));
  if (!Number.isFinite(refresh.medianDeltaMs)) throw new Error('the measured window reported no usable refresh interval (S-CADENCE)');
  manifest.regime.displayCadenceMs = refresh.medianDeltaMs;
  manifest.regime.refreshRateHz = refresh.refreshRateHz;
  manifest.regime.refreshFrameCount = refresh.frameCount;
  writeManifest();

  // The observed PTS lattice — actual frame PTS, never a guessed frame origin.
  const latticeCursor = (await evaluate(m, progressExpression(0), 'M lattice cursor', 10_000)).latestSeq;
  await sleep(LATTICE_PLAY_MS);
  const observedFrames = await evaluate(m, latticeExpression(latticeCursor), 'M lattice read', 15_000);
  const lattice = reduceLattice({ mediaTimeMs: observedFrames.mediaTimeMs, frameIntervalMs });
  manifest.lattice = { ...lattice, frameIntervalMs, minimumFrames: 48 };
  writeManifest();
  if (!lattice.usable) {
    throw new Error(`the PTS lattice is not usable: ${lattice.frameCount} frames, dispersion ${lattice.dispersionMs}ms against a bar of ${frameIntervalMs / 4}ms`);
  }
  const latticeOffsetMs = lattice.latticeOffsetMs;
  console.log(`lattice offset ${latticeOffsetMs}ms over ${lattice.frameCount} frames, dispersion ${lattice.dispersionMs}ms; display cadence ${refresh.medianDeltaMs}ms`);

  const onLattice = (aboutMs) => latticeOffsetMs + Math.round((aboutMs - latticeOffsetMs) / frameIntervalMs) * frameIntervalMs;
  const targetsFrom = (anchorMs) => phases.map((phase, index) => anchorMs + index * TARGET_SEPARATION_FRAMES * frameIntervalMs + phase * frameIntervalMs);

  const starts = [];

  if (conditions.includes('resume')) {
    const buffered = await evaluate(m, BUFFERED_EXPRESSION, 'M buffered ranges', 10_000);
    const ahead = buffered.ranges.find(([, end]) => end - buffered.currentMs > 4000);
    if (!ahead) throw new Error(`no buffered range extends 4s beyond ${buffered.currentMs}ms; the resume condition has nowhere to seek`);
    const resumeAnchor = onLattice(Math.max(ahead[0] + 500, buffered.currentMs + 1500));
    const resumeTargets = matchedTargets('resume', targetsFrom(resumeAnchor), { latticeOffsetMs, frameIntervalMs });
    manifest.plan = { ...(manifest.plan ?? {}), resume: { room: resumeRoom, anchorMs: resumeAnchor, targets: resumeTargets, buffered: buffered.ranges } };
    writeManifest();
    console.log(`resume condition in ${resumeRoom}, targets ${resumeTargets.map((t) => t.toFixed(3)).join(', ')}`);

    for (const [index, phase] of phases.entries()) {
      const requestedTargetMs = resumeTargets[index];
      const label = `resume-${phase}`;
      checkDeadline(label);
      // The target and a second beyond it must be in one retained range, or the
      // element is choosing a frame from a download rather than from the buffer.
      // Waited for, not read once: this is a precondition of reading the start
      // correctly, and a bounded wait for it is not an extension of the
      // measurement — the run still aborts if the buffer never covers the target.
      const covers = (ranges) => ranges.some(([start, end]) => start <= requestedTargetMs && end >= requestedTargetMs + 1000);
      const held = await waitFor(`${label} target buffered`, () => evaluate(m, BUFFERED_EXPRESSION, `${label} buffered`, 10_000),
        (value) => covers(value.ranges), 30_000);
      if (!covers(held.ranges)) throw new Error(`${label}: ${requestedTargetMs}ms + 1s is not inside a retained buffered range (${JSON.stringify(held.ranges)})`);

      starts.push(await runStart({ m, label, condition: 'resume', phase, requestedTargetMs, frameIntervalMs, latticeOffsetMs }, async ({ before }) => {
        const identity = before.identity;
        if (!identity || typeof identity.lineage !== 'string') throw new Error(`${label}: M holds no playback identity to seek against`);
        const sent = await evaluate(h, probeSeekExpression({
          room: resumeRoom, positionMs: requestedTargetMs, basis: { lineage: identity.lineage, version: identity.version },
          leadMs: SEEK_LEAD_MS, tabId: `H-seek-${index}`,
        }), `${label} seek`, 30_000);
        if (sent.error || !sent.sent) throw new Error(`${label}: the seek probe did not send: ${JSON.stringify(sent)}`);
        return sent.sent;
      }));
    }
  }

  if (conditions.includes('load')) {
    const loadAnchor = onLattice(60_000);
    const loadTargets = matchedTargets('load', targetsFrom(loadAnchor), { latticeOffsetMs, frameIntervalMs });
    manifest.plan = { ...(manifest.plan ?? {}), load: { anchorMs: loadAnchor, targets: loadTargets, rooms: phases.map((phase) => `start-${slug}-load-${phase}`) } };
    writeManifest();
    console.log(`load condition, targets ${loadTargets.map((t) => t.toFixed(3)).join(', ')}`);

    for (const [index, phase] of phases.entries()) {
      const requestedTargetMs = loadTargets[index];
      const label = `load-${phase}`;
      const room = `start-${slug}-load-${phase}`;
      const lineage = `qual-${slug}-${phase}`;
      checkDeadline(label);

      // H joins and is answering BEFORE M navigates, so M adopts rather than
      // creates and its first S is the instant H minted.
      const installed = await evaluate(h, probeStateExpression({
        room, lineage, mapping: { playing: true, mediaMs: requestedTargetMs, leadMs: ADOPT_LEAD_MS }, tabId: `H-state-${index}`,
      }), `${label} state probe install`, 10_000);
      if (installed.installed !== true) throw new Error(`${label}: the state probe did not install`);
      await waitFor(`${label} H joined`, () => evaluate(h, `(() => ({ ...window.__startProbe }))()`, `${label} probe state`, 5000),
        (value) => value.joined === true || Boolean(value.error), 20_000);

      await cdpSend(m, 'Page.navigate', { url: measuredUrl(room) }, `${label} M navigate`);
      await waitFor(`${label} M adopted ${lineage}`,
        () => evaluate(m, progressExpression(0), `${label} adoption`, 10_000).catch(() => ({ present: false })),
        (value) => value.present && value.identity?.lineage === lineage, 60_000);

      // The boundary race the 2026-09-17 baseline lost, made deterministic: wait
      // long enough that the paused park — and the start itself — are certainly
      // recorded before the runner's first read.
      if (simulationCase === 'late-first-read') await sleep(LATE_FIRST_READ_MS);

      starts.push(await runStart({ m, label, condition: 'load', phase, requestedTargetMs, frameIntervalMs, latticeOffsetMs, freshDocument: true }, async () => {
        const answered = await evaluate(h, `(() => ({ ...window.__startProbe }))()`, `${label} probe result`, 5000);
        if (!answered.sent) throw new Error(`${label}: H never answered M's state request: ${JSON.stringify(answered)}`);
        return answered.sent;
      }));

      const after = await evaluate(m, progressExpression(0), `${label} opens`, 10_000);
      const entry = manifest.observed.starts.at(-1);
      entry.opens = after.opens;
      if (after.opens !== 1) {
        entry.unusable = [...entry.unusable, `opens-${after.opens}`];
        starts.at(-1).unusable.push(`opens-${after.opens}`);
        manifest.exclusions.unusableStarts.push({ label, reasons: [`opens-${after.opens}`] });
      }
      writeManifest();
    }
  }

  return { starts, frameIntervalMs, displayCadenceMs: refresh.medianDeltaMs, latticeOffsetMs };
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

const STREAMS = Object.freeze({ events: 'events.ndjson', records: 'records.ndjson', frames: 'frames.ndjson' });

/** §16's evidence map, checked against the writer rather than against a schema. */
const MAPPED_FIELDS = Object.freeze({
  events: ['label', 'condition', 'phase', 'seq', 'kind', 'atLocalMs', 'atSharedMs', 'clockOffsetMs', 'clockHalfWidthMs', 'attemptId', 'lineage', 'version', 'absentFields'],
  records: ['label', 'condition', 'phase', 'seq', 'epochMs', 'mediaMs', 'displaySharedMs', 'scheduledMediaMs', 'driftMs', 'presentedFrames', 'clock'],
  frames: ['label', 'condition', 'phase', 'seq', 'kind', 'paused', 'callbackNowMs', 'localNowMs', 'timeOriginMs', 'mediaTimeMs', 'presentedFrames', 'presentationTimeMs', 'expectedDisplayTimeMs', 'commandedRate', 'width', 'height'],
});

function readStreams() {
  const streams = {};
  for (const [key, name] of Object.entries(STREAMS)) {
    const file = path.join(runDir, name);
    if (!fs.existsSync(file)) throw new Error(`missing raw evidence: ${name}`);
    streams[key] = parseNdjson(fs.readFileSync(file, 'utf8'), name);
    if (streams[key].length === 0) throw new Error(`raw evidence is empty: ${name}`);
    const first = streams[key][0];
    for (const field of MAPPED_FIELDS[key]) {
      if (!(field in first)) throw new Error(`${name} record 1 is missing the mapped field ${field}`);
    }
  }
  return streams;
}

/**
 * One frame's drift identity, recomputed here from the retained numbers and
 * nothing else, so the reducer and the evidence are checked against each other.
 */
function handCalculation(streams, starts) {
  const record = streams.records[0];
  const start = starts.find((entry) => entry.label === record.label);
  // A case that acquires no start has nothing to check the identity against, and
  // says so; the capture below requires `verified`, so this cannot pass silently.
  if (!start) return { label: record.label, verified: false, reason: 'no reduced start carries this record\'s label' };
  const modelled = (record.mediaMs - start.scheduledParkMs) - (record.displaySharedMs - start.S);
  const residual = record.driftMs - modelled;
  const alsoFromRecord = record.mediaMs - record.scheduledMediaMs;
  if (!(Math.abs(record.driftMs - alsoFromRecord) <= 1e-9)) {
    throw new Error(`the retained driftMs does not equal mediaMs − scheduledMediaMs: ${record.driftMs} vs ${alsoFromRecord}`);
  }
  return {
    label: record.label, seq: record.seq, driftMs: record.driftMs,
    modelledDriftMs: modelled, identityResidualMs: residual,
    scheduledParkMs: start.scheduledParkMs, S: start.S, verified: Math.abs(residual) <= 0.001,
  };
}

/** The figures a re-reduction off disk must reproduce exactly. */
const RECOMPUTED_FIGURES = Object.freeze([
  'scheduledParkMs', 'S', 'dispatchMs', 'callDurationMs', 'settleMs', 'pausedFramePtsMs',
  'snapErrorMs', 'pausedSnapErrorMs', 'mediaAdvanceMs', 'displayMinusSMs', 'achievedPhase',
  'identityResidualMs', 'earlyMs', 'lateMs', 'tailMs', 'slope', 'joinedCount',
]);

/**
 * The published figures, recomputed from the NDJSON on disk by the same reducer.
 * The run reduced from what it drained over CDP; this reduces from what it wrote,
 * so a writer that drops or reshapes a field cannot publish a figure that still
 * looks right. `frames.ndjson` is a projection of `events.ndjson`, and that is
 * checked rather than assumed.
 */
function recomputeFromDisk(streams, capture, acquired) {
  const byLabel = (records) => {
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.label)) groups.set(record.label, []);
      groups.get(record.label).push(record);
    }
    return groups;
  };
  const events = byLabel(streams.events);
  const records = byLabel(streams.records);
  const frameSeqs = new Set(streams.frames.map((frame) => `${frame.label}:${frame.seq}`));
  for (const event of streams.events) {
    const key = `${event.label}:${event.seq}`;
    if (event.kind === 'frame' && !frameSeqs.has(key)) throw new Error(`frames.ndjson is missing ${key}, which events.ndjson holds`);
    if (event.kind !== 'frame' && frameSeqs.has(key)) throw new Error(`frames.ndjson holds ${key}, which is not a frame`);
  }

  const mismatches = [];
  for (const published of capture.starts) {
    const observed = manifest.observed.starts.find((entry) => entry.label === published.label);
    const again = reduceStart({
      label: published.label, condition: published.condition, phase: published.phase,
      requestedTargetMs: published.requestedTargetMs,
      events: events.get(published.label) ?? [], records: records.get(published.label) ?? [],
      start: { afterSeq: observed.afterSeq, attemptId: observed.attemptId },
      nextAfterSeq: Infinity,
      frameIntervalMs: acquired.frameIntervalMs, latticeOffsetMs: acquired.latticeOffsetMs,
      telemetry: { missed: observed.telemetryMissed, droppedDelta: observed.telemetryDroppedDelta },
      nativeRateReadback: observed.nativeRateReadback,
      framesPerStart, residualPopulation: manifest.planned.residualPopulation,
      expectedAdvanceMs,
    });
    for (const figure of RECOMPUTED_FIGURES) {
      if (!Object.is(again[figure], published[figure])) mismatches.push(`${published.label}.${figure}: disk ${again[figure]} vs published ${published[figure]}`);
    }
    if (!Object.is(again.residual.medianMs, published.residual.medianMs)) {
      mismatches.push(`${published.label}.residual.medianMs: disk ${again.residual.medianMs} vs published ${published.residual.medianMs}`);
    }
  }
  if (mismatches.length > 0) throw new Error(`the retained evidence does not reproduce the published figures: ${mismatches.join('; ')}`);
  return { starts: capture.starts.length, figures: RECOMPUTED_FIGURES.length, frames: streams.frames.length, verified: true };
}

/**
 * The baseline's frozen decision inputs. Every one is read off disk and none is
 * recomputed here (§13.1 item 4): `Um` and the aggregate judge the treated run,
 * and the plan is what makes its eight starts matched.
 */
function frozenTolerance() {
  if (!planFrom) return null;
  const file = path.resolve(APP_DIR, planFrom, 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`--plan-from has no summary.json: ${file}`);
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isFinite(baseline.Um)) throw new Error(`the baseline summary carries no Um: ${file}`);
  if (!Number.isFinite(baseline.aggregate)) throw new Error(`the baseline summary carries no aggregate: ${file}`);
  if (!Array.isArray(baseline.medians) || !baseline.medians.every(Number.isFinite)) {
    throw new Error(`the baseline summary carries no usable per-start medians: ${file}`);
  }
  // A value run must judge the SAME population size it was matched to. Only a
  // qualification may run a smaller window, and it publishes no verdict anyone acts on.
  if (!qualification && baseline.medians.length !== plannedStarts) {
    throw new Error(`the baseline summary carries ${baseline.medians.length} per-start medians, not ${plannedStarts}: ${file}`);
  }
  if (!baseline.plan) throw new Error(`the baseline summary carries no plan to match against: ${file}`);
  return { Um: baseline.Um, aggregate: baseline.aggregate, medians: baseline.medians, from: planFrom, plan: baseline.plan };
}

/**
 * The targets this run runs at. A treated run takes the BASELINE's verbatim —
 * that, and nothing weaker, is what makes the two populations matched — and
 * refuses them if this run's own measured lattice puts them at different
 * phases, because then the starts are not comparable and the run must abort
 * rather than measure something else.
 */
function matchedTargets(condition, computed, { latticeOffsetMs, frameIntervalMs }) {
  const all = frozen?.plan?.[condition]?.targets ?? null;
  if (!all) return computed;
  if (!Array.isArray(all) || all.length < computed.length) {
    throw new Error(`--plan-from has ${all?.length} ${condition} targets, this run plans ${computed.length}`);
  }
  if (!qualification && all.length !== computed.length) {
    throw new Error(`--plan-from has ${all.length} ${condition} targets, this run plans ${computed.length}`);
  }
  const planned = all.slice(0, computed.length);
  planned.forEach((target, index) => {
    if (!Number.isFinite(target)) throw new Error(`--plan-from ${condition} target ${index} is not finite: ${target}`);
    const offset = (((target - latticeOffsetMs) % frameIntervalMs) + frameIntervalMs) % frameIntervalMs;
    const achieved = offset / frameIntervalMs;
    const wanted = phases[index];
    // On the circle: phase 0.9999 is a hair from 0, not a whole interval away.
    const raw = Math.abs(achieved - wanted);
    const gap = Math.min(raw, 1 - raw);
    if (!(gap <= MATCHED_PHASE_TOLERANCE)) {
      throw new Error(`${condition} target ${index} (${target}ms) sits at phase ${achieved} on this run's lattice, not the planned ${wanted}`);
    }
  });
  console.log(`${condition}: matched to the baseline plan's targets from ${frozen.from}`);
  return planned;
}

/**
 * §13.1 condition 3, per start: the later frames, after the residual population
 * the controller has already acted on, judged one-sidedly against `U`. The
 * records come from what this run retained, and `U` from this run's own regime.
 */
function leadsFor(starts, uncertainty) {
  return starts.filter((start) => start.unusable.length === 0).map((start) => {
    const observed = manifest.observed.starts.find((entry) => entry.label === start.label);
    return {
      label: start.label,
      ...startLead({
        records: retained.records.filter((record) => record.label === start.label),
        start: { afterSeq: observed.afterSeq },
        nextAfterSeq: Infinity,
        skip: manifest.planned.residualPopulation,
        minCount: manifest.planned.residualPopulation,
        uncertaintyMs: uncertainty,
      }),
    };
  });
}

function publish(acquired) {
  const streams = readStreams();
  if (simulationCase === 'write-failure') throw new Error('simulated publication write failure');
  const shared = {
    starts: acquired.starts,
    frameIntervalMs: acquired.frameIntervalMs,
    displayCadenceMs: acquired.displayCadenceMs,
    plannedStarts,
  };
  // The treated run is judged by §13.1's conditions against the frozen
  // baseline, never by §13's rule again: that rule already returned its verdict
  // and this run is not allowed to restate it.
  let leads = [];
  let capture;
  if (frozen) {
    const usable = acquired.starts.filter((start) => start.unusable.length === 0);
    const maxHalfWidthMs = usable.length > 0 && usable.every((start) => Number.isFinite(start.maxHalfWidthMs))
      ? Math.max(...usable.map((start) => start.maxHalfWidthMs)) : null;
    const U = uncertaintyMs({ displayCadenceMs: acquired.displayCadenceMs, frameIntervalMs: acquired.frameIntervalMs, maxHalfWidthMs });
    leads = leadsFor(acquired.starts, U);
    capture = reduceTreated({
      ...shared,
      leads,
      baseline: { aggregate: frozen.aggregate, medians: frozen.medians, Um: frozen.Um, advanceMs: expectedAdvanceMs },
    });
  } else {
    capture = reduceCapture({ ...shared, condition: manifest.condition });
  }
  const summary = {
    schemaVersion: 1,
    nonAcceptance: true,
    qualification,
    condition: manifest.condition,
    verdict: capture.verdict,
    reason: capture.reason,
    advanceMs: capture.advanceMs,
    aggregate: capture.aggregate,
    medians: capture.medians,
    U: capture.U,
    uncertainty: capture.uncertainty,
    // Written by the baseline run and read by the treated one — never
    // recomputed from treated data (§13.1 item 4).
    Um: frozen ? frozen.Um : capture.Um,
    UmSource: frozen
      ? { frozenFrom: frozen.from, observedThisRun: decisionToleranceMs({ medians: capture.medians, maxHalfWidthMs: capture.uncertainty.maxHalfWidthMs }) }
      : 'this run',
    UmTerms: { medianSpanMs: capture.medians.length > 0 ? Math.max(...capture.medians) - Math.min(...capture.medians) : null, maxHalfWidthMs: capture.uncertainty.maxHalfWidthMs },
    usableCount: capture.usableCount,
    plannedStarts,
    expectedAdvanceMs,
    leads,
    baseline: capture.baseline ?? null,
    gates: capture.gates,
    starts: capture.starts.map((start) => ({ ...start, firstPlayingFrame: start.firstPlayingFrame?.seq ?? null })),
    plan: manifest.plan,
    lattice: manifest.lattice,
    regime: manifest.regime,
    streams: Object.fromEntries(Object.entries(streams).map(([key, records]) => [key, records.length])),
    handCalculation: handCalculation(streams, capture.starts),
    recomputedFromDisk: recomputeFromDisk(streams, capture, acquired),
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  manifest.status = 'published';
  manifest.summary = { verdict: summary.verdict, reason: summary.reason, advanceMs: summary.advanceMs, aggregate: summary.aggregate, U: summary.U, Um: summary.Um, usableCount: summary.usableCount };
  writeManifest();
  return summary;
}

// ---------------------------------------------------------------------------
// Qualification cases that do not acquire
// ---------------------------------------------------------------------------

function syntheticStreams() {
  const events = [{ label: 'resume-0', condition: 'resume', phase: 0, seq: 1, kind: 'frame', atLocalMs: 1, atSharedMs: 2, clockOffsetMs: 1, clockHalfWidthMs: 1, attemptId: 1, lineage: 'x', version: 1, absentFields: [] }];
  const frames = [{ ...events[0], paused: false, callbackNowMs: 1, localNowMs: 1, timeOriginMs: 0, mediaTimeMs: 1000, presentedFrames: 1, presentationTimeMs: 1, expectedDisplayTimeMs: 1, commandedRate: 1, width: 640, height: 360 }];
  const records = [{ label: 'resume-0', condition: 'resume', phase: 0, seq: 1, epochMs: 0, mediaMs: 1000, displaySharedMs: 1000, scheduledMediaMs: 1000, driftMs: 0, presentedFrames: 1, clock: { offsetMs: 0, halfWidthMs: 1 } }];
  return { events, frames, records };
}

function runSimulation() {
  const streams = syntheticStreams();
  if (simulationCase === 'missing-raw') {
    appendNdjson('events.ndjson', streams.events);
    appendNdjson('frames.ndjson', streams.frames);
    return { starts: [], frameIntervalMs: 1000 / 24, displayCadenceMs: 16.667, latticeOffsetMs: 0 };
  }
  if (simulationCase === 'corrupt-raw') {
    fs.writeFileSync(path.join(runDir, 'records.ndjson'), '{not-json}\n');
    appendNdjson('events.ndjson', streams.events);
    appendNdjson('frames.ndjson', streams.frames);
    return { starts: [], frameIntervalMs: 1000 / 24, displayCadenceMs: 16.667, latticeOffsetMs: 0 };
  }
  for (const [key, name] of Object.entries(STREAMS)) appendNdjson(name, streams[key]);
  return { starts: [], frameIntervalMs: 1000 / 24, displayCadenceMs: 16.667, latticeOffsetMs: 0 };
}

/**
 * The rate pin, shown to work and shown to be necessary, in one browser: the
 * same scripted write of 1.01 against a shimmed document and a bare one.
 */
async function runRateShimCase() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-start-shim-'));
  const room = `start-${slug}-shim`;
  chrome = spawn(CHROME, [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', 'about:blank'], { stdio: 'ignore' });
  chrome.once('error', (error) => { throw new Error(`Chrome launch failed: ${error.message}`); });
  const tab = await bounded(attachTo(PORT, 'about:blank', { label: 'shim' }), BROWSER_ATTACH_TIMEOUT_MS, 'shim attach');
  tabs.push(tab);
  await cdpSend(tab, 'Page.enable', {}, 'shim Page.enable');

  const write = `(() => {
    const video = document.querySelector('video');
    video.playbackRate = 1.01;
    const shim = window.__rateShim ?? null;
    return {
      shimmed: shim?.installed === true,
      commanded: video.playbackRate,
      nativeReadback: shim?.installed === true ? shim.nativeReadback() : video.playbackRate,
      writes: shim?.installed === true ? shim.writes() : [],
    };
  })()`;

  const withShim = await (async () => {
    await cdpSend(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: rateShimScript() }, 'shim install');
    await cdpSend(tab, 'Page.navigate', { url: measuredUrl(`${room}-on`) }, 'shim navigate on');
    await awaitPlaying(tab, 'shim/on');
    return evaluate(tab, write, 'shim on write', 10_000);
  })();

  // A second window with no init script: the same write, nothing in its way.
  const bare = await (async () => {
    const other = await openWindow('shim/off', measuredUrl(`${room}-off`));
    tabs.push(other);
    await awaitPlaying(other, 'shim/off');
    return evaluate(other, write, 'shim off write', 10_000);
  })();

  manifest.rateShim = {
    withShim: { ...withShim, pinnedElement: withShim.nativeReadback === 1, writeLogged: withShim.writes.length > 0 },
    withoutShim: { ...bare, elementFollowedTheWrite: Math.abs(bare.nativeReadback - 1.01) < 1e-9 },
  };
  writeManifest();
  if (withShim.shimmed !== true) throw new Error('the shim did not install in the shimmed window');
  if (withShim.nativeReadback !== 1) throw new Error(`the shimmed window's element left 1.0: ${withShim.nativeReadback}`);
  if (withShim.writes.length === 0) throw new Error('the shimmed window logged no commanded write');
  if (bare.shimmed !== false) throw new Error('the bare window reports a shim');
  if (!(Math.abs(bare.nativeReadback - 1.01) < 1e-9)) throw new Error(`the bare window's element did not follow the write: ${bare.nativeReadback}`);
  console.log('rate pin: shimmed element held 1.0 with the write logged; bare element followed the write to 1.01');
  for (const [key, name] of Object.entries(STREAMS)) appendNdjson(name, syntheticStreams()[key]);
  return { starts: [], frameIntervalMs: 1000 / 24, displayCadenceMs: 16.667, latticeOffsetMs: 0 };
}

function startOwnedServer() {
  ownedServer = spawn(process.execPath, [path.join(APP_DIR, 'server', 'room-server.mjs')], {
    env: { ...process.env, APP_PORT: String(ownedServerPort), APP_DELIVERY: 'http' }, stdio: 'ignore',
  });
  ownedServer.once('error', (error) => { throw new Error(`owned server failed to start: ${error.message}`); });
}

/**
 * Case 3, causally: the trigger fires only after the manifest carries the
 * checkpoint proving the runner reached its capture path, and the trigger
 * instant is retained so the ordering can be asserted rather than assumed.
 */
function armServerLossTrigger() {
  const timer = setInterval(() => {
    if (!manifest?.observed?.captureReachedAt) return;
    clearInterval(timer);
    manifest.serverLoss = {
      checkpoint: manifest.observed.captureReachedAt,
      triggeredAt: new Date().toISOString(),
      port: ownedServerPort,
    };
    writeManifest();
    ownedServer?.kill();
  }, 100);
  timer.unref();
}

// ---------------------------------------------------------------------------

const retainedBytes = () => retainedBytesIn(runDir);

async function cleanup() {
  if (simulationCase === 'cleanup-failure') throw new Error('simulated Chrome cleanup failure');
  ownedServer?.kill();
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
    if (ownedServerPort) {
      startOwnedServer();
      await waitFor('owned server listening', () => fetch(`${ORIGIN}/room.html`, { cache: 'no-store' }).then((r) => r.ok).catch(() => false), (ok) => ok, 20_000);
      await requireDelivery(ORIGIN, 'http');
      armServerLossTrigger();
    }
    let acquired;
    if (simulationCase === 'rate-shim') acquired = await runRateShimCase();
    else if (simulationCase && !BROWSER_CASES.includes(simulationCase)) acquired = runSimulation();
    else {
      if (!ownedServerPort) await requireDelivery(ORIGIN, 'http');
      acquired = await acquire();
    }
    const summary = publish(acquired);
    if (retainedBytes() > MAX_RETAINED_BYTES) throw new Error(`retained evidence exceeds ${MAX_RETAINED_BYTES} bytes`);
    console.log(`verdict ${summary.verdict}${summary.reason ? ` (${summary.reason})` : ''} · aggregate ${summary.aggregate} · advanceMs ${summary.advanceMs} · U ${summary.U} · Um ${summary.Um} · usable ${summary.usableCount}/${plannedStarts}`);
    // The capture exits 0 only on a decided verdict over every planned start.
    // The qualification exercises the plumbing, so its exit code is the
    // plumbing's, and its verdict is recorded rather than required.
    if (!qualification && (summary.usableCount !== plannedStarts || summary.verdict === 'INCONCLUSIVE')) {
      throw new Error(`S-DIAG-EVIDENCE: ${summary.usableCount}/${plannedStarts} usable, verdict ${summary.verdict}`);
    }
    if (!qualification && summary.handCalculation.verified !== true) {
      throw new Error(`the retained evidence did not reproduce the drift identity by hand: ${JSON.stringify(summary.handCalculation)}`);
    }
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
    runFinally({ manifest: manifestFile, failure, cleanupFailure, startedAt, runDir, tabs, withWallAndBytes: true });
  }
  if (failure || cleanupFailure) process.exitCode = 1;
}

await main();
