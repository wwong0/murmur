import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, assert, assertEqual } from '../harness.mjs';
import { recomputeRunDirectory } from '../../harness-figures.mjs';
import { decideFinalization, runHarness, settleFinalization } from '../../harness-run.mjs';
import { maybeInjectDisturbance, DISTURBANCE_MARKER } from '../../harness/disturbance.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RESULTS = path.join(APP, 'results');
// Constructed, because calibration writes a rate into the real saturated condition.
const UDP_WITHOUT_RATE = { name: 'saturated', backgroundLoadProtocol: 'udp', backgroundLoadMbps: null };

function counters(tags, offset) {
  return {
    mediaBytesDelivered: 1000 + offset,
    abortedMediaBytesDelivered: 0,
    unattributedMediaBytesDelivered: 0,
    byPath: { '/media/seg-000.m4s': { hits: 1 + offset, completedHits: 1, bytesDelivered: 1000 + offset, expectedBytes: 1000 } },
    byClient: Object.fromEntries(tags.map((tag) => [tag, {
      mediaBytesDelivered: 500 + offset,
      abortedMediaBytesDelivered: 0,
      segmentBytesDelivered: 500 + offset,
      initBytesDelivered: 0,
    }])),
  };
}

function records() {
  return [0, 1000].map((displaySharedMs, index) => ({
    seq: index + 1,
    epochMs: 1,
    displaySharedMs,
    mediaMs: displaySharedMs,
    driftMs: 1,
    presentedFrames: index,
    clock: { offsetMs: 0, halfWidthMs: 3, delayTermMs: 1, ageTermMs: 2 },
  }));
}

function polls() {
  return [0, 1000].map((atMs, index) => ({
    atMs,
    polls: index + 1,
    clock: { bestDelayMs: 1, probes: { issued: index + 1, abandoned: 0 }, counters: { impossible: 0 } },
    controller: { bandMs: 4, stoppingThresholdMs: 8, thresholdUsable: true, settlingMs: null, mode: 'steady', correctionsApplied: 1 },
    quality: { droppedVideoFrames: 0, totalVideoFrames: index ? 24 : 0 },
    stalls: { epoch: 'e1', count: 0 },
  }));
}

function manifestFor(tags, figureKinds) {
  return {
    schemaVersion: 1,
    declaredClientTags: tags,
    clientTags: tags,
    condition: {
      name: 'constructed-drift', capacityMbps: 100, runLengthMs: 1000, figureKinds,
      criterion: { statistic: 'median', targetMs: 40 },
      bars: { recordCoverageMin: 0, droppedFrameFractionMax: 1, driftLogMissedMax: 0 },
    },
    window: { startMs: 0, endMs: 1000, excludedPrefixMs: 0, measureWindowMs: 1000 },
    content: { identity: 'step0-content-media-v1', frameRate: 1 },
    cadence: Object.fromEntries(tags.map((tag) => [tag, { presentIntervalMs: 16.667, classification: 'synthetic-fixed' }])),
    clients: Object.fromEntries(tags.map((tag) => [tag, {
      tag,
      boundaries: { start: null, end: { playback: { starts: [] } } },
      driftLogMissed: 0,
      requestTimebase: 'measure-window',
    }])),
    disturbance: null,
  };
}

