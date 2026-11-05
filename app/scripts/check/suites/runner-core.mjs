// scripts/check/suites/runner-core.mjs
//
// The run lifecycle in `scripts/runner/`, asserted here because a guard that
// lives only inside a browser runner is never run.
//
// No browser and no container. The two HTTP servers below are a few lines of
// `node:http` each, on ephemeral ports, disposed in a `finally`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, assert, assertEqual, skipWithoutResults } from '../harness.mjs';
import {
  assertServedBundle,
  createDeadline,
  createManifestFile,
  createNdjson,
  prepareRunDirectory,
  retainedBytes,
  runFinally,
} from '../../runner/core.mjs';
import { startOriginMonitor, stopOriginMonitor } from '../../runner/origin-monitor.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TMP_ROOT = path.join(APP_DIR, '.tmp');
const RESULTS_DIR = path.join(APP_DIR, 'results');

let counter = 0;
const uniqueName = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${(counter += 1)}`;

/**
 * A throwaway results root under `app/.tmp/`, never under `app/results/`: a
 * check that writes into the real results tree can destroy a run's evidence,
 * which is the failure `prepareRunDirectory` exists to prevent.
 */
function withTempResults(body) {
  const root = path.join(TMP_ROOT, uniqueName('runner-core'));
  const resultsDir = path.join(root, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  try {
    return body(resultsDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function threw(body) {
  try {
    body();
    return null;
  } catch (error) {
    return error;
  }
}

async function withServer(handler, body) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export default async function runnerCoreSuite() {
  if (skipWithoutResults('runner-core')) return;
  await check('runner-core: an existing run directory is refused, and the refusal leaves its contents alone', async () => {
    withTempResults((resultsDir) => {
      const runDir = path.join(resultsDir, 'run');
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'delivery.ndjson'), 'evidence\n');
      const error = threw(() => prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir }));
      assert(error !== null, 'the existing directory was refused');
      assert(error.message.startsWith('run output directory already exists:'), `named the reason: ${error.message}`);
      assertEqual(fs.readdirSync(runDir).join(','), 'delivery.ndjson', 'nothing was added or removed');
      assertEqual(fs.readFileSync(path.join(runDir, 'delivery.ndjson'), 'utf8'), 'evidence\n', 'the retained evidence is byte-identical');
    });
  });

  await check('runner-core: a run directory outside the results root is refused before anything is created', async () => {
    withTempResults((resultsDir) => {
      for (const [label, runDir] of [
        ['a sibling of the results root', path.join(resultsDir, '..', uniqueName('escape'))],
        ['the results root itself', resultsDir],
        ['an absolute path elsewhere', path.join(TMP_ROOT, uniqueName('absolute'))],
      ]) {
        const error = threw(() => prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir }));
        assert(error !== null, `${label} was refused`);
        assert(error.message.startsWith('run output directory must be inside'), `${label} named the reason: ${error.message}`);
        assert(!fs.existsSync(path.resolve(runDir)) || path.resolve(runDir) === resultsDir, `${label} created nothing`);
      }
      // Two-sided: the same call inside the root succeeds, so the refusal is
      // about containment and not about every path.
      const inside = path.join(resultsDir, 'run');
      const prepared = prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir: inside });
      assertEqual(prepared.relativeRunDir, 'run', 'a contained directory is accepted and named');
      assert(fs.existsSync(inside), 'and created');
    });
  });

  await check('runner-core: a git-ignored run directory is refused only when the caller asks for that refusal', async () => {
    // `app/.tmp/` is ignored by the repository's own .gitignore, so this asks
    // git rather than asserting against a pattern this check invented.
    withTempResults((resultsDir) => {
      const ignored = path.join(resultsDir, 'run');
      const error = threw(() => prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir: ignored, refuseIgnored: true }));
      assert(error !== null, 'an ignored directory was refused');
      assert(error.message.startsWith('run output directory is ignored by'), `named the reason: ${error.message}`);
      assert(!fs.existsSync(ignored), 'and created nothing');

      prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir: ignored, refuseIgnored: false });
      assert(fs.existsSync(ignored), 'the same path is accepted when the caller did not ask for the refusal');
    });

    // And a directory git does NOT ignore passes the same guard, so the check
    // is not simply refusing everything it is handed.
    const tracked = path.join(RESULTS_DIR, uniqueName('runner-core-probe'));
    try {
      prepareRunDirectory({ appDir: APP_DIR, resultsDir: RESULTS_DIR, runDir: tracked, refuseIgnored: true });
      assert(fs.existsSync(tracked), 'a tracked results directory is accepted with refuseIgnored on');
    } finally {
      fs.rmSync(tracked, { recursive: true, force: true });
    }
  });

  await check('runner-core: the manifest is on disk before anything else runs, and reads back as what was set', async () => {
    withTempResults((resultsDir) => {
      const runDir = path.join(resultsDir, 'run');
      prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir });
      const manifestFile = createManifestFile({ runDir });
      manifestFile.write();
      assert(!fs.existsSync(manifestFile.path), 'writing before a manifest is set is a no-op, as it was in the runners');

      const body = manifestFile.set({ schemaVersion: 1, status: 'running', outcome: 'running' });
      manifestFile.write();
      assert(fs.existsSync(manifestFile.path), 'the manifest exists as soon as it is written');
      const read = JSON.parse(fs.readFileSync(manifestFile.path, 'utf8'));
      assertEqual(read.status, 'running', 'and reads back as running');
      body.status = 'later';
      assertEqual(manifestFile.get().status, 'later', 'the handle holds the caller’s own object rather than a copy');
    });
  });

  await check('runner-core: the deadline throws once the budget is spent, and not before', async () => {
    const live = createDeadline({ startedAt: Date.now(), maxWallMs: 60_000 });
    assertEqual(threw(() => live.check('acquisition')), null, 'a live budget does not throw');

    const spent = createDeadline({ startedAt: Date.now() - 1000, maxWallMs: 5 });
    const error = threw(() => spent.check('acquisition'));
    assert(error !== null, 'a spent budget throws');
    assertEqual(error.message, 'acquisition exceeded the 5ms run budget', 'naming the label and the budget');
  });

  await check('runner-core: bounded rejects with its label and clears its timer on both paths', async () => {
    const created = [];
    const cleared = [];
    const timers = {
      setTimeout: (fn, ms) => {
        const id = globalThis.setTimeout(fn, ms);
        created.push(id);
        return id;
      },
      clearTimeout: (id) => {
        cleared.push(id);
        globalThis.clearTimeout(id);
      },
    };
    const deadline = createDeadline({ startedAt: Date.now(), maxWallMs: 60_000, timers });

    const value = await deadline.bounded(Promise.resolve(7), 30_000, 'quick');
    assertEqual(value, 7, 'a promise that settles first is returned');
    assertEqual(cleared.length, 1, 'and its timeout timer was cleared');
    assertEqual(cleared[0], created[0], 'the timer cleared is the timer created');

    let rejection = null;
    try {
      await deadline.bounded(new Promise(() => {}), 20, 'probe');
    } catch (error) {
      rejection = error;
    }
    assert(rejection !== null, 'a promise that never settles is rejected');
    assertEqual(rejection.message, 'probe timed out after 20ms', 'naming the label and the elapsed budget');
    assertEqual(cleared.length, 2, 'the reject path clears its timer too');
  });

  await check('runner-core: waitFor returns the first value that satisfies done, with no read after it', async () => {
    const deadline = createDeadline({ startedAt: Date.now(), maxWallMs: 60_000 });
    let reads = 0;
    const value = await deadline.waitFor('records', async () => (reads += 1), (v) => v >= 3, 5000, 1);
    assertEqual(value, 3, 'the satisfying value is returned');
    assertEqual(reads, 3, 'and nothing was read after it');
  });

  await check('runner-core: an aborted run keeps every stream it wrote and is recorded as aborted', async () => {
    withTempResults((resultsDir) => {
      const runDir = path.join(resultsDir, 'run');
      const startedAt = Date.now();
      prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir });
      const manifestFile = createManifestFile({ runDir });
      manifestFile.set({ schemaVersion: 1, status: 'running', outcome: 'running', cleanup: { status: 'pending' }, failures: [] });
      manifestFile.write();
      createNdjson(runDir).append('delivery.ndjson', [{ seq: 1 }, { seq: 2 }]);

      runFinally({ manifest: manifestFile, failure: new Error('probe aborted'), cleanupFailure: null, startedAt, runDir, tabs: [] });
      const aborted = JSON.parse(fs.readFileSync(manifestFile.path, 'utf8'));
      assertEqual(aborted.status, 'aborted', 'the status is aborted');
      assertEqual(aborted.outcome, 'failed', 'the outcome is failed');
      assertEqual(aborted.failures.join('|'), 'probe aborted', 'the failure is named');
      assertEqual(aborted.runWallMs, undefined, 'and no field the caller did not ask for was added');
      const lines = fs.readFileSync(path.join(runDir, 'delivery.ndjson'), 'utf8').trim().split('\n');
      assertEqual(lines.length, 2, 'the stream written before the abort is retained in full');

      // Two-sided: the same tail on a clean run is complete, so `aborted` is a
      // reading rather than the only value the field can take.
      const clean = createManifestFile({ runDir: path.join(resultsDir, 'run') });
      clean.set({ status: 'running', outcome: 'running' });
      runFinally({ manifest: clean, failure: null, cleanupFailure: null, startedAt, runDir, tabs: [], withWallAndBytes: true });
      assertEqual(clean.get().status, 'complete', 'a run with no failure is complete');
      assertEqual(clean.get().outcome, 'pass', 'and passes');
      assert(Number.isInteger(clean.get().retainedBytes), 'and carries the bytes it was asked for');
    });
  });

  await check('runner-core: retained bytes sum the run directory’s own entries to a constructed total', async () => {
    withTempResults((resultsDir) => {
      const runDir = path.join(resultsDir, 'run');
      prepareRunDirectory({ appDir: APP_DIR, resultsDir, runDir });
      fs.writeFileSync(path.join(runDir, 'a.ndjson'), 'x'.repeat(1000));
      fs.writeFileSync(path.join(runDir, 'b.ndjson'), 'y'.repeat(2500));
      fs.writeFileSync(path.join(runDir, 'manifest.json'), 'z'.repeat(17));
      assertEqual(retainedBytes(runDir), 3517, 'the sum is the three constructed sizes');
    });
  });

  await check('runner-core: the origin monitor gives up after two consecutive failures and not after one', async () => {
    let healthy = true;
    let alternate = false;
    await withServer(
      (req, res) => {
        const ok = alternate ? (healthy = !healthy) : healthy;
        res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'down');
      },
      async (origin) => {
        const failures = [];
        // Alternating up/down never reaches two in a row, so the monitor must
        // survive it. Without this arm the rule below would pass against a
        // monitor that aborts on the first failure.
        alternate = true;
        const survivor = startOriginMonitor({ healthUrl: `${origin}/health`, deadlineAt: Date.now() + 60_000, maxWallMs: 60_000, onFailure: (f) => failures.push(f) });
        const settledEarly = await Promise.race([
          survivor.promise.then(() => 'resolved', () => 'rejected'),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 1400)),
        ]);
        assertEqual(settledEarly, 'pending', 'single failures with a success between them do not abort the run');
        assertEqual(failures.length, 0, 'and report nothing');
        await stopOriginMonitor(survivor);

        alternate = false;
        healthy = false;
        const doomed = startOriginMonitor({ healthUrl: `${origin}/health`, deadlineAt: Date.now() + 60_000, maxWallMs: 60_000, onFailure: (f) => failures.push(f) });
        let rejection = null;
        try {
          await doomed.promise;
        } catch (error) {
          rejection = error;
        }
        assert(rejection !== null, 'two consecutive failures abort the run');
        assertEqual(rejection.serverUnavailable, true, 'flagged as the server being unavailable');
        assert(rejection.message.startsWith('server unavailable at '), `naming the reason: ${rejection.message}`);
        assertEqual(failures.length, 1, 'and reported to the caller exactly once');
        assertEqual(failures[0].endpoint, `${origin}/health`, 'with the endpoint it was watching');
      }
    );
  });

  await check('runner-core: a declared monitor timeout outlasts a slow answer that the default treats as a dead server', async () => {
    // Every answer takes 1300 ms: past the default 1000 ms, inside a declared 3000 ms.
    await withServer(
      (req, res) => { setTimeout(() => res.writeHead(200).end('ok'), 1300); },
      async (origin) => {
        const options = { healthUrl: `${origin}/health`, deadlineAt: Date.now() + 60_000, maxWallMs: 60_000 };
        const strict = startOriginMonitor(options);
        const patient = startOriginMonitor({ ...options, requestTimeoutMs: 3000 });
        const outcome = (monitor) => monitor.promise.then(() => 'resolved', () => 'rejected');
        const pending = new Promise((resolve) => setTimeout(() => resolve('pending'), 3500));
        const [strictOutcome, patientOutcome] = await Promise.all([
          Promise.race([outcome(strict), pending]),
          Promise.race([outcome(patient), pending]),
        ]);
        await stopOriginMonitor(patient);
        await stopOriginMonitor(strict);
        assertEqual(strictOutcome, 'rejected', 'the default timeout aborts on slow answers');
        assertEqual(patientOutcome, 'pending', 'the declared timeout keeps monitoring');
      }
    );
  });

  await check('runner-core: the served-bundle check separates a stale origin from a page on another build', async () => {
    const servedText = 'globalThis.__buildId = "BUILD-AAA"; // served';
    await withServer(
      (req, res) => res.writeHead(200, { 'content-type': 'application/javascript' }).end(servedText),
      async (origin) => {
        const root = path.join(TMP_ROOT, uniqueName('runner-core-bundle'));
        fs.mkdirSync(root, { recursive: true });
        try {
          const bundlePath = path.join(root, 'room.bundle.js');

          fs.writeFileSync(bundlePath, servedText);
          const same = await assertServedBundle({ origin, bundlePath, pageBuildId: 'BUILD-AAA' });
          assert(same.matches, 'an origin serving this tree’s bundle matches');
          assert(same.pageIdInServed, 'and a page reporting a build id the served text carries is accepted');
          assertEqual(same.servedSha, same.diskSha, 'the two short hashes agree');

          const stale = await assertServedBundle({ origin, bundlePath, pageBuildId: 'BUILD-BBB' });
          assert(!stale.pageIdInServed, 'a page on a build the served text does not carry is caught');
          assert(stale.matches, 'while the origin itself is still this tree’s — the two readings are separable');

          fs.writeFileSync(bundlePath, `${servedText}\n// a later edit, never rebuilt`);
          const drifted = await assertServedBundle({ origin, bundlePath, pageBuildId: 'BUILD-AAA' });
          assert(!drifted.matches, 'an origin serving a bundle that is not the one on disk is caught');
          assert(drifted.servedSha !== drifted.diskSha, 'and the two hashes differ');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    );
  });
}
