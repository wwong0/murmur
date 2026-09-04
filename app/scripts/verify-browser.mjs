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

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach as attachTo, cdpHttp as cdpHttpOn, sleep, disposeChrome } from './cdp.mjs';
import { DRIFT_LINE_RE } from '../public/lib/drift-readout.mjs';
import { MIN_RECORDS, RATE_EPSILON } from '../public/lib/drift-controller.mjs';
import { CLOCK_LINE_RE, CONTROLLER_LINE_HELD_RE, CONTROLLER_LINE_ACTING_RE } from '../public/lib/diagnostics-overlay.mjs';
import { plant } from './check/drift-plant.mjs';

const PASS_STARTED_AT = Date.now();
const PORT = 9223;
const ORIGIN = 'http://127.0.0.1:8100';

const cdpHttp = (pathname) => cdpHttpOn(PORT, pathname);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verify-'));
const BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'room.bundle.js');

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
// T6 converged span for tightened tolerances (tasks.md 2.4b).
const CONVERGED_WINDOW_MS = 10_000;
const MIN_CONVERGED_RECORDS = 120;
// T7 excursion observation (design.md D4).
const OBSERVE_MS = 60_000;
const OBSERVE_POLL_MS = 125;
const OBSERVE_PROGRESS_MS = 10_000;
const EXCURSION_POLL_MS = 250;
const PERIODICITY_LIKE = 0.8;
const PERIODICITY_NOT_LIKE = 0.6;
const FLOOR_MULTIPLIER = 1.5;
const PLANT_MEDIAN_MOVEMENT_MS = 1.32;
const PLANT_ASSERTED_FLOOR = 0.8;
const RATE_EFFECTIVE = 0.5;
const RATE_INEFFECTIVE = 0.1;
const STANDING_LAG_MATCH_MS = 20;
// T6b line read-back (design.md D1).
const LINE_READ_DEADLINE_MS = 3_000;
const LINE_READ_POLL_MS = 250;
// T8 seam route (design.md D3).
const DEPART_DEADLINE_MS = 30_000;
const REJOIN_DEADLINE_MS = 30_000;
const SEAM_SETTLE_MS = 3_000;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

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

