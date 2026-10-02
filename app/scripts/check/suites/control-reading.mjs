import fs from 'node:fs';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import {
  baselineTable,
  classifyControlReading,
  classifyControlRun,
  validateControlReading,
} from '../../figures/control-reading.mjs';

const IMAGES = { origin: 'sha256:origin-a', client: 'sha256:client-a' };
const WINDOWS = { highDemandTimeWindow: 15, httpDownloadTimeWindow: 60, p2pDownloadTimeWindow: 60 };
const BASE_READING = {
  kind: 'control',
  criteria: {
    multiplier: { max: 1.5 }, peerFraction: { min: 0.60 },
    startWait: { maxMs: 3_000 }, startRecovery: { maxMs: 120_000 },
  },
  published: [], acceptedRunsMin: 2, attemptsMax: 3,
  productInputs: true, control: { condition: 'p2p-scattered', peerFractionMin: 0.50 },
};

function topology(images = IMAGES) {
  return { boundaries: {
    start: { readback: { refusals: [] } }, end: { readback: { refusals: [] } },
  }, regime: { images } };
}

function recovery(result = { recovered: true, recoveryMs: 60_000 }) {
  return { start: { spans: [], trailingMs: 0, result }, seek: null };
}

function run(directory, multiplier, overrides = {}) {
  const peerFraction = overrides.peerFraction ?? 0.70;
  const steady = overrides.steady ?? { steady: true, failedLegs: [], legs: {
    utilisation: { value: 0.50, pass: true }, downloadRatio: { pass: true }, realtime: { pass: true },
  } };
  const clients = {
    c00: { role: 'host', headroom: overrides.headroom ?? { fraction: 0.85, supplied: false, available: true } },
    c01: { role: 'viewer', buildId: 'build-a', peerId: 'peer-a', engineWindows: overrides.engineWindows ?? {
      declared: null, inForce: WINDOWS, pageError: null,
    } },
    c02: { role: 'viewer', buildId: 'build-a', peerId: 'peer-b', engineWindows: overrides.engineWindows ?? {
      declared: null, inForce: WINDOWS, pageError: null,
    } },
  };
  return {
    directory, condition: overrides.condition ?? 'control-five',
    outcome: overrides.outcome ?? 'complete', publishes: overrides.publishes ?? true,
    finalization: { writeByte: overrides.writeByte ?? true },
    manifest: { clients, topology: topology(overrides.images ?? IMAGES), condition: { capacityMbps: 10, clients: 2 }, window: { startMs: 0, endMs: 180_000 } },
    report: { figures: {
      peerFractionAggregate: peerFraction, peerFractionByClient: { c01: peerFraction, c02: peerFraction },
      hostUploadMultiplier: multiplier, steadyState: steady, control: {
        holds: { start: overrides.startHold ?? { waitMs: 2_000, cause: 'ready', resumed: true }, seek: null },
        recovery: overrides.recovery ?? recovery(), sweep: overrides.sweep ?? null,
      },
    } },
  };
}

function control(overrides = {}) {
  return run('control', 1.1, { ...overrides, condition: 'p2p-scattered' });
}

function classify(runs, reading = BASE_READING, controls = [control()]) {
  return classifyControlReading({ runs: [...runs, ...controls], reading, armNames: ['control-five'] });
}

function findCondition(value, name) {
  if (!value || typeof value !== 'object') return null;
  if (value.name === name) return value;
  for (const child of Object.values(value)) {
    const found = findCondition(child, name);
    if (found) return found;
  }
  return null;
}

