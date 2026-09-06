// scripts/verify-browser.mjs
//
// The manual verification pass, automated: two Chrome windows join one room,
// both play, presence tracks, and the identity rules are exercised in every
// form a browser can actually produce.
// A dev aid, not part of `npm run check` — it needs Chrome, a running server
// and about five and a half minutes, where the protocol check needs none of
// those. It cost ninety seconds until change 4c added the settle wait, the
// converged span and the observation window; the length is the price of a bar
// the controller can fail (4c design.md D2).
//
// IT EXITS NON-ZERO ON THIS TREE, and that is change 4c's result rather than a
// defect in the pass: 20 failures, four T5 clauses per window because neither
// window ever reaches `settled`, and the whole T8 block because CDP's offline
// emulation leaves the websocket up so the seam route never fires. A run
// producing a different count, or the same count from different assertions, is
// new information. Change 5 owns both, in `docs/plan/05-*.md`.
//
// It exists because CLAUDE.md records that every defect in the host-origin
// spike was found by attaching over CDP and reading the console, and because
// design.md D10 settles that the developer here does not look at the page. A
// verification that requires someone to watch two tabs is a verification that
// stops being run.
//
// Usage: npm start (in another shell), then `node scripts/verify-browser.mjs`.
//
// Two things this had to get right to be worth running:
//
//  - Each page gets its OWN Chrome window. A second tab in one window is a
//    background tab, and a background tab does not autoplay, so the first run
//    of this reported the host "not playing" when the host was fine.
//  - 7.3 is split three ways. Chrome's browser process closes the websocket
//    cleanly even when the renderer is killed outright, so closing or crashing
//    a tab is an ordinary departure and never reaches the reclaim path.
//
//    7.3a is a SECOND LIVE window carrying the same tab id. Under change 1 it
//    reclaimed the host role, because presenting the same `tabId` was the whole
//    requirement. Change 1b keys the reclaim on a secret the server issues in
//    one directed reply, so that window is now a stranger holding a published
//    label and is refused — which is the point of the change, and is why this
//    expectation reads the opposite way to the way it used to.
//
//    It is also SLOW on purpose (D13). The refusal carries the time the server
//    would need to free that name, ~15s at the 5000ms default, and the newcomer
//    retries across it rather than guessing. So 7.3a checks two phases — that
//    it is visibly retrying, and that it later gives up — and that costs the
//    run about twenty seconds. That is the price of the budget being correct at
//    every liveness setting instead of only at the one the check uses.
//
//    7.3b covers close-and-reopen, where a briefly hostless room is correct and
//    specified behaviour. 7.3c reloads the host tab, which is the one case the
//    design accepts as lossy: a reload throws the secret away, so the returning
//    page is a stranger and depends on its own retry to get back in.
//
//    The true reclaim path — same tab, same page, secret intact — is not
//    reachable from a browser at all on loopback, because there is no way to
//    make a live page's connection half-open. It is asserted in
//    scripts/protocol-check.mjs instead.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach as attachTo, cdpHttp as cdpHttpOn, sleep, disposeChrome } from './cdp.mjs';
import { createRecorder } from './drift-capture.mjs';
import { DRIFT_LINE_RE } from '../public/lib/drift-readout.mjs';
import { MAX_RATE_DEVIATION, MIN_RECORDS, RATE_EPSILON } from '../public/lib/drift-controller.mjs';
import { CLOCK_LINE_RE, CONTROLLER_LINE_HELD_RE, CONTROLLER_LINE_ACTING_RE } from '../public/lib/diagnostics-overlay.mjs';
// The arithmetic and the verdicts, next door and pure — this file is the
// sequence of windows, waits and assertions, and nothing else.
import {
  DEFAULT_BARS,
  ENDPOINT_CROSSCHECK_MS,
  MAX_RESIDUAL_SLOPE_SE_PPM,
  MAX_STRETCH_SLOPE_SE_PPM,
  MIN_RESIDUAL_RECORDS,
  MIN_RESIDUAL_SPAN_MS,
  MIN_STRETCH_RECORDS,
  MIN_STRETCH_SPAN_MS,
  MIN_CONVERGED_RECORDS,
  PLANT_MEDIAN_MOVEMENT_MS,
  RATE_STEADY_TOLERANCE,
  RESIDUAL_FLOOR_PPM,
  SLOPE_SIGNIFICANCE_SIGMA,
  STRETCH_EDGE_EXCLUSION_MS,
  convergedStats,
  observationStats,
  plantSweepMinimum,
  predictedParkingDistanceMs,
  refreshFrom,
  steadyCommandStretches,
  standingLag,
  stretchSlopes,
  windowVerdicts,
} from './drift-figures.mjs';

const PASS_STARTED_AT = Date.now();
const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';

const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const PASS_STARTED_AT_ISO = new Date(PASS_STARTED_AT).toISOString();
// Do not reuse a run directory: the first pair of captures was lost that way on 2026-09-05.
const RUN_DIRECTORY_NAME = PASS_STARTED_AT_ISO.replaceAll(':', '-');
const RUN_DIR = path.join(RESULTS_DIR, RUN_DIRECTORY_NAME);
const MEDIA_DIR = path.resolve(process.env.APP_MEDIA_DIR ?? path.join(APP_DIR, '..', 'step0', 'content'));
const WINDOW_STATE = 'visible, non-occluded (Chrome automation flags)';
const MAX_RETAINED_BYTES = 10 * 1024 * 1024;
const BAR_UNITS = Object.freeze({
  RATE_STEADY_TOLERANCE: 'dimensionless rate',
  STRETCH_EDGE_EXCLUSION_MS: 'ms',
  MIN_STRETCH_SPAN_MS: 'ms',
  MIN_STRETCH_RECORDS: 'count',
  MIN_RESIDUAL_SPAN_MS: 'ms',
  MIN_RESIDUAL_RECORDS: 'count',
  MAX_STRETCH_SLOPE_SE_PPM: 'ppm',
  MAX_RESIDUAL_SLOPE_SE_PPM: 'ppm',
  SLOPE_SIGNIFICANCE_SIGMA: 'dimensionless',
  RESIDUAL_FLOOR_PPM: 'ppm',
  ENDPOINT_CROSSCHECK_MS: 'ms',
});

/**
 * The gap the run IMPOSES between the two windows (3b design.md D3). Without it
 * the assertion below cannot fail: open both at the same instant and a working
 * timeline and a DELETED timeline both put both windows near position zero, so
 * the observation is identical in the two worlds it has to separate. With it,
 * a working timeline makes the second window catch up and a broken one leaves
 * it ten seconds behind. It is the input to the experiment, not dead time.
 */
const WINDOW_GAP_MS = 10000;

/**
 * How far apart the two windows' converged medians may be — the pairwise
 * question. Read after settling over the span T6 anchors, never off the ring's
 * whole history. NOT criterion 1: two clients on a healthy network are an early
 * signal, not change 6's five-client figure under loss. A failure is a plan
 * finding, never a reason to loosen this constant.
 */
const POSITION_TOLERANCE_MS = 50;

/**
 * One window against the room, over the same converged span — the looser
 * question of the two, and the one the standing lag used to decide. At the 400ms
 * it was sized to before change 4c it passed with the controller deleted, which
 * is what tightening it to the controller's own target ends.
 */
const DRIFT_TOLERANCE_MS = 40;

// T5 settle wait from each window's own playback start (design.md D2).
const SETTLE_DEADLINE_MS = 120_000;
const SETTLING_BUDGET_MS = 75_000;
const SETTLE_POLL_MS = 250;
// Recorder cadence: half the controller's 250 ms poll, so every evaluation is observable.
const CAPTURE_POLL_MS = 125;
// T6 converged span for tightened tolerances (tasks.md 2.4b).
const CONVERGED_WINDOW_MS = 10_000;
// T7 excursion observation (design.md D4). Every threshold the samples are
// JUDGED against lives in drift-figures.mjs; these are the driver's cadence.
const OBSERVE_MS = 60_000;
const OBSERVE_POLL_MS = 125;
const OBSERVE_PROGRESS_MS = 10_000;
const SETTLE_PROGRESS_MS = 4_000;
// 4a's sweep produced a standing lag per window, and the run says whether this
// hardware reproduces it.
const REFERENCE_LAG_MS = [-308, -104];
// T6b line read-back (design.md D1).
const LINE_READ_DEADLINE_MS = 3_000;
const LINE_READ_POLL_MS = 250;
// T8 seam route (design.md D3).
const DEPART_DEADLINE_MS = 30_000;
const DEPART_POLL_MS = 1_000;
const REJOIN_DEADLINE_MS = 30_000;
const REJOIN_POLL_MS = 500;
const SEAM_SETTLE_MS = 3_000;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sha = (text) => sha256(text).slice(0, 12);