const RAF_RATE = `(() => new Promise((resolve) => {
  const stamps = [];
  let finished = false;
  let guard = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (guard !== null) clearTimeout(guard);
    const deltas = [];
    for (let i = 1; i < stamps.length; i++) deltas.push(stamps[i] - stamps[i - 1]);
    deltas.sort((left, right) => left - right);
    const middle = deltas.length >> 1;
    const medianDeltaMs = deltas.length === 0 ? null : deltas.length % 2 === 1
      ? deltas[middle]
      : (deltas[middle - 1] + deltas[middle]) / 2;
    resolve({
      frameCount: stamps.length,
      medianDeltaMs,
      refreshRateHz: Number.isFinite(medianDeltaMs) && medianDeltaMs > 0 ? 1000 / medianDeltaMs : null,
    });
  };
  guard = setTimeout(finish, 4000);
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
    // never chosen (change 4a design.md D8), and change 4b's model check reads
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

async function sampleSeams(tab, durationMs) {
  const startedAt = Date.now();
  const readings = [];
  let absent = 0;
  while (Date.now() - startedAt < durationMs) {
    const seam = await tab.evaluate(SEAM);
    if (seam.present) readings.push({ atMs: Date.now(), seam });
    else absent++;
    const remaining = durationMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(SETTLE_POLL_MS, remaining));
  }
  return { readings, absent };
}

async function waitForSettle(tabs) {
  const startedAt = Date.now();
  const capAt = startedAt + SETTLE_DEADLINE_MS + WINDOW_GAP_MS + 60_000;
  const states = tabs.map(({ label, tab }) => ({
    label,
    tab,
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
  let nextProgressAt = startedAt + 4000;

  for (;;) {
    for (const state of states) {
      const seam = await state.tab.evaluate(SEAM);
      if (!seam.present) {
        state.absent++;
        continue;
      }
      const reading = { atMs: Date.now(), seam };
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

    const now = Date.now();
    if (now >= nextProgressAt) {
      for (const state of states) {
        const seam = state.last?.seam;
        const controller = seam?.controller ?? {};
        const elapsed = state.firstPlaybackAt === null ? 'n/a' : `${((now - state.firstPlaybackAt) / 1000).toFixed(1)}s`;
        console.log(`  ${state.label}: elapsed ${elapsed} · mode ${controller.mode ?? 'null'} · reason ${controller.reason ?? 'null'} · rate ${controller.rate ?? 'null'} · estimateMs ${controller.estimateMs ?? 'null'} · bandMs ${controller.bandMs ?? 'null'} · windowRecords ${controller.windowRecords ?? 'null'} · correctionsApplied ${controller.correctionsApplied ?? 'null'}`);
      }
      nextProgressAt = now + 4000;
    }

    const complete = (state) => state.firstSettledAt !== null || (state.firstPlaybackAt !== null && now >= state.firstPlaybackAt + SETTLE_DEADLINE_MS);
    if (states.every(complete) || now >= capAt) break;
    const remaining = capAt - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(SETTLE_POLL_MS, remaining));
  }
  return states;
}

async function observeWindows(tabs, durationMs) {
  const startedAt = Date.now();
  const endAt = startedAt + durationMs;
  const states = tabs.map(({ label, tab }) => ({ label, tab, samples: [], absent: 0, lastSeam: null }));
  let nextSampleAt = startedAt;
  let nextProgressAt = startedAt + OBSERVE_PROGRESS_MS;

  while (nextSampleAt < endAt) {
    const atMs = Date.now();
    await Promise.all(states.map(async (state) => {
      const seam = await state.tab.evaluate(SEAM);
      if (!seam.present) {
        state.absent++;
        return;
      }
      state.lastSeam = seam;
      const controller = seam.controller ?? {};
      state.samples.push({
        atMs,
        mode: controller.mode ?? null,
        reason: controller.reason ?? null,
        rate: controller.rate ?? null,
        estimateMs: controller.estimateMs ?? null,
        bandMs: controller.bandMs ?? null,
        spreadMs: controller.spreadMs ?? null,
        windowRecords: controller.windowRecords ?? null,
        controlRecords: controller.controlRecords ?? null,
      });
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

function median(sorted) {
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestRank(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function convergedStats(seam, barSeq) {
  const records = (seam.records ?? []).filter((record) => record.seq > barSeq);
  const drifts = records.map((record) => record.driftMs).sort((left, right) => left - right);
  const enough = records.length >= MIN_CONVERGED_RECORDS && records.every((record) => Number.isFinite(record.driftMs));
  return {
    records,
    convergedCount: records.length,
    convergedMedianMs: enough ? median(drifts) : null,
    convergedSpreadMs: enough ? nearestRank(drifts, 0.95) - nearestRank(drifts, 0.05) : null,
  };
}

function alternationStats(records) {
  let pairs = 0;
  let alternating = 0;
  for (let i = 1; i < records.length - 1; i++) {
    const previous = records[i].driftMs - records[i - 1].driftMs;
    const next = records[i + 1].driftMs - records[i].driftMs;
    if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === 0 || next === 0) continue;
    pairs++;
    if (Math.sign(previous) !== Math.sign(next)) alternating++;
  }
  return { pairs, fraction: pairs === 0 ? null : alternating / pairs };
}

function roundedHistogram(records) {
  const counts = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.driftMs)) continue;
    const rounded = Math.round(record.driftMs * 2) / 2;
    const key = rounded.toFixed(1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || Number(leftValue) - Number(rightValue))
    .slice(0, 10)
    .map(([value, count]) => `${value}ms:${count}`);
}

function finiteValues(samples, key) {
  return samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
}

function observationStats(state, convergedRecords) {
  const firstSettledIndex = state.samples.findIndex((sample) => sample.mode === 'settled');
  const afterSettled = firstSettledIndex < 0 ? [] : state.samples.slice(firstSettledIndex);
  const settled = afterSettled.filter((sample) => sample.mode === 'settled');
  const acting = state.samples.filter((sample) => sample.reason === null);
  const population = settled.length > 0 ? settled : acting;
  const populationLabel = settled.length > 0 ? 'settled' : 'acting';
  const spreadValues = finiteValues(population, 'spreadMs').sort((left, right) => left - right);
  const estimateValues = finiteValues(population, 'estimateMs');
  const spreadMedianMs = median(spreadValues);
  const spreadMaxMs = spreadValues.length ? Math.max(...spreadValues) : null;
  const medianMovementMs = estimateValues.length ? Math.max(...estimateValues) - Math.min(...estimateValues) : null;
  const actingRates = finiteValues(acting, 'rate').sort((left, right) => left - right);
  const actingRateMedian = median(actingRates);
  // A WHOLE-WINDOW TREND AGAINST A MEDIAN COMMAND — not a closure rate against
  // the command that produced it. The regression spans every acting sample, so it
  // covers a transient and a plateau together, and the command varies across both
  // because the controller is proportional. Report it, do not conclude from a low
  // one: see the verdict this feeds for which direction it can be read in.
  const closureSamples = acting.filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.estimateMs));
  let observedClosureRateMsPerSec = null;
  if (closureSamples.length >= 2) {
    const meanAtMs = closureSamples.reduce((sum, sample) => sum + sample.atMs, 0) / closureSamples.length;
    const meanEstimateMs = closureSamples.reduce((sum, sample) => sum + sample.estimateMs, 0) / closureSamples.length;
    const denominator = closureSamples.reduce((sum, sample) => sum + (sample.atMs - meanAtMs) ** 2, 0);
    if (denominator > 0) {
      const numerator = closureSamples.reduce((sum, sample) => sum + (sample.atMs - meanAtMs) * (sample.estimateMs - meanEstimateMs), 0);
      observedClosureRateMsPerSec = (numerator / denominator) * 1000;
    }
  }
  const commandedClosureRateMsPerSec = Number.isFinite(actingRateMedian)
    ? (actingRateMedian - 1) * 1000
    : null;
  const effectivenessFraction = Number.isFinite(observedClosureRateMsPerSec)
    && Number.isFinite(commandedClosureRateMsPerSec)
    && commandedClosureRateMsPerSec !== 0
    ? observedClosureRateMsPerSec / commandedClosureRateMsPerSec
    : null;
  const alternation = alternationStats(convergedRecords);
  const excursions = [];
  let current = null;
  const finishExcursion = () => {
    if (!current) return;
    const range = (key) => {
      const values = current.samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
    };
    excursions.push({
      samples: current.samples.length,
      lengthMs: current.samples.length * OBSERVE_POLL_MS,
      controllerPolls: (current.samples.length * OBSERVE_POLL_MS) / EXCURSION_POLL_MS,
      modes: [...current.modes],
      reasons: [...current.reasons],
      windowRecords: range('windowRecords'),
      controlRecords: range('controlRecords'),
    });
    current = null;
  };
  const excursionSamples = firstSettledIndex < 0 ? acting : afterSettled;
  for (const sample of excursionSamples) {
    if (sample.mode === 'settled') {
      finishExcursion();
      continue;
    }
    if (!current) current = { samples: [], modes: new Set(), reasons: new Set() };
    current.samples.push(sample);
    current.modes.add(sample.mode ?? null);
    current.reasons.add(sample.reason ?? null);
  }
  finishExcursion();
  const dutyCycle = afterSettled.length ? settled.length / afterSettled.length : 0;
  return {
    firstSettledIndex,
    settledSamples: afterSettled.length,
    settledCount: settled.length,
    dutyCycle,
    population: populationLabel,
    populationSamples: population.length,
    spreadMedianMs,
    spreadMaxMs,
    medianMovementMs,
    actingCount: acting.length,
    actingFraction: state.samples.length ? acting.length / state.samples.length : null,
    actingRateMedian,
    observedClosureRateMsPerSec,
    commandedClosureRateMsPerSec,
    effectivenessFraction,
    alternation,
    histogram: roundedHistogram(convergedRecords),
    excursions,
  };
}

function firstEightMedian(state) {
  const records = state.firstRecords?.records ?? [];
  const drifts = records.map((record) => record.driftMs);
  if (drifts.length < 8 || drifts.some((driftMs) => !Number.isFinite(driftMs))) return null;
  return median(drifts.sort((left, right) => left - right));
}

function numberText(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'null';
}

function plantSweepMinimum() {
  let minimum = null;
  for (const refreshHz of [60, 180]) {
    for (let standingError = -320; standingError <= -80; standingError += 20) {
      const simulation = plant({ refreshHz, standingError, pollEvery: 6 });
      for (let i = 0; i < 6 * 960; i++) simulation.deliver();
      const firstSettled = simulation.history.findIndex((state) => state.mode === 'settled');
      const afterSettled = firstSettled < 0 ? [] : simulation.history.slice(firstSettled);
      const dutyCycle = afterSettled.length
        ? afterSettled.filter((state) => state.mode === 'settled').length / afterSettled.length
        : 0;
      if (minimum === null || dutyCycle < minimum.dutyCycle) minimum = { dutyCycle, refreshHz, standingError };
    }
  }
  return minimum;
}

async function measureRefreshRates(tabs) {
  return Promise.all(tabs.map(async ({ label, tab }) => {
    const rate = await tab.evaluate(RAF_RATE);
    expect(`3.2 ${label}'s RAF probe returned a finite refresh rate`, rate !== null && typeof rate === 'object' && Number.isFinite(rate.frameCount) && rate.frameCount > 0 && Number.isFinite(rate.refreshRateHz) && rate.refreshRateHz > 0, JSON.stringify(rate));
    return { label, rate };
  }));
}