export default async function controlReadingSuite() {
  await check('control reading: two agreeing runs at 1.31 and 1.42 meet multiplier', async () => {
    const result = classify([run('a', 1.31), run('b', 1.42)]);
    assertEqual(result.arms['control-five'].criteria.multiplier.result, 'met', 'multiplier majority is met');
    assertEqual(result.arms['control-five'].criteria.multiplier.value, 1.31, 'the representative met value is retained');
    assertEqual(result.arms['control-five'].stopped, true, 'two agreeing accepted runs stop the arm');
  });

  await check('control reading: a window failing utilisation fails multiplier and peer fraction by named leg', async () => {
    const failed = { steady: false, reason: 'utilisation', failedLegs: [{ leg: 'utilisation', value: { value: 0.93, pass: false } }],
      legs: { utilisation: { value: 0.93, pass: false }, downloadRatio: { pass: true }, realtime: { pass: true } } };
    const result = classify([run('a', 1.31, { steady: failed }), run('b', 1.42, { steady: failed })]);
    const arm = result.arms['control-five'];
    assertEqual(arm.runs[0].classification.criteria.multiplier.result, 'failed', 'failed steady window fails multiplier');
    assertEqual(arm.runs[0].classification.criteria.multiplier.failedLeg.value, 0.93, 'failed leg value is published');
    assertEqual(arm.criteria.peerFraction.result, 'failed', 'failed steady window fails peer fraction');
  });

  await check('control reading: met and failed with a refused third attempt split the criterion', async () => {
    const result = classify([
      run('met', 1.31), run('failed', 1.70),
      run('refused', 1.31, { outcome: 'refused', writeByte: false }),
    ]);
    const criterion = result.arms['control-five'].criteria.multiplier;
    assertEqual(criterion.result, 'split', 'met and failed do not average');
    assertEqual(criterion.runs[0].result, 'met', 'split lists met');
    assertEqual(criterion.runs[1].result, 'failed', 'split lists failed');
    assertEqual(result.arms['control-five'].stopped, true, 'three attempts exhaust the arm');
  });

  await check('control reading: only another-build control gives no reading and names the rejected control', async () => {
    const otherBuild = control({ images: { ...IMAGES, client: 'sha256:client-b' } });
    const result = classify([run('a', 1.31), run('b', 1.42)], BASE_READING, [otherBuild]);
    const arm = result.arms['control-five'];
    assertEqual(arm.readingKey, 'none', 'another build gives no reading');
    assert(arm.control.candidates[0].rejected.includes('different-build'), 'rejected control is named');
  });

  // Prevention claim: a held start has an opportunity to resume at the action boundary.
  // Mutation: ignoring the resume cause and testing only waitMs makes the bound case pass;
  // the named red assertion is resume-bound, and restoring the cause check returns green.
  await check('control reading: a bound resume at 2000ms fails the wait', async () => {
    const result = classify([run('a', 1.31, { startHold: { waitMs: 2_000, cause: 'bound', resumed: true } }),
      run('b', 1.42, { startHold: { waitMs: 2_000, cause: 'bound', resumed: true } })]);
    assertEqual(result.arms['control-five'].criteria.startWait.result, 'failed', 'resume-bound');
    assertEqual(result.arms['control-five'].criteria.startWait.reason, 'resume-bound', 'bound cause is not met by waitMs alone');
  });

  // Prevention claim: supplied engine inputs have an opportunity at the product-input boundary.
  // Mutation: skipping this refusal classifies the supplied run; the named red assertion is refused,
  // and restoring it leaves the run unclassified and refused.
  await check('control reading: a supplied fraction is refused before classification', async () => {
    const entry = run('supplied', 1.31, { headroom: { fraction: 0.85, supplied: true, available: true } });
    const result = classifyControlRun(entry, BASE_READING);
    assertEqual(result.productInput.refused, true, 'supplied fraction is refused');
    assertEqual(Object.keys(result.criteria).length, 0, 'supplied run is not classified');
  });

  await check('control reading: recovery upper bound at 120000 meets and 180000 is unestablished', async () => {
    const atMost = classifyControlRun(run('at-most', 1.31, { recovery: recovery({
      recovered: true, recoveryMs: null, recoveryAtMostMs: 120_000,
    }) }), BASE_READING);
    const beyond = classifyControlRun(run('beyond', 1.31, { recovery: recovery({
      recovered: true, recoveryMs: null, recoveryAtMostMs: 180_000,
    }) }), BASE_READING);
    assertEqual(atMost.criteria.startRecovery.result, 'met', '120000ms upper bound meets');
    assertEqual(beyond.criteria.startRecovery.result, 'unestablished', '180000ms upper bound is unestablished');
  });

  await check('control reading: empty registry has no reading and does not throw', async () => {
    const result = classifyControlReading({ runs: [], reading: BASE_READING, armNames: ['control-five'] });
    assertEqual(result.arms['control-five'].readingKey, 'none', 'empty arm has no reading');
    assert(result.arms['control-five'].reasons.includes('accepted-run-count:0'), 'empty arm names count');
  });

  await check('control reading: sweep accepted positions publish spans, wait, recovery and queue figures', async () => {
    const reading = { kind: 'control', criteria: {}, published: [], sweep: true,
      acceptedRunsMin: 1, attemptsMax: 2, productInputs: false,
      control: { condition: 'p2p-scattered', peerFractionMin: 0.5 } };
    const entry = run('sweep', 1.31, { sweep: [{ window: { startMs: 0, endMs: 60_000 },
      standingQueueDelayMsP50NearestRank: 12 }], condition: 'sweep-unpaced' });
    const result = classifyControlReading({ runs: [entry, control()], reading, armNames: ['sweep-unpaced'] });
    assertEqual(result.arms['sweep-unpaced'].readingKey, 'published', 'sweep is published, not voted');
    assertEqual(result.arms['sweep-unpaced'].sweep[0].sweep[0].standingQueueDelayMsP50NearestRank, 12, 'queue delay is published');
  });

  await check('control reading: registered bars are loaded by condition name', async () => {
    const file = path.resolve(process.cwd(), 'harness', 'conditions.json');
    const conditions = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bars = {
      'control-five': { multiplier: 1.5, peerFraction: 0.60, startWait: 3_000, startRecovery: 120_000 },
      'control-ten': { multiplier: 2.0 },
      'control-seek': { seekWait: 3_000, seekRecovery: 120_000 },
      'sweep-070': {}, 'sweep-095': {}, 'sweep-unpaced': {},
    };
    const metadata = {
      'control-five': { productInputs: true, acceptedRunsMin: 2, attemptsMax: 3 },
      'control-ten': { productInputs: true, acceptedRunsMin: 2, attemptsMax: 3 },
      'control-seek': { productInputs: true, acceptedRunsMin: 2, attemptsMax: 3 },
      'sweep-070': { productInputs: false, acceptedRunsMin: 1, attemptsMax: 2 },
      'sweep-095': { productInputs: false, acceptedRunsMin: 1, attemptsMax: 2 },
      'sweep-unpaced': { productInputs: false, acceptedRunsMin: 1, attemptsMax: 2 },
    };
    for (const [name, expected] of Object.entries(bars)) {
      const condition = findCondition(conditions, name);
      assert(condition, `${name} is registered in harness/conditions.json`);
      const reading = condition.reading;
      assertEqual(reading?.kind, 'control', `${name} reading kind`);
      assertEqual(reading?.productInputs, metadata[name].productInputs, `${name} product-input gate`);
      assertEqual(reading?.spanMs, 60_000, `${name} span`);
      assertEqual(reading?.spanEdgeSegments, 1, `${name} edge segments`);
      assertEqual(reading?.acceptedRunsMin, metadata[name].acceptedRunsMin, `${name} accepted-run minimum`);
      assertEqual(reading?.attemptsMax, metadata[name].attemptsMax, `${name} attempts maximum`);
      assertEqual(reading?.control?.condition, 'p2p-scattered', `${name} control condition`);
      assertEqual(reading?.control?.peerFractionMin, 0.5, `${name} control floor`);
      for (const [criterion, key] of Object.entries({ multiplier: 'max', peerFraction: 'min', startWait: 'maxMs',
        startRecovery: 'maxMs', seekWait: 'maxMs', seekRecovery: 'maxMs' })) {
        if (!(criterion in expected)) continue;
        assertEqual(condition.reading.criteria?.[criterion]?.[key], expected[criterion], `${name} ${criterion} bar`);
      }
    }
  });

  await check('control reading: missing criterion bars are a hard load error', async () => {
    let thrown = null;
    try { validateControlReading({ ...BASE_READING, criteria: { multiplier: {} } }); } catch (error) { thrown = error; }
    assert(thrown?.message.includes('control-reading-bar-missing:multiplier:max'), 'missing bar is not a vacuous pass');
  });

  await check('control reading: baseline cells require a same-build accepted baseline', async () => {
    const baseline = run('baseline', 1.2, { condition: 'baseline-nop2p-steady' });
    const arm = control();
    const matching = baselineTable({ runs: [baseline], controlRuns: { 'control-five': arm } });
    assertEqual(matching['control-five'].cells.sameBuildBaseline.source, 'baseline', 'same-build baseline is retained');
    const mismatched = baselineTable({ runs: [run('other', 1.2, { condition: 'baseline-nop2p-steady', images: { ...IMAGES, client: 'sha256:other' } })],
      controlRuns: { 'control-five': arm } });
    assertEqual(mismatched['control-five'].cells.sameBuildBaseline.reason, 'baseline-build-mismatch', 'mismatched baseline is named');
  });
}