function writeFixture(root, { figureKinds = ['drift'], tags = ['c01', 'c02'], disturbance = null } = {}) {
  const manifest = manifestFor(tags, figureKinds);
  manifest.disturbance = disturbance;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'origin-counters-start.json'), JSON.stringify({ atMs: 0, counters: counters(tags, 0) }));
  fs.writeFileSync(path.join(root, 'origin-counters-end.json'), JSON.stringify({ atMs: 1000, counters: counters(tags, 10) }));
  fs.writeFileSync(path.join(root, 'origin-link.ndjson'), `${JSON.stringify({ atMs: 0, txBytes: 0, qdisc: { backlogBytes: 100, drops: 0, overlimits: 0 } })}\n${JSON.stringify({ atMs: 1000, txBytes: 12500000, qdisc: { backlogBytes: 200, drops: 0, overlimits: 2 } })}\n`);
  for (const tag of tags) {
    fs.writeFileSync(path.join(root, `client-${tag}.drift.ndjson`), `${records().map((record) => JSON.stringify(record)).join('\n')}\n`);
    fs.writeFileSync(path.join(root, `client-${tag}.poll.ndjson`), `${polls().map((poll) => JSON.stringify(poll)).join('\n')}\n`);
    fs.writeFileSync(path.join(root, `client-${tag}.echo.ndjson`), `${JSON.stringify({ seq: 0, t1: 0, t4: 2, rttMs: 2, lost: false })}\n${JSON.stringify({ seq: 1, t1: 998, t4: 1000, rttMs: 2, lost: false })}\n`);
    fs.writeFileSync(path.join(root, `client-${tag}.requests.ndjson`), '');
    fs.writeFileSync(path.join(root, `client-${tag}.clock-join.json`), JSON.stringify({
      timebase: 'cdp-monotonic', joined: [{ cdpMs: 10 }], echoSent: [], echoReplies: [{ cdpMs: 260 }],
    }));
  }
  return manifest;
}

function manifestFile(root) {
  const body = { status: 'running' };
  return {
    body,
    file: {
      path: path.join(root, 'manifest.json'),
      get: () => body,
      merge: (patch) => Object.assign(body, patch),
      write: () => fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(body)}\n`),
    },
  };
}

function diskManifestFile(root, body) {
  const file = path.join(root, 'manifest.json');
  return {
    path: file,
    get: () => body,
    merge: (patch) => Object.assign(body, patch),
    write: () => fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`),
  };
}

function fakeResult() {
  return {
    preconditions: { clockOffsetFinite: true, playbackPlaying: true },
    pausedBefore: false,
    pauseCallLocalMs: 100,
    playCallLocalMs: 350,
    playResolvedLocalMs: 351,
    playError: null,
    playbackBefore: { opens: 1, begun: 1, retargets: 0 },
    playbackAfter: { opens: 1, begun: 1, retargets: 0 },
    injected: true,
  };
}

