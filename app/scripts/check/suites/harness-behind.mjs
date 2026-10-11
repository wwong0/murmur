import { assert, assertEqual, check } from '../harness.mjs';
import { behindReading, resyncAfter } from '../../figures/behind.mjs';

const disturbance = (pauseMs, injected = true) => ({
  injected,
  pauseCallLocalMs: 0,
  playResolvedLocalMs: 1000,
  observationMs: 90000,
});

const condition = (caseName, pauseMs = caseName === 'inside' ? 400 : 1500) => ({
  clients: 5,
  disturbance: { pauseMs },
  behind: caseName === 'inside'
    ? { case: 'inside', settleAllowanceMs: 11500, saturatedMinPolls: 80 }
    : { case: 'past', skipDecisionMaxMs: 4000, abandonedToleranceMs: 300, startLatenessMaxMs: 600,
      resync: { windowMs: 1000, medianMaxMs: 40, holdMs: 30000, maxMs: 2000 } },
});

const correcting = (atMs, overrides = {}) => ({ atMs, controller: {
  mode: 'correcting', rate: 1.01, estimateMs: -100, bandMs: 40, fastestCloseMs: 50000, ...overrides,
} });

function insidePolls(count, edit = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    ...correcting(1000 + index * 125),
    ...edit(index),
  }));
}

function pastPolls({ count = 2, abandoned = -1500, finalSkips = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    atMs: 1000 + index * 125,
    playback: { skips: index === count - 1 ? finalSkips : 0, lastSkipAbandonedMs: index === count - 1 ? abandoned : null, opens: 2, begun: 2, retargets: 0, reparks: 0 },
    controller: { rate: 1, mode: 'settled' },
  }));
}

function row(reading, name) {
  return reading.find((candidate) => candidate.row === name);
}

export default async function harnessBehindSuite() {
  await check('behind figures: the saturated inside run keeps unity out for the whole 1.01 stretch', async () => {
    const reading = behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls: insidePolls(100), records: [] });
    assertEqual(row(reading, 'B2').status, 'met', '100 polls at 1.01 meet the inside stretch');
    assertEqual(row(reading, 'B2').saturatedPolls, 100, 'the whole stretch is counted');
  });

  await check('behind figures: one unity poll names the poll and turns the stretch missed', async () => {
    const reading = behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls: insidePolls(100, (index) => index === 37 ? { controller: { rate: 1 } } : {}), records: [] });
    assertEqual(row(reading, 'B2').status, 'missed', 'a unity poll misses the inside bar');
    assertEqual(row(reading, 'B2').firstNonUnityPollAtMs, 1000 + 37 * 125, 'the mutation is named by its poll');
  });

  await check('behind figures: fewer than 80 saturated polls is not exercised', async () => {
    const reading = behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls: insidePolls(79), records: [] });
    assertEqual(row(reading, 'B2').status, 'not-exercised', '79 polls do not establish the stretch');
    assertEqual(row(reading, 'B2').saturatedPolls, 79, 'the short stretch is still reported');
  });

  await check('behind figures: settling allowance is inclusive and two-sided', async () => {
    for (const [offset, expected] of [[61500, 'met'], [61501, 'missed']]) {
      const polls = [...insidePolls(80), { atMs: 1000 + offset, controller: { mode: 'settled', rate: 1, estimateMs: 0, bandMs: 1, fastestCloseMs: 50000 } }];
      assertEqual(row(behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls, records: [] }), 'B3').status, expected, `settling at bound + ${offset - 50000}ms is ${expected}`);
    }
    const noSettled = behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls: insidePolls(80), records: [] });
    assertEqual(row(noSettled, 'B3').status, 'missed', 'no settled poll is missed, not absent');
  });

  await check('behind figures: skip cardinality and inside no-skip are separate bars', async () => {
    for (const [count, expected] of [[0, 'missed'], [1, 'met'], [2, 'missed']]) {
      const polls = pastPolls({ finalSkips: count });
      assertEqual(row(behindReading({ condition: condition('past'), disturbance: disturbance(1500), polls, records: [], starts: [] }), 'B5').status, expected, `${count} past skips is ${expected}`);
    }
    const inside = behindReading({ condition: condition('inside'), disturbance: disturbance(400), polls: [
      { atMs: 1000, playback: { skips: 0 } }, { atMs: 1100, playback: { skips: 1 } },
    ], records: [] });
    assertEqual(row(inside, 'B4').status, 'missed', 'an inside skip misses the no-skip bar');
  });

  await check('behind figures: abandoned difference is bounded at both tolerance edges', async () => {
    for (const [abandoned, expected] of [[-1800, 'met'], [-1801, 'missed'], [-1200, 'met'], [-1199, 'missed']]) {
      const reading = behindReading({ condition: condition('past'), disturbance: disturbance(1500), polls: pastPolls({ abandoned }), records: [], starts: [] });
      assertEqual(row(reading, 'B5').status, expected, `${abandoned}ms abandoned drift is ${expected}`);
    }
  });

  await check('behind figures: resync needs a sustained window, not a transient dip', async () => {
    const samples = [0, 500, 1000, 1500, 2000].map((atMs, index) => ({ atMs, driftMs: index % 2 ? 10 : 60 }));
    assertEqual(resyncAfter({ firstFrameSharedMs: 0, pairs: [samples, samples], windowMs: 1000, medianMaxMs: 40, holdMs: 2000 }), null, 'a dip that leaves the bar before settling is null');
  });

  await check('behind figures: a counted skip without a starts entry is evidence failure', async () => {
    const reading = behindReading({ condition: condition('past'), disturbance: disturbance(1500), polls: pastPolls(), records: [], starts: [] });
    assertEqual(row(reading, 'B5').status, 'met', 'the counted skip is otherwise valid');
    assertEqual(row(reading, 'B6').status, 'evidence-failure', 'the missing starts entry is not not-exercised');
  });

  await check('behind figures: no injection is not exercised', async () => {
    const reading = behindReading({ condition: condition('inside'), disturbance: disturbance(400, false), polls: insidePolls(100), records: [] });
    assert(reading.filter((candidate) => candidate.status === 'not-exercised').length >= 4, 'no injection makes the inside rows not exercised');
  });
}
