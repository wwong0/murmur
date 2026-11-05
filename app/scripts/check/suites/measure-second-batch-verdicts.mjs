import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import { runCommand } from '../../measure-batch.mjs';
import { secondBatchValidity, secondBatchVerdicts } from '../../measure/second-batch-verdicts.mjs';

function lab(overrides = {}) {
  return { absMedianMs: 20, absP99Ms: 80, offsetSpreadMs: 4, window: { points: 100 },
    pairs: [{ left: 'c01', right: 'c02', floorMs: 10, hiddenClockMs: 0, missing: 0, epochMismatch: 0 }], ...overrides };
}

function figures(overrides = {}) {
  return { hostUploadMultiplier: 1.5, steadyState: { steady: true, legs: { utilisation: { pass: true } } },
    peerFractionAggregate: 0.6, realtimeFactorByClient: { c01: 0.99, c02: 0.99 },
    stallCountByClient: { c01: 0, c02: 0 }, ...overrides };
}

function bytes(overrides = {}) {
  return { host: { mediaBytes: 1000 }, room: { wholeRunCopies: 1.2, peerShare: 0.5 },
    viewers: { c01: { watchedBytes: 500, prefetchLeftBytes: 50, uploadBytes: 20, httpBytes: 400, p2pBytes: 100 },
      c02: { watchedBytes: 500, prefetchLeftBytes: 60, uploadBytes: 30, httpBytes: 350, p2pBytes: 150 } }, ...overrides };
}

function run({ peer = false, figures: figureOverrides = {}, readings: readingOverrides = {}, ...overrides } = {}) {
  const baseReadings = { 'lab-drift': lab(), 'gap-count': { viewers: { c01: { noFrameMs: 0, farSkips: 0 }, c02: { noFrameMs: 0, farSkips: 0 } } },
    'byte-inventory': peer ? bytes() : { refused: true, reason: 'stream-missing' } };
  return {
    manifest: { status: 'complete', condition: { peerExchange: peer }, declaredClientTags: ['c01', 'c02'] },
    refusalReport: { figures: figures(figureOverrides) }, readings: { ...baseReadings, ...readingOverrides }, schedule: null, ...overrides,
  };
}

function entry(directory, condition, overrides = {}) {
  return { directory, condition, exit: 0, scored: true, peerExchange: false, ...overrides };
}

function landing(copies, stalls, waits) {
  return { hostCopiesSum: copies, stallTotalMs: stalls, waitMs: waits, peerShare30s: 0.5, backAheadMs: 100 };
}

