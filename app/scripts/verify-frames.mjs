// scripts/verify-frames.mjs
//
// Does requestVideoFrameCallback actually fire in the window states change 6's
// harness will use? A dev aid, like verify-browser.mjs — needs Chrome, a running
// server and about ninety seconds, and is NOT part of `npm run check`.
//
// Usage: npm start (in another shell), then `node scripts/verify-frames.mjs`.
//
// The pass bar is decided BEFORE this file is run, never computed from what it
// sees (change 3b design.md D4): recomputing it would make whatever happened
// pass, and a state firing at a fraction of the frame rate — or firing and
// refusing every frame — passes a bare callback count.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS, attach, cdpHttp, sleep } from './cdp.mjs';
import { selectBrowserPlatform } from './runner/browser-platform.mjs';
import { requireAutoStart } from './delivery-pin.mjs';
import { mediaDirFrom } from '../server/media-dir.mjs';

// The platform adapter rather than cdp.mjs's Windows re-exports (D9): change 6a
// runs this same file inside the client container, where the Windows path does
// not exist and `taskkill` is not a command.
const BROWSER = selectBrowserPlatform();
const CHROME = BROWSER.locate();

// The browsers in the container are not on the host's loopback. On the host this
// default is the origin `npm start` serves; in the container it is the media
// network's alias, and giving a browser the wrong one measures the wrong link.
const ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:8100';

// Chrome refuses to start as root in a container without these, and there is no
// GPU there to use. Carried per platform so the host run's flag set is unchanged
// — a measurement taken under a different flag set is a different measurement.
const PLATFORM_FLAGS = BROWSER.name === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
// THE SAME RESOLUTION room-server.mjs USES, env var included. The bar below is
// read from this directory and applied to whatever the server is serving, so the
// two must name the same content: give this run the APP_MEDIA_DIR the server was
// given. Resolved from the script, never from the cwd — a bar read out of a
// different tree is exactly the silently-wrong bar D4 re-reads the frame rate to
// avoid.
const MEDIA_DIR = mediaDirFrom();

// Fixed before the first run (design.md D4) — not touched by what a run sees.
const MEASURE_MS = 20000;
const MIN_CALLBACK_RATIO = 0.9;
const MIN_ACCEPT_RATIO = 0.95;

// The init segment ALONE reports a meaningless `12288/1` — it carries no video
// samples. Concatenating it with one media segment is what makes ffprobe see
// real frames, and this is re-read every run rather than hard-coded because
// change 6 replaces this content with real remuxed media (D4).
function readContentFrameRate() {
  const tmp = path.join(os.tmpdir(), `verify-frames-probe-${Date.now()}.mp4`);
  const init = fs.readFileSync(path.join(MEDIA_DIR, 'init.mp4'));
  const seg = fs.readFileSync(path.join(MEDIA_DIR, 'seg-00000.m4s'));
  fs.writeFileSync(tmp, Buffer.concat([init, seg]));
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=nw=1:nk=1',
      tmp,
    ]);
    const text = out.toString().trim();
    const m = /^(\d+)\/(\d+)$/.exec(text);
    if (!m) throw new Error(`unparseable r_frame_rate: ${JSON.stringify(text)}`);
    const [, num, den] = m;
    const fps = Number(num) / Number(den);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`non-finite fps from ${text}`);
    return fps;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Values read through the harness seam (D2), never `video.currentTime` — this
// project's measurement path is rVFC or nothing (CONSTRAINTS.md → *Playback
// measurement*).
const SEAM = `(() => {
  const app = window.__app;
  if (!app) return { present: false };
  const drift = app.drift(0);
  return {
    present: true,
    playback: app.playback(),
    counters: drift.counters,
    latestSeq: drift.latestSeq,
    held: drift.records.length,
    // The media position of the newest record. Its advance across the window is
    // what separates "the compositor dropped frames" from "the video stalled" —
    // both report a low callback rate and they are different faults.
    latestMediaMs: drift.records.length ? drift.records[drift.records.length - 1].mediaMs : null,
  };
})()`;

/**
 * Poll until playback is open and at least one drift record exists.
 *
 * THE TIMEOUT MESSAGE MUST SAY WHICH OF THE TWO FAILED. A page that never got a
 * clock and a page that played with rVFC silent are the two answers this whole
 * script exists to tell apart, and "never reached the measured state" is the one
 * sentence that hides the difference.
 */
async function waitForPlaying(tab, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await tab.evaluate(SEAM);
    if (last.present && last.playback.playing && last.held > 0) return last;
    await sleep(250);
  }
  if (!last || !last.present) throw new Error(`the page never published the seam within ${timeoutMs}ms`);
  if (!last.playback.playing) throw new Error(`the page never started playback within ${timeoutMs}ms — waiting for ${last.playback.missing}`);
  throw new Error(
    `the page played but produced no drift record within ${timeoutMs}ms — ` +
    `rVFC delivered ${last.playback.callbacks} callbacks, counters ${JSON.stringify(last.counters)}`
  );
}

