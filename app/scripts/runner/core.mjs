// The run lifecycle every CDP runner in this tree repeats: refuse a run
// directory that would destroy evidence, write the manifest before anything
// starts, hold a wall-clock budget, append NDJSON, sum what was retained, and
// write the same tail whether the run passed or aborted.
//
// Where the runners differed, the difference is an argument here, not a branch.
//
// TEST MACHINERY. No product code imports this. Its guards are covered by
// `check/suites/runner-core.mjs`, because a guard that only exists inside a
// runner is a guard nobody runs.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Refuse a run directory before anything is created, then create it.
 *
 * The refusals are ordered, and the order is the one the callers had:
 * containment first, then the git-ignore check, then existence. A run that
 * writes to a fixed path destroys the run before it, which is what cost the
 * first pair of captures on 2026-09-05.
 *
 * `refuseIgnored` and `createParents` exist because the four callers differed
 * in exactly those two places and nowhere else. Neither defaults on: giving a
 * converted runner a refusal it did not have costs its requalification and buys
 * no behaviour.
 */
export function prepareRunDirectory({ appDir, resultsDir, runDir, refuseIgnored = false, createParents = false }) {
  const relativeRunDir = path.relative(resultsDir, runDir).split(path.sep).join('/');
  if (!relativeRunDir || relativeRunDir.startsWith('..') || path.isAbsolute(relativeRunDir)) {
    throw new Error(`run output directory must be inside ${resultsDir}: ${runDir}`);
  }
  if (createParents) fs.mkdirSync(path.dirname(runDir), { recursive: true });
  if (refuseIgnored) {
    let ignoredBy = null;
    try {
      ignoredBy = execFileSync('git', ['check-ignore', '-v', '--', path.relative(appDir, runDir)], {
        cwd: appDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // `git check-ignore` exits 1 when nothing matched, which is the pass.
      if (error?.status !== 1) throw error;
    }
    if (ignoredBy !== null) throw new Error(`run output directory is ignored by ${ignoredBy.trim()}`);
  }
  if (fs.existsSync(runDir)) throw new Error(`run output directory already exists: ${runDir}`);
  fs.mkdirSync(runDir, { recursive: false });
  return { runDir, relativeRunDir };
}

/**
 * The manifest file, separated from the manifest body. `set` returns the body
 * it was handed, so a runner keeps reading and writing plain properties on its
 * own object and this handle only owns when that object reaches the disk.
 */
export function createManifestFile({ runDir, initial = null }) {
  const filePath = path.join(runDir, 'manifest.json');
  let body = initial;
  return {
    path: filePath,
    get: () => body,
    set(next) {
      body = next;
      return body;
    },
    merge(patch) {
      if (!body) return null;
      Object.assign(body, patch);
      return body;
    },
    write() {
      if (!body) return;
      fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
    },
  };
}

/**
 * The wall-clock budget, and the two ways a runner waits inside it.
 *
 * `timers` is injectable so the suite can observe that the timeout timer is
 * cleared on both the resolve and the reject path. A leaked timer is invisible
 * in the value `bounded` returns, which is the only thing a check could
 * otherwise read.
 */
export function createDeadline({ startedAt, maxWallMs, timers = globalThis }) {
  const deadlineAt = startedAt + maxWallMs;

  function check(label) {
    if (Date.now() >= deadlineAt) throw new Error(`${label} exceeded the ${maxWallMs}ms run budget`);
  }

  async function bounded(promise, timeoutMs, label) {
    check(label);
    const remaining = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = timers.setTimeout(() => reject(new Error(`${label} timed out after ${remaining}ms`)), remaining);
        }),
      ]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  // Without `Math.max(1, ...)` the interval is asked to sleep a negative once
  // the finish instant has passed.
  async function waitFor(label, read, done, timeoutMs = 60_000, everyMs = 250) {
    const finish = Math.min(deadlineAt, Date.now() + timeoutMs);
    let value = await read();
    while (!done(value)) {
      if (Date.now() >= finish) throw new Error(`${label} not reached before ${timeoutMs}ms`);
      await sleep(Math.min(everyMs, Math.max(1, finish - Date.now())));
      value = await read();
    }
    return value;
  }

  return { deadlineAt, check, bounded, waitFor };
}

/** Both semantics, because both are used: leads truncates, start timing appends. */
export function createNdjson(runDir) {
  const lines = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join('');
  return {
    append: (name, records) => fs.appendFileSync(path.join(runDir, name), lines(records)),
    write: (name, records) => fs.writeFileSync(path.join(runDir, name), lines(records)),
  };
}

/**
 * Today's sum: the run directory's own entries, not a tree walk. Every stream
 * these runners write lands directly in the run directory. A harness stream
 * that ever lands in a subdirectory makes this under-report, and the fix is to
 * walk rather than to leave it quiet.
 */
export function retainedBytes(runDir) {
  return fs.readdirSync(runDir).reduce((total, name) => total + fs.statSync(path.join(runDir, name)).size, 0);
}

/**
 * The tail every runner writes in its `finally`. `withWallAndBytes` is off by
 * default so a converted manifest gains no field it did not have.
 */
export function runFinally({ manifest, failure, cleanupFailure, startedAt, runDir, tabs = [], withWallAndBytes = false }) {
  if (!manifest || !manifest.get()) return null;
  const failed = failure || cleanupFailure;
  const patch = { runEndedAt: new Date().toISOString() };
  if (withWallAndBytes) {
    patch.runWallMs = Date.now() - startedAt;
    patch.retainedBytes = fs.existsSync(runDir) ? retainedBytes(runDir) : 0;
  }
  patch.status = failed ? 'aborted' : 'complete';
  patch.outcome = failed ? 'failed' : 'pass';
  patch.failures = [failure, cleanupFailure].filter(Boolean).map((error) => error.message);
  if (cleanupFailure) patch.cleanup = { status: 'failed', error: cleanupFailure.message, tabs: tabs.length };
  manifest.merge(patch);
  manifest.write();
  return manifest.get();
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Which build is this run talking to? A 200 on a page proves something is
 * answering, not what it is: reachable is not fresh. This detects a page
 * running a DIFFERENT build; it cannot detect a page misreporting its own, and
 * does not claim to. Callers keep their own assertion text and their own labels.
 */
export async function assertServedBundle({ origin, bundlePath, pageBuildId }) {
  const served = await (await fetch(`${origin}/room.bundle.js`)).text();
  const onDisk = fs.readFileSync(bundlePath, 'utf8');
  const servedSha256 = sha256(served);
  const diskSha256 = sha256(onDisk);
  return {
    servedSha256,
    diskSha256,
    servedSha: servedSha256.slice(0, 12),
    diskSha: diskSha256.slice(0, 12),
    matches: servedSha256 === diskSha256,
    pageIdInServed: typeof pageBuildId === 'string' && served.includes(pageBuildId),
  };
}
