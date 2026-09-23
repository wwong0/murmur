import { assert, assertEqual, check } from '../harness.mjs';
import { FROZEN_BASELINE, judgeHostOrigin } from '../../figures/host-origin-bars.mjs';

const TAGS = Object.keys(FROZEN_BASELINE.realtimeFactorByClient);

function figure({ utilisation = FROZEN_BASELINE.uplinkUtilisationMean, factors = Object.values(FROZEN_BASELINE.realtimeFactorByClient), waste = 0, peer = 0, agreement = 0 } = {}) {
  return {
    uplinkUtilisationMean: utilisation,
    realtimeFactorByClient: Object.fromEntries(TAGS.map((tag, index) => [tag, factors[index] ?? factors.at(-1)])),
    originWasteFraction: waste,
    hostUploadMultiplier: FROZEN_BASELINE.hostUploadMultiplier,
    peerByteFractionByClient: Object.fromEntries(TAGS.map((tag) => [tag, peer])),
    originVsClientBytesByClient: Object.fromEntries(TAGS.map((tag) => [tag, { differenceFraction: agreement }])),
  };
}

const baseline = figure();
const fast = figure({ factors: [1, 1, 1, 1, 1] });
const slow = figure({ factors: [0.8, 0.8, 0.8, 0.8, 0.8] });

function expectError(fn, includes) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert(error, `expected an error containing ${includes}`);
  assert(error.message.includes(includes), `error names ${includes}`);
}

export default async function hostOriginBarsSuite() {
  await check('host-origin bars: frozen baseline passes every bar', async () => {
    const result = judgeHostOrigin({ baseline, capped: baseline, uncapped: fast });
    assertEqual(result.baselineVerified, true, 'baseline is verified');
    for (const name of ['B1', 'B2', 'B3', 'B4', 'B5']) assertEqual(result.bars[name].pass, true, `${name} passes`);
    assertEqual(result.routing, 'capped-pass', 'passing capped arm routes to record');
  });

  await check('host-origin bars: spike collapse fails utilisation and realtime', async () => {
    const result = judgeHostOrigin({ baseline, capped: figure({ utilisation: 0.22, factors: [0.22, 0.22, 0.22, 0.22, 0.22] }), uncapped: fast });
    assertEqual(result.bars.B1.pass, false, 'collapse fails B1');
    assertEqual(result.bars.B2.pass, false, 'collapse fails B2');
  });

  await check('host-origin bars: one starved viewer fails its own-median floor', async () => {
    const result = judgeHostOrigin({ baseline, capped: figure({ factors: [0.7, 0.7, 0.7, 0.7, 0.6] }), uncapped: fast });
    assertEqual(result.bars.B2.pass, true, 'the median clears B2');
    assertEqual(result.bars.B3.pass, false, 'the minimum fails B3');
  });

  await check('host-origin bars: routing covers refusal, owner decision, ceiling and pass', async () => {
    assertEqual(judgeHostOrigin({ baseline, capped: { ...baseline, status: 'refused' }, uncapped: fast }).routing, 'instrument-refusal', 'refusal route');
    assertEqual(judgeHostOrigin({ baseline, capped: figure({ utilisation: 0.8 }), uncapped: fast }).routing, 'owner-decision', 'fast uncapped route');
    assertEqual(judgeHostOrigin({ baseline, capped: figure({ utilisation: 0.8 }), uncapped: slow }).routing, 'transport-ceiling', 'slow uncapped route');
    assertEqual(judgeHostOrigin({ baseline, capped: baseline, uncapped: slow }).routing, 'capped-pass', 'passing capped route');
  });

  await check('host-origin bars: any verified baseline drift is refused', async () => {
    expectError(() => judgeHostOrigin({ baseline: { ...baseline, hostUploadMultiplier: 99 }, capped: baseline, uncapped: fast }), 'hostUploadMultiplier');
    expectError(() => judgeHostOrigin({ baseline: { ...baseline, realtimeFactorByClient: { ...baseline.realtimeFactorByClient, c03: 0.7 } }, capped: baseline, uncapped: fast }), 'realtimeFactorByClient.c03');
  });
}
