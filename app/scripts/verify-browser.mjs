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
// T8 AND ITS OFFLINE ROUTE ARE GONE (change 5 design.md D11): the fresh-join
// re-open it forced no longer exists, and CDP's offline emulation never fired it.
// A window may finish T5 without a correction; the labels that then make no
// claim print NOT EXERCISED from the two approved lists below, never PASS.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach as attachTo, cdpHttp as cdpHttpOn, sleep, disposeChrome } from './cdp.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { INTEGRATION_SCHEMA, createRecorder, pitchReference } from './drift-capture.mjs';
import { auditClient, integrationSummary, readClientEvidence } from './product-integration-evidence.mjs';
import { DRIFT_LINE_RE, driftLineForm } from '../public/lib/drift-readout.mjs';
import { D8_COMMAND_THRESHOLD, MAX_RATE_DEVIATION, MIN_RECORDS, RATE_EPSILON } from '../public/lib/drift-controller.mjs';
import { CLOCK_LINE_RE, CONTROLLER_LINE_HELD_RE, CONTROLLER_LINE_ACTING_RE } from '../public/lib/diagnostics-overlay.mjs';
// The arithmetic and the verdicts, next door and pure — this file is the
// sequence of windows, waits and assertions, and nothing else.
import {
  MIN_CONVERGED_RECORDS,
  convergedStats,
  observationStats,
  plantSweepMinimum,
  steadyCommandStretches,
  predictedParkingDistanceMs,
  refreshFrom,
  standingLag,
  windowVerdicts,
} from './drift-figures.mjs';
// The retained-evidence round trip and the T9 block. Both are importable without
// Chrome, which is what this file is not; see each module's header.
import { BAR_DEFINITIONS, barsFromManifest, evaluateSufficiency, readNdjson, rederiveConvergedMedian } from './drift-browser-evidence.mjs';
import { t9FigureLines } from './drift-browser-report.mjs';
import { inSyncWithoutCorrection } from './settle-wait.mjs';
import { TRANSITION_LEAD_MS } from '../public/lib/playback-leads.mjs';
import { WAITING_PAUSED } from '../public/lib/playback-start.mjs';
import { seamEpochAgreement, startResidual } from './start-residual.mjs';
import { evaluatePeerExchange } from './figures/peer-exchange-bars.mjs';
import { PEER_PAGE_READING } from './peer-exchange-probe.mjs';
import { Core } from '../node_modules/p2p-media-loader-core/lib/core.js';

const PASS_STARTED_AT = Date.now();
const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';

const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const PASS_STARTED_AT_ISO = new Date(PASS_STARTED_AT).toISOString();
// Do not reuse a run directory: the first pair of captures was lost that way on 2026-09-05.
// `--run-dir=` is the integration supervisor's seam: a new directory under app/results only.
const RUN_DIR_ARGUMENT = process.argv.find((arg) => arg.startsWith('--run-dir='))?.slice('--run-dir='.length) ?? null;
const RUN_DIR = RUN_DIR_ARGUMENT === null
  ? path.join(RESULTS_DIR, PASS_STARTED_AT_ISO.replaceAll(':', '-'))
  : path.resolve(APP_DIR, RUN_DIR_ARGUMENT);
// Containment is `prepareRunDirectory`'s, below, and only its. A second copy
// here would trip on the same input, and two guards at one threshold cannot be
// told apart by a probe (CONSTRAINTS.md -> Verification).
const RUN_DIRECTORY_NAME = path.relative(RESULTS_DIR, RUN_DIR).split(path.sep).join('/');
const MEDIA_DIR = path.resolve(process.env.APP_MEDIA_DIR ?? path.join(APP_DIR, '..', 'step0', 'content'));
const WINDOW_STATE = 'visible, non-occluded (Chrome automation flags)';
const MAX_RETAINED_BYTES = 10 * 1024 * 1024;
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
// The in-sync settle path and the start residual (change 5 design.md D11).
const SETTLED_FOR_MS = 5_000;
const SETTLE_BARS = Object.freeze({ minRecords: MIN_RECORDS, settledForMs: SETTLED_FOR_MS, rateEpsilon: RATE_EPSILON });
const RESIDUAL_POPULATION = 24;
const RESIDUAL_DEADLINE_MS = 30_000;
/**
 * T5 label stems a window done by the in-sync path makes no claim on (D11,
 * owner-approved). Printed NOT EXERCISED with their values, never PASS.
 */
const SETTLE_WITHOUT_CORRECTION_ASSERTIONS = Object.freeze([
  'recorded a correction',
  'applied a rate write',
  `settled within ${SETTLING_BUDGET_MS}ms`,
]);
/** Owner decision O1 option 1 (tasks.md Current status): the same cause, two more labels. */
const O1_WITHOUT_CORRECTION_ASSERTIONS = Object.freeze([
  'retains a qualifying saturated stretch',
  'followed the adopted refusal and dwell policy',
]);

