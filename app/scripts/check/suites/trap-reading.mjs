import { assert, assertEqual, check } from '../harness.mjs';
import { classifyTrapReading } from '../../figures/trap-reading.mjs';

const IMAGES = { origin: 'sha256:origin-a', client: 'sha256:client-a' };
const reading = {
  kind: 'trap', behindHeldAheadMsBelow: 15_000, reproducedPeerFractionMax: 0.10,
  notReproducedPeerFractionMin: 0.50, scatteredSpreadMsAbove: 4_000,
  acceptedRunsMin: 2, attemptsMax: 3,
  control: { condition: 'p2p-scattered', peerFractionMin: 0.50 },
};

function run(directory, peerFraction, heldAhead, spread, overrides = {}) {
  return {
    directory,
    condition: overrides.condition ?? 'trap-seek',
    outcome: overrides.outcome ?? 'complete',
    publishes: overrides.publishes ?? true,
    finalization: { writeByte: overrides.writeByte ?? true },
    manifest: {
      clients: overrides.builds ?? { c01: { buildId: 'build-a' }, c02: { buildId: 'build-a' } },
      topology: { regime: { images: overrides.images ?? IMAGES } },
    },
    report: { figures: { peerFractionAggregate: peerFraction,
      heldAheadMsRoomMedian: heldAhead, positionSpreadMsMedian: spread } },
  };
}

function control(overrides = {}) {
  return run('control', 0.80, 5_000, 8_000, { ...overrides, condition: 'p2p-scattered' });
}

function classify(runs, controls = [control()]) {
  return classifyTrapReading({ reading, runs: [...runs, ...controls] });
}