const failures = [];
/** Each state's `/json/version` Browser string, keyed by state. */
const chromeVersions = {};
function expect(label, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
  return cond;
}

/**
 * One Chrome instance, one state. Returns the per-state figures for the
 * summary block; throws (recorded as a failure) rather than guessing on any
 * step that could otherwise silently report the wrong state's numbers under
 * this name — the minimized check in particular.
 */
async function runState({ name, room, port, extraFlags, minimizeAfterAttach }, fps) {
  console.log(`\n--- ${name} ---`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `verify-frames-${name}-`));
  const url = `${ORIGIN}/room.html?room=${room}&role=host&tab=T`;
  const chrome = BROWSER.launch(
    [...FLAGS, ...PLATFORM_FLAGS, ...extraFlags, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=700,500', '--window-position=0,0', url],
    { stdio: 'ignore' }
  );
  try {
    chromeVersions[name] = (await cdpHttp(port, '/json/version')).Browser ?? null;
    console.log(`  chrome: ${chromeVersions[name]} · ${CHROME}`);
    const tab = await attach(port, url);

    if (minimizeAfterAttach) {
      const { windowId } = await tab.send('Browser.getWindowForTarget', { targetId: tab.targetId });
      await tab.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      // A probe that silently failed to minimize would report the visible
      // state's numbers under the minimized state's name — the worst outcome
      // this script can produce — so the minimize is verified, not assumed.
      const after = await tab.send('Browser.getWindowForTarget', { targetId: tab.targetId });
      if (after.bounds.windowState !== 'minimized') {
        throw new Error(`window did not report minimized after setWindowBounds (got ${after.bounds.windowState})`);
      }
    }

    await waitForPlaying(tab, 30000);
    const before = await tab.evaluate(SEAM);
    const t0 = Date.now();
    await sleep(MEASURE_MS);
    const after = await tab.evaluate(SEAM);
    const elapsedMs = Date.now() - t0;
    const elapsedSec = elapsedMs / 1000;

    const dCallbacks = after.playback.callbacks - before.playback.callbacks;
    const dOffered = after.counters.framesOffered - before.counters.framesOffered;
    // Accepted records via the seq delta, not `held` — `held` is the ring's
    // current length and undercounts once eviction starts (DEFAULT_CAPACITY).
    const accepted = after.latestSeq - before.latestSeq;
    const refusalDeltas = {};
    for (const reason of Object.keys(after.counters)) {
      if (reason === 'framesOffered') continue;
      refusalDeltas[reason] = after.counters[reason] - before.counters[reason];
    }

    const mediaAdvancedMs =
      after.latestMediaMs !== null && before.latestMediaMs !== null ? after.latestMediaMs - before.latestMediaMs : null;
    const callbacksPerSec = dCallbacks / elapsedSec;
    const requiredCallbacksPerSec = MIN_CALLBACK_RATIO * fps;
    const acceptRatio = dCallbacks > 0 ? accepted / dCallbacks : 0;

    console.log(`  callbacks in window: ${dCallbacks}, elapsed: ${elapsedSec.toFixed(2)}s, callbacks/sec: ${callbacksPerSec.toFixed(2)}`);
    console.log(`  content frame rate: ${fps.toFixed(3)} fps, required minimum: ${requiredCallbacksPerSec.toFixed(2)}/sec`);
    console.log(`  accepted records: ${accepted}, accept ratio: ${(acceptRatio * 100).toFixed(1)}%`);
    console.log(`  framesOffered delta: ${dOffered}`);
    console.log(`  media advanced: ${mediaAdvancedMs === null ? 'unknown' : `${(mediaAdvancedMs / 1000).toFixed(2)}s`} over ${elapsedSec.toFixed(2)}s wall${mediaAdvancedMs === null ? '' : ` (${(mediaAdvancedMs / elapsedMs).toFixed(3)}x realtime)`}`);
    for (const [reason, delta] of Object.entries(refusalDeltas)) {
      console.log(`  refusal ${reason}: +${delta}`);
    }

    const passRate = expect(`${name}: callback rate >= ${MIN_CALLBACK_RATIO * 100}% of content fps`, callbacksPerSec >= requiredCallbacksPerSec, `${callbacksPerSec.toFixed(2)}/s vs ${requiredCallbacksPerSec.toFixed(2)}/s`);
    const passAccept = expect(`${name}: accept ratio >= ${MIN_ACCEPT_RATIO * 100}%`, acceptRatio >= MIN_ACCEPT_RATIO, `${(acceptRatio * 100).toFixed(1)}%`);
    const passRefusals = expect(`${name}: no refusal counters rose`, Object.values(refusalDeltas).every((d) => d === 0), JSON.stringify(refusalDeltas));

    return { name, dCallbacks, elapsedSec, callbacksPerSec, requiredCallbacksPerSec, accepted, acceptRatio, refusalDeltas, mediaAdvancedMs, elapsedMs, pass: passRate && passAccept && passRefusals };
  } finally {
    // The adapter's report, kept: a disposal that failed to remove the profile
    // is how a container run orphans 92 MB, and discarding the report is what
    // makes that failure silent (browser-platform.mjs).
    const disposal = await BROWSER.dispose(chrome, profile);
    console.log(`  disposal: ${JSON.stringify(disposal)}`);
  }
}

