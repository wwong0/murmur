import { assert, assertEqual, check } from '../harness.mjs';
import * as controlReading from '../../figures/control-reading.mjs';
import * as regimesReading from '../../figures/regimes-reading.mjs';
import * as trapReading from '../../figures/trap-reading.mjs';

const IMAGES = { origin: 'o1', client: 'c1' };
const READING = {
  kind: 'control', productInputs: false, acceptedRunsMin: 2, attemptsMax: 3,
  criteria: { multiplier: { max: 1.5 } },
  control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};
const REGIME_READING = {
  figure: 'median', reading1: { peerFractionMin: 0.6, multiplierMax: 1.5 },
  reading2: { peerFractionBelow: 0.55, multiplierAbove: 1.65 },
  marginPeerFraction: 0.05, marginMultiplier: 0.15, eligibleRunsMin: 2, eligibleRunsMax: 3,
  control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};
const TRAP_READING = {
  kind: 'trap', behindHeldAheadMsBelow: 15_000, reproducedPeerFractionMax: 0.1,
  notReproducedPeerFractionMin: 0.5, scatteredSpreadMsAbove: 4_000,
  acceptedRunsMin: 2, attemptsMax: 3, control: { condition: 'p2p-scattered', peerFractionMin: 0.5 },
};

function ids(count, value = 'A', missing = 0) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`c${String(index + 1).padStart(2, '0')}`, {
    role: 'viewer', buildId: index < missing ? null : value, peerId: `p${index + 1}`,
  }]));
}

function entry({ count = 5, value = 'A', missing = 0, images = IMAGES, condition = 'arm', peer = 0.8,
  multiplier = 1.1, control = false, figureKind = 'control' } = {}) {
  const clients = ids(count, value, missing);
  if (control) clients.c00 = { role: 'host', buildId: null };
  const manifest = {
    clients, topology: { regime: { images }, boundaries: {
      start: { readback: { refusals: [] } }, end: { readback: { refusals: [] } },
    } },
  };
  return {
    directory: `${condition}-${value}-${count}`,
    condition, outcome: 'complete', publishes: true,
    finalization: { writeByte: true }, manifest,
    report: { publishedByte: { published: true }, figures: {
      peerFractionAggregate: peer, peerFractionByClient: Object.fromEntries(Object.keys(clients)
        .filter((tag) => tag !== 'c00').map((tag) => [tag, peer])),
      hostUploadMultiplier: multiplier,
      steadyState: { steady: true, reason: null, legs: {} },
      ...(figureKind === 'trap' ? {
        peerFractionAggregate: peer, heldAheadMsRoomMedian: 1_000, positionSpreadMsMedian: 1_000,
      } : {}),
    } },
  };
}

function buildMatch(left, right) {
  return typeof regimesReading.buildMatch === 'function' ? regimesReading.buildMatch(left, right) : null;
}

function controlRun(options = {}) {
  return entry({ ...options, condition: options.condition ?? 'p2p-scattered', control: true });
}

