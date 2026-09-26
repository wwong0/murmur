import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { readRunDirectory, recomputeRunDirectory } from '../../harness-figures.mjs';
import { bytesForStretch, computeOneViewing } from '../../figures/one-viewing.mjs';
import { computePeerFigures, steadyState } from '../../figures/peer-figures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RESULTS = path.join(ROOT, 'app', 'results');
const SCRATCH = path.join(ROOT, '.tmp', '7c-c2');
const BARS = {
  steadyUtilisationMax: 0.90,
  steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25,
  steadyRealtimeMin: 0.98,
};

const EXPECTED_MULTIPLIERS = Object.freeze({
  '7b2-p2p-naive-2026-09-25T08-15-37.387Z': 3.492,
  '7b2-p2p-naive-2026-09-25T08-21-50.919Z': 3.544,
  '7b2-p2p-naive-2026-09-25T08-34-42.650Z': 3.553,
  '7b2-p2p-naive-2026-09-25T10-12-05.282Z': 3.481,
  '7b2-p2p-naive-2026-09-25T10-18-48.535Z': 3.492,
  '7b2-p2p-naive-2026-09-25T10-32-15.408Z': 3.574,
});

function drift(positionStart, positionEnd, displayStart = 0, displayEnd = 7_000) {
  return [
    { displaySharedMs: displayStart, scheduledMediaMs: positionStart, mediaMs: positionStart },
    { displaySharedMs: displayEnd, scheduledMediaMs: positionEnd, mediaMs: positionEnd },
  ];
}

function steadyFixture(overrides = {}) {
  const tags = ['c01', 'c02'];
  const input = {
    condition: { bars: BARS },
    clients: { c01: {}, c02: {} },
    content: { segmentSizes: [1_000] },
    segmentSeconds: 1,
    window: { startMs: 0, endMs: 1_000 },
    ...overrides.input,
  };
  const oneViewing = { playedMediaMsByClient: {
    c01: { start: 0, end: 1_000 }, c02: { start: 0, end: 1_000 },
  } };
  const cohorts = {
    c01: [{ lengthBytes: 1_000 }], c02: [{ lengthBytes: 1_000 }],
  };
  return {
    input,
    tags,
    figures: { uplinkUtilisationMean: 0.8, realtimeFactorByClient: { c01: 1, c02: 1 }, ...overrides.figures },
    cohorts: overrides.cohorts ?? cohorts,
    oneViewing: overrides.oneViewing ?? oneViewing,
  };
}

function state(overrides = {}) {
  const fixture = steadyFixture(overrides);
  return steadyState(fixture);
}

function acceptedEntries() {
  const registry = JSON.parse(fs.readFileSync(path.join(RESULTS, 'RUNS-7b2.json'), 'utf8'));
  return registry.runs.filter((run) => run.publishes === true && run.outcome === 'complete');
}

function oneViewingInput(input) {
  const tags = input.declaredClientTags;
  const offsets = input.condition?.positionOffsetMsByClient ?? {};
  return computeOneViewing({
    clients: input.clients,
    tags,
    window: input.window,
    offsets,
    segmentSizes: input.content.segmentSizes,
    segmentSeconds: input.segmentSeconds,
  });
}

