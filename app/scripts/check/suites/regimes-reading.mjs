import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { classifyRegimesReading, computeViewerUploadRates } from '../../figures/regimes-reading.mjs';

const BUILD = { c00: { role: 'host', buildId: null }, c01: { buildId: 'build-a' }, c02: { buildId: 'build-a' } };
const steady = { steady: true, reason: null, legs: {
  utilisation: { value: 0.8, pass: true },
  downloadRatio: { byClient: { c01: 1, c02: 1 }, pass: true },
  realtime: { byClient: { c01: 1, c02: 1 }, pass: true },
} };
const reading = {
  figure: 'median',
  reading1: { peerFractionMin: 0.6, multiplierMax: 1.5 },
  reading2: { peerFractionBelow: 0.55, multiplierAbove: 1.65 },
  marginPeerFraction: 0.05,
  marginMultiplier: 0.15,
  eligibleRunsMin: 2,
  eligibleRunsMax: 3,
  control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};

function run(directory, peerFraction, multiplier, overrides = {}) {
  return {
    directory,
    condition: overrides.condition ?? 'regimes-limited-shaped',
    outcome: overrides.outcome ?? 'complete',
    publishes: overrides.publishes ?? true,
    manifest: { clients: overrides.builds ?? BUILD },
    report: {
      publishedByte: overrides.publishedByte ?? { published: true },
      figures: {
        peerFractionAggregate: peerFraction,
        hostUploadMultiplier: multiplier,
        hostFetchOnceRatio: overrides.hostFetchOnceRatio ?? 1.1,
        steadyState: overrides.steadyState ?? steady,
      },
    },
  };
}

function control(peerFraction = 0.5, overrides = {}) {
  return run('control', peerFraction, null, { ...overrides, condition: 'p2p-scattered' });
}

function classify(runs, controls = [control()]) {
  return classifyRegimesReading({ reading, runs: [...runs, ...controls] });
}

export default async function regimesReadingSuite() {
  await check('regimes reading: viewer upload diagnostics divide boundary bytes by window seconds and retain the link rate', async () => {
    const rates = computeViewerUploadRates({
      manifest: {
        window: { startMs: 1_000, endMs: 5_000 },
        clients: { c01: {} },
        topology: { probePaths: { c01: { peerLinkRateBitsPerSecond: 10_000_000 } } },
      },
      boundaryStart: { clients: { c01: { uploadBytes: { peerA: 100, peerB: 200 } } } },
      boundaryEnd: { clients: { c01: { uploadBytes: { peerA: 1_100, peerB: 700 } } } },
    });
    assertEqual(rates.c01.uploadBytes, 1_500, 'upload delta sums peers');
    assertEqual(rates.c01.uploadRateBitsPerSecond, 3_000, 'upload rate uses four-second window');
    assertEqual(rates.c01.peerLinkRateBitsPerSecond, 10_000_000, 'upload diagnostic retains link rate');
  });

  await check('regimes reading: no reading requires the minimum eligible count or a qualifying control', async () => {
    assertEqual(classify([run('one', 0.8, 1.2)]).reading, 'No reading', 'one eligible run is no reading');
    assertEqual(classify([run('a', 0.8, 1.2), run('b', 0.8, 1.2)], [control(0.49)]).reading,
      'No reading', 'a control below the floor is no reading');
  });

  await check('regimes reading: a two-run figure uses the arithmetic mean and Reading 1 accepts its edge', async () => {
    const result = classify([run('a', 0.6, 1), run('b', 0.8, 2)]);
    assertEqual(result.reading, 'Reading 1', 'median of two runs reads Reading 1');
    assertNear(result.medians.peerFractionAggregate, 0.7, 0, 'two-run peer fraction is the mean');
    assertNear(result.medians.hostUploadMultiplier, 1.5, 0, 'two-run multiplier is the mean');
    const edge = classify([run('edge-a', 0.6, 1.5), run('edge-b', 0.6, 1.5)]);
    assertEqual(edge.reading, 'Reading 1', 'peer fraction 0.60 and multiplier 1.50 are Reading 1');
  });

  await check('regimes reading: margin boundaries distinguish Reading 2 from Reading 3', async () => {
    const boundary = classify([run('boundary-a', 0.55, 1.65), run('boundary-b', 0.55, 1.65)]);
    assertEqual(boundary.reading, 'Reading 3', 'peer fraction 0.55 and multiplier 1.65 are Reading 3');
    const beyond = classify([run('beyond-a', 0.5499, 1.5), run('beyond-b', 0.5499, 1.5)]);
    assertEqual(beyond.reading, 'Reading 2', 'peer fraction 0.5499 is Reading 2');
    const highMultiplier = classify([run('high-a', 0.6, 1.6501), run('high-b', 0.6, 1.6501)]);
    assertEqual(highMultiplier.reading, 'Reading 2', 'multiplier above 1.65 is Reading 2');
  });

  await check('regimes reading: a failed steady-state leg is listed but does not vote', async () => {
    const refused = run('refused', 0.99, null, {
      steadyState: { steady: false, reason: 'steady-state-utilisation', legs: { utilisation: { value: 0.91, pass: false } } },
    });
    const result = classify([refused, run('accepted-a', 0.6, 1.1), run('accepted-b', 0.6, 1.1)]);
    assertEqual(result.eligibleCount, 2, 'the failed leg is excluded from eligible runs');
    assertEqual(result.runs.find((entry) => entry.directory === 'refused').refusal.reason,
      'steady-state-utilisation', 'the refusal names its failed leg');
    assertEqual(result.runs.find((entry) => entry.directory === 'refused').hostFetchOnceRatio, 1.1,
      'the refused run retains hostFetchOnceRatio');
    assertEqual(result.reading, 'Reading 1', 'the two passing runs classify');
  });

  await check('regimes reading: the control can fail steady state and still qualify, but a build mismatch cannot', async () => {
    const notSteady = control(0.51, { steadyState: { steady: false, reason: 'steady-state-utilisation', legs: {} } });
    const result = classify([run('a', 0.6, 1.2), run('b', 0.6, 1.2)], [notSteady]);
    assertEqual(result.reading, 'Reading 1', 'control floor qualifies independently of steady state');
    const mismatch = classify([run('a', 0.6, 1.2), run('b', 0.6, 1.2)],
      [control(0.51, { builds: { c01: { buildId: 'build-b' }, c02: { buildId: 'build-b' } } })]);
    assertEqual(mismatch.reading, 'No reading', 'a control on another build is rejected');
  });

  await check('regimes reading: thresholds come only from the registered block', async () => {
    for (const [label, block] of [['absent', undefined], ['missing a margin', { ...reading, marginMultiplier: undefined }]]) {
      let error;
      try {
        classifyRegimesReading({ reading: block, runs: [] });
      } catch (caught) {
        error = caught;
      }
      assertEqual(error?.message, 'reading-thresholds-invalid', `a block ${label} is refused, not defaulted`);
    }
  });

  await check('regimes reading: more eligible runs than the stopping rule permits is a hard error', async () => {
    let error;
    try {
      classify([run('a', 0.6, 1), run('b', 0.6, 1), run('c', 0.6, 1), run('d', 0.6, 1)]);
    } catch (caught) {
      error = caught;
    }
    assertEqual(error?.message, 'eligible-run-count-exceeds-max', 'the stopping rule is fail-closed');
  });
}
