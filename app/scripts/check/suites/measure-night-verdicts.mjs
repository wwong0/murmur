import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import { runCommand } from '../../measure-night.mjs';
import { driftVerdict, multiplierVerdict, nightVerdicts, runValidity } from '../../measure/night-verdicts.mjs';

function lab({ median = 20, p99 = 80, floor = 16.7, missing = 0, epochMismatch = 0 } = {}) {
  return { absMedianMs: median, absP99Ms: p99, window: { points: 100 }, pairs: [{ left: 'c01', right: 'c02', floorMs: floor, missing, epochMismatch }] };
}

function figures(overrides = {}) {
  return { hostUploadMultiplier: 1.5, steadyState: { steady: true, legs: { utilisation: { pass: true } } },
    peerFractionAggregate: 0.6, realtimeFactorByClient: { c01: 0.99, c02: 0.99 }, stallCountByClient: { c01: 0, c02: 0 }, ...overrides };
}

function run(overrides = {}) {
  return { manifest: { status: 'complete' }, refusalReport: { figures: figures() },
    readings: { 'lab-drift': lab(), 'byte-inventory': { viewers: { c01: { peakStoredBytes: 999 } } }, 'gap-count': { viewers: {} } }, ...overrides };
}

function entry(directory, condition, overrides = {}) { return { directory, condition, exit: 0, scored: true, ...overrides }; }
function maps(entries, common = {}) { return Object.fromEntries(entries.map((item) => [item.directory, { ...run(common), ...item.run }])); }
function landing(copies, stalls, waits) { return { hostCopiesSum: copies, stallTotalMs: stalls, waitMs: waits, peerShare30s: 0.5, backAheadMs: 100 }; }

