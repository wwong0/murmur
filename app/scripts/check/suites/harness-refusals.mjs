import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import {
  captureBoundary,
  conditions,
  decideFinalization,
  drainClient,
  mergeVerifiedContext,
  runHarness,
  settleFinalization,
} from '../../harness-run.mjs';
import { attachTabTakenDetector, isTabTakenNetworkFrame } from '../../harness/cdp-records.mjs';
import { evaluateRefusals, REFUSAL_REASONS, refusalReasonSetIsUnique } from '../../harness/refusals.mjs';
import { validateCdpQualification } from '../../harness/qualification.mjs';
import { bytesByClientCsv, isPublishedFigure, publish, utilisationCsv } from '../../figures/publication.mjs';
import { HTTP } from '../fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BARS = { recordCoverageMin: 0.95, droppedFrameFractionMax: 0.02, driftLogMissedMax: 0 };

function records(count = 3197, span = 3197) {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    displaySharedMs: index * 180000 / Math.max(1, count - 1),
    mediaMs: index * 133200 / Math.max(1, count - 1),
    presentedFrames: Math.floor(index * (span - 1) / Math.max(1, count - 1)),
  }));
}

function polls(epochs = ['e1']) {
  return [0, 180000].map((atMs, index) => ({
    atMs,
    quality: { droppedVideoFrames: index ? 0 : 0, totalVideoFrames: index ? 100 : 0 },
    stalls: { epoch: epochs[index] ?? epochs[0], count: 0 },
  }));
}

// A cadence the run established: one value, tightly clustered, at 60Hz — so
// `optimismVsSixtyHzMs` is zero and the fixture carries no hidden advantage
// over a viewer on a 60Hz panel (design.md D6).
function cadenceRecords(tags = ['c01'], override = {}) {
  return Object.fromEntries(tags.map((tag) => [tag, {
    tag,
    classification: 'synthetic-fixed',
    presentIntervalMs: 1000 / 60,
    impliedHz: 60,
    dispersionMs: 0.2,
    optimismVsSixtyHzMs: 0,
    reasons: [],
    ...override,
  }]));
}

function evidence({ count = 3197, span = 3197, client = {}, unattributedEnd = 0, publication = {}, cadence } = {}) {
  const clientEvidence = {
    records: records(count, span),
    polls: polls(),
    finalPlayback: { begun: 1 },
    driftLogMissed: 0,
    maxDriftDrainGapMs: 15000,
    ...client,
  };
  return {
    condition: { name: 'constructed', capacityMbps: 10, publishes: true, bars: BARS },
    window: { startMs: 0, endMs: 180000, startSnapshotAtMs: 0, endSnapshotAtMs: 180000 },
    declaredClientTags: ['c01'],
    originStart: { unattributedMediaBytesDelivered: 0 },
    originEnd: { unattributedMediaBytesDelivered: unattributedEnd },
    clients: { c01: clientEvidence },
    cadence: cadence === undefined ? cadenceRecords(['c01']) : cadence,
    publicationContext: {
      condition: { name: 'constructed', capacityMbps: 10 },
      window: { startMs: 0, endMs: 180000, startSnapshotAtMs: 0, endSnapshotAtMs: 180000 },
      originWasteFraction: 0,
      realtimeFactorByClient: { c01: 0.74 },
      stallCountByClient: { c01: 0 },
      content: { identity: 'constructed', frameRate: 24 },
      declaredClientTags: ['c01'],
      cdpQualification: {
        status: 'passed', statSizeBytes: 1000, bodyBytesFromChunks: 1000, bodyBytesFromTotal: 1000,
      },
      ...publication,
    },
    cdpQualification: {
      status: 'passed', statSizeBytes: 1000, bodyBytesFromChunks: 1000, bodyBytesFromTotal: 1000,
    },
  };
}

function publishedByteFixture() {
  const context = {
    condition: { name: 'constructed', capacityMbps: 10 },
    window: { startMs: 0, endMs: 180000, startSnapshotAtMs: 0, endSnapshotAtMs: 180000 },
    originWasteFraction: 0,
    realtimeFactorByClient: { c01: 0.74 },
    stallCountByClient: { c01: 0 },
    content: { identity: 'constructed', frameRate: 24 },
    declaredClientTags: ['c01'],
  };
  return publish('byte', {
    originWasteFraction: 0,
    peerByteFractionByClient: {},
    originMediaBytesByClient: {},
    clientReceivedMediaBytesByClient: {},
    originVsClientBytesByClient: {},
    abortedQueuedResidualBytesByClient: {},
  }, context);
}