export default async function harnessDriftRunnerSuite() {
  await check('harness drift runner: the drift file settled by the runner equals a later recompute', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-drift-recompute-'));
    try {
      // The runner's order: manifest written as running, recompute, then settle,
      // which writes the lifecycle keys. Comparing against a file this check wrote
      // itself compared the code with itself (d1-findings.md F1).
      const mf = diskManifestFile(root, { ...writeFixture(root), status: 'running', outcome: 'running' });
      mf.write();
      const first = recomputeRunDirectory(root);
      assertEqual(JSON.stringify(first), JSON.stringify(recomputeRunDirectory(root)), 'two recomputes are deeply equal');
      assert(first.publishedDrift && first.publishedDrift.published !== false, 'constructed drift publishes');
      assert(typeof first.driftCsv === 'string' && typeof first.driftSvg === 'string', 'published plots are text');
      const evaluation = { refused: false, runRefused: false, figures: { byte: true, drift: true }, reasons: [] };
      const decision = decideFinalization({ evaluation, recomputed: first, figureKinds: ['drift'] });
      settleFinalization({ decision, manifestFile: mf, runDir: root, recomputed: first, evaluation, startedAt: Date.now(), retained: 1 });
      assertEqual(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).status, 'complete', 'the manifest on disk was settled');
      const stored = JSON.parse(fs.readFileSync(path.join(root, 'published-drift.json'), 'utf8'));
      assertEqual(JSON.stringify(recomputeRunDirectory(root).publishedDrift), JSON.stringify(stored), 'stored drift matches a recompute of the settled directory');
      assert(Number.isFinite(first.figures.mediaBytesDeliveredInWindow), 'the run computed a byte figure the drift file could carry');
      assert(!Object.hasOwn(stored, 'mediaBytesDeliveredInWindow') && !Object.hasOwn(stored, 'status'), 'the drift file carries no byte figure and no lifecycle key');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner: a byte-scoped run refusal still writes drift, a drift-scoped one does not', async () => {
    // 6a design.md D5: a byte-attribution fault does not suppress a drift figure
    // (d1-findings.md F2).
    for (const [scope, driftEligible] of [[['byte'], true], [['byte', 'drift'], false]]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-f2-'));
      try {
        writeFixture(root);
        const recomputed = recomputeRunDirectory(root);
        const evaluation = {
          refused: true, runRefused: true,
          figures: { byte: false, drift: driftEligible },
          reasons: [{ reason: 'origin-unattributed-bytes-nonzero', scope }],
        };
        const decision = decideFinalization({ evaluation, recomputed, figureKinds: ['drift'] });
        assertEqual(`${decision.status}/${decision.exitCode}`, 'refused/1', `scope ${scope}: the run is still refused`);
        const mf = manifestFile(root);
        settleFinalization({ decision, manifestFile: mf.file, runDir: root, recomputed, evaluation, startedAt: Date.now(), retained: 1 });
        for (const name of ['published-drift.json', 'drift-series.csv', 'drift.svg']) {
          assertEqual(fs.existsSync(path.join(root, name)), driftEligible, `scope ${scope}: ${name} ${driftEligible ? 'written' : 'withheld'}`);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  await check('harness drift runner: a 6a-shaped directory has no drift or requalification keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-6a-shape-'));
    try {
      writeFixture(root, { figureKinds: null, tags: ['c01'] });
      const report = recomputeRunDirectory(root);
      assert(!Object.hasOwn(report, 'publishedDrift'), '6a report has no publishedDrift key');
      assert(!Object.hasOwn(report, 'requalification'), '6a report has no requalification key');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner G2: drift-only finalization writes drift and no byte files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g2-'));
    try {
      writeFixture(root);
      // A branded stand-in with its CSVs, and byte evidence eligible, so figureKinds
      // alone keeps the byte files off disk.
      const drift = recomputeRunDirectory(root);
      const recomputed = { ...drift, publishedByte: drift.publishedDrift, csv: { bytesByClient: 'tag\n', utilisation: 'atMs\n' } };
      const evaluation = { refused: false, runRefused: false, figures: { byte: true, drift: true }, reasons: [] };
      const result = decideFinalization({ evaluation, recomputed, figureKinds: ['drift'] });
      const mf = manifestFile(root);
      settleFinalization({ decision: result, manifestFile: mf.file, runDir: root, recomputed, evaluation, startedAt: Date.now(), retained: 1 });
      for (const name of ['published-drift.json', 'drift-series.csv', 'drift.svg']) assert(fs.existsSync(path.join(root, name)), `drift output ${name}`);
      assert(!fs.existsSync(path.join(root, 'bytes-by-client.csv')), 'G2 has no bytes-by-client.csv');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner G3: refused drift publication writes no drift files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g3-'));
    try {
      const recomputed = { publishedDrift: { published: false, missing: 'clockHalfWidthMsP50ByClient[c01]' } };
      const evaluation = { refused: false, runRefused: false, figures: { byte: false, drift: true }, reasons: [] };
      const result = decideFinalization({ evaluation, recomputed, figureKinds: ['drift'] });
      const mf = manifestFile(root);
      settleFinalization({ decision: result, manifestFile: mf.file, runDir: root, recomputed, evaluation, startedAt: Date.now(), retained: 1 });
      for (const name of ['published-drift.json', 'drift-series.csv', 'drift.svg']) assert(!fs.existsSync(path.join(root, name)), `G3 has no ${name}`);
      assertEqual(mf.body.driftPublication.missing, 'clockHalfWidthMsP50ByClient[c01]', 'refusal is on disk');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner G3: a drift-scope refusal of a published drift figure writes no drift files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g3-scope-'));
    try {
      writeFixture(root);
      const recomputed = recomputeRunDirectory(root);
      assert(recomputed.publishedDrift?.published !== false, 'fixture drift figure publishes');
      const evaluation = { refused: true, runRefused: false, figures: { byte: false, drift: false }, reasons: [] };
      const result = decideFinalization({ evaluation, recomputed, figureKinds: ['drift'] });
      const mf = manifestFile(root);
      settleFinalization({ decision: result, manifestFile: mf.file, runDir: root, recomputed, evaluation, startedAt: Date.now(), retained: 1 });
      for (const name of ['published-drift.json', 'drift-series.csv', 'drift.svg']) assert(!fs.existsSync(path.join(root, name)), `G3 scope refusal has no ${name}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner G3: drift writes are all-or-none after the second file fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-g3-write-'));
    try {
      writeFixture(root);
      const recomputed = recomputeRunDirectory(root);
      const evaluation = { refused: false, runRefused: false, figures: { byte: false, drift: true }, reasons: [] };
      const mf = manifestFile(root);
      let writes = 0;
      let thrown = null;
      try {
        settleFinalization({
          decision: decideFinalization({ evaluation, recomputed, figureKinds: ['drift'] }),
          manifestFile: mf.file, runDir: root, recomputed, evaluation, startedAt: Date.now(), retained: 1,
          writeFile: (filePath, contents) => { writes += 1; if (writes === 2) throw new Error('second drift write failed'); fs.writeFileSync(filePath, contents); },
        });
      } catch (error) { thrown = error; }
      assert(thrown, 'second drift write failure is surfaced');
      assertEqual(mf.body.status, 'aborted', 'failed drift write aborts');
      for (const name of ['published-drift.json', 'drift-series.csv', 'drift.svg']) assert(!fs.existsSync(path.join(root, name)), `partial ${name} removed`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness drift runner G5: null disturbance evaluates nothing', async () => {
    const calls = [];
    const result = await maybeInjectDisturbance([{ tag: 'c01', tab: { evaluate: async (source) => calls.push(source) } }], null);
    assertEqual(result, null, 'null disturbance has no result');
    assertEqual(calls.length, 0, 'G5 has no injection evaluate');
  });

  await check('harness drift runner: declared disturbance evaluates exactly named clients once', async () => {
    const calls = [];
    const sessions = ['c01', 'c02', 'c03'].map((tag) => ({ tag, tab: { evaluate: async (source) => { calls.push([tag, source]); return fakeResult(); } } }));
    const result = await maybeInjectDisturbance(sessions, { clients: ['c02', 'c03'], pauseMs: 250, observationMs: 20000 });
    assertEqual(Object.keys(result.results).sort().join(','), 'c02,c03', 'only named clients return results');
    assertEqual(calls.length, 2, 'one evaluate per named client');
    assert(calls.every(([, source]) => source.includes(DISTURBANCE_MARKER)), 'evaluate uses the injection marker');
  });

  await check('harness drift runner: disturbance evaluate failure is recorded per client', async () => {
    const sessions = [
      { tag: 'c02', tab: { evaluate: async () => fakeResult() } },
      { tag: 'c03', tab: { evaluate: async () => { throw new Error('tab closed'); } } },
    ];
    const result = await maybeInjectDisturbance(sessions, { clients: ['c02', 'c03'], pauseMs: 250, observationMs: 20000 });
    assertEqual(result.results.c03.error, 'tab closed', 'client evaluate error retained');
    assertEqual(result.results.c02.injected, true, 'other client still completes');
  });

  await check('harness drift runner: disturbance instants are page values and observation is retained', async () => {
    const result = await maybeInjectDisturbance([{ tag: 'c02', tab: { evaluate: async () => fakeResult() } }], { clients: ['c02'], pauseMs: 250, observationMs: 20000 });
    const entry = result.results.c02;
    assert(entry.pauseCallLocalMs < entry.playCallLocalMs && entry.playCallLocalMs <= entry.playResolvedLocalMs, 'page instants are ordered');
    assertEqual(entry.observationMs, 20000, 'observation duration is retained');
    assert(entry.pauseCallLocalMs !== result.injectionHarnessMs, 'page instant is not harness Date.now');
  });

  await check('harness drift runner G4: UDP condition without rate is refused before directory creation', async () => {
    const runDir = path.join(RESULTS, `check-g4-${process.pid}-${Date.now()}`);
    try {
      let thrown = null;
      try { await runHarness({ conditionName: 'saturated', condition: UDP_WITHOUT_RATE, runDir }); } catch (error) { thrown = error; }
      assert(thrown, 'missing UDP rate throws');
      assert(thrown.message.includes('saturated'), 'G4 names the condition');
      assert(!fs.existsSync(runDir), 'G4 creates no run directory');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
}