function prepareRunDirectory() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const relativeRunDir = path.relative(APP_DIR, RUN_DIR);
  try {
    const ignoredBy = execFileSync('git', ['check-ignore', '-v', '--', relativeRunDir], {
      cwd: APP_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error(`run output directory is ignored by ${ignoredBy.trim()}`);
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  if (fs.existsSync(RUN_DIR)) {
    throw new Error(`run output directory already exists: ${RUN_DIR}`);
  }
  fs.mkdirSync(RUN_DIR);
  console.log(`run output directory: ${RUN_DIR}`);
}

prepareRunDirectory();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verify-'));

const BAR_DEFINITIONS = Object.freeze({
  RATE_STEADY_TOLERANCE: { value: RATE_STEADY_TOLERANCE, units: BAR_UNITS.RATE_STEADY_TOLERANCE },
  STRETCH_EDGE_EXCLUSION_MS: { value: STRETCH_EDGE_EXCLUSION_MS, units: BAR_UNITS.STRETCH_EDGE_EXCLUSION_MS },
  MIN_STRETCH_SPAN_MS: { value: MIN_STRETCH_SPAN_MS, units: BAR_UNITS.MIN_STRETCH_SPAN_MS },
  MIN_STRETCH_RECORDS: { value: MIN_STRETCH_RECORDS, units: BAR_UNITS.MIN_STRETCH_RECORDS },
  MIN_RESIDUAL_SPAN_MS: { value: MIN_RESIDUAL_SPAN_MS, units: BAR_UNITS.MIN_RESIDUAL_SPAN_MS },
  MIN_RESIDUAL_RECORDS: { value: MIN_RESIDUAL_RECORDS, units: BAR_UNITS.MIN_RESIDUAL_RECORDS },
  MAX_STRETCH_SLOPE_SE_PPM: { value: MAX_STRETCH_SLOPE_SE_PPM, units: BAR_UNITS.MAX_STRETCH_SLOPE_SE_PPM },
  MAX_RESIDUAL_SLOPE_SE_PPM: { value: MAX_RESIDUAL_SLOPE_SE_PPM, units: BAR_UNITS.MAX_RESIDUAL_SLOPE_SE_PPM },
  SLOPE_SIGNIFICANCE_SIGMA: { value: SLOPE_SIGNIFICANCE_SIGMA, units: BAR_UNITS.SLOPE_SIGNIFICANCE_SIGMA },
  RESIDUAL_FLOOR_PPM: { value: RESIDUAL_FLOOR_PPM, units: BAR_UNITS.RESIDUAL_FLOOR_PPM },
  ENDPOINT_CROSSCHECK_MS: { value: ENDPOINT_CROSSCHECK_MS, units: BAR_UNITS.ENDPOINT_CROSSCHECK_MS },
});

// Copied from verify-frames.mjs's readContentFrameRate. That file executes its
// pass on import and is outside this change's write set, so importing it would
// run a second Chrome pass; keep this probe aligned manually.
function readContentFrameRate() {
  const temporaryPath = path.join(os.tmpdir(), `verify-browser-fps-${Date.now()}.mp4`);
  const init = fs.readFileSync(path.join(MEDIA_DIR, 'init.mp4'));
  const segment = fs.readFileSync(path.join(MEDIA_DIR, 'seg-00000.m4s'));
  fs.writeFileSync(temporaryPath, Buffer.concat([init, segment]));
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=nw=1:nk=1',
      temporaryPath,
    ]).toString().trim();
    const match = /^(\d+)\/(\d+)$/.exec(output);
    if (!match) throw new Error(`unparseable content frame rate: ${JSON.stringify(output)}`);
    const fps = Number(match[1]) / Number(match[2]);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid content frame rate: ${output}`);
    return fps;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

const URL_A = `${ORIGIN}/room.html?room=demo&role=host&tab=A`;
const URL_B = `${ORIGIN}/room.html?room=demo&role=viewer&tab=B`;
const URL_V = `${ORIGIN}/room.html?room=demo&role=viewer&tab=V`;

// The first window IS page A — no about:blank bootstrap window.
const chrome = spawn(
  CHROME,
  [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', URL_A],
  { stdio: 'ignore' }
);

/**
 * A page in its OWN Chrome window — a second tab in one window is a background
 * tab, and a background tab does not autoplay, which is what made the first run
 * of this report the host "not playing" when the host was fine.
 *
 * `alreadyOpen` is the first window, the one Chrome was launched with: nothing
 * to spawn, and nothing to exclude, because that target is the one being looked
 * for.
 */
async function attach(label, url, alreadyOpen = false) {
  if (alreadyOpen) return attachTo(PORT, url, { label });
  const before = new Set((await cdpHttp('/json/list')).map((t) => t.id));
  spawn(CHROME, [...FLAGS, '--new-window', `--user-data-dir=${profile}`, '--window-size=700,500', url], { stdio: 'ignore' });
  return attachTo(PORT, url, { label, exclude: before });
}

// `currentTime` appears here and NOWHERE ELSE IN THIS FILE, for two questions it
// can answer: is this element playing, and has it advanced. It is not a drift
// primitive and is not used as one (`CONSTRAINTS.md` → *Playback measurement*):
// every figure below about WHERE a window is — the two-window agreement of 3.5
// included — is read from the drift records, which come from
// `requestVideoFrameCallback`.
const PROBE = `({
  time: document.querySelector('video').currentTime,
  paused: document.querySelector('video').paused,
  members: [...document.querySelectorAll('#roster li')].map(li => li.textContent.trim()),
  status: (document.querySelector('#status-line')||{}).textContent,
  clockText: (document.querySelector('#clock-line')||{}).textContent,
  driftText: (document.querySelector('#drift-line')||{}).textContent,
  controllerText: (document.querySelector('#controller-line')||{}).textContent,
  notices: [...document.querySelectorAll('#notices li')].map(li => li.textContent.trim()),
})`;

// THE STAMPS, not a statistic taken from them: the panel's rate is derived on
// this side, through the same median every other figure in the run uses.
const RAF_STAMPS = `(() => new Promise((resolve) => {
  const stamps = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(guard);
    resolve(stamps.slice());
  };
  const guard = setTimeout(finish, 4000);
  const frame = (atMs) => {
    if (finished) return;
    stamps.push(atMs);
    if (stamps.length >= 121) finish();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}))()`;

/**
 * The harness seam (3b design.md D2), as change 6 will read it: values, not text
 * scraped back out of a string formatted for a person. `latest` is the newest
 * drift record — one client against the room timeline, NOT criterion 1's
 * pairwise figure.
 */
const SEAM = `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  const drift = app.drift(0);
  return {
    present: true,
    buildId: app.buildId,
    clock: app.clock(),
    playback: app.playback(),
    controller: app.controller(),
    timeline: app.timeline(),
    counters: drift.counters,
    held: drift.records.length,
    latest: drift.records[drift.records.length - 1] ?? null,
    // THE WHOLE ARRAY, not a figure derived from it. The sawtooth amplitude the
    // controller's simulated plant runs on is measured from these records and
    // never chosen (change 4a design.md D8), and change 4c's model check reads
    // Chrome's real scatter back beside the plant's. Deleting this line costs
    // the only route from a real player to that constant.
    records: drift.records,
    // THE PAGE'S OWN ROLLING WINDOW, not a second one derived here. This
    // re-derivation took the upper of the middle two where the log takes their
    // mean, so the figure the run reported was never quite the one the page did.
    summary: app.summary(),
  };
})()`;

/** The seam, once the bundle has run. A page probed before that reports nothing. */
async function seamOf(tab, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seam = await tab.evaluate(SEAM);
    if (seam.present || Date.now() > deadline) return seam;
    await sleep(250);
  }
}

/**
 * How far this window has played PAST WHERE IT OPENED. `currentTime` on its own
 * stopped meaning "it is playing" the moment change 3b made playback start at
 * the room's position: the second window opens WINDOW_GAP_MS in BY CONSTRUCTION,
 * so `time > 1` is true of it before it has shown a single frame. A window whose
 * start position is unreadable yields NaN, which fails every comparison below
 * rather than passing one.
 */
function advancedMs(seam, probe) {
  const startedAt = seam.playback?.startedAtMediaMs;
  return Number.isFinite(startedAt) ? probe.time * 1000 - startedAt : NaN;
}

const failures = [];
function expect(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
}

/**
 * Poll `read` every `everyMs` until `done` accepts a reading or `deadlineAt`
 * passes, and say which of the two ended it. `first` is a reading already in
 * hand, tested before anything is read.
 *
 * ONE PIECE OF DEADLINE ARITHMETIC, where the five waits below had a copy of it
 * each and the copies had already begun to differ over whether the last sleep
 * may overrun the deadline. A wait that overruns its budget is how a pass
 * reports a timeout it never actually waited out.
 */
async function pollUntil(read, done, { everyMs, deadlineAt, first }) {
  let value = first === undefined ? await read() : first;
  while (!done(value)) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { value, ok: false };
    await sleep(Math.min(everyMs, remaining));
    // The reading that would land ON the deadline is not taken: a wait reports
    // what it saw INSIDE its budget, and every loop this replaced ended that way.
    if (Date.now() >= deadlineAt) return { value, ok: false };
    value = await read();
  }
  return { value, ok: true };
}

async function pumpAll(recorders, atMs = Date.now()) {
  for (const recorder of recorders) {
    if (recorder) await recorder.pump(atMs);
  }
}

async function pumpingWait(recorders, durationMs, everyMs) {
  const endAt = Date.now() + durationMs;
  await pumpAll(recorders);
  while (Date.now() < endAt) {
    await sleep(Math.min(everyMs, endAt - Date.now()));
    if (Date.now() < endAt) await pumpAll(recorders);
  }
  await pumpAll(recorders);
}

function readNdjson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (text === '') return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid NDJSON at ${filePath}:${index + 1}: ${error.message}`);
    }
  });
}

function barsFromManifest(manifest) {
  const bars = Object.fromEntries(Object.entries(manifest.bars ?? {}).map(([name, definition]) => [name, definition.value]));
  for (const name of Object.keys(DEFAULT_BARS)) {
    if (!Number.isFinite(bars[name])) throw new Error(`manifest is missing bar ${name}`);
  }
  return bars;
}

function qualifyingFit(fit, minimumRecords, minimumSpanMs, standardErrorPpm) {
  return !fit.refused
    && fit.recordCount >= minimumRecords
    && fit.trimmedSpanMs >= minimumSpanMs
    && Number.isFinite(fit.media?.standardErrorPpm)
    && fit.media.standardErrorPpm <= standardErrorPpm
    && Number.isFinite(fit.drift?.standardErrorPpm)
    && fit.drift.standardErrorPpm <= standardErrorPpm
    && fit.endpointCrosscheck?.mediaWithinBar === true
    && fit.endpointCrosscheck?.driftWithinBar === true;
}