export default async function oneViewingSuite() {
  await check('one viewing: pro-rates both boundary segments', async () => {
    assertNear(bytesForStretch(2_000, 9_000, [1_000, 2_000, 3_000], 4), 3_250, 0, '2s to 9s is 3250 bytes');
  });

  await check('one viewing: room position removes the declared offset', async () => {
    const clients = {
      c01: { records: drift(2_000, 9_000) },
      c02: { records: drift(32_000, 39_000) },
    };
    const result = computeOneViewing({ clients, tags: ['c01', 'c02'], window: { startMs: 0, endMs: 7_000 },
      offsets: { c01: 0, c02: 30_000 }, segmentSizes: [1_000, 2_000, 3_000], segmentSeconds: 4 });
    assertNear(result.roomStretchMs.start, 2_000, 0, 'room starts at 2s');
    assertNear(result.roomStretchMs.end, 9_000, 0, 'room ends at 9s');
    assertEqual(JSON.stringify(result.roomPositionSpreadMs), JSON.stringify({ start: 0, end: 0 }), 'offset viewers agree');
    assertNear(result.oneViewingBytesInWindow, 3_250, 0, 'room bytes are hand-computable');
  });

  await check('one viewing: each steady-state leg fails independently and names its value', async () => {
    const utilisation = state({ figures: { uplinkUtilisationMean: 0.91, realtimeFactorByClient: { c01: 1, c02: 1 } } });
    assertEqual(utilisation.steady, false, 'utilisation failure is not steady');
    assertEqual(utilisation.reason, 'steady-state-utilisation', 'utilisation failure is named');
    assertNear(utilisation.legs.utilisation.value, 0.91, 0, 'utilisation value is retained');

    const ratio = state({ cohorts: { c01: [{ lengthBytes: 940 }], c02: [{ lengthBytes: 1_260 }] } });
    assertEqual(ratio.steady, false, 'download-ratio failure is not steady');
    assertEqual(ratio.reason, 'steady-state-download-ratio', 'download-ratio failure is named');
    assertNear(ratio.legs.downloadRatio.byClient.c01, 0.94, 0, 'low ratio is retained');
    assertNear(ratio.legs.downloadRatio.byClient.c02, 1.26, 0, 'high ratio is retained');

    const realtime = state({ figures: { realtimeFactorByClient: { c01: 0.979, c02: 1 } } });
    assertEqual(realtime.steady, false, 'realtime failure is not steady');
    assertEqual(realtime.reason, 'steady-state-realtime', 'realtime failure is named');
    assertNear(realtime.legs.realtime.byClient.c01, 0.979, 0, 'realtime value is retained');
  });

  await check('one viewing: all legs pass and absent bars refuse the multiplier', async () => {
    const passing = state();
    assertEqual(passing.steady, true, 'all legs pass');
    assertEqual(passing.legs.utilisation.pass, true, 'utilisation passes');
    assertEqual(passing.legs.downloadRatio.pass, true, 'download ratio passes');
    assertEqual(passing.legs.realtime.pass, true, 'realtime passes');
    const control = state({ input: { condition: { bars: {} } } });
    assertEqual(control.steady, false, 'control without bars is not steady');
    assertEqual(control.reason, 'steady-state-bars-undeclared', 'missing bars are named');
  });

  await check('one viewing: recompute propagates denominator and publishes one multiplier outcome', async () => {
    const source = path.join(RESULTS, '7b2-p2p-naive-2026-09-25T08-15-37.387Z');
    fs.mkdirSync(SCRATCH, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(SCRATCH, 't7-pass-through-'));
    try {
      fs.cpSync(source, runDir, { recursive: true });
      const manifestPath = path.join(runDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.multiplierDenominator = 'one-viewing';
      manifest.condition.bars = { ...manifest.condition.bars, ...BARS };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const report = recomputeRunDirectory(runDir);
      assertEqual(report.figures.multiplierDenominator, 'one-viewing', 'recompute keeps manifest denominator');
      const outcomes = ['hostUploadMultiplier', 'hostUploadMultiplierRefusal']
        .filter((key) => report.figures[key] !== undefined && report.figures[key] !== null);
      assertEqual(outcomes.length, 1, 'recompute publishes exactly one multiplier outcome');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  await check('one viewing: one-viewing without drift evidence is a hard error', async () => {
    const input = {
      byteAccountingMethod: 'peer-attempt-cohort-v1',
      multiplierDenominator: 'one-viewing',
      declaredClientTags: ['c01'],
      clients: { c01: { records: [] } },
      condition: { capacityMbps: 10 },
      content: { segmentSizes: [1_000] },
      segmentSeconds: 1,
      window: { startMs: 0, endMs: 1_000 },
      originStart: { mediaBytesDelivered: 0 },
      originEnd: { mediaBytesDelivered: 0 },
    };
    const pairing = { byClient: { c01: { pairs: [] } }, excused: [] };
    let error;
    try {
      computePeerFigures(input, pairing);
    } catch (caught) {
      error = caught;
    }
    assertEqual(error?.message, 'one-viewing-drift-evidence-unavailable', 'one-viewing missing drift evidence throws');
    const legacy = computePeerFigures({ ...input, multiplierDenominator: 'distinct-completed' }, pairing);
    assertEqual(legacy.multiplierDenominator, 'distinct-completed', 'legacy denominator remains tolerant');
  });

  await check('one viewing: retained 7b2 published keys reproduce (dirs and keys are counted)', async () => {
    const entries = acceptedEntries();
    let keyCount = 0;
    for (const entry of entries) {
      const runDir = path.join(RESULTS, entry.directory);
      const retained = JSON.parse(fs.readFileSync(path.join(runDir, 'published-figures.json'), 'utf8'));
      const report = recomputeRunDirectory(runDir);
      assert(report.publishedByte && report.publishedByte.published !== false,
        `${entry.directory} recompute publishes`);
      for (const [key, value] of Object.entries(retained)) {
        keyCount += 1;
        assert(isDeepStrictEqual(report.publishedByte[key], value), `${entry.directory} retained key ${key} reproduces`);
      }
    }
    assert(entries.length > 0, 'accepted registry is non-empty');
    assert(keyCount > entries.length, `compared retained keys across ${entries.length} accepted directories`);
  });

  await check('one viewing: 7b2 six naive runs reproduce D3 multipliers and room spread', async () => {
    const entries = acceptedEntries().filter((run) => run.condition === 'p2p-naive');
    const values = entries.map((entry) => {
      const runDir = path.join(RESULTS, entry.directory);
      const { input } = readRunDirectory(runDir);
      const report = recomputeRunDirectory(runDir);
      const one = oneViewingInput(input);
      const media = report.figures.mediaBytesDeliveredInWindow;
      const multiplier = media / one.oneViewingBytesInWindow;
      return {
        directory: entry.directory,
        mediaBytesDeliveredInWindow: media,
        oneViewingBytesInWindow: one.oneViewingBytesInWindow,
        multiplier,
        roomStretchMs: one.roomStretchMs,
        roomPositionSpreadMs: one.roomPositionSpreadMs,
      };
    });
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 't7-54.json'), `${JSON.stringify(values, null, 2)}\n`);
    assertEqual(values.length, 6, 'six accepted naive runs are measured');
    for (const value of values) {
      assertNear(value.multiplier, EXPECTED_MULTIPLIERS[value.directory], 0.0005,
        `${value.directory} multiplier matches D3 to 3 decimals`);
      assert(value.roomPositionSpreadMs.start <= 1 && value.roomPositionSpreadMs.end <= 1,
        `${value.directory} room-position spread is within 1ms`);
    }
    const scattered = '7b2-p2p-scattered-2026-09-25T10-04-34.990Z';
    const { input } = readRunDirectory(path.join(RESULTS, scattered));
    const one = oneViewingInput(input);
    const report = recomputeRunDirectory(path.join(RESULTS, scattered));
    values.push({ directory: scattered, mediaBytesDeliveredInWindow: report.figures.mediaBytesDeliveredInWindow,
      oneViewingBytesInWindow: one.oneViewingBytesInWindow,
      multiplier: report.figures.mediaBytesDeliveredInWindow / one.oneViewingBytesInWindow,
      roomStretchMs: one.roomStretchMs, roomPositionSpreadMs: one.roomPositionSpreadMs });
    fs.writeFileSync(path.join(SCRATCH, 't7-54.json'), `${JSON.stringify(values, null, 2)}\n`);
    assertNear(values.at(-1).roomStretchMs.end - values.at(-1).roomStretchMs.start, 180_009, 20,
      'scattered stretch is C1 context');
  });
}