export default async function buildMatchSuite() {
  await check('build match: ten viewers A against five viewers A share images and build', async () => {
    const result = buildMatch(entry({ count: 10 }), entry({ count: 5 }));
    assertEqual(result?.same, true, 'same build and images pass');
    assertEqual(result?.matchedOn, 'build-id-and-images', 'build ids and images are named');
  });

  await check('build match: missing viewer ids fall back to images', async () => {
    const result = buildMatch(entry({ missing: 5 }), entry({ count: 5 }));
    assertEqual(result?.same, true, 'image-only match is same');
    assertEqual(result?.matchedOn, 'images', 'image-only match is labelled');
  });

  await check('build match: different ids refuse while different images refuse first', async () => {
    const idsDiffer = buildMatch(entry(), entry({ value: 'B' }));
    assertEqual(idsDiffer?.same, false, 'different build ids are not same');
    assertEqual(idsDiffer?.reason, 'different-build-id', 'different ids have a named reason');
    const imagesDiffer = buildMatch(entry(), entry({ images: { ...IMAGES, client: 'c2' } }));
    assertEqual(imagesDiffer?.reason, 'different-images', 'different images take precedence');
  });

  await check('build match: a partial viewer id is unestablished', async () => {
    const result = buildMatch(entry({ missing: 1 }), entry());
    assertEqual(result?.same, null, 'partial ids are not a difference');
    assertEqual(result?.reason, 'build-id-partial', 'partial ids have a named reason');
  });

  await check('build match: no image pair is unavailable', async () => {
    const result = buildMatch(entry({ images: null }), entry());
    assertEqual(result?.same, null, 'missing images are unestablished');
    assertEqual(result?.reason, 'images-unavailable', 'missing images have a named reason');
  });

  await check('build match: control reading accepts a ten-viewer arm and five-viewer control on one build', async () => {
    const arm = [entry({ count: 10, condition: 'control-five' }), entry({ count: 10, condition: 'control-five' })];
    const result = controlReading.classifyControlReading({
      runs: [...arm, controlRun()], reading: READING, armNames: ['control-five'],
    });
    const control = result.arms['control-five'].control;
    assertEqual(control?.selected?.qualifies, true, 'same build control qualifies');
    assertEqual(control?.selected?.sameBuildAsArm, true, 'control matches every arm run');
  });

  await check('build match: control on build B is rejected and the arm has no reading', async () => {
    const runs = [entry({ count: 10, condition: 'control-five' }), entry({ count: 10, condition: 'control-five' }),
      controlRun({ value: 'B' })];
    const result = controlReading.classifyControlReading({ runs, reading: READING, armNames: ['control-five'] });
    assertEqual(result.arms['control-five'].readingKey, 'none', 'different-build control gives no reading');
    assert(result.arms['control-five'].control.candidates[0].rejected.includes('different-build'),
      'different-build rejection is named');
  });

  await check('build match: baseline cells retain an image-only match and name mismatch', async () => {
    const arm = entry({ condition: 'control-five' });
    const imageOnly = entry({ condition: 'baseline-nop2p-steady', missing: 5 });
    const matching = controlReading.baselineTable({ runs: [imageOnly], controlRuns: { 'control-five': arm } });
    assertEqual(matching['control-five'].cells.sameBuildBaseline.multiplier, 1.1, 'image-only baseline is retained');
    assertEqual(matching['control-five'].cells.sameBuildBaseline.matchedOn, 'images', 'baseline match is labelled');
    const mismatched = controlReading.baselineTable({
      runs: [entry({ condition: 'baseline-nop2p-steady', images: { ...IMAGES, client: 'c2' } })],
      controlRuns: { 'control-five': arm },
    });
    assertEqual(mismatched['control-five'].cells.sameBuildBaseline.reason, 'baseline-build-mismatch',
      'different baseline images are named');
  });

  await check('build match: image-only controls do not qualify regimes or trap readings', async () => {
    // Each pair differs in the control's build ids alone: five 'A' against none.
    const arm = [entry({ condition: 'regimes-limited-shaped' }), entry({ condition: 'regimes-limited-shaped' })];
    const regime = (control) => regimesReading.classifyRegimesReading({ runs: [...arm, control], reading: REGIME_READING });
    assert(regime(controlRun()).readingKey !== 'none', 'a control on the same build id gives the regimes a reading');
    assertEqual(regime(controlRun({ missing: 5 })).readingKey, 'none', 'regimes requires build ids');
    const trapArm = [entry({ condition: 'trap-seek', figureKind: 'trap' }), entry({ condition: 'trap-seek', figureKind: 'trap' })];
    const trap = (control) => trapReading.classifyTrapReading({ runs: [...trapArm, control], reading: TRAP_READING });
    assert(trap(controlRun({ figureKind: 'trap' })).readingKey !== 'not-reproduced-within-budget',
      'a control on the same build id gives the trap a reading');
    assertEqual(trap(controlRun({ figureKind: 'trap', missing: 5 })).readingKey, 'not-reproduced-within-budget',
      'trap has no reading without build ids');
  });
}