function evaluateSufficiency(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bars = barsFromManifest(manifest);
  const windows = (manifest.windows ?? []).map((window) => {
    const records = readNdjson(path.join(RUN_DIR, window.files.records));
    const captures = readNdjson(path.join(RUN_DIR, window.files.captures));
    const samples = captures.map((capture) => ({ atMs: capture.atMs, ...capture.controller }));
    const stretches = steadyCommandStretches(samples, bars);
    const fits = stretchSlopes({ stretches, records, bars });
    const saturatedFits = fits.filter((fit) => qualifyingFit(
      fit,
      bars.MIN_STRETCH_RECORDS,
      bars.MIN_STRETCH_SPAN_MS,
      bars.MAX_STRETCH_SLOPE_SE_PPM,
    ) && Math.abs(fit.medianRate - (1 + MAX_RATE_DEVIATION)) <= bars.RATE_STEADY_TOLERANCE);
    const plateauFits = fits.filter((fit) => qualifyingFit(
      fit,
      bars.MIN_RESIDUAL_RECORDS,
      bars.MIN_RESIDUAL_SPAN_MS,
      bars.MAX_RESIDUAL_SLOPE_SE_PPM,
    ) && fit.medianRate < 1 + MAX_RATE_DEVIATION - bars.RATE_STEADY_TOLERANCE);
    const recordMinimumMet = records.length >= bars.MIN_RESIDUAL_RECORDS;
    const spanMinimumMet = plateauFits.length > 0;
    const missed = window.counts?.missed;
    const ok = missed === 0 && recordMinimumMet && spanMinimumMet && saturatedFits.length > 0 && plateauFits.length > 0;
    return {
      label: window.label,
      records: records.length,
      captures: captures.length,
      missed,
      stretches: fits.length,
      qualifyingSaturated: saturatedFits.length,
      qualifyingPlateau: plateauFits.length,
      recordMinimumMet,
      spanMinimumMet,
      ok,
    };
  });
  return { ok: windows.length === 2 && windows.every((window) => window.ok), windows };
}

function rederiveConvergedMedian(recordsPath, barSeq, endSeq) {
  if (!Number.isSafeInteger(barSeq) || !Number.isSafeInteger(endSeq) || endSeq < barSeq) {
    throw new Error(`invalid retained median bounds ${barSeq}..${endSeq}`);
  }
  const records = readNdjson(recordsPath);
  if (!records.every((record) => record && Number.isSafeInteger(record.seq))) {
    throw new Error(`retained records in ${recordsPath} do not all have sequence numbers`);
  }
  const selected = records.filter((record) => record.seq > barSeq && record.seq <= endSeq);
  const result = convergedStats({ records: selected }, barSeq);
  return { medianMs: result.convergedMedianMs, count: result.convergedCount };
}

async function waitForSettle(tabs) {
  const startedAt = Date.now();
  const capAt = startedAt + SETTLE_DEADLINE_MS + WINDOW_GAP_MS + 60_000;
  const states = tabs.map(({ label, tab, recorder }) => ({
    label,
    tab,
    recorder,
    last: null,
    absent: 0,
    firstPlaybackAt: null,
    firstPlayback: null,
    firstSettledAt: null,
    firstSettlingMs: null,
    lastNoCorrection: null,
    lastNoSettling: null,
    firstRecords: null,
    firstClock: null,
  }));
  let nextProgressAt = startedAt + SETTLE_PROGRESS_MS;
  let settleTurn = 0;

  const readAll = async () => {
    const readSeam = settleTurn % 2 === 0;
    settleTurn++;
    for (const state of states) {
      const atMs = Date.now();
      if (readSeam) {
        const seam = await state.tab.evaluate(SEAM);
        if (!seam.present) {
          state.absent++;
        } else {
          const reading = { atMs, seam };
          state.last = reading;
          const playback = seam.playback ?? {};
          const controller = seam.controller ?? {};
          if (playback.playing === true && state.firstPlaybackAt === null) {
            state.firstPlaybackAt = reading.atMs;
            state.firstPlayback = reading;
          }
          if (controller.mode === 'settled' && controller.settlingMs !== null && state.firstSettledAt === null) {
            state.firstSettledAt = reading.atMs;
            state.firstSettlingMs = controller.settlingMs;
          }
          if (controller.correctionsApplied === 0) state.lastNoCorrection = reading;
          if (controller.settlingMs === null) state.lastNoSettling = reading;
          if (Array.isArray(seam.records) && seam.records.length >= MIN_RECORDS && state.firstRecords === null) {
            state.firstRecords = { atMs: reading.atMs, records: seam.records.slice(0, 8) };
          }
          if (seam.clock?.offsetMs != null && state.firstClock === null) {
            state.firstClock = { atMs: reading.atMs, held: seam.held, counters: seam.counters };
          }
        }
      }
      await state.recorder?.pump(atMs);
    }

    const now = Date.now();
    if (now >= nextProgressAt) {
      for (const state of states) {
        const seam = state.last?.seam;
        const controller = seam?.controller ?? {};
        const elapsed = state.firstPlaybackAt === null ? 'n/a' : `${((now - state.firstPlaybackAt) / 1000).toFixed(1)}s`;
        console.log(`  ${state.label}: elapsed ${elapsed} · mode ${controller.mode ?? 'null'} · reason ${controller.reason ?? 'null'} · rate ${controller.rate ?? 'null'} · estimateMs ${controller.estimateMs ?? 'null'} · bandMs ${controller.bandMs ?? 'null'} · windowRecords ${controller.windowRecords ?? 'null'} · correctionsApplied ${controller.correctionsApplied ?? 'null'}`);
      }
      nextProgressAt = now + SETTLE_PROGRESS_MS;
    }
    return states;
  };

  // A window is done when it has settled, or when its OWN playback start is
  // SETTLE_DEADLINE_MS behind — the per-window deadline is the point of the
  // wait, and `capAt` is only the backstop for a window that never played.
  // Pump-only turns reuse these persisted latches; checking them twice as often
  // does not require another tab evaluation.
  const settledOrOutOfTime = (state) => state.firstSettledAt !== null
    || (state.firstPlaybackAt !== null && Date.now() >= state.firstPlaybackAt + SETTLE_DEADLINE_MS);
  await pollUntil(readAll, (all) => all.every(settledOrOutOfTime), { everyMs: CAPTURE_POLL_MS, deadlineAt: capAt });
  return states;
}

async function observeWindows(tabs, durationMs) {
  const startedAt = Date.now();
  const endAt = startedAt + durationMs;
  const states = tabs.map(({ label, tab, recorder }) => ({ label, tab, recorder, samples: [], absent: 0, lastSeam: null }));
  let nextSampleAt = startedAt;
  let nextProgressAt = startedAt + OBSERVE_PROGRESS_MS;

  while (nextSampleAt < endAt) {
    const atMs = Date.now();
    await Promise.all(states.map(async (state) => {
      const seam = await state.tab.evaluate(SEAM);
      if (!seam.present) {
        state.absent++;
        await state.recorder?.pump(atMs);
        return;
      }
      state.lastSeam = seam;
      const controller = seam.controller ?? {};
      state.samples.push({
        atMs,
        mode: controller.mode ?? null,
        reason: controller.reason ?? null,
        rate: controller.rate ?? null,
        polls: controller.polls ?? null,
        estimateMs: controller.estimateMs ?? null,
        bandMs: controller.bandMs ?? null,
        spreadMs: controller.spreadMs ?? null,
        windowRecords: controller.windowRecords ?? null,
        controlRecords: controller.controlRecords ?? null,
      });
      await state.recorder?.pump(atMs);
    }));

    const now = Date.now();
    if (now >= nextProgressAt) {
      const elapsed = Math.min(durationMs, now - startedAt);
      console.log(`  observation ${Math.round(elapsed / 1000)}s/${durationMs / 1000}s: ${states.map((state) => `${state.label} ${state.samples.length} samples`).join(' / ')}`);
      while (nextProgressAt <= now) nextProgressAt += OBSERVE_PROGRESS_MS;
    }

    nextSampleAt += OBSERVE_POLL_MS;
    const remaining = Math.min(nextSampleAt, endAt) - Date.now();
    if (remaining > 0) await sleep(remaining);
  }
  return states;
}

function numberText(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'null';
}

async function measureRefreshRates(tabs) {
  return Promise.all(tabs.map(async ({ label, tab }) => {
    const rate = refreshFrom(await tab.evaluate(RAF_STAMPS));
    expect(`3.2 ${label}'s RAF probe returned a finite refresh rate`, rate.frameCount > 0 && Number.isFinite(rate.refreshRateHz) && rate.refreshRateHz > 0, JSON.stringify(rate));
    return { label, rate };
  }));
}

/**
 * Every rendered reading up to the first that has all three lines populated —
 * the readings are the evidence, so they are kept rather than the verdict.
 */
async function readLines(tab, initial) {
  const readings = [initial];
  const matches = (probe) => {
    const clock = CLOCK_LINE_RE.test((probe.clockText ?? '').trim());
    const drift = DRIFT_LINE_RE.exec((probe.driftText ?? '').trim());
    const controller = CONTROLLER_LINE_HELD_RE.test((probe.controllerText ?? '').trim()) || CONTROLLER_LINE_ACTING_RE.test((probe.controllerText ?? '').trim());
    return clock && drift !== null && Number(drift[1]) > 0 && controller;
  };
  await pollUntil(
    async () => {
      const probe = await tab.evaluate(PROBE);
      readings.push(probe);
      return probe;
    },
    matches,
    { everyMs: LINE_READ_POLL_MS, deadlineAt: Date.now() + LINE_READ_DEADLINE_MS, first: initial },
  );
  return readings;
}

async function readRoute(tab) {
  const [seam, probe] = await Promise.all([tab.evaluate(SEAM), tab.evaluate(PROBE)]);
  return { seam, probe };
}

function routeFields(reading) {
  const seam = reading.seam ?? {};
  const timeline = seam.timeline ?? {};
  const playback = seam.playback ?? {};
  const clock = seam.clock ?? {};
  const controller = seam.controller ?? {};
  return {
    timelineEpochMs: timeline.epochMs ?? null,
    freshJoins: timeline.freshJoins ?? null,
    epochRevisions: timeline.epochRevisions ?? null,
    playbackEpochMs: playback.epochMs ?? null,
    opens: playback.opens ?? null,
    reopens: playback.reopens ?? null,
    callbacks: playback.callbacks ?? null,
    seams: playback.seams?.length ?? null,
    probesIssued: clock.probes?.issued ?? null,
    lost: clock.counters?.lost ?? null,
    sampleCount: clock.sampleCount ?? null,
    halfWidthMs: clock.halfWidthMs ?? null,
    seamDrops: controller.counters?.drops?.seam ?? null,
    mode: controller.mode ?? null,
    probeMembers: reading.probe?.members ?? null,
  };
}