const STATES = [
  { name: 'visible', room: 'verify-frames-visible', port: 9301, extraFlags: [] },
  { name: 'minimized', room: 'verify-frames-minimized', port: 9302, extraFlags: [], minimizeAfterAttach: true },
  { name: 'headless', room: 'verify-frames-headless', port: 9303, extraFlags: ['--headless=new'] },
];

/**
 * Which states to run, and where to write what they said.
 *
 * `--states=` exists because the container has no display and only `headless`
 * is meaningful there. It REFUSES a name it does not know instead of silently
 * selecting nothing: a run that measured no state and printed ALL PASS is the
 * false pass this script was written to prevent.
 */
export function parseArgs(argv, states = STATES) {
  const known = new Map(states.map((state) => [state.name, state]));
  const value = (flag) => argv.find((entry) => entry.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
  const requested = value('--states');
  const selected = requested === null ? states : requested.split(',').map((entry) => entry.trim()).filter(Boolean).map((name) => {
    if (!known.has(name)) throw new Error(`unknown state ${JSON.stringify(name)}; known states are ${[...known.keys()].join(', ')}`);
    return known.get(name);
  });
  if (selected.length === 0) throw new Error('--states selected no state; omit the flag to run all of them');
  return { states: selected, report: value('--report') };
}

// Guarded, so `parseArgs` can be imported and asserted. Without it, importing
// this file to reach one pure function launches three browsers.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const options = isMain ? parseArgs(process.argv.slice(2)) : null;
let report = null;

if (isMain) {
  try {
    await requireAutoStart(ORIGIN);
    console.log('autoStart: on');
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exit(2);
  }
}

if (isMain) try {
  const fps = readContentFrameRate();
  console.log(`content frame rate (ffprobe, init.mp4 + seg-00000.m4s): ${fps} fps`);

  // ONE STATE'S FAILURE MUST NOT SKIP THE OTHERS. Headless is the state change 6
  // actually runs in, and a minimized window that cannot be measured is a result
  // about minimized windows, not a reason to learn nothing about headless.
  const results = [];
  for (const state of options.states) {
    try {
      results.push(await runState(state, fps));
    } catch (err) {
      console.log(`  FAIL  ${state.name}: ${err.message}`);
      failures.push(`${state.name}: ${err.message}`);
      results.push({ name: state.name, unmeasurable: err.message, pass: false });
    }
  }

  console.log('\n--- summary (a result that stays in this terminal has not been recorded) ---');
  for (const r of results) {
    if (r.unmeasurable) {
      console.log(`  ${r.name}: NOT MEASURABLE — ${r.unmeasurable}`);
      continue;
    }
    console.log(
      `  ${r.name}: ${r.callbacksPerSec.toFixed(2)}/s callbacks (fps=${fps.toFixed(3)}, min=${r.requiredCallbacksPerSec.toFixed(2)}/s), ` +
      `accept ${(r.acceptRatio * 100).toFixed(1)}%, refusals ${JSON.stringify(r.refusalDeltas)} — ${r.pass ? 'PASS' : 'FAIL'}`
    );
  }

  report = {
    origin: ORIGIN,
    mediaDir: MEDIA_DIR,
    browserPlatform: BROWSER.name,
    chrome: BROWSER.locate(),
    chromeVersions,
    flags: [...FLAGS, ...PLATFORM_FLAGS],
    frameRate: fps,
    frameRateSource: 'ffprobe(init.mp4 + seg-00000.m4s)',
    bars: { measureMs: MEASURE_MS, minCallbackRatio: MIN_CALLBACK_RATIO, minAcceptRatio: MIN_ACCEPT_RATIO },
    statesRequested: options.states.map((state) => state.name),
    results,
    endedAt: new Date().toISOString(),
  };
} catch (err) {
  console.log('ERROR:', err.message);
  failures.push(err.message);
} finally {
  // Written even when the run failed, and carrying the failures: a report that
  // only exists for a passing run is a file whose presence is the verdict, and
  // the evidence for the state that could NOT be measured is the evidence this
  // change most needs (CONSTRAINTS.md → *Artifacts*).
  if (options.report) {
    fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
    fs.writeFileSync(path.resolve(options.report), `${JSON.stringify({ ...(report ?? { results: [] }), failures, ok: failures.length === 0 }, null, 2)}\n`);
    console.log(`report: ${path.resolve(options.report)}`);
  }
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