export default async function measureNightVerdictsSuite() {
  await check('measurement night validity: complete and playback refusals are valid, other refusals are not', async () => {
    const complete = runValidity(entry('complete', '13d-a-five'), run());
    assertEqual(complete.valid, true, 'complete run is valid');
    const playback = runValidity(entry('playback', '13d-a-five'), run({ manifest: { status: 'refused', refusalReasons: [{ reason: 'client-did-not-start' }] } }));
    assertEqual(playback.valid, true, 'playback refusal remains valid');
    assertEqual(playback.playbackRefused, true, 'playback refusal is marked');
    const build = runValidity(entry('build', '13d-a-five'), run({ manifest: { status: 'refused', refusalReasons: [{ reason: 'client-did-not-start' }, { reason: 'build-mismatch' }] } }));
    assertEqual(build.valid, false, 'a build mismatch invalidates a refusal');
    assert(build.reasons.includes('refusal:build-mismatch'), 'the build mismatch is named');
    assertEqual(runValidity(entry('exit', '13d-a-five', { exit: null }), run()).valid, false, 'an unobserved exit is invalid');
    assertEqual(runValidity(entry('reader', '13d-a-five'), run({ readings: { ...run().readings, 'lab-drift': { refused: true } } })).valid, false,
      'a refused reader invalidates a run');
  });

  await check('measurement night boundaries: drift and multiplier bars are two-sided', async () => {
    assertEqual(driftVerdict(20, 16.7, 40).status, 'met', '20 plus its floor meets 40');
    assertEqual(driftVerdict(24, 16.7, 40).status, 'undecidable', '24 is inside the drift band');
    assertEqual(driftVerdict(57, 16.7, 40).status, 'missed', '57 minus its floor misses 40');
    assertEqual(driftVerdict(20, null, 40).status, 'unestablished', 'a missing floor is unestablished');
    assertEqual(driftVerdict(20, 20, 40).status, 'met', 'the inclusive drift boundary meets');
    assertEqual(multiplierVerdict(figures({ hostUploadMultiplier: 1.5 }), 1.5).status, 'met', '1.5 meets');
    assertEqual(multiplierVerdict(figures({ hostUploadMultiplier: 1.51 }), 1.5).status, 'missed', '1.51 misses');
    const noMultiplier = multiplierVerdict(figures({ steadyState: { steady: false, legs: { utilisation: { pass: false }, capacity: { pass: true } } } }), 1.5);
    assertEqual(noMultiplier.status, 'no-multiplier', 'an unsteady run has no multiplier');
    assertEqual(noMultiplier.failedLegs[0].leg, 'utilisation', 'the failed leg is named');
  });

  await check('measurement night A: all three A5 criteria are required', async () => {
    const item = entry('a-pass', '13d-a-five');
    const result = nightVerdicts({ entries: [item], runs: maps([item]) }).tests.A.runs[0];
    assertEqual(result.criteria.C1.status, 'met', 'A5 drift is met');
    assertEqual(result.criteria.C2.status, 'met', 'A5 multiplier is met');
    assertEqual(result.criteria.C3.status, 'met', 'A5 peer fraction is met');
    assertEqual(result.pass, true, 'A5 passes only with all criteria');
    const missItem = entry('a-miss', '13d-a-five');
    const missRun = run({ refusalReport: { figures: figures({ peerFractionAggregate: 0.59 }) } });
    const missed = nightVerdicts({ entries: [missItem], runs: { 'a-miss': missRun } }).tests.A.runs[0];
    assertEqual(missed.pass, false, 'A5 fails one missed criterion');
    assertEqual(missed.criteria.C3.status, 'missed', 'the peer criterion is missed');
  });

  await check('measurement night L: drift, realtime and coverage clauses are named', async () => {
    const good = entry('l-good', '13d-l-loss5');
    const goodResult = nightVerdicts({ entries: [good], runs: maps([good]) }).tests.L.runs[0];
    assertEqual(goodResult.verdict.status, 'pass', 'L passes all clauses');
    const realtime = entry('l-realtime', '13d-l-loss5');
    const realtimeRun = run({ refusalReport: { figures: figures({ realtimeFactorByClient: { c01: 0.97, c02: 0.99 } }) } });
    const realtimeResult = nightVerdicts({ entries: [realtime], runs: { 'l-realtime': realtimeRun } }).tests.L.runs[0];
    assertEqual(realtimeResult.verdict.status, 'fail', 'low realtime fails L');
    assert(realtimeResult.verdict.reasons.some((reason) => reason.startsWith('realtime:')), 'realtime is named');
    const coverage = entry('l-coverage', '13d-l-loss5');
    const coverageRun = run({ readings: { ...run().readings, 'lab-drift': lab({ missing: 6 }) } });
    const coverageResult = nightVerdicts({ entries: [coverage], runs: { 'l-coverage': coverageRun } }).tests.L.runs[0];
    assertEqual(coverageResult.verdict.status, 'fail', 'six percent missing fails L');
    assert(coverageResult.verdict.reasons.some((reason) => reason.startsWith('coverage:')), 'coverage is named');
  });

  await check('measurement night J cut: exercise and remaining stalls control the verdict', async () => {
    const notExercised = entry('cut-no', '13d-j-cut');
    const noRun = run({ readings: { ...run().readings, 'event-clocks': { supplierCut: { section: 'readable', victim: 'c02', victimVerified: false } } } });
    const noResult = nightVerdicts({ entries: [notExercised], runs: { 'cut-no': noRun } }).tests['J-cut'].runs[0];
    assertEqual(noResult.valid, false, 'an unverified victim is invalid for J');
    assertEqual(noResult.reasons.includes('cut-not-exercised'), true, 'the cut exercise failure is named');
    const cut = entry('cut-stall', '13d-j-cut');
    const cutRun = run({ readings: { ...run().readings, 'event-clocks': { supplierCut: { section: 'readable', victim: 'c02', victimVerified: true,
      selection: { segment: { index: 4, path: '/media/seg-00004.m4s' } }, replacement: { c01: { 4: 'c03' } },
      stalls: { c01: { count: 1, stallCountDelta: 0 }, c03: { count: 0, stallCountDelta: 0 } } } } } });
    const cutResult = nightVerdicts({ entries: [cut], runs: { 'cut-stall': cutRun } }).tests['J-cut'].runs[0];
    assertEqual(cutResult.verdict.status, 'fail', 'a remaining viewer stall fails J');
    assert(cutResult.verdict.reasons.includes('stalls:c01'), 'the remaining viewer is named');
  });

  await check('measurement night E: valid-pair count, trade-off and shown label follow the rule', async () => {
    const entries = [];
    const runs = {};
    for (let index = 0; index < 4; index += 1) {
      const product = entry(`e-product-${index}`, '13d-e-product');
      const control = entry(`e-control-${index}`, '13d-e-control');
      entries.push(product, control);
      runs[product.directory] = run({ readings: { ...run().readings, landings: { start: landing(1, 100, 50), seek: landing(1, 100, 50) } } });
      runs[control.directory] = run({ readings: { ...run().readings, landings: { start: landing(2, 0, 0), seek: landing(2, 0, 0) } } });
    }
    const shown = nightVerdicts({ entries, runs }).tests.E;
    assertEqual(shown.status, 'shown', 'four valid pairs with three held clauses show the gain');
    assertEqual(shown.label, 'host-copy gain shown in these trials', 'shown label is exact');
    assertEqual(shown.tradeOff, false, 'all stalls hold in the shown case');
    const changed = nightVerdicts({ entries, runs: { ...runs, 'e-product-3': run({ readings: { ...run().readings,
      landings: { start: landing(1, 300, 100), seek: landing(1, 300, 100) } } }) } }).tests.E;
    assertEqual(changed.status, 'not-shown', 'one stall difference over 250 hides the gain');
    assertEqual(changed.tradeOff, true, 'the copy gain remains a trade-off');
    assert(changed.reasons.includes('stalls'), 'the failing stall clause is named');
    const shortEntries = entries.slice(0, 4);
    const shortRuns = Object.fromEntries(shortEntries.map((item) => [item.directory, runs[item.directory]]));
    const short = nightVerdicts({ entries: shortEntries, runs: shortRuns }).tests.E;
    assertEqual(short.status, 'not-shown', 'two valid pairs do not show the gain');
    assert(short.reasons.includes('valid-pairs'), 'the valid pair count is named');
  });

  await check('measurement night peaks: the billion-byte bound is flagged inclusively', async () => {
    const high = entry('peak-high', '13d-a-five');
    const highRun = run({ readings: { ...run().readings, 'byte-inventory': { viewers: {
      c01: { peakStoredBytes: 1_000_000_000, peakReason: 'reading' }, c02: { peakStoredBytes: 999_999_999 } } } } });
    const result = nightVerdicts({ entries: [high], runs: { 'peak-high': highRun } }).peaks[0].viewers;
    assertEqual(result.c01.flagged, true, 'one billion bytes is flagged');
    assertEqual(result.c02.flagged, false, 'one byte below one billion is not flagged');
  });

  await check('measurement night CLI: an existing output path returns 2 without changing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-night-'));
    try {
      const out = path.join(root, 'existing');
      fs.mkdirSync(out);
      assertEqual(runCommand(['node', 'measure-night.mjs', '--registry', path.join(root, 'missing.json'), '--readings', path.join(root, 'missing-readings.json'), '--out', out]), 2,
        'existing output returns exit 2');
      assert(fs.existsSync(out), 'existing output remains');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