let recorderA = null;
let recorderB = null;
let manifestPath = null;
let contentFps = null;
let contentFpsUnavailableReason = null;

function runCheck() {
  const command = 'npm run check';
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let result;
  try {
    result = spawnSync(executable, ['run', 'check'], {
      cwd: APP_DIR,
      shell: process.platform === 'win32',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      command,
      exitStatus: null,
      summaryLine: null,
      output: '',
      error: error?.message ?? String(error),
    };
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr}`;
  // THE ASSERTION TALLY, not the first line that happens to start with the
  // prefix — the check announces its servers on `protocol-check:` lines too, and
  // a `find` on the prefix alone records the ephemeral port as the run's result.
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('protocol-check: '));
  const summaryLine = lines.findLast((line) => line.includes('assertions')) ?? lines.at(-1) ?? null;
  return {
    command,
    exitStatus: result.status,
    summaryLine,
    output: result.status === 0 && !result.error ? null : output,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

try {
  const chromeInfo = await cdpHttp('/json/version');
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
  try {
    contentFps = readContentFrameRate();
    console.log(`content frame rate (ffprobe, init.mp4 + seg-00000.m4s): ${contentFps} fps`);
  } catch (error) {
    contentFpsUnavailableReason = error?.message ?? String(error);
    console.log(`content frame rate unavailable: ${contentFpsUnavailableReason}`);
  }
  const windows = await cdpHttp('/json/list');
  console.log(`(chrome opened ${windows.filter((t) => t.type === 'page').length} page target(s))`);

  console.log('\n--- 7.1 / 7.2: two windows, one room ---');
  const a = await attach('A/host', URL_A, true);
  recorderA = createRecorder({ label: 'A', tab: a, dir: RUN_DIR });

  console.log('\n--- 3.1: which build is this run talking to? ---');
  // A 200 on /room.html proves something is answering, not what it is
  // (`CONSTRAINTS.md` → *Reachable is not fresh*). This detects a page running a
  // DIFFERENT build, not a page misreporting its own — do not read it as more
  // than that (3b design.md D3).
  const seamEarly = await seamOf(a);
  expect('3.1 the page publishes the harness seam', seamEarly.present === true, JSON.stringify(seamEarly).slice(0, 120));
  const served = await (await fetch(`${ORIGIN}/room.bundle.js`)).text();
  const onDisk = fs.readFileSync(BUNDLE_PATH, 'utf8');
  console.log(`  build id: ${seamEarly.buildId} · served ${sha(served)} · on disk ${sha(onDisk)}`);
  expect('3.1 the origin serves this tree’s bundle', sha(served) === sha(onDisk), `served ${sha(served)}, on disk ${sha(onDisk)}`);
  expect(
    '3.1 the page is running the bundle the origin is serving',
    typeof seamEarly.buildId === 'string' && served.includes(seamEarly.buildId),
    `page reports ${seamEarly.buildId}`
  );

  // THE IMPOSED GAP (3.4) — the input to the experiment, not dead time. Read
  // WINDOW_GAP_MS before shortening or removing it.
  console.log(`\n--- 3.4: opening the second window ${WINDOW_GAP_MS / 1000}s late, on purpose ---`);
  await pumpingWait([recorderA], WINDOW_GAP_MS, CAPTURE_POLL_MS);
  const b = await attach('B/view', URL_B);
  recorderB = createRecorder({ label: 'B', tab: b, dir: RUN_DIR });

  console.log('\n--- T5: waiting for both windows to settle ---');
  const recorders = [recorderA, recorderB];
  const settleStates = await waitForSettle([{ label: 'A', tab: a, recorder: recorderA }, { label: 'B', tab: b, recorder: recorderB }]);
  for (const state of settleStates) {
    const seam = state.last?.seam;
    const controller = seam?.controller ?? {};
    const gapMs = state.firstPlaybackAt === null || state.firstSettledAt === null || state.firstSettlingMs === null
      ? NaN
      : state.firstSettledAt - state.firstPlaybackAt - state.firstSettlingMs;
    console.log(`  ${state.label}: ${state.absent} seam reading(s) not present; first playback ${state.firstPlayback ? `held ${state.firstPlayback.seam.held}` : 'not seen'}; first 8 records ${state.firstRecords ? 'kept' : 'not seen'}; first clock ${state.firstClock ? `held ${state.firstClock.held}` : 'not seen'}; last no-correction ${state.lastNoCorrection ? 'kept' : 'not seen'}; last no-settling ${state.lastNoSettling ? 'kept' : 'not seen'}`);
    console.log(`  ${state.label}: settlingMs ${controller.settlingMs ?? 'null'}; gap before first correction ${Number.isFinite(gapMs) ? `${gapMs.toFixed(1)}ms` : 'unavailable'} (each endpoint observed at ${SETTLE_POLL_MS}ms, about ±0.25s)`);
    // TWO OF THESE FIVE READ THE FINAL POLL AND THREE DO NOT, and the labels say
    // which. `settlingMs` and `correctionsApplied` latch once and never reset
    // (drift-controller.mjs:309); `mode` and `rate` drop on a believed excursion
    // (:285-296). So a red on those two beside three green ones is an excursion,
    // not a failure to converge — read them together or the run cannot tell the
    // two apart. Change 4c design.md D2.
    expect(`T5 ${state.label} is settled at the end of the wait`, controller.mode === 'settled', `${controller.mode ?? 'null'} · ${controller.reason ?? 'null'}`);
    expect(`T5 ${state.label} recorded a correction`, controller.settlingMs !== null, JSON.stringify(controller.settlingMs));
    expect(`T5 ${state.label} applied a rate write`, controller.correctionsApplied > 0, JSON.stringify(controller.correctionsApplied));
    expect(`T5 ${state.label} settled within ${SETTLING_BUDGET_MS}ms`, Number.isFinite(controller.settlingMs) && controller.settlingMs <= SETTLING_BUDGET_MS, JSON.stringify(controller.settlingMs));
    expect(`T5 ${state.label} holds the base rate at the end of the wait`, Math.abs((controller.rate ?? NaN) - 1) <= RATE_EPSILON, JSON.stringify(controller.rate));
  }

  console.log('\n--- T6: measuring a converged span ---');
  const barA = await a.evaluate(SEAM);
  const barB = await b.evaluate(SEAM);
  const barSeqA = barA.latest?.seq ?? 0;
  const barSeqB = barB.latest?.seq ?? 0;
  // THE ANCHOR IS ASSERTED BEFORE ANY FIGURE IS DERIVED FROM IT (`CONSTRAINTS.md`
  // → *A probe that reports its own failure as `null`*). Sequence numbers start
  // at 1 (frame-drift.mjs:139), so a seam read that came back absent leaves the
  // anchor at the 0 sentinel — and every record in the ring is then past it,
  // which silently turns the converged median back into the whole-run median
  // this span exists to replace. The record-count guard below cannot catch that:
  // the whole ring clears MIN_CONVERGED_RECORDS by an order of magnitude.
  expect('T6 A anchored its converged span on a real record', Number.isFinite(barSeqA) && barSeqA > 0, `barSeq ${barSeqA}`);
  expect('T6 B anchored its converged span on a real record', Number.isFinite(barSeqB) && barSeqB > 0, `barSeq ${barSeqB}`);
  await pumpingWait(recorders, CONVERGED_WINDOW_MS / 2, CAPTURE_POLL_MS);
  console.log(`  converged span in progress: ${CONVERGED_WINDOW_MS / 1000}s total, ${CONVERGED_WINDOW_MS / 2000}s elapsed`);
  await pumpingWait(recorders, CONVERGED_WINDOW_MS / 2, CAPTURE_POLL_MS);
  const sa = await a.evaluate(SEAM);
  const pa = await a.evaluate(PROBE);
  const sb = await b.evaluate(SEAM);
  const pb = await b.evaluate(PROBE);
  await pumpAll(recorders);
  const convergedA = convergedStats(sa, barSeqA);
  const convergedB = convergedStats(sb, barSeqB);
  for (const [label, seam, stats] of [['A', sa, convergedA], ['B', sb, convergedB]]) {
    const whole = seam.summary ?? {};
    console.log(`  ${label}: converged span ${CONVERGED_WINDOW_MS / 1000}s, ${stats.convergedCount} records, ${stats.convergedCount < MIN_CONVERGED_RECORDS ? 'not enough records; ' : ''}median ${stats.convergedMedianMs ?? 'null'}ms, interpolated p95-p5 ${stats.convergedSpreadMs ?? 'null'}ms; whole run (ring, up to 3600 records): median ${whole.medianDriftMs ?? 'null'}ms, framesHeld ${whole.framesHeld ?? 'null'}, p99DriftMs ${whole.p99DriftMs ?? 'null'}ms`);
    expect(`3.6 ${label} converged span has at least ${MIN_CONVERGED_RECORDS} records`, stats.convergedCount >= MIN_CONVERGED_RECORDS, `${stats.convergedCount} records`);
    expect(`3.6 ${label} converged records have finite drift`, stats.records.every((record) => Number.isFinite(record.driftMs)), `${stats.records.length} records`);
  }

  console.log('\n--- 3.5 / 3.6 / 3.7: the two windows are in the same room, at the same place ---');
  console.log('  A seam:', JSON.stringify({ playback: sa.playback, summary: sa.summary, counters: sa.counters }));
  console.log('  B seam:', JSON.stringify({ playback: sb.playback, summary: sb.summary, counters: sb.counters }));
  for (const [label, seam] of [['A', sa], ['B', sb]]) {
    expect(`3.7 ${label} reports through the seam that it started playback`, seam.playback?.playing === true, JSON.stringify(seam.playback));
    expect(`3.7 ${label} reports no missing input`, seam.playback?.missing === null, JSON.stringify(seam.playback?.missing));
    expect(`3.7 ${label} opened the media exactly once`, seam.playback?.opens === 1 && seam.playback?.reopens === 0, `opens=${seam.playback?.opens} reopens=${seam.playback?.reopens}`);
  }
  expect('3.6 both windows hold the same timeline reference point', sa.latest?.epochMs === sb.latest?.epochMs && Number.isFinite(sa.latest?.epochMs), `A=${sa.latest?.epochMs} B=${sb.latest?.epochMs}`);
  expect(`3.6 A is within ${DRIFT_TOLERANCE_MS}ms of the room`, Math.abs(convergedA.convergedMedianMs ?? Infinity) <= DRIFT_TOLERANCE_MS, `median ${convergedA.convergedMedianMs?.toFixed(1)}ms over ${convergedA.convergedCount} records`);
  expect(`3.6 B is within ${DRIFT_TOLERANCE_MS}ms of the room`, Math.abs(convergedB.convergedMedianMs ?? Infinity) <= DRIFT_TOLERANCE_MS, `median ${convergedB.convergedMedianMs?.toFixed(1)}ms over ${convergedB.convergedCount} records`);
  const spread = Math.abs((convergedA.convergedMedianMs ?? NaN) - (convergedB.convergedMedianMs ?? NaN));
  expect(
    `3.5 the late window caught up: the two agree to within ${POSITION_TOLERANCE_MS}ms, not the ${WINDOW_GAP_MS / 1000}s it opened late`,
    spread <= POSITION_TOLERANCE_MS,
    `A median ${convergedA.convergedMedianMs ?? 'null'}ms; B median ${convergedB.convergedMedianMs ?? 'null'}ms over ${CONVERGED_WINDOW_MS / 1000}s spans (${convergedA.convergedCount}/${convergedB.convergedCount} records)`
  );

  console.log('\n--- T6b: reading the three rendered lines ---');
  await pumpAll(recorders);
  const linesA = await readLines(a, pa);
  await pumpAll(recorders);
  const linesB = await readLines(b, pb);
  await pumpAll(recorders);
  for (const [label, readings, seam] of [['A', linesA, sa], ['B', linesB, sb]]) {
    const distinct = (key) => [...new Set(readings.map((reading) => reading[key] ?? ''))];
    console.log(`  ${label} clock line readings: ${JSON.stringify(distinct('clockText'))}`);
    console.log(`  ${label} drift line readings: ${JSON.stringify(distinct('driftText'))}`);
    console.log(`  ${label} controller line readings: ${JSON.stringify(distinct('controllerText'))}`);
    const clockMatches = readings.filter((reading) => CLOCK_LINE_RE.test((reading.clockText ?? '').trim()));
    const driftMatches = readings.filter((reading) => {
      const match = DRIFT_LINE_RE.exec((reading.driftText ?? '').trim());
      return match !== null && Number(match[1]) > 0;
    });
    const actingMatches = readings.filter((reading) => CONTROLLER_LINE_ACTING_RE.test((reading.controllerText ?? '').trim()));
    const controllerMatches = readings.filter((reading) => {
      const text = (reading.controllerText ?? '').trim();
      return CONTROLLER_LINE_HELD_RE.test(text) || CONTROLLER_LINE_ACTING_RE.test(text);
    });
    expect(`3.2 ${label}'s clock line stops saying "no estimate"`, readings.every((reading) => !/no estimate/i.test(reading.clockText ?? '')), JSON.stringify(distinct('clockText')));
    expect(`3.2 ${label}'s clock line reports an offset, an uncertainty and a sample count`, clockMatches.length > 0, JSON.stringify(distinct('clockText')));
    expect(`3.3 ${label}'s drift line reports a finite drift over a nonzero frame count`, driftMatches.length > 0, JSON.stringify(distinct('driftText')));
    expect(`3.3 ${label}'s seam held records while playing`, seam.summary?.framesHeld > 0 && seam.playback?.playing === true, JSON.stringify({ framesHeld: seam.summary?.framesHeld, playing: seam.playback?.playing }));
    expect(`3.3 ${label}'s summary is labelled a rolling window, not "median drift"`, readings.every((reading) => !/median drift/i.test(reading.driftText ?? '')), JSON.stringify(distinct('driftText')));
    for (const reading of readings) {
      const text = (reading.driftText ?? '').trim();
      const match = DRIFT_LINE_RE.exec(text);
      if (match === null || Number(match[1]) <= 0) console.log(`  ${label} drift line non-match (${reading.paused ? 'not playing' : 'no new records'}): ${JSON.stringify(reading.driftText)}`);
      console.log(`  ${label} controller line beside seam state: ${JSON.stringify({ line: reading.controllerText, mode: seam.controller?.mode, reason: seam.controller?.reason, rate: seam.controller?.rate, estimateMs: seam.controller?.estimateMs, bandMs: seam.controller?.bandMs, fastestCloseMs: seam.controller?.fastestCloseMs, windowRecords: seam.controller?.windowRecords })}`);
    }
    expect(`3.8 ${label}'s controller line uses the acting shape`, actingMatches.length > 0, JSON.stringify(distinct('controllerText')));
    expect(`3.8 ${label}'s controller line uses a published shape`, controllerMatches.length === readings.length, JSON.stringify(distinct('controllerText')));
  }

  console.log('\n--- 7.1 / 7.2: two windows, one room ---');
  console.log('  A:', JSON.stringify(pa));
  console.log('  B:', JSON.stringify(pb));
  const advA = advancedMs(sa, pa);
  const advB = advancedMs(sb, pb);
  expect('7.1 both windows have played on past where they opened', advA > 1000 && advB > 1000, `A +${(advA / 1000).toFixed(1)}s past its start, B +${(advB / 1000).toFixed(1)}s`);
  expect('7.1 both rosters show two members', pa.members.length === 2 && pb.members.length === 2, `A=${pa.members.length} B=${pb.members.length}`);
  expect('7.1 rosters agree', JSON.stringify(pa.members.slice().sort()) === JSON.stringify(pb.members.slice().sort()));

  console.log('\n--- T7: model check and hardware questions ---');
  const observationStates = await observeWindows([{ label: 'A', tab: a, recorder: recorderA }, { label: 'B', tab: b, recorder: recorderB }], OBSERVE_MS);
  const refreshRates = await measureRefreshRates([{ label: 'A', tab: a }, { label: 'B', tab: b }]);
  const plantMinimum = plantSweepMinimum();
  const expectedObservationSamples = Math.ceil(OBSERVE_MS / OBSERVE_POLL_MS);
  const t7Figures = [];
  for (let i = 0; i < observationStates.length; i++) {
    const state = observationStates[i];
    const settleState = settleStates[i];
    const converged = i === 0 ? convergedA : convergedB;
    const stats = observationStats(state.samples, converged.records, OBSERVE_POLL_MS);
    const refresh = refreshRates[i].rate;

    // Every figure here is printed once, in T9's block; collecting them keeps the
    // run's numbers in one place a person can copy into design.md. THE GROUPS GO
    // IN WHOLE — a field-by-field copy of `stats` is a second place for every one
    // of those names to go stale, and it silently drops the one the copy forgets.
    t7Figures.push({
      label: state.label,
      stats,
      refresh,
      verdicts: windowVerdicts({ stats, refresh, plantMinimum }),
      lag: standingLag(settleState.firstRecords?.records, REFERENCE_LAG_MS[i]),
      noCorrectionEstimateMs: settleState.lastNoCorrection?.seam?.controller?.estimateMs,
      converged,
      wholeMedianMs: (i === 0 ? sa : sb).summary?.medianDriftMs ?? null,
      finalCounters: state.lastSeam?.counters ?? null,
      firstClock: settleState.firstClock,
      firstPlayback: settleState.firstPlayback,
      observedSamples: state.samples.length,
      absent: state.absent,
      plantMinimum,
    });
  }

  console.log('\n--- T10: flushing retained records and evaluating sufficiency ---');
  // This is before the next block closes B; anything still in B's ring is lost
  // once that close is issued, so both recorders are closed here after one last pump.
  await pumpAll(recorders);
  const countsA = recorderA.finish();
  const countsB = recorderB.finish();
  const retainedBytes = [recorderA.recordsPath, recorderA.capturesPath, recorderB.recordsPath, recorderB.capturesPath]
    .reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
  if (retainedBytes > MAX_RETAINED_BYTES) {
    throw new Error(`retained capture volume ${retainedBytes} bytes exceeds the ${MAX_RETAINED_BYTES}-byte STOP limit`);
  }
  manifestPath = path.join(RUN_DIR, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    runDirectory: RUN_DIRECTORY_NAME,
    gitHead,
    build: {
      pageBuildId: seamEarly.buildId ?? null,
      servedBundleSha256: sha256(served),
      onDiskBundleSha256: sha256(onDisk),
    },
    chrome: {
      version: chromeInfo.Browser ?? null,
      userAgent: chromeInfo['User-Agent'] ?? null,
    },
    platform: {
      platform: process.platform,
      osRelease: os.release(),
    },
    regime: {
      windowState: WINDOW_STATE,
      contentFps,
      contentFpsUnavailableReason,
      mediaDir: MEDIA_DIR,
      appMediaDir: process.env.APP_MEDIA_DIR ?? MEDIA_DIR,
    },
    timing: {
      passStartedAt: PASS_STARTED_AT_ISO,
      passEndedAt: new Date().toISOString(),
    },
    bars: BAR_DEFINITIONS,
    check: runCheck(),
    windows: t7Figures.map((figure, index) => ({
      label: figure.label,
      panel: refreshRates[index].rate,
      files: {
        records: `${figure.label}.records.ndjson`,
        captures: `${figure.label}.captures.ndjson`,
      },
      counts: index === 0 ? countsA : countsB,
      observedSamples: figure.observedSamples,
      absentSamples: figure.absent,
    })),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const sufficiency = evaluateSufficiency(manifestPath);
  manifest.sufficiency = sufficiency;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const window of sufficiency.windows) {
    console.log(`  ${window.label}: missed ${window.missed}; ${window.records} retained records and ${window.captures} captures; ${window.qualifyingSaturated} qualifying saturated stretch(es), ${window.qualifyingPlateau} qualifying plateau stretch(es); record minimum ${window.recordMinimumMet ? 'met' : 'not met'}, span minimum ${window.spanMinimumMet ? 'met' : 'not met'}`);
  }
  expect('T10 both windows retain a sufficient, gap-free capture', sufficiency.ok, JSON.stringify(sufficiency));

  const rederivedA = rederiveConvergedMedian(path.join(RUN_DIR, 'A.records.ndjson'), barSeqA, sa.latest?.seq);
  const rederivedB = rederiveConvergedMedian(path.join(RUN_DIR, 'B.records.ndjson'), barSeqB, sb.latest?.seq);
  expect('T10 A converged median re-derives from retained NDJSON', rederivedA.medianMs === convergedA.convergedMedianMs && rederivedA.count === convergedA.convergedCount, `retained ${rederivedA.medianMs}ms/${rederivedA.count}; printed ${convergedA.convergedMedianMs}ms/${convergedA.convergedCount}`);
  expect('T10 B converged median re-derives from retained NDJSON', rederivedB.medianMs === convergedB.convergedMedianMs && rederivedB.count === convergedB.convergedCount, `retained ${rederivedB.medianMs}ms/${rederivedB.count}; printed ${convergedB.convergedMedianMs}ms/${convergedB.convergedCount}`);

  const predictedParkingMs = predictedParkingDistanceMs(
    t7Figures[0]?.stats.bandMedianMs,
    t7Figures[1]?.stats.bandMedianMs,
  );

  const pa2 = await a.evaluate(PROBE);
  const pb2 = await b.evaluate(PROBE);
  const advA2 = advancedMs(await seamOf(a), pa2);
  const advB2 = advancedMs(await seamOf(b), pb2);
  expect('7.2 playback continues past the first few segments', advA2 > 12000 && advB2 > 12000, `A +${(advA2 / 1000).toFixed(1)}s past its start, B +${(advB2 / 1000).toFixed(1)}s`);
  expect('7.2 neither window stalled', pa2.time > pa.time + 5 && pb2.time > pb.time + 5, `A +${(pa2.time - pa.time).toFixed(1)}s, B +${(pb2.time - pb.time).toFixed(1)}s`);

  console.log('\n--- 7.1: closing one updates the other ---');
  await cdpHttp(`/json/close/${b.targetId}`);
  await sleep(3000);
  const pa3 = await a.evaluate(PROBE);
  expect("7.1 closing B shrinks A's roster", pa3.members.length === 1, JSON.stringify(pa3.members));

  console.log('\n--- 7.3a: a second live window carrying the same tab id ---');
  // CHANGED BY change 1b, and this is the change in one place. Under change 1
  // this window reclaimed the host role, because presenting the same `tabId`
  // was the entire requirement — which is exactly why any member holding the
  // roster could do the same. It now holds no reclaim secret, so it is not the
  // same tab as far as the server is concerned: it is refused `tab-taken`,
  // retries for about a second against a holder that is answering pings, and
  // then reports that the name is in use. The incumbent is untouched.
  const v = await attach('V/view', URL_V);
  await sleep(3000);
  const noticesBefore = (await v.evaluate(PROBE)).notices.length;

  const a2 = await attach('A2/host', URL_A);

  // TWO PHASES NOW, because of D13. Under D11 this window gave up in about a
  // second, on a boolean saying the holder looked alive. That boolean could not
  // be read in time at this server's 5000ms interval, so the budget now comes
  // from the refusal itself: the server reports ~15s (three sweep ticks) and
  // the newcomer retries across it before giving up at ~18s, one backoff step
  // past the deadline.
  //
  // Phase one asserts it is visibly retrying, not hung and not silently gone.
  // Read from the NOTICES, not the status line: the status cycles through
  // retrying → disconnected → reconnecting → connected on every attempt, so any
  // single sample of it is a coin toss. The notice log accumulates.
  await sleep(6000);
  const pRetry = await a2.evaluate(PROBE);
  const refusalNotices = pRetry.notices.filter((n) => /join refused/i.test(n));
  console.log('  A2 while retrying:', JSON.stringify(refusalNotices.slice(-3)));
  expect('7.3a the newcomer reports the refusal immediately', refusalNotices.length >= 1, JSON.stringify(refusalNotices[0]));
  expect('7.3a and says it is retrying, with how long for', /retrying for up to \d+s/i.test(refusalNotices[0] ?? ''), refusalNotices[0]);
  expect('7.3a it is still retrying several seconds in', refusalNotices.length >= 2, `${refusalNotices.length} refusal notices`);

  const pvMid = await v.evaluate(PROBE);
  const pa1Mid = await a.evaluate(PROBE);
  expect('7.3a the incumbent keeps the host role while contested', pa1Mid.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa1Mid.members));
  expect('7.3a the incumbent was not superseded', !/superseded/i.test(pa1Mid.status), pa1Mid.status);
  expect('7.3a the viewer sees exactly one host', pvMid.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pvMid.members));
  expect('7.3a the incumbent kept playing while contested', !pa1Mid.paused, `t=${pa1Mid.time.toFixed(2)}s`);

  // Phase two: past the reported window, it gives up for good.
  await sleep(18000);
  const pv = await v.evaluate(PROBE);
  const pa4 = await a2.evaluate(PROBE);
  const pa1 = await a.evaluate(PROBE);
  const duringContest = pv.notices.slice(noticesBefore);
  console.log('  V saw during the contest:', JSON.stringify(duringContest));
  console.log('  A2 final status:', JSON.stringify(pa4.status));
  console.log('  A (incumbent) roster:', JSON.stringify(pa1.members));

  // NAMES THE CODE, not merely the word "refused". The bare /refused:/ this
  // read before went red the moment change 2 made the page say `refused
  // (tab-taken):`, and stayed red for two changes because nobody runs this file
  // mid-change (CONSTRAINTS.md → *A check outside `npm run check`*).
  const REFUSED_RE = /^refused \(tab-taken\): .*in use/i;
  expect('7.3a the newcomer eventually gives up, and says which name is in use', REFUSED_RE.test(pa4.status ?? ''), pa4.status);
  expect('7.3a the incumbent still holds the role', pa1.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa1.members));
  expect('7.3a the viewer still sees exactly one host', pv.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv.members));
  // A refused join is a directed error that consumes no `seq`, so the room
  // never observes the attempt at all — no join, no leave, no presence. That
  // holds for every one of the retries, not just the first.
  expect('7.3a the room observed no membership change at any point', !duringContest.some((n) => /presence/.test(n)), JSON.stringify(duringContest));
  const advV = advancedMs(await seamOf(v), pv);
  expect('7.3a the viewer kept playing throughout', advV > 5000 && !pv.paused, `+${(advV / 1000).toFixed(1)}s past its start`);

  // Give the refused tab several backoff intervals to misbehave.
  await sleep(4000);
  const pv2 = await v.evaluate(PROBE);
  const swaps = pv2.notices.slice(noticesBefore).filter((n) => /presence/.test(n)).length;
  expect('7.3a the refused tab stays down once it has given up', swaps === 0, `${swaps} presence events after the refusal`);
  const pa4b = await a2.evaluate(PROBE);
  expect('7.3a and does not resume retrying', REFUSED_RE.test(pa4b.status ?? ''), pa4b.status);
  await cdpHttp(`/json/close/${a2.targetId}`);

  console.log('\n--- 7.3b: closing the host tab and reopening it with the same tab id ---');
  const noticesB = pv2.notices.length;
  await cdpHttp(`/json/close/${a.targetId}`);
  await sleep(1500);
  const a3 = await attach('A3/host', URL_A);
  await sleep(4000);
  const pv3 = await v.evaluate(PROBE);
  const pa5 = await a3.evaluate(PROBE);
  console.log('  V saw:', JSON.stringify(pv3.notices.slice(noticesB)));
  // A cleanly closed tab sends a websocket close frame, so this is an ordinary
  // departure followed by an ordinary join, NOT the reclaim path — the room is
  // briefly hostless, which the spec explicitly permits.
  expect('7.3b the reopened host holds the role again', pa5.members.some((m) => /host/.test(m) && /^A /.test(m)), JSON.stringify(pa5.members));
  expect('7.3b the viewer ends with exactly one host', pv3.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv3.members));
  const advV3 = advancedMs(await seamOf(v), pv3);
  expect('7.3b the viewer kept playing throughout', advV3 > 10000 && !pv3.paused, `+${(advV3 / 1000).toFixed(1)}s past its start`);

  console.log('\n--- 7.3c: reloading the host tab (change 1b task 4.3) ---');
  // The case design.md D4 names as the accepted hole: a reload throws the
  // reclaim secret away, so the new page is a stranger holding the old page's
  // label. It is normally invisible — a reloading tab produces a clean close,
  // so the room has no host by the time the new page joins — but if the join
  // beats the close, the new page is refused and has to retry itself in.
  //
  // Automated rather than done by hand because a verification that requires
  // someone to watch a tab is a verification that stops being run, and because
  // "how often" is the part worth knowing.
  const RELOADS = 6;
  let refusedReloads = 0;
  let failedReloads = 0;
  for (let i = 1; i <= RELOADS; i++) {
    await a3.send('Page.reload', { ignoreCache: false });
    await sleep(4000);
    await a3.send('Runtime.enable');
    const probe = await a3.evaluate(PROBE);
    const contested = probe.notices.some((n) => /refused/i.test(n));
    const holdsRole = probe.members.some((m) => /host/.test(m) && /^A /.test(m));
    if (contested) refusedReloads++;
    if (!holdsRole) failedReloads++;
    console.log(`  reload ${i}: ${holdsRole ? 'rejoined as host' : 'DID NOT REJOIN'}${contested ? ' (was refused first, then retried in)' : ''} — ${JSON.stringify(probe.status)}`);
  }
  expect(`7.3c every reload ends holding the host role (${RELOADS} reloads)`, failedReloads === 0, `${failedReloads} reload(s) did not rejoin`);
  console.log(`  ${refusedReloads}/${RELOADS} reload(s) hit the D4 race and were refused before retrying in`);

  const pv4 = await v.evaluate(PROBE);
  expect('7.3c the viewer ends with exactly one host', pv4.members.filter((m) => /host/.test(m)).length === 1, JSON.stringify(pv4.members));
  expect('7.3c the viewer kept playing throughout', !pv4.paused, `t=${pv4.time.toFixed(2)}s`);

  console.log('\n--- T8: producing the first seam ---');
  // THE ROUTE IS READ THROUGH `routeFields` AND NOWHERE ELSE — the fields
  // printed here are the fields every assertion below is decided on, so a
  // `before` and an `after` cannot come from two different paths.
  const before = { V: routeFields(await readRoute(v)), A3: routeFields(await readRoute(a3)) };
  console.log(`  before V: ${JSON.stringify(before.V)}`);
  console.log(`  before A3: ${JSON.stringify(before.A3)}`);

  const offlineConditions = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  const onlineConditions = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await v.send('Network.enable');
  await v.send('Network.emulateNetworkConditions', offlineConditions);

  // ONE 30s BUDGET, shared by the two waits below rather than restarted between
  // them: the departure and the offline signature are the same event, and a
  // second full deadline would let the hold run to a minute.
  const routeOfflineStartedAt = Date.now();
  const routeOfflineDeadlineAt = routeOfflineStartedAt + DEPART_DEADLINE_MS;
  const departure = await pollUntil(
    () => a3.evaluate(PROBE),
    (probe) => probe.members.length === 1,
    { everyMs: DEPART_POLL_MS, deadlineAt: routeOfflineDeadlineAt },
  );
  const departureObserved = departure.ok;
  console.log(departureObserved
    ? `  T8 A3 observed V's departure after ${Date.now() - routeOfflineStartedAt}ms: ${JSON.stringify(departure.value.members)}`
    : `  T8 departure deadline expired after ${DEPART_DEADLINE_MS / 1000}s; A3 roster ${JSON.stringify(departure.value.members)}`);

  // Named for the two readings in scope, not shadowing them.
  const deltaValue = (afterValue, beforeValue) => Number.isFinite(afterValue) && Number.isFinite(beforeValue) ? afterValue - beforeValue : NaN;
  const offlineSignatureFor = (beforeFields, afterFields) => ({
    probesIssued: deltaValue(afterFields.probesIssued, beforeFields.probesIssued) >= 3,
    lost: deltaValue(afterFields.lost, beforeFields.lost) >= 3,
    sampleCountUnchanged: afterFields.sampleCount === beforeFields.sampleCount,
    halfWidthWidened: Number.isFinite(afterFields.halfWidthMs) && afterFields.halfWidthMs > beforeFields.halfWidthMs,
    callbacksAdvanced: deltaValue(afterFields.callbacks, beforeFields.callbacks) > 0,
  });

  const offline = await pollUntil(
    async () => {
      const fields = routeFields(await readRoute(v));
      return { fields, signature: offlineSignatureFor(before.V, fields) };
    },
    ({ signature }) => !departureObserved || Object.values(signature).every(Boolean),
    { everyMs: DEPART_POLL_MS, deadlineAt: routeOfflineDeadlineAt },
  );
  const { fields: offlineFields, signature: offlineSignature } = offline.value;
  console.log(`  T8 V offline signature: ${JSON.stringify({ ...offlineSignature, readings: offlineFields })}`);
  // ONLY `lost` DISCRIMINATES, and the labels below say which clause claims what
  // (`CONSTRAINTS.md` → *A reading pinned at its cap*). The other two stay
  // because they say the controller kept its estimate across the hold; both
  // passed in 4c's runs while every probe was completing, so neither is evidence
  // of a disconnection and neither may be read as one.
  expect('T8 V probes issued advanced by at least 3 while offline', offlineSignature.probesIssued, JSON.stringify(offlineFields));
  expect('T8 V lost exchanges advanced by at least 3 while offline', offlineSignature.lost, JSON.stringify(offlineFields));
  expect('T8 V kept its clock estimate: the filter window stayed full', offlineSignature.sampleCountUnchanged, JSON.stringify(offlineFields));
  expect('T8 V clock half-width grew between the two readings', offlineSignature.halfWidthWidened, JSON.stringify(offlineFields));
  expect('T8 V kept producing callbacks while offline', offlineSignature.callbacksAdvanced, JSON.stringify(offlineFields));
  expect('T8 A3 observed V departure before the deadline', departureObserved, JSON.stringify(departure.value.members));

  await v.send('Network.emulateNetworkConditions', onlineConditions);
  const routeRejoinStartedAt = Date.now();
  const beforeFreshJoins = before.V.freshJoins;
  const rejoin = await pollUntil(
    () => v.evaluate(SEAM),
    (seam) => Number.isFinite(seam.timeline?.freshJoins) && Number.isFinite(beforeFreshJoins) && seam.timeline.freshJoins > beforeFreshJoins,
    { everyMs: REJOIN_POLL_MS, deadlineAt: routeRejoinStartedAt + REJOIN_DEADLINE_MS },
  );
  const routeRejoined = rejoin.ok;
  console.log(routeRejoined
    ? `  T8 V fresh-joined after ${Date.now() - routeRejoinStartedAt}ms`
    : `  T8 rejoin deadline expired after ${REJOIN_DEADLINE_MS / 1000}s; V reading ${JSON.stringify(offlineFields)}`);

  const transientControllerReadings = [];
  if (routeRejoined) {
    const transientStartedAt = Date.now();
    while (Date.now() - transientStartedAt < SEAM_SETTLE_MS) {
      const seam = await v.evaluate(SEAM);
      const controller = seam.controller ?? {};
      transientControllerReadings.push({
        atMs: Date.now(),
        mode: controller.mode ?? null,
        reason: controller.reason ?? null,
      });
      const remaining = SEAM_SETTLE_MS - (Date.now() - transientStartedAt);
      if (remaining > 0) await sleep(Math.min(OBSERVE_POLL_MS, remaining));
    }
  }
  const transientTooFew = transientControllerReadings.some((reading) => reading.mode === 'waiting' && reading.reason === 'too-few-records');
  console.log(`  T8 transient waiting · too-few-records observed: ${transientTooFew ? 'yes' : 'no'} over ${transientControllerReadings.length} samples at ${OBSERVE_POLL_MS}ms`);

  const routeAfterV = await readRoute(v);
  const after = { V: routeFields(routeAfterV), A3: routeFields(await readRoute(a3)) };
  console.log(`  after V: ${JSON.stringify(after.V)}`);
  console.log(`  after A3: ${JSON.stringify(after.A3)}`);

  const delta = (who, field) => deltaValue(after[who][field], before[who][field]);
  const freshJoinDelta = delta('V', 'freshJoins');
  const reopenDelta = delta('V', 'reopens');
  const openDelta = delta('V', 'opens');
  const seamDelta = delta('V', 'seams');
  // The two things the route fields cannot carry: the seam LIST rather than its
  // length, and the controller state that is not part of the route.
  const afterVPlayback = routeAfterV.seam?.playback ?? {};
  const afterVController = routeAfterV.seam?.controller ?? {};
  const newVSeam = Array.isArray(afterVPlayback.seams) && Number.isFinite(before.V.seams)
    ? afterVPlayback.seams[before.V.seams]
    : null;

  expect('T8 V freshJoins advanced by exactly 1', freshJoinDelta === 1, `before=${before.V.freshJoins} after=${after.V.freshJoins}`);
  expect('T8 V epochRevisions advanced by 0', delta('V', 'epochRevisions') === 0, `before=${before.V.epochRevisions} after=${after.V.epochRevisions}`);
  expect('T8 V timeline epoch moved later', Number.isFinite(after.V.timelineEpochMs) && after.V.timelineEpochMs > before.V.timelineEpochMs, `before=${before.V.timelineEpochMs} after=${after.V.timelineEpochMs}`);
  expect('T8 V reopens advanced by exactly 1', reopenDelta === 1, `before=${before.V.reopens} after=${after.V.reopens}`);
  expect('T8 V opens advanced by 0', openDelta === 0, `before=${before.V.opens} after=${after.V.opens}`);
  expect('T8 V seams advanced by exactly 1', seamDelta === 1, `before=${before.V.seams} after=${after.V.seams}`);
  expect('T8 V new seam has a nonzero afterSeq', Number.isFinite(newVSeam?.afterSeq) && newVSeam.afterSeq > 0, JSON.stringify(newVSeam));
  expect('T8 V new seam uses the post-event timeline epoch', newVSeam?.epochMs === after.V.timelineEpochMs, JSON.stringify({ seamEpochMs: newVSeam?.epochMs, timelineEpochMs: after.V.timelineEpochMs }));
  expect('T8 V seam-drop counter advanced by exactly 1', delta('V', 'seamDrops') === 1, `before=${before.V.seamDrops} after=${after.V.seamDrops}`);
  expect("T8 V controller's last drop was a seam", afterVController.lastDrop?.reason === 'seam', JSON.stringify(afterVController.lastDrop));
  expect('T8 V controller returned to the base rate within RATE_EPSILON', Math.abs((afterVController.rate ?? NaN) - 1) <= RATE_EPSILON, JSON.stringify(afterVController.rate));
  expect("T8 V controller did not re-settle during the 3s post-seam read", after.V.mode !== 'settled', JSON.stringify({ mode: after.V.mode, reason: afterVController.reason }));
  expect('T8 V controller rebuilt a nonempty window', afterVController.windowRecords > 0, JSON.stringify(afterVController.windowRecords));
  expect('T8 V newest record is after the new seam', Number.isFinite(routeAfterV.seam?.latest?.seq) && routeAfterV.seam.latest.seq > newVSeam?.afterSeq, JSON.stringify({ latestSeq: routeAfterV.seam?.latest?.seq, afterSeq: newVSeam?.afterSeq }));
  expect('T8 A3 freshJoins stayed unchanged', delta('A3', 'freshJoins') === 0, `before=${before.A3.freshJoins} after=${after.A3.freshJoins}`);
  expect('T8 A3 epochRevisions stayed unchanged', delta('A3', 'epochRevisions') === 0, `before=${before.A3.epochRevisions} after=${after.A3.epochRevisions}`);
  expect('T8 A3 reopens stayed unchanged', delta('A3', 'reopens') === 0, `before=${before.A3.reopens} after=${after.A3.reopens}`);
  expect('T8 A3 seam-drop counter stayed unchanged', delta('A3', 'seamDrops') === 0, `before=${before.A3.seamDrops} after=${after.A3.seamDrops}`);
  expect('T8 A3 timeline epoch stayed unchanged', after.A3.timelineEpochMs === before.A3.timelineEpochMs, `before=${before.A3.timelineEpochMs} after=${after.A3.timelineEpochMs}`);

  const networkSignaturePresent = offlineSignature.probesIssued && offlineSignature.lost && offlineSignature.sampleCountUnchanged && offlineSignature.halfWidthWidened;
  if (!offlineSignature.callbacksAdvanced) console.log('  T8 V media stall: playback.callbacks did not advance during the offline hold; this is a stall, not a seam failure.');
  const routeSignaturePresent = Object.values(offlineSignature).every(Boolean);
  let routeDiagnosis = null;
  if (!networkSignaturePresent) routeDiagnosis = 'V never went offline';
  else if (freshJoinDelta !== 1) routeDiagnosis = 'V went offline and was reclaimed';
  else if (reopenDelta !== 1) routeDiagnosis = 'V fresh-joined and did not re-open';
  const routeFired = departureObserved && routeSignaturePresent && freshJoinDelta === 1 && reopenDelta === 1 && openDelta === 0 && seamDelta === 1;
  if (routeDiagnosis !== null || !routeFired) {
    console.log(`  T8 route diagnosis: ${routeDiagnosis ?? 'V fresh-joined and re-opened, but another route assertion failed'}; offline signature ${JSON.stringify(offlineSignature)}; V before/after ${JSON.stringify({ before: before.V, after: after.V })}`);
  } else {
    console.log(`  T8 route diagnosis: seam fired; V fresh-joined and re-opened once, A3 remained untouched`);
  }

  console.log('\n--- T9: figures ---');
  console.log('--- T9 FIGURES BEGIN ---');
  for (const state of settleStates) {
    const seam = state.last?.seam;
    const controller = seam?.controller ?? {};
    const gapMs = state.firstPlaybackAt === null || state.firstSettledAt === null || state.firstSettlingMs === null
      ? NaN
      : state.firstSettledAt - state.firstPlaybackAt - state.firstSettlingMs;
    console.log(`  settling ${state.label}: settlingMs ${numberText(controller.settlingMs)}ms; gap before first correction ${numberText(gapMs)}ms (observed at ${SETTLE_POLL_MS}ms endpoints, ±0.25s granularity); applied rate ${numberText(controller.rate, 9)}; correctionsApplied ${controller.correctionsApplied ?? 'null'}`);
  }
  console.log(`  convergence: ${CONVERGED_WINDOW_MS / 1000}s spans; A median ${numberText(convergedA.convergedMedianMs)}ms over ${convergedA.convergedCount} records; B median ${numberText(convergedB.convergedMedianMs)}ms over ${convergedB.convergedCount} records; separation ${numberText(spread)}ms; whole-run summary medians A ${numberText(sa.summary?.medianDriftMs)}ms and B ${numberText(sb.summary?.medianDriftMs)}ms (ring-held history)`);
  console.log(`  3.3 two-client parking prediction: ${numberText(predictedParkingMs)}ms from A published ${t7Figures[0]?.stats.population} band median ${numberText(t7Figures[0]?.stats.bandMedianMs)}ms + B published ${t7Figures[1]?.stats.population} band median ${numberText(t7Figures[1]?.stats.bandMedianMs)}ms; predicted worst-case separation, not an observed distance.`);
  for (const figure of t7Figures) {
    const { label, stats, verdicts, lag, refresh, converged, plantMinimum: minimum } = figure;
    const plantMinimumText = minimum === null ? 'null' : `${(minimum.dutyCycle * 100).toFixed(1)}% at ${minimum.refreshHz}Hz/${minimum.standingError}ms over ${minimum.population}`;
    console.log(`  3.1 ${label}: first 8 drift median ${numberText(lag.firstEightMs)}ms; last estimate with correctionsApplied=0 ${numberText(figure.noCorrectionEstimateMs)}ms; 4a reference ${lag.referenceLagMs}ms; verdict: ${lag.verdict}.`);
    console.log(`  3.2 ${label}: interpolated span scatter ${numberText(converged.convergedSpreadMs)}ms over ${converged.convergedCount} records; alternation ${numberText(stats.alternation?.fraction, 3)} over ${stats.alternation?.nonzeroPairs ?? 0} nonzero pairs, ${stats.alternation?.zeroPairs ?? 0} zero pairs, ${stats.alternation?.totalPairs ?? 0} total pairs; rounded drifts ${JSON.stringify(stats.histogram)}; panel refresh ${numberText(refresh.refreshRateHz)}Hz from ${refresh.frameCount ?? 'null'} frames with median delta ${numberText(refresh.medianDeltaMs)}ms; verdict: ${verdicts.cadenceVerdict}.`);
    console.log(`  3.3 ${label}: published ${stats.population} spread median ${numberText(stats.spreadMedianMs)}ms, max ${numberText(stats.spreadMaxMs)}ms; predicted half-vsync floor ${numberText(verdicts.predictedFloorMs)}ms; estimate range over the observation ${numberText(stats.estimateRangeMs)}ms; verdict: ${verdicts.floorVerdict}.`);
    console.log(`  3.4 ${label}: first settled sample index ${stats.firstSettledIndex}; population ${stats.population}; duty ${verdicts.dutyVerdict}; excursions ${JSON.stringify(stats.excursions)}; verdict: ${verdicts.excursionVerdict}; plant sweep minimum ${plantMinimumText}; recommendation: ${verdicts.recommendation}; read over ${figure.observedSamples}/${expectedObservationSamples} samples with ${figure.absent} absent.`);
    console.log(`  2.11 ${label}: Chrome 10s interpolated scatter ${numberText(converged.convergedSpreadMs)}ms vs half-vsync ${numberText(verdicts.predictedFloorMs)}ms; published ${stats.population} spread ${numberText(stats.spreadMedianMs)}ms; estimate range over the observation ${numberText(stats.estimateRangeMs)}ms; max per-poll estimate movement ${numberText(stats.maxPerPollMovementMs)}ms over ${stats.perPollPairsUsed} adjacent pairs, ${stats.perPollPairsSkippedForGap} skipped for poll gaps (comparable to the plant's ${PLANT_MEDIAN_MOVEMENT_MS}ms largest per-poll movement, not a median); verdict: ${verdicts.modelVerdict}; median applied rate ${numberText(stats.actingRateMedian, 6)} over acting fraction ${numberText(stats.actingFraction, 3)}; observed closure ${numberText(stats.observedClosureRateMsPerSec)}ms/s; commanded closure ${numberText(stats.commandedClosureRateMsPerSec)}ms/s; effectiveness fraction ${numberText(stats.effectivenessFraction, 3)}; rate-effectiveness verdict: ${verdicts.rateEffectivenessVerdict}.`);
    console.log(`  3.5 ${label}: final no-clock counters ${JSON.stringify({ noClock: figure.finalCounters?.noClock ?? null, framesOffered: figure.finalCounters?.framesOffered ?? null })}; first clock held ${figure.firstClock?.held ?? 'null'} counters ${JSON.stringify(figure.firstClock?.counters ?? null)}; first playing held ${figure.firstPlayback?.seam?.held ?? 'null'} counters ${JSON.stringify(figure.firstPlayback?.seam?.counters ?? null)}; verdict: direct controller record count is not observable, and this page construction cannot feed the no-clock arm because records require a clock and an established offset does not return to null.`);
  }
  for (const [label, readings] of [['A', linesA], ['B', linesB]]) {
    const distinct = (key) => [...new Set(readings.map((reading) => reading[key] ?? ''))];
    console.log(`  T6b ${label} rendered clock lines ${JSON.stringify(distinct('clockText'))} (asserted against CLOCK_LINE_RE); drift lines ${JSON.stringify(distinct('driftText'))} (asserted against DRIFT_LINE_RE with a positive frame count); controller lines ${JSON.stringify(distinct('controllerText'))} (asserted against CONTROLLER_LINE_ACTING_RE and CONTROLLER_LINE_HELD_RE, with an acting match required).`);
  }
  console.log(`  T8 seam route counters: V before ${JSON.stringify(before.V)}; V after ${JSON.stringify(after.V)}; A3 before ${JSON.stringify(before.A3)}; A3 after ${JSON.stringify(after.A3)}; diagnosis ${routeDiagnosis ?? 'seam fired'}.`);
  console.log(`  whole pass wall-clock length: ${numberText(Date.now() - PASS_STARTED_AT, 0)}ms (${numberText((Date.now() - PASS_STARTED_AT) / 1000, 1)}s), measured from script start.`);
  console.log('--- T9 FIGURES END ---');

} catch (err) {
  console.log('ERROR:', err.message);
  failures.push(err.message);
} finally {
  for (const recorder of [recorderA, recorderB]) {
    if (!recorder) continue;
    try {
      recorder.finish();
    } catch (error) {
      failures.push(error?.message ?? String(error));
    }
  }
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const finalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      finalManifest.timing.passEndedAt = new Date().toISOString();
      finalManifest.outcome = failures.length === 0 ? 'pass' : 'failed';
      fs.writeFileSync(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
    } catch (error) {
      failures.push(`manifest finalization failed: ${error?.message ?? error}`);
    }
  }
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`);
  await disposeChrome(chrome, profile);
  process.exit(failures.length === 0 ? 0 : 1);
}
