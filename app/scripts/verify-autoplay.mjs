// scripts/verify-autoplay.mjs
//
// Refused-start recovery under Chrome's real autoplay policy (change 5 design.md
// D6, D11; tasks.md 9.2). verify-browser.mjs launches Chrome with the policy
// switched off, so a refused `play()` can only be produced here: the same flags
// minus `--autoplay-policy`, a fresh profile, and the element unmuted by a
// script with no user gesture BEFORE the first start. A click on the page is
// then the activation that lets a fresh attempt play.
//
// A dev aid like verify-browser: needs Chrome and a running server on 8100.
// Usage: `node scripts/verify-autoplay.mjs --run-dir=results/5-autoplay-<iso>`.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, FLAGS, attach, cdpHttp, sleep, disposeChrome } from './cdp.mjs';
import { assertServedBundle, prepareRunDirectory } from './runner/core.mjs';
import { WAITING_REFUSED } from '../public/lib/playback-start.mjs';

const PORT = 9225;
const ORIGIN = 'http://127.0.0.1:8100';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BUNDLE_PATH = path.join(APP_DIR, 'public', 'room.bundle.js');
const REFUSAL_DEADLINE_MS = 30_000;
const RECOVERY_DEADLINE_MS = 15_000;
const POLL_MS = 100;

const runDirArgument = process.argv.find((arg) => arg.startsWith('--run-dir='))?.slice('--run-dir='.length);
if (!runDirArgument) throw new Error('--run-dir=results/<name> is required');
const RUN_DIR = path.resolve(APP_DIR, runDirArgument);
// `createParents` keeps `mkdirSync(..., { recursive: true })`'s behaviour: a
// nested `--run-dir` worked here before the conversion and still does.
prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: RUN_DIR, createParents: true });

const failures = [];
const labels = [];
function expect(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  labels.push({ label, pass: Boolean(cond), detail: detail ?? null });
  if (!cond) failures.push(label);
}

const PLAYBACK = '(() => window.__app ? window.__app.playback() : null)()';

async function waitFor(tab, done, deadlineMs) {
  const deadlineAt = Date.now() + deadlineMs;
  let value = await tab.evaluate(PLAYBACK);
  while (!done(value) && Date.now() < deadlineAt) {
    await sleep(POLL_MS);
    value = await tab.evaluate(PLAYBACK);
  }
  return { value, ok: done(value) };
}

const flags = FLAGS.filter((flag) => !flag.startsWith('--autoplay-policy'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'app-autoplay-'));
const room = `autoplay-${crypto.randomBytes(6).toString('hex')}`;
const url = `${ORIGIN}/room.html?room=${room}&role=host&tab=A`;
const report = { startedAt: new Date().toISOString(), gitHead: null, flags, room, readings: {}, labels, failures };
let chrome = null;

try {
  report.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
  expect('9.2 the launch drops exactly the autoplay-policy flag', flags.length === FLAGS.length - 1, JSON.stringify(flags));

  chrome = spawn(CHROME, [...flags, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=700,500', 'about:blank'], { stdio: 'ignore' });
  await cdpHttp(PORT, '/json/version');
  // Attach to the launch window first and navigate it, so the unmute below
  // races nothing but the page's own clock estimate and preparation lead.
  const tab = await attach(PORT, 'about:blank', { label: 'A' });
  await tab.send('Page.navigate', { url });

  // Unmute before anything can start. The mute toggle cannot be the lever: a
  // click on it is itself the user activation that lets the start succeed.
  let unmuted = null;
  for (const deadlineAt = Date.now() + 10_000; Date.now() < deadlineAt;) {
    const response = await tab.send('Runtime.evaluate', {
      expression: `(() => { const video = document.querySelector('video'); if (!video || !window.__app) return null; video.muted = false; return { muted: video.muted, starts: window.__app.playback().starts.length }; })()`,
      userGesture: false,
      returnByValue: true,
    });
    unmuted = response.result?.value ?? null;
    if (unmuted) break;
    await sleep(20);
  }
  report.readings.unmuted = unmuted;
  expect('9.2 the element was unmuted before the first scheduled start', unmuted?.muted === false && unmuted.starts === 0, JSON.stringify(unmuted));

  const buildId = await tab.evaluate('window.__app.buildId');
  const bundle = await assertServedBundle({ origin: ORIGIN, bundlePath: BUNDLE_PATH, pageBuildId: buildId });
  expect('9.2 the page runs the bundle on disk', bundle.matches && bundle.pageIdInServed, `served ${bundle.servedSha} · page ${buildId}`);

  const refusal = await waitFor(tab, (playback) => playback?.waiting === WAITING_REFUSED, REFUSAL_DEADLINE_MS);
  report.readings.refused = refusal.value;
  if (!refusal.ok) console.log('  S-AUTOPLAY: Chrome did not refuse the unmuted start without a gesture');
  expect(`9.2 the unmuted start is refused (${WAITING_REFUSED})`, refusal.ok && refusal.value.playing === false && refusal.value.lastPlayError === null, JSON.stringify(refusal.value));
  const refusedAttempt = refusal.value?.starts?.at(-1)?.attemptId ?? null;
  const refusedStarts = refusal.value?.starts?.length ?? 0;

  // A trusted click through the input pipeline, on a non-control element.
  const box = await tab.evaluate(`(() => { const r = (document.getElementById('status-line') || document.body).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  const recovery = await waitFor(tab, (playback) => playback?.playing === true && (playback.starts?.length ?? 0) > refusedStarts, RECOVERY_DEADLINE_MS);
  report.readings.recovered = recovery.value;
  const fresh = recovery.value?.starts?.at(-1) ?? null;
  expect('9.2 the click produced a new start whose attempt differs from the refused one', recovery.ok && fresh !== null && fresh.attemptId !== refusedAttempt, `refused attempt ${refusedAttempt} · new ${JSON.stringify(fresh)}`);
  expect('9.2 the new start played at or after its scheduled instant', Number.isFinite(fresh?.playAtSharedMs) && Number.isFinite(fresh?.startAtSharedMs) && fresh.playAtSharedMs >= fresh.startAtSharedMs, JSON.stringify(fresh));
  expect('9.2 the page is playing after the click', recovery.value?.playing === true && recovery.value?.waiting === null, JSON.stringify({ playing: recovery.value?.playing, waiting: recovery.value?.waiting }));
} catch (error) {
  console.log('ERROR:', error.message);
  failures.push(error.message);
} finally {
  report.endedAt = new Date().toISOString();
  report.outcome = failures.length === 0 ? 'pass' : 'failed';
  fs.writeFileSync(path.join(RUN_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}`);
  await disposeChrome(chrome, profile);
  process.exit(failures.length === 0 ? 0 : 1);
}