prepareRunDirectory({
  appDir: APP_DIR,
  resultsDir: RESULTS_DIR,
  runDir: RUN_DIR,
  refuseIgnored: true,
  createParents: true,
});
console.log(`run output directory: ${RUN_DIR}`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verify-'));

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
const URL_P = `${ORIGIN}/room.html?room=demo&role=viewer&tab=P`;
// The treatment's event history, on the two measured windows only; the later
// route windows keep the normal page.
const URL_A_MEASURED = `${URL_A}&treatmentEvidence=1`;
const URL_B_MEASURED = `${URL_B}&treatmentEvidence=1`;

// The first window IS page A — no about:blank bootstrap window.
const chrome = spawn(
  CHROME,
  [...FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', URL_A_MEASURED],
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
    pitch: app.pitch ? app.pitch() : null,
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

/** The page surface change 5 pass 2 adds: controls, invite, URL, and the state they act on. */
const PAGE = `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  const button = (id) => { const el = document.getElementById(id); return el ? { disabled: el.disabled === true, text: el.textContent } : null; };
  const invite = document.getElementById('invite');
  const link = invite && (invite.tagName === 'A' ? invite : invite.querySelector('a'));
  return {
    present: true,
    search: location.search,
    playback: app.playback(),
    timeline: app.timeline(),
    muted: document.querySelector('video').muted,
    buttons: Object.fromEntries(['play', 'pause', 'back-10', 'forward-10', 'control-mode', 'mute'].map((id) => [id, button(id)])),
    invite: link ? link.href : null,
    members: [...document.querySelectorAll('#roster li')].map((li) => li.textContent.trim()),
  };
})()`;

/** PAGE, reading a navigating page as absent rather than throwing. */
async function pageOf(tab) {
  try {
    return await tab.evaluate(PAGE);
  } catch {
    return { present: false };
  }
}

/**
 * A trusted click through Chrome's input pipeline at the element's centre —
 * never `element.click()`, which no user can do to a disabled button (D11).
 * `enableFirst` clears `disabled` in the same evaluation, just before the click,
 * so the page's next enablement pass has no time to restore it.
 */
async function clickElement(tab, selector, { enableFirst = false } = {}) {
  const box = await tab.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const disabledBefore = el.disabled === true;
    if (${enableFirst}) el.disabled = false;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabledBefore };
  })()`);
  if (!box) throw new Error(`${tab.label}: ${selector} is not on the page`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  return box;
}

const sameIdentity = (pages) => pages.every((page) => page.timeline?.identity && JSON.stringify(page.timeline.identity) === JSON.stringify(pages[0].timeline.identity));
const lastSeamPosition = (page) => page.playback?.seams?.at(-1)?.positionMs;

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
  const startedAt = latestStart(seam)?.positionMs;
  return Number.isFinite(startedAt) ? probe.time * 1000 - startedAt : NaN;
}

/** The page's start status and its records after the latest start, in one evaluation. */
const START_RECORDS = `(() => {
  const app = window.__app;
  if (!app) return null;
  const playback = app.playback();
  const start = playback.starts[playback.starts.length - 1];
  return { playback, records: start ? app.drift(start.afterSeq).records : [] };
})()`;

/**
 * Waits for a start beyond the first `startsBefore` entries with a full residual
 * population after it, and says which ended the wait.
 */
async function awaitStartRecords(tab, label, startsBefore) {
  const ready = await pollUntil(
    async () => {
      const read = await tab.evaluate(START_RECORDS);
      const start = (read?.playback?.starts?.length ?? 0) > startsBefore ? latestStart(read) : null;
      const accepted = start ? read.records.filter((record) => record.seq > start.afterSeq && Number.isFinite(record.driftMs)).length : 0;
      return { read, accepted };
    },
    ({ accepted }) => accepted >= RESIDUAL_POPULATION,
    { everyMs: 500, deadlineAt: Date.now() + RESIDUAL_DEADLINE_MS },
  );
  console.log(`  ${label} ${ready.ok ? 'reached' : 'did not reach'} ${RESIDUAL_POPULATION} accepted records after a new start (${ready.value.accepted})`);
  // No new start: an absent residual, never the older start's figure under this label.
  const read = ready.value.read;
  return (read?.playback?.starts?.length ?? 0) > startsBefore ? read : { playback: null, records: [] };
}

/** A residual for a window whose recorder is not running: its records are retained here first. */
function evaluateRetainedResidual({ label, fileStem, ready, frameIntervalMs }) {
  const recordsPath = path.join(RUN_DIR, `${fileStem}.records.ndjson`);
  const records = Array.isArray(ready.records) ? ready.records : [];
  fs.writeFileSync(recordsPath, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  return evaluateResidual({ label, fileStem, seam: ready, records, retainedRecords: () => readNdjson(recordsPath), frameIntervalMs });
}

/** Steady-command stretches at the saturated rate in a window's retained captures, as T10 fits them. */
function saturatedStretchesHeld(label, bars) {
  const samples = readNdjson(path.join(RUN_DIR, `${label}.captures.ndjson`)).map((capture) => ({ atMs: capture.atMs, ...capture.controller }));
  return steadyCommandStretches(samples, bars)
    .filter((stretch) => Math.abs(stretch.medianRate - (1 + MAX_RATE_DEVIATION)) <= bars.RATE_STEADY_TOLERANCE).length;
}

/** The newest scheduled start the page recorded, or null. */
function latestStart(seam) {
  const starts = seam?.playback?.starts;
  return Array.isArray(starts) && starts.length > 0 ? starts.at(-1) : null;
}

/** The first seam marked after `start`, whose records a residual must not take. */
function nextSeamAfterSeq(seam, start) {
  const later = (seam?.playback?.seams ?? []).map((entry) => entry?.afterSeq).filter((afterSeq) => Number.isSafeInteger(afterSeq) && afterSeq > start?.afterSeq);
  return later.length > 0 ? Math.min(...later) : Infinity;
}

const failures = [];
// A THIRD OUTCOME. An assertion whose precondition never occurred has not
// passed and has not failed — it made no claim. Kept out of `failures` so the
// command's status stays honest, and out of PASS so nothing unearned is banked.
// Each entry carries what its absence leaves unverified.
const notExercised = [];
function expect(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
}
function expectWhen(label, exercised, cond, detail, qualifier) {
  if (exercised) return expect(label, cond, detail);
  const approved = [...SETTLE_WITHOUT_CORRECTION_ASSERTIONS, ...O1_WITHOUT_CORRECTION_ASSERTIONS];
  if (!approved.some((stem) => label.endsWith(` ${stem}`))) throw new Error(`assertion is not approved for NOT EXERCISED: ${label}`);
  console.log(`NOT EXERCISED  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${qualifier}`);
  notExercised.push({ label, qualifier });
}

/**
 * The RES labels for one window's latest start: the residual from the page's
 * records, retained to `<label>.starts.json`, then re-derived from the retained
 * NDJSON (D11). `retainedRecords` is read only after the first figure exists.
 */
function evaluateResidual({ label, fileStem = label, seam, records, retainedRecords, frameIntervalMs }) {
  const start = latestStart(seam);
  const nextAfterSeq = nextSeamAfterSeq(seam, start);
  const inputs = { start, nextAfterSeq, frameIntervalMs, population: RESIDUAL_POPULATION };
  const residual = startResidual({ records, ...inputs });
  fs.writeFileSync(path.join(RUN_DIR, `${fileStem}.starts.json`), `${JSON.stringify({ start, nextAfterSeq: Number.isFinite(nextAfterSeq) ? nextAfterSeq : null, residual, frameIntervalMs: Number.isFinite(frameIntervalMs) ? frameIntervalMs : null }, null, 2)}\n`);
  const intervalText = Number.isFinite(frameIntervalMs) ? frameIntervalMs.toFixed(3) : 'null';
  expect(
    `RES ${label} scheduled-start residual within one frame interval (${intervalText}ms)`,
    residual.status === 'met',
    `status ${residual.status} · S ${start?.startAtSharedMs ?? 'null'} · playAtSharedMs ${start?.playAtSharedMs ?? 'null'} · latenessMs ${start?.latenessMs ?? 'null'} · advanceMs ${start?.advanceMs ?? 'null'} · scheduledPositionMs ${start?.scheduledPositionMs ?? 'null'} · positionMs ${start?.positionMs ?? 'null'} · medianMs ${residual.medianMs ?? 'null'} · count ${residual.count} · seq ${residual.firstSeq ?? 'null'}..${residual.lastSeq ?? 'null'} after ${start?.afterSeq ?? 'null'} · next seam ${nextAfterSeq} · starts ${seam?.playback?.starts?.length ?? 'null'} · retargets ${seam?.playback?.retargets ?? 'null'}`,
  );
  const rederived = startResidual({ records: retainedRecords(), ...inputs });
  expect(`RES ${label} re-derives from retained records`, JSON.stringify(rederived) === JSON.stringify(residual), `retained ${JSON.stringify(rederived)}; printed ${JSON.stringify(residual)}`);
  // §15 item 4. The seam must carry the ROOM's mapping epoch. With a nonzero
  // advance `S - scheduledPositionMs` and `S - positionMs` differ by the
  // advance, so a seam derived from the physical park is caught here — and
  // nowhere else, because the controller drops its window by `afterSeq`.
  const epoch = seamEpochAgreement({ start, records: retainedRecords() });
  expect(
    `EPOCH ${label} seam epoch equals the room mapping epoch`,
    epoch.status === 'agrees',
    `status ${epoch.status} · seam epochMs ${epoch.epochMs ?? 'null'} · S - scheduledPositionMs ${epoch.fromRoomMs ?? 'null'} · first record epochMs ${epoch.recordEpochMs ?? 'null'} · delta ${epoch.deltaMs ?? 'null'} · advanceMs ${start?.advanceMs ?? 'null'}`,
  );
  return residual;
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
    reads: [],
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
          state.reads.push({ atMs, schema: INTEGRATION_SCHEMA, controller: seam.controller ?? null, pitch: pitchReference(seam.pitch), playback: seam.playback ?? null });
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
        console.log(`  ${state.label}: elapsed ${elapsed} · mode ${controller.mode ?? 'null'} · reason ${controller.reason ?? 'null'} · rate ${controller.rate ?? 'null'} · estimateMs ${controller.estimateMs ?? 'null'} · U/bandMs ${controller.bandMs ?? 'null'} · L/allowanceMs ${controller.actuatorAllowanceMs ?? 'null'} · requiredS ${controller.requiredStoppingThresholdMs ?? 'null'} · acceptedS ${controller.stoppingThresholdMs ?? 'null'} · usable ${controller.thresholdUsable ?? 'null'} · windowRecords ${controller.windowRecords ?? 'null'} · correctionsApplied ${controller.correctionsApplied ?? 'null'}`);
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
  // The in-sync path is re-evaluated over every read each turn, not latched: a
  // run broken after it first qualified keeps the wait going (D11).
  const settledOrOutOfTime = (state) => state.firstSettledAt !== null
    || inSyncWithoutCorrection(state.reads, SETTLE_BARS).done
    || (state.firstPlaybackAt !== null && Date.now() >= state.firstPlaybackAt + SETTLE_DEADLINE_MS);
  await pollUntil(readAll, (all) => all.every(settledOrOutOfTime), { everyMs: CAPTURE_POLL_MS, deadlineAt: capAt });
  for (const state of states) {
    state.inSync = inSyncWithoutCorrection(state.reads, SETTLE_BARS);
    state.path = state.firstSettledAt !== null ? 'settled' : state.inSync.done ? 'in-sync' : 'neither';
  }
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
        halfWidthMs: controller.halfWidthMs ?? null,
        measurementLimit: controller.measurementLimit ?? null,
        actuatorAllowanceMs: controller.actuatorAllowanceMs ?? null,
        requiredStoppingThresholdMs: controller.requiredStoppingThresholdMs ?? null,
        stoppingThresholdMs: controller.stoppingThresholdMs ?? null,
        thresholdUsable: controller.thresholdUsable ?? false,
        windowRecords: controller.windowRecords ?? null,
        controlRecords: controller.controlRecords ?? null,
        pitch: pitchReference(seam.pitch),
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
  const a = await attach('A/host', URL_A_MEASURED, true);
  recorderA = createRecorder({ label: 'A', tab: a, dir: RUN_DIR, treatment: true });

  console.log('\n--- 3.1: which build is this run talking to? ---');
  // A 200 on /room.html proves something is answering, not what it is
  // (`CONSTRAINTS.md` → *Reachable is not fresh*). This detects a page running a
  // DIFFERENT build, not a page misreporting its own — do not read it as more
  // than that (3b design.md D3).
  const seamEarly = await seamOf(a);
  expect('3.1 the page publishes the harness seam', seamEarly.present === true, JSON.stringify(seamEarly).slice(0, 120));
  const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: seamEarly.buildId });
  console.log(`  build id: ${seamEarly.buildId} · served ${bundle.servedSha} · on disk ${bundle.diskSha}`);
  expect('3.1 the origin serves this tree’s bundle', bundle.matches, `served ${bundle.servedSha}, on disk ${bundle.diskSha}`);
  expect(
    '3.1 the page is running the bundle the origin is serving',
    bundle.pageIdInServed,
    `page reports ${seamEarly.buildId}`
  );

  // THE IMPOSED GAP (3.4) — the input to the experiment, not dead time. Read
  // WINDOW_GAP_MS before shortening or removing it.
  console.log(`\n--- 3.4: opening the second window ${WINDOW_GAP_MS / 1000}s late, on purpose ---`);
  await pumpingWait([recorderA], WINDOW_GAP_MS, CAPTURE_POLL_MS);
  const b = await attach('B/view', URL_B_MEASURED);
  recorderB = createRecorder({ label: 'B', tab: b, dir: RUN_DIR, treatment: true });

  console.log('\n--- T5: waiting for both windows to settle ---');
  const recorders = [recorderA, recorderB];
  const settleStates = await waitForSettle([{ label: 'A', tab: a, recorder: recorderA }, { label: 'B', tab: b, recorder: recorderB }]);
  // EVERY T5 seam read, not the first and last: the treatment audit reads each one.
  for (const state of settleStates) {
    fs.writeFileSync(path.join(RUN_DIR, `${state.label}.settle.ndjson`), state.reads.map((read) => `${JSON.stringify(read)}\n`).join(''));
  }
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
    console.log(`  ${state.label}: done by path ${state.path}; in-sync ${JSON.stringify(state.inSync)}`);
    const corrected = state.path !== 'in-sync';
    const inSyncQualifier = `${state.label} finished T5 inside the threshold with no correction (D11 in-sync path), so this label makes no claim`;
    if (corrected) {
      expect(`T5 ${state.label} is settled at the end of the wait`, controller.mode === 'settled', `${controller.mode ?? 'null'} · ${controller.reason ?? 'null'}`);
    } else {
      const inside = controller.thresholdUsable === true && Math.abs(controller.estimateMs ?? NaN) <= controller.stoppingThresholdMs;
      expect(`T5 ${state.label} is inside the threshold at the end of the wait`, inside, `estimateMs ${controller.estimateMs ?? 'null'} · acceptedS ${controller.stoppingThresholdMs ?? 'null'} · usable ${controller.thresholdUsable ?? 'null'}`);
    }
    expectWhen(`T5 ${state.label} recorded a correction`, corrected, controller.settlingMs !== null, JSON.stringify(controller.settlingMs), inSyncQualifier);
    expectWhen(`T5 ${state.label} applied a rate write`, corrected, controller.correctionsApplied > 0, JSON.stringify(controller.correctionsApplied), inSyncQualifier);
    expectWhen(`T5 ${state.label} settled within ${SETTLING_BUDGET_MS}ms`, corrected, Number.isFinite(controller.settlingMs) && controller.settlingMs <= SETTLING_BUDGET_MS, JSON.stringify(controller.settlingMs), inSyncQualifier);
    expect(`T5 ${state.label} holds the base rate at the end of the wait`, Math.abs((controller.rate ?? NaN) - 1) <= RATE_EPSILON, JSON.stringify(controller.rate));
  }
  console.log(`  windows needing a correction: ${settleStates.filter((state) => state.path !== 'in-sync').length} of ${settleStates.length}`);

  console.log('\n--- RES: where each scheduled start landed ---');
  const frameIntervalMs = Number.isFinite(contentFps) ? 1000 / contentFps : NaN;
  await pumpAll(recorders);
  for (const [label, tab, recorder] of [['A', a, recorderA], ['B', b, recorderB]]) {
    const seam = await tab.evaluate(SEAM);
    await pumpAll(recorders);
    evaluateResidual({ label, seam, records: seam.records, retainedRecords: () => readNdjson(recorder.recordsPath), frameIntervalMs });
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
    expect(`3.7 ${label} opened the media exactly once`, seam.playback?.opens === 1, `opens=${seam.playback?.opens} · retargets=${seam.playback?.retargets} · lastLatenessMs=${seam.playback?.lastLatenessMs}`);
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
      if (match === null || Number(match[1]) <= 0) console.log(`  ${label} drift line non-match (${driftLineForm(text)}): ${JSON.stringify(reading.driftText)}`);
      console.log(`  ${label} controller line beside seam state: ${JSON.stringify({ line: reading.controllerText, mode: seam.controller?.mode, reason: seam.controller?.reason, rate: seam.controller?.rate, estimateMs: seam.controller?.estimateMs, bandMs: seam.controller?.bandMs, spreadMs: seam.controller?.spreadMs, halfWidthMs: seam.controller?.halfWidthMs, measurementLimit: seam.controller?.measurementLimit, actuatorAllowanceMs: seam.controller?.actuatorAllowanceMs, requiredStoppingThresholdMs: seam.controller?.requiredStoppingThresholdMs, stoppingThresholdMs: seam.controller?.stoppingThresholdMs, thresholdUsable: seam.controller?.thresholdUsable, fastestCloseMs: seam.controller?.fastestCloseMs, windowRecords: seam.controller?.windowRecords })}`);
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

  console.log('\n--- 5.1: a late-joining viewer and peer exchange (7b D7) ---');
  // B has played far longer than D7's 20 s head start, so P is the late joiner.
  // P closes before T7, which observes A and B only.
  const peerSettings = await (await fetch(`${ORIGIN}/app-settings`, { cache: 'no-store' })).json();
  const p = await attach('P/view', URL_P);
  const pStart = (await pollUntil(() => p.evaluate(PEER_PAGE_READING), (reading) => reading?.playback?.playing === true, { everyMs: 500, deadlineAt: Date.now() + 60_000 })).value;
  await sleep(2000);
  const pAdvanced = await p.evaluate(PEER_PAGE_READING);
  expect('5.1 the late joiner plays and advances 2 s', (pAdvanced.currentTime - pStart.currentTime) >= 2, `${pStart.currentTime} → ${pAdvanced.currentTime}`);
  const peerDeadline = Date.now() + 90_000;
  let peerReading = null;
  do {
    peerReading = { rooms: [{ roomId: 'demo', host: await a.evaluate(PEER_PAGE_READING), viewers: [await b.evaluate(PEER_PAGE_READING), await p.evaluate(PEER_PAGE_READING)] }] };
    if (peerReading.rooms[0].viewers.some((page) => page.peerBytes?.kept?.peerBytes > 0)) break;
    await sleep(Math.min(1000, Math.max(1, peerDeadline - Date.now())));
  } while (Date.now() < peerDeadline);
  fs.writeFileSync(path.join(RUN_DIR, 'peer-exchange-readings.json'), `${JSON.stringify(peerReading, null, 2)}\n`);
  const peerBars = evaluatePeerExchange({
    ...peerReading,
    defaults: {
      defaultStreamConfig: Core.DEFAULT_STREAM_CONFIG,
      defaultCommonConfig: Core.DEFAULT_COMMON_CORE_CONFIG,
      trackerUrl: peerSettings.trackerUrl,
      iceServers: peerSettings.iceServers,
    },
  });
  for (const key of ['B1', 'B3', 'B4', 'B5', 'B8']) {
    const bar = peerBars.byKey[key];
    expect(`5.1 ${key} peer-exchange bar passes`, bar?.pass === true, JSON.stringify(bar));
  }
  await cdpHttp(`/json/close/${p.targetId}`);
  const rosterBack = (await pollUntil(() => a.evaluate(PROBE), (probe) => probe.members.length === 2, { everyMs: 500, deadlineAt: Date.now() + 15_000 })).value;
  expect('5.1 closing the late joiner returns the room to two members', rosterBack.members.length === 2, JSON.stringify(rosterBack.members));

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
      observations: state.samples,
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
    schemaVersion: 2,
    integrationSchema: INTEGRATION_SCHEMA,
    runDirectory: RUN_DIRECTORY_NAME,
    gitHead,
    build: {
      pageBuildId: seamEarly.buildId ?? null,
      servedBundleSha256: bundle.servedSha256,
      onDiskBundleSha256: bundle.diskSha256,
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
        treatment: `${figure.label}.treatment.ndjson`,
        settle: `${figure.label}.settle.ndjson`,
      },
      counts: index === 0 ? countsA : countsB,
      settlePath: settleStates[index].path,
      inSync: settleStates[index].inSync,
      observedSamples: figure.observedSamples,
      absentSamples: figure.absent,
      observations: figure.observations,
      thresholdSummary: {
        population: figure.stats.thresholdPopulation,
        samples: figure.stats.thresholdPopulationSamples,
        schemas: figure.stats.thresholdSchemas,
        usableCount: figure.stats.thresholdUsableCount,
        usableFraction: figure.stats.thresholdUsableFraction,
        stoppingThresholdMedianMs: figure.stats.stoppingThresholdMedianMs,
        stoppingThresholdMaxMs: figure.stats.stoppingThresholdMaxMs,
        actuatorAllowanceMedianMs: figure.stats.actuatorAllowanceMedianMs,
        actuatorAllowanceMaxMs: figure.stats.actuatorAllowanceMaxMs,
      },
    })),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const sufficiency = evaluateSufficiency(manifestPath, RUN_DIR);
  manifest.sufficiency = sufficiency;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const window of sufficiency.windows) {
    console.log(`  ${window.label}: missed ${window.missed}; ${window.records} retained records and ${window.captures} captures; ${window.qualifyingSaturated} qualifying saturated stretch(es), ${window.qualifyingPlateau} qualifying plateau stretch(es); record minimum ${window.recordMinimumMet ? 'met' : 'not met'}, span minimum ${window.spanMinimumMet ? 'met' : 'not met'}`);
  }
  const sufficiencyBars = barsFromManifest(manifest);
  expect('T10 both windows were evaluated for sufficiency', sufficiency.windows.length === 2, JSON.stringify(sufficiency.windows.map((window) => window.label)));
  for (const window of sufficiency.windows) {
    const settle = settleStates.find((state) => state.label === window.label);
    expect(`T10 ${window.label} retained the record minimum with no missed polls`, window.missed === 0 && window.recordMinimumMet, `missed ${window.missed} · ${window.records} records`);
    expect(`T10 ${window.label} retains a qualifying plateau stretch`, window.qualifyingPlateau > 0, `${window.qualifyingPlateau} plateau · ${window.stretches} stretches`);
    // O1 as widened by the owner after pass 1: a window whose retained captures
    // never HELD the saturated rate (no steady stretch at it, qualifying or not)
    // has no saturated fit to make, whether it corrected gently or not at all.
    const heldSaturated = saturatedStretchesHeld(window.label, sufficiencyBars);
    expectWhen(
      `T10 ${window.label} retains a qualifying saturated stretch`,
      !(window.qualifyingSaturated === 0 && heldSaturated === 0),
      window.qualifyingSaturated > 0,
      `${window.qualifyingSaturated} qualifying · ${heldSaturated} steady stretch(es) at rate ${1 + MAX_RATE_DEVIATION} · path ${settle?.path ?? 'null'} · correctionsApplied ${settle?.last?.seam?.controller?.correctionsApplied ?? 'null'}`,
      `${window.label}'s retained captures never held the saturated rate, so no saturated stretch exists to fit (O1, widened by the owner after pass 1)`,
    );
  }

  const rederivedA = rederiveConvergedMedian(path.join(RUN_DIR, 'A.records.ndjson'), barSeqA, sa.latest?.seq);
  const rederivedB = rederiveConvergedMedian(path.join(RUN_DIR, 'B.records.ndjson'), barSeqB, sb.latest?.seq);
  expect('T10 A converged median re-derives from retained NDJSON', rederivedA.medianMs === convergedA.convergedMedianMs && rederivedA.count === convergedA.convergedCount, `retained ${rederivedA.medianMs}ms/${rederivedA.count}; printed ${convergedA.convergedMedianMs}ms/${convergedA.convergedCount}`);
  expect('T10 B converged median re-derives from retained NDJSON', rederivedB.medianMs === convergedB.convergedMedianMs && rederivedB.count === convergedB.convergedCount, `retained ${rederivedB.medianMs}ms/${rederivedB.count}; printed ${convergedB.convergedMedianMs}ms/${convergedB.convergedCount}`);

  console.log('\n--- INT: the adopted treatment and refusal/dwell policy, from the retained streams ---');
  // From each client's first retained poll through this flush: the settle wait,
  // T6 and T7 whole, before any deliberate disruption.
  const integrationClients = [['A', countsA], ['B', countsB]].map(([label, counts]) => auditClient({
    label,
    ...readClientEvidence(RUN_DIR, label),
    stream: counts.treatment,
    expectedF: D8_COMMAND_THRESHOLD,
  }));
  manifest.integration = { schema: INTEGRATION_SCHEMA, expectedF: D8_COMMAND_THRESHOLD, clients: integrationClients, summary: integrationSummary(integrationClients) };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const client of integrationClients) {
    const { treatment, refusalDwell } = client;
    console.log(`  ${client.label}: treatment ${treatment.status} over ${treatment.observed.samples} samples (startup ${treatment.observed.outcome}); refusal/dwell ${refusalDwell.status} over polls ${refusalDwell.firstPollId}..${refusalDwell.lastPollId}; settled entries ${JSON.stringify(refusalDwell.settledEntries.map((entry) => entry.elapsedMs))}`);
    expect(`INT ${client.label} held the adopted pitch treatment on every retained sample`, treatment.status === 'met', JSON.stringify(treatment.failures));
    const settle = settleStates.find((state) => state.label === client.label);
    const onlyNeverSettled = refusalDwell.failures.length === 1 && refusalDwell.failures[0] === 'never-settled';
    expectWhen(
      `INT ${client.label} followed the adopted refusal and dwell policy`,
      !(onlyNeverSettled && settle?.path === 'in-sync'),
      refusalDwell.status === 'met',
      JSON.stringify(refusalDwell.failures),
      `${client.label} finished T5 in sync, and never-settled is its only failure (O1 option 1)`,
    );
  }

  const parkingThresholdsUsable = t7Figures.length === 2 && t7Figures.every((figure) =>
    figure.stats.thresholdUsableFraction === 1
    && Number.isFinite(figure.stats.stoppingThresholdMedianMs));
  const predictedParkingMs = parkingThresholdsUsable
    ? predictedParkingDistanceMs(
      t7Figures[0].stats.stoppingThresholdMedianMs,
      t7Figures[1].stats.stoppingThresholdMedianMs,
    )
    : null;

  const pa2 = await a.evaluate(PROBE);
  const pb2 = await b.evaluate(PROBE);
  const advA2 = advancedMs(await seamOf(a), pa2);
  const advB2 = advancedMs(await seamOf(b), pb2);
  expect('7.2 playback continues past the first few segments', advA2 > 12000 && advB2 > 12000, `A +${(advA2 / 1000).toFixed(1)}s past its start, B +${(advB2 / 1000).toFixed(1)}s`);
  expect('7.2 neither window stalled', pa2.time > pa.time + 5 && pb2.time > pb.time + 5, `A +${(pa2.time - pa.time).toFixed(1)}s, B +${(pb2.time - pb.time).toFixed(1)}s`);

  console.log('\n--- 9.1: replicated pause and resume, by page click ---');
  const replicaPages = () => Promise.all([pageOf(a), pageOf(b)]);
  const pauseClickedAt = Date.now();
  await clickElement(a, '#pause');
  const paused = await pollUntil(
    replicaPages,
    (pages) => pages.every((page) => page.playback?.waiting === WAITING_PAUSED && Number.isFinite(lastSeamPosition(page))) && sameIdentity(pages) && lastSeamPosition(pages[0]) === lastSeamPosition(pages[1]),
    { everyMs: 100, deadlineAt: pauseClickedAt + TRANSITION_LEAD_MS + 2000 },
  );
  const pausedPages = paused.value;
  const pausedDetail = JSON.stringify(pausedPages.map((page) => ({ waiting: page.playback?.waiting, identity: page.timeline?.identity, parkedAt: lastSeamPosition(page) })));
  console.log(`  pause ${paused.ok ? 'replicated' : 'did not replicate'} after ${Date.now() - pauseClickedAt}ms: ${pausedDetail}`);
  expect(`9.1 A's pause click leaves both windows ${WAITING_PAUSED} within ${TRANSITION_LEAD_MS + 2000}ms`, pausedPages.every((page) => page.playback?.waiting === WAITING_PAUSED), pausedDetail);
  expect('9.1 both paused windows hold the same state identity', sameIdentity(pausedPages), pausedDetail);
  expect('9.1 both paused windows parked at the same position', Number.isFinite(lastSeamPosition(pausedPages[0])) && lastSeamPosition(pausedPages[0]) === lastSeamPosition(pausedPages[1]), pausedDetail);

  const startsBeforeResume = pausedPages.map((page) => page.playback?.starts?.length ?? 0);
  // `room-paused` is published while the pause is still pending, and a pending
  // transition disables every issuing button (C1-11): click only once B's play is live.
  const playEnabled = await pollUntil(() => pageOf(b), (page) => page.buttons?.play?.disabled === false, { everyMs: 100, deadlineAt: Date.now() + TRANSITION_LEAD_MS + 2000 });
  expect("9.1 B's play is enabled once the pause has taken effect", playEnabled.ok, JSON.stringify(playEnabled.value.buttons?.play));
  const resumeClickedAt = Date.now();
  await clickElement(b, '#play');
  const resumed = await pollUntil(
    replicaPages,
    (pages) => pages.every((page) => page.playback?.playing === true) && sameIdentity(pages),
    { everyMs: 100, deadlineAt: resumeClickedAt + TRANSITION_LEAD_MS + 5000 },
  );
  const resumedDetail = JSON.stringify(resumed.value.map((page) => ({ playing: page.playback?.playing, waiting: page.playback?.waiting, identity: page.timeline?.identity })));
  console.log(`  resume ${resumed.ok ? 'replicated' : 'did not replicate'} after ${Date.now() - resumeClickedAt}ms`);
  expect("9.1 B's play click has both windows playing again", resumed.value.every((page) => page.playback?.playing === true), resumedDetail);
  expect('9.1 both resumed windows hold the same, newer state identity', sameIdentity(resumed.value) && resumed.value[0].timeline.identity.version > pausedPages[0].timeline?.identity?.version, resumedDetail);
  for (const [index, label, tab] of [[0, 'A', a], [1, 'B', b]]) {
    const ready = await awaitStartRecords(tab, `${label} resume`, startsBeforeResume[index]);
    evaluateRetainedResidual({ label: `${label} resume`, fileStem: `${label}-resume`, ready, frameIntervalMs });
  }

  console.log('\n--- 7.1: closing one updates the other ---');
  // The roster WITH `joinedAt`, which the page renders without: read off A's own
  // socket frames from here, after every measured span, for the late-join
  // precondition at 7.3b (D11). Every membership change after this reaches A.
  let rosterSeenByA = null;
  a.on('Network.webSocketFrameReceived', ({ response }) => {
    let env;
    try { env = JSON.parse(response?.payloadData ?? ''); } catch { return; }
    if ((env?.type === 'joined' || env?.type === 'presence') && Array.isArray(env.payload?.roster)) rosterSeenByA = env.payload.roster;
  });
  await a.send('Network.enable');
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
  const rosterAtClose = rosterSeenByA;
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

  console.log('\n--- LJ / RES: the late joiner after the earliest member left (D11) ---');
  // The precondition first, from the roster A last received before it closed:
  // without it, A3 adopting V's state says nothing about the survivor route.
  const rosterShaped = Array.isArray(rosterAtClose) && rosterAtClose.length >= 2
    && rosterAtClose.every((member) => typeof member?.tabId === 'string' && Number.isFinite(member.joinedAt))
    && rosterAtClose.filter((member) => member.tabId === 'A').length === 1;
  const earliestAtClose = rosterShaped ? rosterAtClose.reduce((first, member) => (member.joinedAt < first.joinedAt ? member : first)) : null;
  expect('LJ A was the earliest joiner of the members present when it closed', rosterShaped && earliestAtClose.tabId === 'A' && rosterAtClose.filter((member) => member.joinedAt === earliestAtClose.joinedAt).length === 1, JSON.stringify(rosterAtClose));
  const a3Ready = await awaitStartRecords(a3, 'A3', 0);
  const [a3Now, vNow] = await Promise.all([a3.evaluate(SEAM), v.evaluate(SEAM)]);
  const a3Identity = a3Now.timeline?.identity ?? null;
  const vIdentity = vNow.timeline?.identity ?? null;
  expect("LJ A3 holds the survivor's state identity", a3Identity !== null && typeof a3Identity === 'object' && JSON.stringify(a3Identity) === JSON.stringify(vIdentity), `A3 ${JSON.stringify(a3Identity)} · V ${JSON.stringify(vIdentity)}`);
  const a3EpochMs = a3Now.latest?.epochMs;
  const vEpochMs = vNow.latest?.epochMs;
  expect("LJ A3's records carry the survivor's epoch", Number.isFinite(a3EpochMs) && Number.isFinite(vEpochMs) && a3EpochMs === vEpochMs, `A3 ${a3EpochMs} · V ${vEpochMs}`);
  evaluateRetainedResidual({ label: 'A3', fileStem: 'A3', ready: a3Ready, frameIntervalMs });

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

  console.log('\n--- 9.1: the host toggle, by page click ---');
  const controlPages = () => Promise.all([pageOf(a3), pageOf(v)]);
  const [hostStart] = await controlPages();
  expect('9.1 the room is not yet in host control', hostStart.present && hostStart.timeline?.controlMode !== 'host', JSON.stringify(hostStart.timeline?.controlMode));
  await clickElement(a3, '#control-mode');
  const hostMode = await pollUntil(
    controlPages,
    (pages) => pages.every((page) => page.timeline?.controlMode === 'host') && pages[1].buttons?.pause?.disabled === true,
    { everyMs: 100, deadlineAt: Date.now() + TRANSITION_LEAD_MS + 3000 },
  );
  const [hostHeld, viewerHeld] = hostMode.value;
  expect("9.1 the host's toggle disables the viewer's pause", viewerHeld.timeline?.controlMode === 'host' && viewerHeld.buttons?.pause?.disabled === true, JSON.stringify({ mode: viewerHeld.timeline?.controlMode, pause: viewerHeld.buttons?.pause }));
  const rejectedOf = (page) => page.timeline?.rejected?.notPermitted;
  const heldVersions = [hostHeld, viewerHeld].map((page) => page.timeline?.identity?.version);

  const disabledClick = await clickElement(v, '#pause');
  await sleep(TRANSITION_LEAD_MS + 1000);
  const afterDisabled = await controlPages();
  expect('9.1 a click on the disabled pause issues nothing', disabledClick.disabledBefore && afterDisabled.every((page, i) => rejectedOf(page) === rejectedOf([hostHeld, viewerHeld][i]) && page.timeline?.identity?.version === heldVersions[i]), JSON.stringify({ disabledBefore: disabledClick.disabledBefore, notPermitted: afterDisabled.map(rejectedOf), versions: afterDisabled.map((page) => page.timeline?.identity?.version) }));

  const forcedClick = await clickElement(v, '#pause', { enableFirst: true });
  const rejected = await pollUntil(
    controlPages,
    (pages) => pages.every((page, i) => rejectedOf(page) === rejectedOf(afterDisabled[i]) + 1),
    { everyMs: 100, deadlineAt: Date.now() + TRANSITION_LEAD_MS + 3000 },
  );
  const rejectedDetail = JSON.stringify({ disabledBefore: forcedClick.disabledBefore, notPermitted: { before: afterDisabled.map(rejectedOf), after: rejected.value.map(rejectedOf) }, versions: rejected.value.map((page) => page.timeline?.identity?.version) });
  expect('9.1 a viewer pause forced past the disabled button is rejected notPermitted by host and viewer', rejected.value.every((page, i) => rejectedOf(page) === rejectedOf(afterDisabled[i]) + 1), rejectedDetail);
  expect('9.1 the rejected pause left the state version unchanged', rejected.value.every((page, i) => page.timeline?.identity?.version === heldVersions[i]), rejectedDetail);

  await clickElement(a3, '#control-mode');
  const sharedAgain = await pollUntil(
    controlPages,
    (pages) => pages.every((page) => page.timeline?.controlMode !== 'host') && pages[1].buttons?.pause?.disabled === false,
    { everyMs: 100, deadlineAt: Date.now() + TRANSITION_LEAD_MS + 3000 },
  );
  expect("9.1 toggling back re-enables the viewer's pause", sharedAgain.ok, JSON.stringify({ mode: sharedAgain.value[1].timeline?.controlMode, pause: sharedAgain.value[1].buttons?.pause }));

  console.log('\n--- 9.1: the mute toggle, by page click ---');
  const [muteHostBefore, muteViewerBefore] = await controlPages();
  await clickElement(a3, '#mute');
  await sleep(500);
  const [muteHostAfter, muteViewerAfter] = await controlPages();
  const muteDetail = JSON.stringify({ A3: [muteHostBefore.muted, muteHostAfter.muted], V: [muteViewerBefore.muted, muteViewerAfter.muted], versions: [muteHostBefore, muteHostAfter, muteViewerBefore, muteViewerAfter].map((page) => page.timeline?.identity?.version) });
  expect("9.1 A3's mute flips its own element and not V's", typeof muteHostBefore.muted === 'boolean' && muteHostAfter.muted === !muteHostBefore.muted && muteViewerAfter.muted === muteViewerBefore.muted, muteDetail);
  expect('9.1 mute changes no state version', muteHostAfter.timeline?.identity?.version === muteHostBefore.timeline?.identity?.version && muteViewerAfter.timeline?.identity?.version === muteViewerBefore.timeline?.identity?.version, muteDetail);

  console.log('\n--- 9.1: a page with no room creates one, and invites ---');
  const n = await attach('N/creator', `${ORIGIN}/room.html`);
  const created = await pollUntil(() => pageOf(n), (page) => page.present && /[?&]room=/.test(page.search) && page.members.length > 0, { everyMs: 250, deadlineAt: Date.now() + 15_000 });
  const createdQuery = new URLSearchParams(created.value.search ?? '');
  const createdRoom = createdQuery.get('room');
  const createdTab = createdQuery.get('tab');
  expect('9.1 the no-room page rewrote its URL with a new room, role=host and a tab', /^[0-9a-f]{32}$/.test(createdRoom ?? '') && createdQuery.get('role') === 'host' && Boolean(createdTab), created.value.search);
  let inviteUrl = null;
  try { inviteUrl = new URL(created.value.invite); } catch { /* asserted below */ }
  expect('9.1 the invite link carries the room and nothing else', inviteUrl !== null && inviteUrl.pathname === '/room.html' && [...inviteUrl.searchParams.keys()].join(',') === 'room' && inviteUrl.searchParams.get('room') === createdRoom, created.value.invite);
  expect('9.1 the creator holds the host role under its tab', created.value.members.some((member) => member.startsWith(`${createdTab} · host`)), JSON.stringify(created.value.members));

  await n.send('Page.reload', { ignoreCache: false });
  await sleep(1000);
  await n.send('Runtime.enable');
  // D4's reload race may refuse the new page first; it retries in (7.3c).
  const reloaded = await pollUntil(() => pageOf(n), (page) => page.present && page.members.some((member) => member.startsWith(`${createdTab} · host`)), { everyMs: 500, deadlineAt: Date.now() + 25_000 });
  const reloadedQuery = new URLSearchParams(reloaded.value.search ?? '');
  expect('9.1 the reloaded creator keeps its room and tab', reloadedQuery.get('room') === createdRoom && reloadedQuery.get('tab') === createdTab && reloadedQuery.get('role') === 'host', reloaded.value.search);
  expect('9.1 the reloaded creator rejoins as host', reloaded.ok, JSON.stringify(reloaded.value.members));

  const invited = inviteUrl ? await attach('I/invite', inviteUrl.href) : null;
  const joinedByInvite = await pollUntil(
    () => pageOf(n),
    (page) => page.members.length === 2 && page.members.some((member) => /^\S+ · viewer · /.test(member) && !member.startsWith(`${createdTab} · `)),
    { everyMs: 250, deadlineAt: Date.now() + 15_000 },
  );
  expect("9.1 the invite joins the creator's room as a viewer under a different tab", invited !== null && joinedByInvite.ok, JSON.stringify(joinedByInvite.value.members));
  if (invited) await cdpHttp(`/json/close/${invited.targetId}`);
  await cdpHttp(`/json/close/${n.targetId}`);

  console.log('\n--- T9: figures ---');
  for (const line of t9FigureLines({
    settleStates,
    settlePollMs: SETTLE_POLL_MS,
    convergedWindowMs: CONVERGED_WINDOW_MS,
    converged: [convergedA, convergedB],
    spread,
    wholeRunMedians: [sa.summary?.medianDriftMs, sb.summary?.medianDriftMs],
    figures: t7Figures,
    predictedParkingMs,
    parkingThresholdsUsable,
    expectedObservationSamples,
    renderedLines: [['A', linesA], ['B', linesB]],
    elapsedMs: Date.now() - PASS_STARTED_AT,
  })) console.log(line);

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
      finalManifest.failures = failures.slice();
      finalManifest.notExercised = notExercised.slice();
      fs.writeFileSync(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
    } catch (error) {
      failures.push(`manifest finalization failed: ${error?.message ?? error}`);
    }
  }
  const unexercisedText = notExercised.length === 0
    ? ''
    : `\n${notExercised.length} NOT EXERCISED: ${notExercised.map((entry) => `${entry.label} — ${entry.qualifier}`).join('; ')}`;
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}${unexercisedText}`);
  await disposeChrome(chrome, profile);
  process.exit(failures.length === 0 ? 0 : 1);
}
