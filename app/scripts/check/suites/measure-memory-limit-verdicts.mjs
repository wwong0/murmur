import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { conditionForName } from '../../harness-run.mjs';
import { memoryLimitVerdicts } from '../../measure/memory-limit-verdicts.mjs';
import { runCommand } from '../../measure-night.mjs';

const LIMIT = 1_073_741_824;
const entry = (condition = '13f-w-long') => ({ directory: 'run', condition, exit: 0, peerExchange: true, clientTags: ['c01', 'c02'] });
function run(peak = LIMIT, basis = 'store', figures = {}) {
  return {
    manifest: { status: 'complete', declaredClientTags: ['c01', 'c02'], condition: { peerExchange: true } },
    refusalReport: { figures: { hostUploadMultiplier: 1.5, steadyState: { steady: true },
      peerFractionAggregate: 0.60, stallCountByClient: { c01: 1 }, realtimeFactorByClient: { c01: 0.99 }, ...figures },
      countedAsStall: [{ tag: 'c01', reasons: [] }],
      published: { noFrameMsByClient: { c01: 2000 }, coverageFromPollsByClient: { c01: { coverage: 1 } } } },
    readings: { 'lab-drift': {}, 'gap-count': {}, 'byte-inventory': { viewers: {
      c01: { peakBasis: basis, peakStoredBytes: peak, storedBytes: LIMIT + 1 },
      c02: { peakBasis: 'store', peakStoredBytes: LIMIT - 1, storedBytes: LIMIT },
    } } },
  };
}
const verdict = (sample, condition = '13f-w-long', baseline = null) => memoryLimitVerdicts({
  entries: [entry(condition)], runs: { run: sample }, baseline,
}).runs[0];

export default async function measureMemoryLimitVerdictsSuite() {
  await check('13f conditions: both copies preserve every other field', async () => {
    const sourceW = structuredClone(conditionForName('13e-w-long'));
    const sourceR = structuredClone(conditionForName('13d-a-five'));
    sourceW.name = '13f-w-long';
    sourceR.name = '13f-r0-five';
    sourceR.excusals.bytelessUnreceivedResponse = true;
    assertEqual(JSON.stringify(conditionForName('13f-w-long')), JSON.stringify(sourceW), 'W differs only by name');
    assertEqual(JSON.stringify(conditionForName('13f-r0-five')), JSON.stringify(sourceR), 'R0 differs only by name and excusal');
  });
  await check('13f W: inclusive store bound, missing basis and gate', async () => {
    const met = verdict(run()).reading;
    assertEqual(met.viewers.c01.status, 'met', 'at the limit meets');
    assertEqual(met.viewers.c02.status, 'met', 'one byte below meets');
    assertEqual(met.gate, 'met', 'all viewers met');
    assertEqual(met.viewers.c01.limitActed, true, 'distinct bytes above limit show action');
    assertEqual(met.viewers.c02.limitActed, false, 'distinct bytes at limit do not show action');
    assertEqual(met.noFrameMsByClient.c01, 2000, 'no-frame time carried');
    assertEqual(met.coverageFromPollsByClient.c01.coverage, 1, 'poll coverage carried');
    assertEqual(met.countedAsStall[0].tag, 'c01', 'counted viewer carried');
    const missed = verdict(run(LIMIT + 1)).reading;
    assertEqual(missed.viewers.c01.status, 'missed', 'one byte above misses');
    assertEqual(missed.gate, 'missed', 'one missed viewer makes gate missed');
    const missing = verdict(run(LIMIT, 'distinct-completed')).reading;
    assertEqual(missing.viewers.c01.status, 'unestablished', 'distinct basis is not a store reading');
    assertEqual(missing.gate, 'unestablished', 'missing store leaves gate unestablished');
    assertEqual(verdict(run(null)).reading.viewers.c01.status, 'unestablished', 'non-finite peak is unestablished');
    const baseline = { stallCountByClient: { c01: 2 }, realtimeFactorByClient: { c01: 0.8 }, peerFractionAggregate: 0.7, ignored: 1 };
    const beside = verdict(run(), '13f-w-long', baseline).reading.beside13eW;
    assertEqual(beside.label, 'descriptive-invalid-run', 'baseline is labelled');
    assertEqual(beside.baseline.stallCountByClient.c01, 2, 'baseline figures carried');
    assertEqual(beside.baseline.ignored, undefined, 'only requested baseline fields carried');
  });
  await check('13f R0: multiplier and peer bars have both edges', async () => {
    const at = verdict(run(), '13f-r0-five').reading;
    assertEqual(at.criterion2.status, 'met', '1.5 multiplier meets');
    assertEqual(at.criterion3.status, 'met', '0.60 peer share meets');
    const above = verdict(run(LIMIT, 'store', { hostUploadMultiplier: 1.51, peerFractionAggregate: 0.59 }), '13f-r0-five').reading;
    assertEqual(above.criterion2.status, 'missed', '1.51 multiplier misses');
    assertEqual(above.criterion3.status, 'missed', '0.59 peer share misses');
    const unsteady = verdict(run(LIMIT, 'store', { steadyState: { steady: false } }), '13f-r0-five').reading;
    assertEqual(unsteady.criterion2.status, 'no-multiplier', 'non-steady has no multiplier');
    assertEqual(unsteady.viewers.c01.peakStoredBytes, LIMIT, 'R0 retains peak');
    assertEqual(unsteady.countedAsStall.length, 1, 'R0 retains counted stalls');
  });
  await check('13f verdicts: invalid run has reasons and no reading', async () => {
    const sample = run();
    sample.manifest.status = 'aborted';
    const result = verdict(sample);
    assertEqual(result.valid, false, 'aborted is invalid');
    assert(result.reasons.includes('status:aborted'), 'invalidity names status');
    assertEqual(result.reading, undefined, 'invalid run has no reading');
  });
  await check('13f CLI: an absent baseline publishes null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-limit-'));
    try {
      const sample = run();
      const runDir = path.join(root, 'run');
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(sample.manifest));
      fs.writeFileSync(path.join(runDir, 'refusal-report.json'), JSON.stringify(sample.refusalReport));
      const registry = path.join(root, 'registry.json');
      const readings = path.join(root, 'readings.json');
      const out = path.join(root, 'out');
      fs.writeFileSync(registry, JSON.stringify({ runs: [{ ...entry(), directory: runDir }] }));
      fs.writeFileSync(readings, JSON.stringify({ runs: { [runDir]: sample.readings } }));
      assertEqual(runCommand(['node', 'measure-night.mjs', '--night', '13f', '--registry', registry, '--readings', readings, '--out', out]), 0, '13f command succeeds');
      const result = JSON.parse(fs.readFileSync(path.join(out, 'verdicts.json'), 'utf8'));
      assertEqual(result.runs[0].reading.beside13eW.baseline, null, 'absent baseline is null');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