export default async function trapReadingSuite() {
  await check('trap reading: behind low sharing is reproduced and behind middle sharing is partial', async () => {
    const result = classify([run('a', 0.05, 6_000, 100), run('b', 0.30, 6_000, 100)]);
    assertEqual(result.arms['trap-seek'].runs[0].class, 'reproduced', 'low sharing is T1');
    assertEqual(result.arms['trap-seek'].runs[1].class, 'partial', 'middle sharing is T2');
    assertEqual(result.reading, 'split', 'different classes do not average');
  });

  await check('trap reading: an escaped room is not reproduced whatever its peer fraction', async () => {
    const result = classify([run('a', 0.05, 40_000, 100), run('b', 0.05, 40_000, 100)]);
    assertEqual(result.arms['trap-seek'].readingKey, 't3', 'ahead room reads T3');
    assertEqual(result.arms['trap-seek'].label, 'escaped', 'ahead room is escaped');
  });

  await check('trap reading: the worse arm decides and a one-run arm has no reading', async () => {
    const runs = [run('a', 0.05, 6_000, 100, { condition: 'trap-seek' }),
      run('b', 0.05, 6_000, 100, { condition: 'trap-seek' }),
      run('c', 0.80, 6_000, 100, { condition: 'trap-seek-short' })];
    const result = classify(runs);
    assertEqual(result.readingKey, 't1', 'reproduced arm is the most severe reading');
    assertEqual(result.arms['trap-seek-short'].reading, 'No reading', 'one run names no reading');
  });

  await check('trap reading: the most severe voting arm decides whichever arm is listed first', async () => {
    const t3 = [run('a', 0.80, 6_000, 100, { condition: 'trap-seek' }), run('b', 0.80, 6_000, 100, { condition: 'trap-seek' })];
    const t1 = [run('c', 0.05, 6_000, 100, { condition: 'trap-seek-short' }), run('d', 0.05, 6_000, 100, { condition: 'trap-seek-short' })];
    const t2 = [run('e', 0.30, 6_000, 100, { condition: 'trap-seek' }), run('f', 0.30, 6_000, 100, { condition: 'trap-seek' })];
    const split = [run('g', 0.05, 6_000, 100, { condition: 'trap-seek-short' }), run('h', 0.80, 6_000, 100, { condition: 'trap-seek-short' })];
    assertEqual(classify([...t3, ...t1]).readingKey, 't1', 'T1 outranks an earlier T3 arm');
    assertEqual(classify([...t2, ...split]).readingKey, 'split', 'split outranks an earlier T2 arm');
  });

  await check('trap reading: T3 labels tie to scattered and a two-to-one label majority wins', async () => {
    const tie = classify([run('escaped', 0.60, 20_000, 100), run('sync', 0.60, 10_000, 100)]);
    assertEqual(tie.arms['trap-seek'].readingKey, 't3', 'T3 class wins over label disagreement');
    assertEqual(tie.arms['trap-seek'].label, 'scattered', 'label tie carries scattered consequence');
    assertEqual(tie.arms['trap-seek'].labels.length, 2, 'both T3 labels are listed');
    const majority = classify([run('escaped-a', 0.60, 20_000, 100), run('escaped-b', 0.60, 20_000, 100),
      run('scattered', 0.60, 10_000, 5_000)]);
    assertEqual(majority.arms['trap-seek'].label, 'escaped', 'two escaped labels win');
  });

  await check('trap reading: a three-run class majority is two-to-one', async () => {
    const result = classify([run('one', 0.05, 6_000, 100), run('two', 0.05, 6_000, 100),
      run('three', 0.60, 6_000, 100)]);
    assertEqual(result.arms['trap-seek'].readingKey, 't1', 'class majority reads T1');
  });

  await check('trap reading: both arms without a reading report not reproduced within budget', async () => {
    const result = classify([run('short', 0.05, 6_000, 100, { condition: 'trap-seek-short' })], []);
    assertEqual(result.reading, 'not reproduced within budget', 'no arm votes without a control and count');
  });

  await check('trap reading: runner files, not the registry label, decide acceptance', async () => {
    const result = classify([run('a', 0.05, 6_000, 100), run('b', 0.05, 6_000, 100),
      run('withheld', 0.05, 6_000, 100, { outcome: 'complete', writeByte: false })]);
    assertEqual(result.arms['trap-seek'].acceptedCount, 2, 'withheld run does not vote');
    assertEqual(result.arms['trap-seek'].readingKey, 't1', 'registry label cannot admit a withheld run');
  });

  await check('trap reading: another rig cannot serve as the control', async () => {
    const result = classify([run('a', 0.05, 6_000, 100), run('b', 0.05, 6_000, 100)],
      [control({ images: { ...IMAGES, client: 'sha256:client-b' } })]);
    assertEqual(result.arms['trap-seek'].reading, 'No reading', 'other rig control is refused');
  });

  await check('trap reading: threshold boundaries stay on their registered sides', async () => {
    const low = classify([run('low-a', 0.10, 14_999, 4_000), run('low-b', 0.10, 14_999, 4_000)]);
    assertEqual(low.arms['trap-seek'].readingKey, 't1', 'peer fraction exactly 0.10 is T1');
    const high = classify([run('high-a', 0.50, 14_999, 4_000), run('high-b', 0.50, 14_999, 4_000)]);
    assertEqual(high.arms['trap-seek'].readingKey, 't3', 'peer fraction exactly 0.50 is T3');
    const ahead = classify([run('ahead-a', 0.10, 15_000, 4_000), run('ahead-b', 0.10, 15_000, 4_000)]);
    assertEqual(ahead.arms['trap-seek'].label, 'escaped', 'held-ahead exactly 15 seconds is not behind');
  });

  // Mutation proof: replacing class majority with an arm mean makes this split
  // case read partial, so the assertion observes the prevention boundary.
  await check('trap reading: mutation to arm means is caught by the split boundary', async () => {
    const result = classify([run('t1', 0.05, 6_000, 100), run('t3', 0.60, 6_000, 100)]);
    assertEqual(result.arms['trap-seek'].readingKey, 'split', 'class majority is not a mean');
    assert(result.arms['trap-seek'].reading !== 'partial', 'mean mutation would be red here');
  });
}