async function readLines(tab, initial) {
  const readings = [initial];
  const deadline = Date.now() + LINE_READ_DEADLINE_MS;
  const matches = (probe) => {
    const clock = CLOCK_LINE_RE.test((probe.clockText ?? '').trim());
    const drift = DRIFT_LINE_RE.exec((probe.driftText ?? '').trim());
    const controller = CONTROLLER_LINE_HELD_RE.test((probe.controllerText ?? '').trim()) || CONTROLLER_LINE_ACTING_RE.test((probe.controllerText ?? '').trim());
    return clock && drift !== null && Number(drift[1]) > 0 && controller;
  };
  while (!matches(readings[readings.length - 1]) && Date.now() < deadline) {
    await sleep(Math.min(LINE_READ_POLL_MS, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    readings.push(await tab.evaluate(PROBE));
  }
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

function printRouteReading(label, stage, reading) {
  console.log(`  ${stage} ${label}: ${JSON.stringify(routeFields(reading))}`);
}

try {
  await cdpHttp('/json/version');
  const windows = await cdpHttp('/json/list');
  console.log(`(chrome opened ${windows.filter((t) => t.type === 'page').length} page target(s))`);

  console.log('\n--- 7.1 / 7.2: two windows, one room ---');
  const a = await attach('A/host', URL_A, true);

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
  const gapA = await sampleSeams(a, WINDOW_GAP_MS);
  console.log(`  A sampled ${gapA.readings.length} seam readings during the gap (${gapA.absent} not present)`);
  const b = await attach('B/view', URL_B);

  console.log('\n--- T5: waiting for both windows to settle ---');
  const settleStates = await waitForSettle([{ label: 'A', tab: a }, { label: 'B', tab: b }]);
  for (const state of settleStates) {
    const seam = state.last?.seam;
    const controller = seam?.controller ?? {};
    const gapMs = state.firstPlaybackAt === null || state.firstSettledAt === null || state.firstSettlingMs === null
      ? NaN
      : state.firstSettledAt - state.firstPlaybackAt - state.firstSettlingMs;
    console.log(`  ${state.label}: ${state.absent} seam reading(s) not present; first playback ${state.firstPlayback ? `held ${state.firstPlayback.seam.held}` : 'not seen'}; first 8 records ${state.firstRecords ? 'kept' : 'not seen'}; first clock ${state.firstClock ? `held ${state.firstClock.held}` : 'not seen'}; last no-correction ${state.lastNoCorrection ? 'kept' : 'not seen'}; last no-settling ${state.lastNoSettling ? 'kept' : 'not seen'}`);
    console.log(`  ${state.label}: settlingMs ${controller.settlingMs ?? 'null'}; gap before first correction ${Number.isFinite(gapMs) ? `${gapMs.toFixed(1)}ms` : 'unavailable'} (each endpoint observed at ${SETTLE_POLL_MS}ms, about ±0.25s)`);
    // TWO OF THESE FIVE READ THE FINAL POLL AND THREE DO NOT, and the labels say
    // which. `settlingMs` and `correctionsApplied` are latched once and never
    // reset (drift-controller.mjs:309), so they answer "did this window
    // converge" whatever the controller is doing at the instant the wait ends.
    // `mode` and `rate` do not: a believed excursion drops the latch and moves
    // the rate off unity (:285-296), and design.md D4 measures a converged
    // client outside `settled` for up to 16% of a run. So a red on those two
    // beside three green ones is an excursion, not a failure to converge — read
    // them together or the run cannot tell the two apart.
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
  await sleep(CONVERGED_WINDOW_MS / 2);
  console.log(`  converged span in progress: ${CONVERGED_WINDOW_MS / 1000}s total, ${CONVERGED_WINDOW_MS / 2000}s elapsed`);
  await sleep(CONVERGED_WINDOW_MS / 2);
  const sa = await a.evaluate(SEAM);
  const pa = await a.evaluate(PROBE);
  const sb = await b.evaluate(SEAM);
  const pb = await b.evaluate(PROBE);
  const convergedA = convergedStats(sa, barSeqA);
  const convergedB = convergedStats(sb, barSeqB);
  for (const [label, seam, stats] of [['A', sa, convergedA], ['B', sb, convergedB]]) {
    const whole = seam.summary ?? {};
    console.log(`  ${label}: converged span ${CONVERGED_WINDOW_MS / 1000}s, ${stats.convergedCount} records, ${stats.convergedCount < MIN_CONVERGED_RECORDS ? 'not enough records; ' : ''}median ${stats.convergedMedianMs ?? 'null'}ms, p95-p5 ${stats.convergedSpreadMs ?? 'null'}ms; whole run (ring, up to 3600 records): median ${whole.medianDriftMs ?? 'null'}ms, framesHeld ${whole.framesHeld ?? 'null'}, p99DriftMs ${whole.p99DriftMs ?? 'null'}ms`);
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
  const linesA = await readLines(a, pa);
  const linesB = await readLines(b, pb);
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
  const observationStates = await observeWindows([{ label: 'A', tab: a }, { label: 'B', tab: b }], OBSERVE_MS);
  const refreshRates = await measureRefreshRates([{ label: 'A', tab: a }, { label: 'B', tab: b }]);
  const plantMinimum = plantSweepMinimum();
  const expectedObservationSamples = Math.ceil(OBSERVE_MS / OBSERVE_POLL_MS);
  const t7Figures = [];
  for (let i = 0; i < observationStates.length; i++) {
    const state = observationStates[i];
    const settleState = settleStates[i];
    const converged = i === 0 ? convergedA : convergedB;
    const stats = observationStats(state, converged.records);
    const referenceLagMs = i === 0 ? -308 : -104;
    const firstEightMs = firstEightMedian(settleState);
    const noCorrectionEstimateMs = settleState.lastNoCorrection?.seam?.controller?.estimateMs;
    const lagMatches = Number.isFinite(firstEightMs) && Math.abs(firstEightMs - referenceLagMs) <= STANDING_LAG_MATCH_MS;
    const inMeasuredBand = Number.isFinite(firstEightMs) && Math.abs(firstEightMs) >= 100 && Math.abs(firstEightMs) <= 240;
    const refresh = refreshRates[i].rate ?? {};
    const predictedFloorMs = Number.isFinite(refresh.refreshRateHz) && refresh.refreshRateHz > 0
      ? 1000 / (2 * refresh.refreshRateHz)
      : null;
    const floorHeld = Number.isFinite(stats.spreadMedianMs) && Number.isFinite(predictedFloorMs)
      ? stats.spreadMedianMs <= predictedFloorMs * FLOOR_MULTIPLIER
      : null;
    const parkingDistanceMs = Number.isFinite(stats.spreadMedianMs) ? stats.spreadMedianMs * 2 : null;
    const cadenceVerdict = stats.alternation.fraction === null
      ? 'not enough nonzero differences'
      : stats.alternation.fraction >= PERIODICITY_LIKE
        ? 'period-2-like'
        : stats.alternation.fraction <= PERIODICITY_NOT_LIKE
          ? 'not period-2-like'
          : 'inconclusive (between 0.6 and 0.8)';
    // THE MOVEMENT TERM IS WITHHELD, NOT FAILED. PLANT_MEDIAN_MOVEMENT_MS is the
    // largest movement of the median between two CONSECUTIVE 250ms polls (4a: p95
    // 1.30ms, max 1.32ms, from window parity); `medianMovementMs` is the RANGE of
    // the estimate across the whole observation. A per-poll step and a 60s range
    // are not the same quantity, so the comparison was false for any real run and
    // manufactured the disagreement it reported. Withheld rather than dropped: an
    // incomparable term cannot support `agree` either. The like-for-like version
    // is the movement between consecutive controller polls, which needs the 125ms
    // samples deduplicated by poll — filed under change 5 (design.md D2).
    const movementComparable = false;
    const modelVerdict = cadenceVerdict === 'period-2-like' && floorHeld === true && movementComparable
      ? stats.population === 'settled' ? 'agree' : 'agree on acting figures; no settled hold was observed'
      : `inconclusive: cadence ${cadenceVerdict}, floor ${floorHeld === true ? 'within prediction' : floorHeld === false ? 'above prediction' : 'unavailable'}, median-movement term withheld (a whole-window range is not the plant's per-poll step)${stats.population === 'settled' ? '' : '; no settled hold was observed'}`;
    const floorVerdict = floorHeld === null
      ? `${stats.population} population has no finite spread`
      : stats.population === 'settled'
        ? floorHeld ? `held at <=${FLOOR_MULTIPLIER}x predicted` : `not held above ${FLOOR_MULTIPLIER}x predicted`
        : floorHeld
          ? `within <=${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`
          : `above ${FLOOR_MULTIPLIER}x predicted while acting; not evidence of a held floor`;
    const excursionVerdict = stats.populationSamples === 0
      ? 'unavailable (no acting samples)'
      : stats.firstSettledIndex < 0
        ? stats.excursions.some((excursion) => excursion.lengthMs > EXCURSION_POLL_MS)
          ? 'yes, an acting excursion exceeded one controller poll; no settled hold was observed'
          : 'no, no acting excursion exceeded one controller poll; no settled hold was observed'
        : stats.excursions.some((excursion) => excursion.lengthMs > EXCURSION_POLL_MS)
          ? 'yes, an excursion exceeded one controller poll'
          : 'no, none exceeded one controller poll';
    const dutyVerdict = Number.isFinite(stats.dutyCycle)
      ? stats.firstSettledIndex < 0
        ? `${(stats.dutyCycle * 100).toFixed(1)}% settled (0 settled samples; acting population used for steady-state figures)`
        : `${(stats.dutyCycle * 100).toFixed(1)}% settled after first settled sample (${stats.settledCount}/${stats.settledSamples} samples)`
      : 'unavailable';
    const recommendation = stats.firstSettledIndex < 0
      ? 'no settled hold observed; keep the simulated 0.8 floor pending hardware hold evidence'
      : !Number.isFinite(stats.dutyCycle)
        ? 'no recommendation from this window'
      : stats.dutyCycle < PLANT_ASSERTED_FLOOR
        ? 'keep the simulated 0.8 floor; browser duty is below it'
        : stats.dutyCycle < plantMinimum.dutyCycle
          ? 'keep the simulated 0.8 floor; browser clears it but not the plant minimum'
          : 'browser clears the plant minimum; any floor change belongs to a follow-up';
    // ONE-SIDED, AND THE VERDICT SAYS SO. A high ratio does prove the actuator
    // moves the clock: an estimate trending at the commanded rate over the whole
    // window cannot happen without it. A LOW ONE PROVES NOTHING, because a
    // converged proportional loop reads low here whatever its actuator is doing —
    // on a plateau the trend is ~0 by definition while the command stays nonzero,
    // since a residual error is what produces it. The window also spans a
    // transient and a plateau and the median rate mixes the commands in force
    // across both. Separating a dead actuator from a held steady-state error
    // needs the slope over a stretch where the command is STEADY; that
    // measurement is filed under change 5 (design.md D2).
    const rateEffectivenessVerdict = !Number.isFinite(stats.effectivenessFraction)
      ? 'unavailable (insufficient acting samples or zero commanded closure rate)'
      : stats.effectivenessFraction >= RATE_EFFECTIVE
        ? `effective (>=${RATE_EFFECTIVE}; the whole-window trend tracks the command, so the rate does move the media clock)`
        : stats.effectivenessFraction < RATE_INEFFECTIVE
          ? `low (<${RATE_INEFFECTIVE}); this ratio cannot say whether the actuator is dead or the loop is holding a steady-state error — read the steady-command stretches, not this number`
          : `low (${RATE_INEFFECTIVE}-${RATE_EFFECTIVE}); same caveat as below ${RATE_INEFFECTIVE} — this ratio does not discriminate`;
    const finalCounters = state.lastSeam?.counters ?? null;
    const firstClock = settleState.firstClock;
    const firstPlayback = settleState.firstPlayback;

    // Every figure here is printed once, in T9's block; collecting them keeps the
    // run's numbers in one place a person can copy into design.md.
    t7Figures.push({
      label: state.label,
      firstEightMs,
      noCorrectionEstimateMs,
      referenceLagMs,
      lagMatches,
      inMeasuredBand,
      convergedCount: converged.convergedCount,
      convergedMedianMs: converged.convergedMedianMs,
      convergedSpreadMs: converged.convergedSpreadMs,
      wholeMedianMs: (i === 0 ? sa : sb).summary?.medianDriftMs ?? null,
      alternation: stats.alternation,
      histogram: stats.histogram,
      refresh,
      predictedFloorMs,
      floorHeld,
      parkingDistanceMs,
      spreadMedianMs: stats.spreadMedianMs,
      spreadMaxMs: stats.spreadMaxMs,
      medianMovementMs: stats.medianMovementMs,
      population: stats.population,
      populationSamples: stats.populationSamples,
      actingCount: stats.actingCount,
      actingFraction: stats.actingFraction,
      actingRateMedian: stats.actingRateMedian,
      observedClosureRateMsPerSec: stats.observedClosureRateMsPerSec,
      commandedClosureRateMsPerSec: stats.commandedClosureRateMsPerSec,
      effectivenessFraction: stats.effectivenessFraction,
      rateEffectivenessVerdict,
      floorVerdict,
      cadenceVerdict,
      firstSettledIndex: stats.firstSettledIndex,
      dutyCycle: stats.dutyCycle,
      dutyVerdict,
      excursions: stats.excursions,
      excursionVerdict,
      modelVerdict,
      movementComparable,
      recommendation,
      finalCounters,
      firstClock,
      firstPlayback,
      observedSamples: state.samples.length,
      expectedObservationSamples,
      absent: state.absent,
      plantMinimum,
    });
  }

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
  const routeBeforeV = await readRoute(v);
  const routeBeforeA3 = await readRoute(a3);
  printRouteReading('V', 'before', routeBeforeV);
  printRouteReading('A3', 'before', routeBeforeA3);

  const offlineConditions = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  const onlineConditions = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await v.send('Network.enable');
  await v.send('Network.emulateNetworkConditions', offlineConditions);

  const routeOfflineStartedAt = Date.now();
  let departureProbe = routeBeforeA3.probe;
  let departureObserved = false;
  while (!departureObserved && Date.now() - routeOfflineStartedAt < DEPART_DEADLINE_MS) {
    departureProbe = await a3.evaluate(PROBE);
    departureObserved = departureProbe.members.length === 1;
    if (!departureObserved) {
      const remaining = DEPART_DEADLINE_MS - (Date.now() - routeOfflineStartedAt);
      if (remaining > 0) await sleep(Math.min(1000, remaining));
    }
  }
  if (!departureObserved) {
    console.log(`  T8 departure deadline expired after ${DEPART_DEADLINE_MS / 1000}s; A3 roster ${JSON.stringify(departureProbe.members)}`);
  } else {
    console.log(`  T8 A3 observed V's departure after ${Date.now() - routeOfflineStartedAt}ms: ${JSON.stringify(departureProbe.members)}`);
  }

  const deltaValue = (after, before) => Number.isFinite(after) && Number.isFinite(before) ? after - before : NaN;
  const offlineSignatureFor = (before, after) => {
    const beforeClock = before.seam?.clock ?? {};
    const afterClock = after.seam?.clock ?? {};
    const beforePlayback = before.seam?.playback ?? {};
    const afterPlayback = after.seam?.playback ?? {};
    return {
      probesIssued: deltaValue(afterClock.probes?.issued, beforeClock.probes?.issued) >= 3,
      lost: deltaValue(afterClock.counters?.lost, beforeClock.counters?.lost) >= 3,
      sampleCountUnchanged: afterClock.sampleCount === beforeClock.sampleCount,
      halfWidthWidened: Number.isFinite(afterClock.halfWidthMs) && afterClock.halfWidthMs > beforeClock.halfWidthMs,
      callbacksAdvanced: deltaValue(afterPlayback.callbacks, beforePlayback.callbacks) > 0,
    };
  };

  let routeOfflineV = await readRoute(v);
  let offlineSignature = offlineSignatureFor(routeBeforeV, routeOfflineV);
  while (departureObserved && !Object.values(offlineSignature).every(Boolean) && Date.now() - routeOfflineStartedAt < DEPART_DEADLINE_MS) {
    const remaining = DEPART_DEADLINE_MS - (Date.now() - routeOfflineStartedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(1000, remaining));
    routeOfflineV = await readRoute(v);
    offlineSignature = offlineSignatureFor(routeBeforeV, routeOfflineV);
  }
  console.log(`  T8 V offline signature: ${JSON.stringify({ ...offlineSignature, readings: routeFields(routeOfflineV) })}`);
  // ONLY `lost` DISCRIMINATES, and the labels below say which clause claims what
  // (`CONSTRAINTS.md` → *A reading pinned at its cap*). The filter evicts by
  // count (clock-filter.mjs:167), so `sampleCount` sits pinned at DEFAULT_WINDOW
  // on every healthy page and *unchanged* is the only value it can take; the
  // half-width grows on its age term between any two reads, offline or not. Both
  // passed in 4c's runs while every probe was completing. They stay because they
  // say the controller kept its estimate across the hold — which is worth
  // knowing and is not evidence of a disconnection. Do not read them as one.
  expect('T8 V probes issued advanced by at least 3 while offline', offlineSignature.probesIssued, JSON.stringify(routeFields(routeOfflineV)));
  expect('T8 V lost exchanges advanced by at least 3 while offline', offlineSignature.lost, JSON.stringify(routeFields(routeOfflineV)));
  expect('T8 V kept its clock estimate: the filter window stayed full', offlineSignature.sampleCountUnchanged, JSON.stringify(routeFields(routeOfflineV)));
  expect('T8 V clock half-width grew between the two readings', offlineSignature.halfWidthWidened, JSON.stringify(routeFields(routeOfflineV)));
  expect('T8 V kept producing callbacks while offline', offlineSignature.callbacksAdvanced, JSON.stringify(routeFields(routeOfflineV)));
  expect('T8 A3 observed V departure before the deadline', departureObserved, JSON.stringify(departureProbe.members));

  await v.send('Network.emulateNetworkConditions', onlineConditions);
  const routeRejoinStartedAt = Date.now();
  const beforeFreshJoins = routeBeforeV.seam?.timeline?.freshJoins;
  let routeRejoined = false;
  let routeAfterV = routeOfflineV;
  while (!routeRejoined && Date.now() - routeRejoinStartedAt < REJOIN_DEADLINE_MS) {
    const seam = await v.evaluate(SEAM);
    const freshJoins = seam.timeline?.freshJoins;
    if (Number.isFinite(freshJoins) && Number.isFinite(beforeFreshJoins) && freshJoins > beforeFreshJoins) {
      routeAfterV = { seam, probe: await v.evaluate(PROBE) };
      routeRejoined = true;
      break;
    }
    const remaining = REJOIN_DEADLINE_MS - (Date.now() - routeRejoinStartedAt);
    if (remaining > 0) await sleep(Math.min(500, remaining));
  }
  if (!routeRejoined) {
    console.log(`  T8 rejoin deadline expired after ${REJOIN_DEADLINE_MS / 1000}s; V reading ${JSON.stringify(routeFields(routeAfterV))}`);
  } else {
    console.log(`  T8 V fresh-joined after ${Date.now() - routeRejoinStartedAt}ms`);
  }

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

  const routeAfter = {
    V: await readRoute(v),
    A3: await readRoute(a3),
  };
  printRouteReading('V', 'after', routeAfter.V);
  printRouteReading('A3', 'after', routeAfter.A3);

  const beforeVSeam = routeBeforeV.seam ?? {};
  const afterVSeam = routeAfter.V.seam ?? {};
  const beforeA3Seam = routeBeforeA3.seam ?? {};
  const afterA3Seam = routeAfter.A3.seam ?? {};
  const beforeVTimeline = beforeVSeam.timeline ?? {};
  const afterVTimeline = afterVSeam.timeline ?? {};
  const beforeA3Timeline = beforeA3Seam.timeline ?? {};
  const afterA3Timeline = afterA3Seam.timeline ?? {};
  const beforeVPlayback = beforeVSeam.playback ?? {};
  const afterVPlayback = afterVSeam.playback ?? {};
  const beforeA3Playback = beforeA3Seam.playback ?? {};
  const afterA3Playback = afterA3Seam.playback ?? {};
  const beforeVController = beforeVSeam.controller ?? {};
  const afterVController = afterVSeam.controller ?? {};
  const beforeA3Controller = beforeA3Seam.controller ?? {};
  const afterA3Controller = afterA3Seam.controller ?? {};
  const freshJoinDelta = deltaValue(afterVTimeline.freshJoins, beforeVTimeline.freshJoins);
  const epochRevisionDelta = deltaValue(afterVTimeline.epochRevisions, beforeVTimeline.epochRevisions);
  const reopenDelta = deltaValue(afterVPlayback.reopens, beforeVPlayback.reopens);
  const openDelta = deltaValue(afterVPlayback.opens, beforeVPlayback.opens);
  const seamDelta = deltaValue(afterVPlayback.seams?.length, beforeVPlayback.seams?.length);
  const seamDropDelta = deltaValue(afterVController.counters?.drops?.seam, beforeVController.counters?.drops?.seam);
  const newVSeam = Array.isArray(afterVPlayback.seams) && Number.isFinite(beforeVPlayback.seams?.length)
    ? afterVPlayback.seams[beforeVPlayback.seams.length]
    : null;

  expect('T8 V freshJoins advanced by exactly 1', freshJoinDelta === 1, `before=${beforeVTimeline.freshJoins} after=${afterVTimeline.freshJoins}`);
  expect('T8 V epochRevisions advanced by 0', epochRevisionDelta === 0, `before=${beforeVTimeline.epochRevisions} after=${afterVTimeline.epochRevisions}`);
  expect('T8 V timeline epoch moved later', Number.isFinite(afterVTimeline.epochMs) && afterVTimeline.epochMs > beforeVTimeline.epochMs, `before=${beforeVTimeline.epochMs} after=${afterVTimeline.epochMs}`);
  expect('T8 V reopens advanced by exactly 1', reopenDelta === 1, `before=${beforeVPlayback.reopens} after=${afterVPlayback.reopens}`);
  expect('T8 V opens advanced by 0', openDelta === 0, `before=${beforeVPlayback.opens} after=${afterVPlayback.opens}`);
  expect('T8 V seams advanced by exactly 1', seamDelta === 1, `before=${beforeVPlayback.seams?.length} after=${afterVPlayback.seams?.length}`);
  expect('T8 V new seam has a nonzero afterSeq', Number.isFinite(newVSeam?.afterSeq) && newVSeam.afterSeq > 0, JSON.stringify(newVSeam));
  expect('T8 V new seam uses the post-event timeline epoch', newVSeam?.epochMs === afterVTimeline.epochMs, JSON.stringify({ seamEpochMs: newVSeam?.epochMs, timelineEpochMs: afterVTimeline.epochMs }));
  expect('T8 V seam-drop counter advanced by exactly 1', seamDropDelta === 1, `before=${beforeVController.counters?.drops?.seam} after=${afterVController.counters?.drops?.seam}`);
  expect("T8 V controller's last drop was a seam", afterVController.lastDrop?.reason === 'seam', JSON.stringify(afterVController.lastDrop));
  expect('T8 V controller returned to the base rate within RATE_EPSILON', Math.abs((afterVController.rate ?? NaN) - 1) <= RATE_EPSILON, JSON.stringify(afterVController.rate));
  expect("T8 V controller did not re-settle during the 3s post-seam read", afterVController.mode !== 'settled', JSON.stringify({ mode: afterVController.mode, reason: afterVController.reason }));
  expect('T8 V controller rebuilt a nonempty window', afterVController.windowRecords > 0, JSON.stringify(afterVController.windowRecords));
  expect('T8 V newest record is after the new seam', Number.isFinite(afterVSeam.latest?.seq) && afterVSeam.latest.seq > newVSeam?.afterSeq, JSON.stringify({ latestSeq: afterVSeam.latest?.seq, afterSeq: newVSeam?.afterSeq }));
  expect('T8 A3 freshJoins stayed unchanged', deltaValue(afterA3Timeline.freshJoins, beforeA3Timeline.freshJoins) === 0, `before=${beforeA3Timeline.freshJoins} after=${afterA3Timeline.freshJoins}`);
  expect('T8 A3 epochRevisions stayed unchanged', deltaValue(afterA3Timeline.epochRevisions, beforeA3Timeline.epochRevisions) === 0, `before=${beforeA3Timeline.epochRevisions} after=${afterA3Timeline.epochRevisions}`);
  expect('T8 A3 reopens stayed unchanged', deltaValue(afterA3Playback.reopens, beforeA3Playback.reopens) === 0, `before=${beforeA3Playback.reopens} after=${afterA3Playback.reopens}`);
  expect('T8 A3 seam-drop counter stayed unchanged', deltaValue(afterA3Controller.counters?.drops?.seam, beforeA3Controller.counters?.drops?.seam) === 0, `before=${beforeA3Controller.counters?.drops?.seam} after=${afterA3Controller.counters?.drops?.seam}`);
  expect('T8 A3 timeline epoch stayed unchanged', afterA3Timeline.epochMs === beforeA3Timeline.epochMs, `before=${beforeA3Timeline.epochMs} after=${afterA3Timeline.epochMs}`);

  const networkSignaturePresent = offlineSignature.probesIssued && offlineSignature.lost && offlineSignature.sampleCountUnchanged && offlineSignature.halfWidthWidened;
  if (!offlineSignature.callbacksAdvanced) console.log('  T8 V media stall: playback.callbacks did not advance during the offline hold; this is a stall, not a seam failure.');
  const routeSignaturePresent = Object.values(offlineSignature).every(Boolean);
  let routeDiagnosis = null;
  if (!networkSignaturePresent) routeDiagnosis = 'V never went offline';
  else if (freshJoinDelta !== 1) routeDiagnosis = 'V went offline and was reclaimed';
  else if (reopenDelta !== 1) routeDiagnosis = 'V fresh-joined and did not re-open';
  const routeFired = departureObserved && routeSignaturePresent && freshJoinDelta === 1 && reopenDelta === 1 && openDelta === 0 && seamDelta === 1;
  if (routeDiagnosis !== null || !routeFired) {
    console.log(`  T8 route diagnosis: ${routeDiagnosis ?? 'V fresh-joined and re-opened, but another route assertion failed'}; offline signature ${JSON.stringify(offlineSignature)}; V before/after ${JSON.stringify({ before: routeFields(routeBeforeV), after: routeFields(routeAfter.V) })}`);
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
  for (const figure of t7Figures) {
    const refresh = figure.refresh ?? {};
    const plantMinimumText = figure.plantMinimum === null ? 'null' : `${(figure.plantMinimum.dutyCycle * 100).toFixed(1)}% at ${figure.plantMinimum.refreshHz}Hz/${figure.plantMinimum.standingError}ms`;
    console.log(`  3.1 ${figure.label}: first 8 drift median ${numberText(figure.firstEightMs)}ms; last estimate with correctionsApplied=0 ${numberText(figure.noCorrectionEstimateMs)}ms; 4a reference ${figure.referenceLagMs}ms; verdict: ${figure.lagMatches ? 'reproduces within one 20ms sweep step' : 'does not reproduce within one 20ms sweep step'}, ${figure.inMeasuredBand ? 'inside' : 'outside'} the 3b 100-240ms band.`);
    console.log(`  3.2 ${figure.label}: scatter ${numberText(figure.convergedSpreadMs)}ms over ${figure.convergedCount} records; alternation ${numberText(figure.alternation?.fraction, 3)} over ${figure.alternation?.pairs ?? 0} nonzero pairs; rounded drifts ${JSON.stringify(figure.histogram)}; panel refresh ${numberText(refresh.refreshRateHz)}Hz from ${refresh.frameCount ?? 'null'} frames with median delta ${numberText(refresh.medianDeltaMs)}ms; verdict: ${figure.cadenceVerdict}.`);
    console.log(`  3.3 ${figure.label}: published ${figure.population} spread median ${numberText(figure.spreadMedianMs)}ms, max ${numberText(figure.spreadMaxMs)}ms; predicted half-vsync floor ${numberText(figure.predictedFloorMs)}ms; estimate range over the observation ${numberText(figure.medianMovementMs)}ms; two-client parking ${numberText(figure.parkingDistanceMs)}ms against ${DRIFT_TOLERANCE_MS}ms; verdict: ${figure.floorVerdict}.`);
    console.log(`  3.4 ${figure.label}: first settled sample index ${figure.firstSettledIndex}; population ${figure.population}; duty ${figure.dutyVerdict}; excursions ${JSON.stringify(figure.excursions)}; verdict: ${figure.excursionVerdict}; plant sweep minimum ${plantMinimumText}; recommendation: ${figure.recommendation}; read over ${figure.observedSamples}/${figure.expectedObservationSamples} samples with ${figure.absent} absent.`);
    console.log(`  2.11 ${figure.label}: Chrome 10s scatter ${numberText(figure.convergedSpreadMs)}ms vs half-vsync ${numberText(figure.predictedFloorMs)}ms; published ${figure.population} spread ${numberText(figure.spreadMedianMs)}ms; estimate range over the observation ${numberText(figure.medianMovementMs)}ms (NOT comparable to the plant's ${PLANT_MEDIAN_MOVEMENT_MS}ms, which is a per-poll step); verdict: ${figure.modelVerdict}; median applied rate ${numberText(figure.actingRateMedian, 6)} over acting fraction ${numberText(figure.actingFraction, 3)}; observed closure ${numberText(figure.observedClosureRateMsPerSec)}ms/s; commanded closure ${numberText(figure.commandedClosureRateMsPerSec)}ms/s; effectiveness fraction ${numberText(figure.effectivenessFraction, 3)}; rate-effectiveness verdict: ${figure.rateEffectivenessVerdict}.`);
    console.log(`  3.5 ${figure.label}: final no-clock counters ${JSON.stringify({ noClock: figure.finalCounters?.noClock ?? null, framesOffered: figure.finalCounters?.framesOffered ?? null })}; first clock held ${figure.firstClock?.held ?? 'null'} counters ${JSON.stringify(figure.firstClock?.counters ?? null)}; first playing held ${figure.firstPlayback?.seam?.held ?? 'null'} counters ${JSON.stringify(figure.firstPlayback?.seam?.counters ?? null)}; verdict: direct controller record count is not observable, and this page construction cannot feed the no-clock arm because records require a clock and an established offset does not return to null.`);
  }
  for (const [label, readings] of [['A', linesA], ['B', linesB]]) {
    const distinct = (key) => [...new Set(readings.map((reading) => reading[key] ?? ''))];
    console.log(`  T6b ${label} rendered clock lines ${JSON.stringify(distinct('clockText'))} (asserted against CLOCK_LINE_RE); drift lines ${JSON.stringify(distinct('driftText'))} (asserted against DRIFT_LINE_RE with a positive frame count); controller lines ${JSON.stringify(distinct('controllerText'))} (asserted against CONTROLLER_LINE_ACTING_RE and CONTROLLER_LINE_HELD_RE, with an acting match required).`);
  }
  console.log(`  T8 seam route counters: V before ${JSON.stringify(routeFields(routeBeforeV))}; V after ${JSON.stringify(routeFields(routeAfter.V))}; A3 before ${JSON.stringify(routeFields(routeBeforeA3))}; A3 after ${JSON.stringify(routeFields(routeAfter.A3))}; diagnosis ${routeDiagnosis ?? 'seam fired'}.`);
  console.log(`  whole pass wall-clock length: ${numberText(Date.now() - PASS_STARTED_AT, 0)}ms (${numberText((Date.now() - PASS_STARTED_AT) / 1000, 1)}s), measured from script start.`);
  console.log('--- T9 FIGURES END ---');

} catch (err) {
  console.log('ERROR:', err.message);
  failures.push(err.message);
} finally {
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`);
  await disposeChrome(chrome, profile);
  process.exit(failures.length === 0 ? 0 : 1);
}