function has(result, reason) {
  return result.reasons.some((entry) => entry.reason === reason);
}

function writeRefusalFixture(root, result) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ status: 'refused', reasons: result.reasons }, null, 2));
  fs.writeFileSync(path.join(root, 'client-c01.drift.ndjson'), '{"seq":1}\n');
  return { exitCode: result.refused ? 1 : 0, files: fs.readdirSync(root) };
}

export default async function harnessRefusalsSuite() {
  await check('harness-refusals: green control passes coverage and publishes realtime 0.74', async () => {
    const result = evaluateRefusals(evidence());
    assert(!result.refused, `control refused: ${JSON.stringify(result.reasons)}`);
    assertNear(result.coverage.c01.coverage, 1, 0, 'one record per presented frame');
    assertNear(result.published.realtimeFactorByClient.c01, 0.74, 1e-12, 'realtime factor');
    assertEqual(result.figures.byte, true, 'byte figure remains available');
    assertEqual(result.figures.drift, true, 'drift figure remains available');
  });

  await check('harness-refusals: never-played gate uses begun and suppresses every figure', async () => {
    const result = evaluateRefusals(evidence({ client: { finalPlayback: { begun: 0 } } }));
    assert(has(result, 'client-never-began-playback'), 'never-played reason');
    assertEqual(result.figures.byte, false, 'byte suppressed');
    assertEqual(result.figures.drift, false, 'drift suppressed');
  });

  await check('harness-refusals: no whole-run records is independent of window coverage', async () => {
    const result = evaluateRefusals(evidence({ client: { records: [] } }));
    assert(has(result, 'client-holds-no-drift-records'), 'no-record reason');
    assert(has(result, 'record-coverage-unavailable'), 'empty window is unavailable too');
    assertEqual(result.figures.byte, true, 'byte remains available');
    assertEqual(result.figures.drift, false, 'drift suppressed');
  });

  await check('harness-refusals: 3197/3037/3036 coverage discriminator is inclusive at the declared bar', async () => {
    const full = evaluateRefusals(evidence({ count: 3197 }));
    const edge = evaluateRefusals(evidence({ count: 3037 }));
    const red = evaluateRefusals(evidence({ count: 3036 }));
    assertNear(full.coverage.c01.coverage, 1, 0, '3197 coverage');
    assertNear(edge.coverage.c01.coverage, 3037 / 3197, 1e-12, '3037 coverage');
    assert(!has(edge, 'record-coverage-below-declared-fraction'), '3037 is accepted at the edge');
    assert(has(red, 'record-coverage-below-declared-fraction'), '3036 is refused');
    assertNear(full.published.realtimeFactorByClient.c01, 0.74, 1e-12, 'full realtime');
  });

  await check('harness-refusals: malformed, nonmonotonic and null presentedFrames are unavailable', async () => {
    const malformed = evidence();
    malformed.clients.c01.records[4].seq = malformed.clients.c01.records[3].seq;
    const nonmonotonic = evidence();
    nonmonotonic.clients.c01.records[4].presentedFrames = nonmonotonic.clients.c01.records[3].presentedFrames;
    const missing = evidence();
    missing.clients.c01.records[4].presentedFrames = null;
    for (const result of [evaluateRefusals(malformed), evaluateRefusals(nonmonotonic), evaluateRefusals(missing)]) {
      assert(has(result, 'record-coverage-unavailable'), 'malformed coverage reason');
      assertEqual(result.figures.byte, true, 'malformed drift evidence does not suppress bytes');
      assertEqual(result.figures.drift, false, 'malformed drift evidence suppresses drift');
    }
  });

  await check('harness-refusals: eviction gate fires on any discarded record', async () => {
    const result = evaluateRefusals(evidence({ client: { driftLogMissed: 1 } }));
    assert(has(result, 'drift-log-discarded-records'), 'eviction reason');
    assertEqual(result.figures.byte, true, 'byte remains available');
    assertEqual(result.figures.drift, false, 'drift suppressed');
  });

  await check('harness-refusals: missing or nonfinite eviction evidence refuses drift', async () => {
    const absent = evaluateRefusals(evidence({ client: { driftLogMissed: undefined } }));
    const nonfinite = evaluateRefusals(evidence({ client: { driftLogMissed: Number.NaN } }));
    for (const result of [absent, nonfinite]) {
      assert(has(result, 'drift-log-missed-unavailable'), 'missing eviction reason');
      assertEqual(result.figures.byte, true, 'drift evidence fault leaves byte publication eligible');
      assertEqual(result.figures.drift, false, 'missing eviction evidence blocks drift');
    }
  });

  await check('harness-refusals: unavailable quality counters refuse rather than pass', async () => {
    const fewer = evaluateRefusals(evidence({ client: { polls: [polls()[0]] } }));
    const missing = evaluateRefusals(evidence({ client: { polls: [
      { atMs: 0, quality: null, stalls: { epoch: 'e1', count: 0 } },
      { atMs: 180000, quality: null, stalls: { epoch: 'e1', count: 0 } },
    ] } }));
    const nonmonotonic = evaluateRefusals(evidence({ client: { polls: [
      { atMs: 0, quality: { droppedVideoFrames: 0, totalVideoFrames: 100 }, stalls: { epoch: 'e1', count: 0 } },
      { atMs: 90000, quality: { droppedVideoFrames: 1, totalVideoFrames: 200 }, stalls: { epoch: 'e1', count: 0 } },
      { atMs: 180000, quality: { droppedVideoFrames: 2, totalVideoFrames: 150 }, stalls: { epoch: 'e1', count: 0 } },
    ] } }));
    for (const result of [fewer, missing, nonmonotonic]) {
      assert(has(result, 'dropped-frame-evidence-unavailable'), 'quality unavailable reason');
      assertEqual(result.runRefused, true, 'quality instrument failure refuses run');
      assertEqual(result.figures.byte, false, 'quality evidence scopes byte');
      assertEqual(result.figures.drift, false, 'quality evidence scopes drift');
    }
  });

  await check('harness-refusals: page reset and excessive drain gap invalidate drift evidence', async () => {
    const reset = evaluateRefusals(evidence({ client: { pageReset: true } }));
    const gap = evaluateRefusals(evidence({ client: { maxDriftDrainGapMs: 60001 } }));
    assert(has(reset, 'drift-page-reset'), 'page reset reason');
    assert(has(gap, 'drift-drain-gap-over-60s'), 'drain gap reason');
    assertEqual(reset.figures.byte, true, 'page reset does not suppress byte context');
    assertEqual(gap.figures.byte, true, 'drain gap does not suppress byte context');
    assertEqual(reset.figures.drift, false, 'page reset suppresses drift');
    assertEqual(gap.figures.drift, false, 'drain gap suppresses drift');
  });

  await check('harness-refusals: dropped-frame delta uses the declared window bar', async () => {
    const result = evaluateRefusals(evidence({ client: { polls: [
      { atMs: 0, quality: { droppedVideoFrames: 0, totalVideoFrames: 100 }, stalls: { epoch: 'e1', count: 0 } },
      { atMs: 180000, quality: { droppedVideoFrames: 3, totalVideoFrames: 200 }, stalls: { epoch: 'e1', count: 0 } },
    ] } }));
    assert(has(result, 'dropped-frames-above-declared-bar'), 'dropped-frame reason');
    assertEqual(result.figures.byte, false, 'byte suppressed');
    assertEqual(result.figures.drift, false, 'drift suppressed');
  });

  await check('harness-refusals: CDP qualification requires equal known-size byte paths', async () => {
    const good = validateCdpQualification({ status: 'passed', statSizeBytes: 17, bodyBytesFromChunks: 17, bodyBytesFromTotal: 17 });
    const bad = validateCdpQualification({ status: 'passed', statSizeBytes: 17, bodyBytesFromChunks: 16, bodyBytesFromTotal: 17 });
    assertEqual(good.valid, true, 'equal qualification passes');
    assertEqual(bad.valid, false, 'mismatched qualification fails');
    const result = evaluateRefusals({ ...evidence(), cdpQualification: bad });
    assert(has(result, 'cdp-byte-mapping-unqualified'), 'qualification refusal reason');
    assertEqual(result.runRefused, false, 'qualification blocks publication only');
    assertEqual(result.figures.byte, false, 'unqualified byte figure suppressed');
    assertEqual(result.figures.drift, true, 'unqualified byte mapping leaves drift eligible');

    const never = evaluateRefusals({ ...evidence(), cdpQualification: null });
    const failed = evaluateRefusals({ ...evidence(), cdpQualification: { status: 'failed', reason: 'qualification-error:recorder stopped' } });
    const neverEvidence = never.reasons.find((entry) => entry.reason === 'cdp-byte-mapping-unqualified').evidence;
    const failedEvidence = failed.reasons.find((entry) => entry.reason === 'cdp-byte-mapping-unqualified').evidence;
    assertEqual(neverEvidence.attempted, false, 'never-run evidence is marked unattempted');
    assertEqual(failedEvidence.attempted, true, 'failed-run evidence is marked attempted');
    assertEqual(failedEvidence.status, 'failed', 'failed-run status is retained');
    assertEqual(failedEvidence.qualificationReason, 'qualification-error:recorder stopped', 'failed-run reason is retained');
    assertEqual(never.figures.byte, false, 'never-run byte figure suppressed');
    assertEqual(failed.figures.byte, false, 'failed-run byte figure suppressed');
  });

  await check('harness-refusals: the run qualifies once after the first client and retains thrown failure evidence', async () => {
    const tab = {
      on: () => () => {},
      send: async () => {},
      evaluate: async (source) => source.includes('wallMs') ? { wallMs: Date.now(), performanceNowMs: 0 } : true,
    };
    const topology = {
      async prepare() { return { containers: { origin: 'origin-container' } }; },
      async applyQdiscs() { return []; },
      async teardown() {},
    };
    const stopAfterQualification = async () => { throw new Error('stop after qualification'); };
    // prepareRunDirectory refuses a run directory outside results/, so this one
    // has to be written there. The removal is in a finally because a failing
    // assertion below would otherwise leave a directory in the evidence tree
    // that the run register knows nothing about.
    const run = async (name, qualifier) => {
      const runDir = path.join(ROOT, 'results', `check-cdp-qualification-${process.pid}-${Date.now()}-${name}`);
      try {
        try {
          await runHarness({
            conditionName: 'shakedown/filler-null',
            runDir,
            originUrl: HTTP,
            clientOriginUrl: HTTP,
            topology,
            clientFactory: async () => ({ tab }),
            establishCadence: stopAfterQualification,
            qualifyCdpBytes: qualifier,
          });
        } catch (error) {
          assertEqual(error.message, 'stop after qualification', 'the harness stops at the injected cadence seam');
        }
        return JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
      } finally {
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    };

    let calls = 0;
    const passed = { status: 'passed', statSizeBytes: 7, bodyBytesFromChunks: 7, bodyBytesFromTotal: 7 };
    const merged = await run('passed', async (calledTab, options) => {
      calls += 1;
      assertEqual(calledTab, tab, 'the first prepared tab is qualified');
      assertEqual(options.originContainer, 'origin-container', 'the prepared origin container is passed');
      return passed;
    });
    assertEqual(calls, 1, 'the qualifier is called exactly once per run');
    assertEqual(JSON.stringify(merged.cdpQualification), JSON.stringify(passed), 'qualification is merged into the manifest');

    const failed = await run('throw', async () => { throw new Error('recorder stopped'); });
    assertEqual(failed.cdpQualification.status, 'failed', 'a throwing qualifier records failure');
    assertEqual(failed.cdpQualification.reason, 'qualification-error:recorder stopped', 'a throwing qualifier records its reason');
    assert(failed.cdpQualification !== null, 'a throwing qualifier never leaves null evidence');
  });

  await check('harness-refusals: unattributed origin delta suppresses byte figures only', async () => {
    const result = evaluateRefusals(evidence({ unattributedEnd: 1 }));
    assert(has(result, 'origin-unattributed-bytes-nonzero'), 'unattributed reason');
    assertEqual(result.figures.byte, false, 'byte suppressed');
    assertEqual(result.figures.drift, true, 'drift remains available');
  });

  await check('harness-refusals: tab collision suppresses every figure', async () => {
    const result = evaluateRefusals({ ...evidence(), tabCollision: true });
    assert(has(result, 'server-refused-tab-id'), 'tab collision reason');
    assertEqual(result.figures.byte, false, 'byte suppressed');
    assertEqual(result.figures.drift, false, 'drift suppressed');
  });

  await check('harness-refusals: an unestablished cadence refuses the run and names the client', async () => {
    // `none` WITH A FINITE INTERVAL, because that is what the classifier
    // actually returns: `classifyCadence` carries `raf.p50` through its none
    // branch, so a probe that saw too few callbacks — or saw them too dispersed
    // to be one cadence — reports a real number beside its refusal. A fixture
    // with a null interval would be caught by the finiteness clause and would
    // leave the classification clause untested, which a mutation of that clause
    // alone confirmed: it survived a full green check.
    const none = evaluateRefusals(evidence({ cadence: cadenceRecords(['c01'], { classification: 'none', presentIntervalMs: 12.4, impliedHz: null, optimismVsSixtyHzMs: null, reasons: ['no rVFC callbacks'] }) }));
    const unreadable = evaluateRefusals(evidence({ cadence: cadenceRecords(['c01'], { presentIntervalMs: null }) }));
    const absent = evaluateRefusals(evidence({ cadence: {} }));
    for (const result of [none, unreadable, absent]) {
      assert(has(result, 'client-cadence-unavailable'), 'cadence reason');
      assertEqual(result.runRefused, true, 'an unestablished cadence is a run refusal, not a publication one');
      assertEqual(result.figures.byte, false, 'byte suppressed');
      assertEqual(result.figures.drift, false, 'drift suppressed');
      assertEqual(result.reasons.find((entry) => entry.reason === 'client-cadence-unavailable').tag, 'c01', 'the client is named');
    }
    // The green control: the same evidence with a cadence trips nothing, so the
    // gate is shown to discriminate rather than to be universally red.
    assert(!has(evaluateRefusals(evidence()), 'client-cadence-unavailable'), 'an established cadence is not refused');
  });

  await check('harness-refusals: existing run directory is a refusal before a run starts', async () => {
    const result = evaluateRefusals({ ...evidence(), runDirectoryExists: true });
    assert(has(result, 'run-directory-exists'), 'directory reason');
    assertEqual(result.runRefused, true, 'run refused');
  });

  await check('harness-refusals: missing publication context names only its figure', async () => {
    const result = evaluateRefusals(evidence({ publication: { content: { identity: 'constructed' } } }));
    assert(has(result, 'required-context-absent:content.frameRate'), 'missing context reason');
    assertEqual(result.runRefused, false, 'publication refusal is not a run refusal');
    assertEqual(result.publicationRefused, true, 'publication refusal set');
    assertEqual(result.figures.byte, false, 'affected byte figure suppressed');
    assertEqual(result.figures.drift, true, 'unaffected drift figure remains available');
  });

  await check('harness-refusals: stall epoch discontinuity is publication-only', async () => {
    const result = evaluateRefusals(evidence({ client: { polls: polls(['e1', 'e2']) } }));
    assert(has(result, 'required-context-absent:stallCountByClient[c01]'), 'stall context reason');
    assertEqual(result.runRefused, false, 'stall discontinuity does not refuse the run');
    assertEqual(result.figures.byte, false, 'affected figure suppressed');
  });

  await check('harness-refusals: a refusal retains evidence and has a nonzero command result', async () => {
    const root = path.join(ROOT, '.tmp', `harness-refusal-${process.pid}-${Date.now()}`);
    try {
      const result = evaluateRefusals(evidence({ client: { driftLogMissed: 1 } }));
      const retained = writeRefusalFixture(root, result);
      assertEqual(retained.exitCode, 1, 'refused command exits nonzero');
      assert(retained.files.includes('manifest.json'), 'manifest retained');
      assert(retained.files.includes('client-c01.drift.ndjson'), 'drift stream retained');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness-refusals: all declared refusal reasons are built before uniqueness is asserted', async () => {
    assertEqual(refusalReasonSetIsUnique(), true, 'declared reason set is unique');
    assertEqual(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length, 'reason list has no collisions');
  });

  await check('harness-refusals: condition values are frozen and command settings are not overrides', async () => {
    assert(Object.isFrozen(conditions), 'condition matrix frozen');
    assert(Object.isFrozen(conditions['baseline-nop2p']), 'baseline frozen');
    assertEqual(conditions['baseline-nop2p'].clients, 5, 'baseline client count declared');
    assertEqual(conditions['baseline-nop2p-10'].clients, 10, 'ten-client count declared');
    assertEqual(conditions['baseline-nop2p'].measureWindowMs, 180000, 'baseline window declared');
    assertEqual(conditions['baseline-nop2p'].qdiscs[0].params.rate, '10mbit', 'baseline capacity qdisc declared');
    assertEqual(conditions['baseline-nop2p-10'].qdiscs[0].params.rate, '10mbit', 'ten-client capacity qdisc declared');
    assertEqual(conditions.shakedown.filler.backgroundLoadMbps, 4, 'filler rate declared');
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'harness-run.mjs'), 'utf8');
    assert(!source.includes('retry'), 'driver has no retry path');
    assert(!source.includes('extend'), 'driver has no extension path');
    assert(!source.includes('adapt'), 'driver has no adaptive bar path');
    assertEqual((source.match(/runHarness\s*\(/g) ?? []).length, 2, 'driver does not reinvoke a run');
    assert(!source.includes('condition.bars ='), 'driver never writes bars');
    assert(!source.includes('Runtime.consoleAPICalled'), 'tab collision does not depend on console logging');
  });

  await check('harness-refusals: final drain uses the scheduled drain operation and retains tail records', async () => {
    const appended = [];
    let calls = 0;
    const session = {
      tag: 'c01', cursor: 2, records: [], driftLogMissed: 0, lastDrainAt: null, maxDrainGapMs: 0,
      tab: { evaluate: async () => {
        calls += 1;
        return { latestSeq: calls === 1 ? 3 : 4, missed: 0, records: [{ seq: calls + 2, displaySharedMs: calls }] };
      } },
    };
    const ndjson = { append: (name, rows) => appended.push({ name, rows }) };
    await drainClient(session, ndjson, 1000);
    await drainClient(session, ndjson, 16000);
    assertEqual(calls, 2, 'scheduled and final drain call the same operation');
    assertEqual(session.records.length, 2, 'tail records retained');
    assertEqual(session.maxDrainGapMs, 15000, 'drain gap retained');
    assertEqual(appended.length, 2, 'tail is written to canonical drift stream');
  });

  await check('harness-refusals: network tab-taken envelope is parsed at the CDP event seam', async () => {
    let listener;
    const tab = {
      on: (name, callback) => { assertEqual(name, 'Network.webSocketFrameReceived', 'Network event seam'); listener = callback; return () => {}; },
    };
    let collisions = 0;
    attachTabTakenDetector(tab, () => { collisions += 1; });
    listener({ response: { payloadData: '{"type":"error","payload":{"code":"tab-taken"}}' } });
    listener({ response: { payloadData: '{"type":"error","payload":{"code":"other"}}' } });
    listener({ response: { payloadData: 'not-json' } });
    assertEqual(collisions, 1, 'only tab-taken frame is detected');
    assertEqual(isTabTakenNetworkFrame({ payloadData: { type: 'error', code: 'tab-taken' } }), true, 'defensive direct envelope is accepted');
  });

  await check('harness-refusals: finalization scopes outputs and settles post-acquisition failures', async () => {
    const root = path.join(ROOT, '.tmp', `harness-finalization-${process.pid}-${Date.now()}`);
    const byteFigure = publishedByteFixture();
    assertEqual(isPublishedFigure(byteFigure), true, 'real publish result is branded');
    const recomputed = {
      publishedByte: byteFigure,
      csv: { bytesByClient: bytesByClientCsv(byteFigure), utilisation: utilisationCsv(byteFigure) },
    };
    const manifestFor = (runDir) => {
      const body = { status: 'running' };
      return {
        body,
        file: {
          get: () => body,
          merge: (patch) => Object.assign(body, patch),
          write: () => fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(body)),
        },
      };
    };
    fs.mkdirSync(root, { recursive: true });
    try {
      const driftManifest = manifestFor(root);
      const driftEvaluation = { refused: true, runRefused: true, figures: { byte: true, drift: false }, reasons: [{ reason: 'record-coverage-below-declared-fraction' }] };
      const driftOnly = decideFinalization({ evaluation: driftEvaluation, recomputed });
      settleFinalization({ decision: driftOnly, manifestFile: driftManifest.file, runDir: root, recomputed, evaluation: driftEvaluation, startedAt: Date.now(), retained: 1 });
      assertEqual(driftOnly.status, 'refused', 'D5 refusal status retained');
      assertEqual(driftOnly.exitCode, 1, 'D5 refusal exits nonzero');
      for (const name of ['published-figures.json', 'bytes-by-client.csv', 'utilisation.csv']) {
        assert(fs.existsSync(path.join(root, name)), `drift-only byte output retains ${name}`);
      }
      assertEqual(driftManifest.body.figureEligibility.byte, true, 'eligibility metadata is separate');
      assertEqual(driftManifest.body.figureEligibility.drift, false, 'drift eligibility is retained');
      assertEqual(isPublishedFigure(driftManifest.body.figures.byte), true, 'manifest retains actual branded byte figure');
      assertEqual(driftManifest.body.figures.byte === true, false, 'manifest figures is not a boolean');
      const retainedManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      assertEqual(retainedManifest.figureEligibility.byte, true, 'retained eligibility metadata');
      assertEqual(retainedManifest.figures.byte.originWasteFraction, 0, 'retained actual byte figure');

      const publicationRoot = path.join(root, 'publication-only');
      fs.mkdirSync(publicationRoot);
      const publicationManifest = manifestFor(publicationRoot);
      const publicationEvaluation = { refused: true, runRefused: false, publicationRefused: true, figures: { byte: false, drift: true }, reasons: [{ reason: 'required-context-absent:content.frameRate' }] };
      const publicationOnly = decideFinalization({ evaluation: publicationEvaluation, recomputed });
      assertEqual(publicationOnly.status, 'complete', 'publication-only refusal completes run');
      assertEqual(publicationOnly.exitCode, 0, 'publication-only refusal exits zero');
      settleFinalization({ decision: publicationOnly, manifestFile: publicationManifest.file, runDir: publicationRoot, recomputed, evaluation: publicationEvaluation, startedAt: Date.now(), retained: 1 });
      assertEqual(publicationManifest.body.status, 'complete', 'publication-only manifest is complete');
      assertEqual(Object.keys(publicationManifest.body.figures).length, 0, 'unavailable figure is not written');
      assertEqual(publicationManifest.body.figureEligibility.byte, false, 'publication eligibility is retained');
      assert(!fs.existsSync(path.join(publicationRoot, 'published-figures.json')), 'publication-only has no published figure');
      assert(!fs.existsSync(path.join(publicationRoot, 'bytes-by-client.csv')), 'publication-only has no byte CSV');
      assert(!fs.existsSync(path.join(publicationRoot, 'utilisation.csv')), 'publication-only has no utilisation CSV');

      const mixedEvaluation = { refused: true, runRefused: true, figures: { byte: false, drift: false }, reasons: [{ reason: 'client-never-began-playback' }, { reason: 'required-context-absent:stallCountByClient[c01]' }] };
      const mixed = decideFinalization({ evaluation: mixedEvaluation, recomputed });
      assertEqual(mixed.status, 'refused', 'mixed run and publication refusal is refused');
      assertEqual(mixed.exitCode, 1, 'mixed refusal exits nonzero');
      const publicationCleanup = decideFinalization({ evaluation: publicationEvaluation, recomputed, cleanupFailure: new Error('cleanup failed') });
      assertEqual(publicationCleanup.status, 'aborted', 'publication-only plus cleanup failure aborts');
      assertEqual(publicationCleanup.exitCode, 1, 'publication-only cleanup failure exits nonzero');

      const cleanup = decideFinalization({ evaluation: { refused: false, figures: { byte: true, drift: true }, reasons: [] }, recomputed, cleanupFailure: new Error('dispose failed') });
      assertEqual(cleanup.status, 'aborted', 'cleanup-only failure is aborted');
      assertEqual(cleanup.outcome, 'failed', 'cleanup-only failure is failed');
      const cleanupRoot = path.join(root, 'cleanup-only');
      fs.mkdirSync(cleanupRoot);
      const cleanupManifest = manifestFor(cleanupRoot);
      settleFinalization({ decision: cleanup, manifestFile: cleanupManifest.file, runDir: cleanupRoot, recomputed, evaluation: { reasons: [], figures: cleanup }, cleanupFailure: new Error('dispose failed'), startedAt: Date.now(), retained: 1 });
      assertEqual(cleanupManifest.body.status, 'aborted', 'cleanup failure is recorded');
      assertEqual(cleanupManifest.body.failures.length, 1, 'cleanup failure is retained');

      const instrument = decideFinalization({ recomputeError: new Error('offline recompute failed'), recomputed });
      assertEqual(instrument.status, 'aborted', 'recompute failure is aborted');
      assertEqual(instrument.writeByte, false, 'recompute failure publishes no bytes');
      const refusedCleanup = decideFinalization({ evaluation: driftEvaluation, recomputed, cleanupFailure: new Error('cleanup failed') });
      assertEqual(refusedCleanup.status, 'refused', 'D5 refusal remains refused with cleanup failure');

      const writeFailureRoot = path.join(root, 'write-failure');
      fs.mkdirSync(writeFailureRoot);
      const writeFailureManifest = manifestFor(writeFailureRoot);
      let writes = 0;
      let writeError;
      try {
        settleFinalization({ decision: decideFinalization({ evaluation: { refused: false, figures: { byte: true, drift: true }, reasons: [] }, recomputed }), manifestFile: writeFailureManifest.file, runDir: writeFailureRoot, recomputed, evaluation: { reasons: [], figures: { byte: true, drift: true } }, startedAt: Date.now(), retained: 1, writeFile: (filePath, contents) => { writes += 1; if (writes === 2) throw new Error('simulated CSV write failure'); fs.writeFileSync(filePath, contents); } });
      } catch (error) { writeError = error; }
      assert(writeError, 'failed output write is surfaced');
      assertEqual(writeFailureManifest.body.status, 'aborted', 'failed output settles aborted');
      for (const name of ['published-figures.json', 'bytes-by-client.csv', 'utilisation.csv']) {
        assert(!fs.existsSync(path.join(writeFailureRoot, name)), `failed output removes ${name}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('harness-refusals: verified Section 3 context crosses the runner seam', async () => {
    const manifest = { content: { identity: 'condition' }, regime: { name: 'condition' }, cadence: null, cdpQualification: null };
    const merged = mergeVerifiedContext(manifest, {
      content: { identity: 'verified', frameRate: 24 },
      regime: { name: 'verified' },
      cadence: { source: 'display', frameRate: 60 },
      cdpQualification: { status: 'passed' },
    });
    assertEqual(merged.content.identity, 'verified', 'content seam');
    assertEqual(merged.regime.name, 'verified', 'regime seam');
    assertEqual(merged.cadence.source, 'display', 'cadence seam');
    assertEqual(merged.cdpQualification.status, 'passed', 'CDP qualification seam');
    assertEqual(mergeVerifiedContext(manifest, {}).cdpQualification, null, 'default seam stays unavailable');
  });

  await check('harness-refusals: both boundary snapshot paths retain origin and playback evidence', async () => {
    const root = path.join(ROOT, '.tmp', `harness-boundary-${process.pid}-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    const manifest = { window: {}, clients: { c01: { boundaries: { start: null, end: null } } } };
    const manifestFile = { path: path.join(root, 'manifest.json'), write() {} };
    const sessions = [{ tag: 'c01', tab: { evaluate: async () => ({ atMs: 11, playback: { starts: [], seams: [] } }) } }];
    const snapshotReader = async (origin) => ({ atMs: origin === 'start' ? 100 : 200, counters: {} });
    try {
      await captureBoundary('start', sessions, 'start', manifest, manifestFile, null, snapshotReader);
      sessions[0].tab.evaluate = async () => ({ atMs: 22, playback: { starts: [{ id: 1 }], seams: [] } });
      await captureBoundary('end', sessions, 'end', manifest, manifestFile, null, snapshotReader);
      assert(fs.existsSync(path.join(root, 'origin-counters-start.json')), 'start snapshot retained');
      assert(fs.existsSync(path.join(root, 'origin-counters-end.json')), 'end snapshot retained');
      assertEqual(manifest.window.startSnapshotAtMs, 100, 'start boundary timebase');
      assertEqual(manifest.window.endSnapshotAtMs, 200, 'end boundary timebase');
      assertEqual(manifest.clients.c01.boundaries.end.playback.starts.length, 1, 'end playback array retained');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