export default async function measureSecondBatchVerdictsSuite() {
  await check('measurement batch 2 validity: reader requirements follow peer exchange and K', async () => {
    const noPeer = entry('no-peer', '13e-b2-nop2p-10');
    const valid = secondBatchValidity(noPeer, run());
    assertEqual(valid.valid, true, 'a no-peer run is valid when R1 and R7 read');
    const noPeerResult = secondBatchVerdicts({ entries: [noPeer], runs: { 'no-peer': run() } });
    assertEqual(noPeerResult.entries[0].byteInventory, 'not-applicable', 'no-peer R2 is not applicable');
    const gap = secondBatchValidity(noPeer, run({ readings: { 'gap-count': { refused: true } } }));
    assertEqual(gap.valid, false, 'a refused R7 invalidates no-peer');
    assert(gap.reasons.includes('reader:gap-count'), 'the R7 refusal is named');
    const peer = entry('peer', '13e-u-host5', { peerExchange: true });
    const peerInvalid = secondBatchValidity(peer, run({ peer: true, readings: { 'byte-inventory': { refused: true } } }));
    assertEqual(peerInvalid.valid, false, 'a peer run requires R2');
    assert(peerInvalid.reasons.includes('reader:byte-inventory'), 'the R2 refusal is named');
    const k = entry('k', '13e-k-half');
    const kInvalid = secondBatchValidity(k, run({ readings: { 'catch-up': { refused: true } } }));
    assertEqual(kInvalid.valid, false, 'K requires catch-up');
    assert(kInvalid.reasons.includes('reader:catch-up'), 'the catch-up refusal is named');
  });

  await check('measurement batch 2 references: bars are labelled references and retain refusal reasons', async () => {
    const met = entry('met', '13e-u-host5', { peerExchange: true });
    const missed = entry('missed', '13e-u-viewers3', { peerExchange: true });
    const unsteady = entry('unsteady', '13e-u-one1', { peerExchange: true });
    const result = secondBatchVerdicts({ entries: [met, missed, unsteady], runs: {
      met: run({ peer: true }),
      missed: run({ peer: true, figures: { hostUploadMultiplier: 1.51 } }),
      unsteady: run({ peer: true, figures: { steadyState: { steady: false, legs: { utilisation: { pass: false } } },
        hostUploadMultiplierRefusal: { reason: 'one-viewing-unavailable' } } }),
    } });
    assertEqual(result.tests.U.runs[0].reading.references.multiplier.status, 'met', '1.5 meets the reference');
    assertEqual(result.tests.U.runs[1].reading.references.multiplier.status, 'missed', '1.51 misses the reference');
    assertEqual(result.tests.U.runs[2].reading.references.multiplier.status, 'no-multiplier', 'an unsteady reference has no multiplier');
    assertEqual(result.tests.U.runs[2].reading.references.multiplier.refusal, 'one-viewing-unavailable', 'the refusal reason is carried');
    assertEqual(result.tests.U.runs[0].reading.references.peerFraction.status, 'met', '0.60 meets the peer reference');
    const e = entry('e', '13e-e10-product', { peerExchange: true });
    const eResult = secondBatchVerdicts({ entries: [e], runs: { e: run({ peer: true, figures: { hostUploadMultiplier: 2 } }) } });
    assertEqual(eResult.tests.E10.pairs[0], undefined, 'an unpaired E10 arm has no pair');
  });

  await check('measurement batch 2 B2: no-peer multipliers and playback figures are printed', async () => {
    const steady = entry('b2-steady', '13e-b2-nop2p-10');
    const unsteady = entry('b2-unsteady', '13e-b2-nop2p-20');
    const result = secondBatchVerdicts({ entries: [steady, unsteady], runs: {
      'b2-steady': run(),
      'b2-unsteady': run({ figures: { steadyState: { steady: false }, hostUploadMultiplier: undefined,
        hostUploadMultiplierRefusal: { reason: 'one-viewing-unavailable' }, realtimeFactorByClient: { c01: 0.99 }, stallCountByClient: { c01: 2 } } }),
    } });
    assertEqual(result.tests.B2.runs[0].reading.multiplier.status, 'reading', 'a steady no-peer arm has a reading');
    assertEqual(result.tests.B2.runs[0].reading.multiplier.value, 1.5, 'the steady multiplier value is printed');
    assertEqual(result.tests.B2.runs[1].reading.multiplier.status, 'no-multiplier', 'an unsteady B2 arm has no multiplier');
    assertEqual(result.tests.B2.runs[1].reading.multiplier.refusal, 'one-viewing-unavailable', 'B2 names the refusal');
    assertEqual(result.tests.B2.runs[1].reading.realtimeFactorByClient.c01, 0.99, 'B2 prints realtime');
    assertEqual(result.tests.B2.runs[1].reading.stallCountByClient.c01, 2, 'B2 prints stalls');
    assertEqual(result.tests.B2.runs[0].reading.waits, null, 'B2 waits are null when not published');
    assertEqual(result.tests.B2.runs[0].reading.waitsReason, 'not-published', 'B2 names unpublished waits');
  });

  await check('measurement batch 2 Q labels: prevention, recovery and missing schedule are distinct', async () => {
    const product = entry('q-product', '13e-q-product', { clientTags: ['c01', 'c02'] });
    const control = entry('q-control', '13e-q-control', { clientTags: ['c01', 'c02'] });
    const schedule = { drop: { inForce: true }, rise: { inForce: true }, edge: { reached: true, heldAheadMsByClient: { c01: 10, c02: 11 } } };
    const result = secondBatchVerdicts({ entries: [product, control], runs: {
      'q-product': run({ schedule, figures: { realtimeFactorByClient: { c01: 0.5, c02: 0.98 } }, readings: {
        'gap-count': { viewers: { c01: { noFrameMs: 0 }, c02: { noFrameMs: 1200 } } } } }),
      'q-control': run({ schedule }),
    } });
    const viewers = result.tests.Q.pairs[0].product.reading.viewers;
    assertEqual(viewers.c01.status, 'prevented', 'zero no-frame time is prevented');
    assertEqual(viewers.c02.status, 'recovered', '0.98 realtime is recovered');
    const slow = entry('q-slow', '13e-q-product', { clientTags: ['c01'] });
    const slowResult = secondBatchVerdicts({ entries: [slow], runs: { 'q-slow': run({ schedule, figures: { realtimeFactorByClient: { c01: 0.97 } }, readings: {
      'gap-count': { viewers: { c01: { noFrameMs: 1200 } } } } }) } });
    assertEqual(slowResult.tests.Q.runs[0].reading.viewers.c01.status, 'not-recovered-within-observation', '0.97 realtime is not recovered');
    const missing = entry('q-missing', '13e-q-product');
    const missingResult = secondBatchVerdicts({ entries: [missing], runs: { 'q-missing': run() } });
    assertEqual(missingResult.tests.Q.runs[0].valid, false, 'a Q run without a schedule is invalid');
    assert(missingResult.tests.Q.runs[0].reasons.includes('schedule-missing'), 'Q names the missing schedule');
  });

  await check('measurement batch 2 T and K: skew, echo and catch-up readings retain units', async () => {
    const t = entry('t', '13e-t-skew60');
    const tRun = run({ figures: { echoRoundTripMsP50ByClient: { c01: 10, c02: 12, c05: 42 } }, readings: {
      'lab-drift': lab({ pairs: [{ left: 'c01', right: 'c05', hiddenClockMs: 30, floorMs: 10 },
        { left: 'c02', right: 'c05', hiddenClockMs: 34, floorMs: 10 }, { left: 'c01', right: 'c02', hiddenClockMs: 0, floorMs: 10 }] }) } });
    const tResult = secondBatchVerdicts({ entries: [t], runs: { t: tRun } }).tests.T.runs[0].reading;
    assertEqual(tResult.hiddenClockMedianMs, 32, 'T takes the median over c05 pairs');
    assertEqual(tResult.echoRoundTripMsP50ByClient.othersMedianMs, 11, 'T compares c05 echo with the others');
    assertEqual(tResult.predictionMs, 30, 'T prints the prediction');
    assertEqual(tResult.predictionLabel, 'prediction', 'T labels the prediction');
    const k = entry('k-good', '13e-k-half');
    const catchUp = { measuredPauseMs: 500, gapAfterMs: 100, timeInto40Ms: 3000, resolvedBy: 'rate', skipsDelta: 0,
      stallCountDelta: 2, othersMovedMs: { beforeMs: 1, afterMs: 2, differenceMs: 1 }, rate: { offUnityMs: 400 } };
    const kResult = secondBatchVerdicts({ entries: [k], runs: { 'k-good': run({ readings: { 'catch-up': catchUp } }) } }).tests.K.runs[0].reading;
    assertEqual(kResult.measuredPauseMs, 500, 'K prints measured pause');
    assertEqual(kResult.rateOffUnityMs, 400, 'K prints rate time off unity');
  });

  await check('measurement batch 2 E10: both valid pairs are required for the descriptive label', async () => {
    const entries = [];
    const runs = {};
    for (let index = 0; index < 2; index += 1) {
      const product = entry(`e-p-${index}`, '13e-e10-product', { peerExchange: true });
      const control = entry(`e-c-${index}`, '13e-e10-control', { peerExchange: true });
      entries.push(product, control);
      runs[product.directory] = run({ peer: true, readings: { landings: { start: landing(1, 100, 50), seek: landing(1, 100, 50) } } });
      runs[control.directory] = run({ peer: true, readings: { landings: { start: landing(2, 0, 0), seek: landing(2, 0, 0) } } });
    }
    const shown = secondBatchVerdicts({ entries, runs }).tests.E10;
    assertEqual(shown.status, 'shown', 'two valid pairs with all clauses hold show the gain');
    assertEqual(shown.descriptive, true, 'E10 is descriptive');
    assertEqual(shown.pairs[0].product.references.multiplier.status, 'met', 'E10 2.0 reference bar is met at the default reading');
    const e10MissedRuns = { ...runs, 'e-p-0': run({ peer: true, figures: { hostUploadMultiplier: 2.01 }, readings: { landings: { start: landing(1, 100, 50), seek: landing(1, 100, 50) } } }) };
    const e10Missed = secondBatchVerdicts({ entries, runs: e10MissedRuns }).tests.E10;
    assertEqual(e10Missed.pairs[0].product.references.multiplier.status, 'missed', 'E10 2.01 misses the reference bar');
    const tradeRuns = { ...runs, 'e-p-1': run({ peer: true, readings: { landings: { start: landing(1, 300, 50), seek: landing(1, 1, 50) } } }) };
    const trade = secondBatchVerdicts({ entries, runs: tradeRuns }).tests.E10;
    assertEqual(trade.status, 'not-shown', 'one failed stall clause hides E10');
    assertEqual(trade.tradeOff, true, 'copy gain with failed stalls is a trade-off');
    const invalidRuns = { ...runs, 'e-p-1': run({ peer: true, readings: { 'gap-count': { refused: true }, landings: { start: landing(1, 100, 50), seek: landing(1, 100, 50) } } }) };
    const invalid = secondBatchVerdicts({ entries, runs: invalidRuns }).tests.E10;
    assertEqual(invalid.status, 'not-shown', 'one invalid pair is not shown');
    assert(invalid.reasons.includes('valid-pairs'), 'an invalid pair names valid-pairs');
  });

  await check('measurement batch 2 peaks: no-peer is not applicable and the billion-byte bound is inclusive', async () => {
    const noPeer = entry('peak-no-peer', '13e-b2-nop2p-10');
    const high = entry('peak-high', '13e-u-host5', { peerExchange: true });
    const low = entry('peak-low', '13e-u-viewers3', { peerExchange: true });
    const result = secondBatchVerdicts({ entries: [noPeer, high, low], runs: {
      'peak-no-peer': run(),
      'peak-high': run({ peer: true, readings: { 'byte-inventory': bytes({ viewers: { c01: { peakStoredBytes: 1_000_000_000 } } }) } }),
      'peak-low': run({ peer: true, readings: { 'byte-inventory': bytes({ viewers: { c01: { peakStoredBytes: 999_999_999 } } }) } }),
    } }).peaks;
    assertEqual(result[0].viewers.c01.peakReason, 'not-applicable-no-peer-exchange', 'no-peer peak is not applicable');
    assertEqual(result[0].viewers.c01.flagged, false, 'no-peer peak is not flagged');
    assertEqual(result[1].viewers.c01.flagged, true, 'one billion bytes is flagged');
    assertEqual(result[2].viewers.c01.flagged, false, 'one byte below one billion is not flagged');
  });

  await check('measurement batch 2 CLI: 13e selection and unknown batches return exit 2 safely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-second-batch-'));
    try {
      const out = path.join(root, 'existing');
      fs.mkdirSync(out);
      assertEqual(runCommand(['node', 'measure-batch.mjs', '--batch', '13e', '--registry', path.join(root, 'missing.json'), '--readings', path.join(root, 'missing-readings.json'), '--out', out]), 2,
        '13e with an existing output returns exit 2');
      assertEqual(runCommand(['node', 'measure-batch.mjs', '--batch', 'bogus', '--registry', path.join(root, 'missing.json'), '--readings', path.join(root, 'missing-readings.json'), '--out', path.join(root, 'new')]), 2,
        'an unknown batch returns exit 2');
      assert(fs.existsSync(out), 'the existing output remains');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

