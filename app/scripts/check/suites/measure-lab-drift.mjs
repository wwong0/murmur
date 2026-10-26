import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { labDrift } from '../../measure/lab-drift.mjs';

const tags = ['c01', 'c02'];
const span = { startedAt: '1970-01-01T00:00:00.000Z', runEndedAt: '1970-01-01T00:01:00.000Z' };

function record(L, mediaMs, offsetMs = 0, driftMs = 0, epochMs = 1) {
  return { displaySharedMs: L + offsetMs, mediaMs, driftMs, epochMs, clock: { offsetMs } };
}

function evidence({ records = {}, offsets = {}, polls = {}, frameRate = 10, window = { startMs: 0, endMs: 100 }, cadence = {} } = {}) {
  return { run: 'constructed', manifest: { ...span, window, cadence, content: { frameRate } }, condition: { positionOffsetMsByClient: offsets }, tags,
    hostPoll: [{ pageMs: 1_000.4, pageWallMs: 1_000 }, { pageMs: 2_000.4, pageWallMs: 2_000 }],
    clients: Object.fromEntries(tags.map((tag) => [tag, { drift: records[tag] ?? [], polls: polls[tag] ?? [{ atMs: 1_000.4, wallMs: 1_000 }, { atMs: 2_000.4, wallMs: 2_000 }] }])),
  };
}

export default async function measureLabDriftSuite() {
  await check('measurement lab drift: declared offsets are removed from the raw gap', async () => {
    const result = labDrift(evidence({ frameRate: 10, records: {
      c01: [record(0, 1), record(100, 101)], c02: [record(0, 501, 0, 0, -499), record(100, 601, 0, 0, -499)],
    }, offsets: { c02: 500 }, cadence: { c01: { presentIntervalMs: 10 }, c02: { presentIntervalMs: 10 } } }));
    const pair = result.pairs[0];
    assertEqual(pair.points, 1, 'an epoch moved back by the declared offset is the same epoch');
    assertEqual(pair.rawSignedMedianMs, -500, 'raw gap retains the declared offset');
    assertEqual(pair.signedMedianMs, 0, 'aligned gap is zero');
    assertEqual(pair.recordSignedMedianMs, 0, 'record gap is zero');
    assertEqual(result.timeBasis, 'lab-time', 'met timebase uses lab label');
    assertNear(pair.floorMs, 12, 0.001, 'met timebase adds its 2 ms bound');
  });

  await check('measurement lab drift: hidden clock difference and epoch exclusion', async () => {
    const result = labDrift(evidence({ records: {
      c01: [record(0, 1, 0, 0), record(100, 101, 0, 0)],
      c02: [record(0, 1, 30, 30), record(100, 101, 30, 30, 2)],
    }, window: { startMs: 0, endMs: 101 } }));
    const pair = result.pairs[0];
    assertEqual(pair.signedMedianMs, 0, 'clock offset does not change lab gap');
    assertEqual(pair.hiddenClockMs, 30, 'hidden clock difference is published');
    assertEqual(pair.epochMismatch, 1, 'epoch mismatch is counted');
    assertEqual(pair.points, 1, 'epoch mismatch is excluded from points');
  });

  await check('measurement lab drift: missing wall clocks are unestablished', async () => {
    const fixture = evidence({ records: { c01: [record(0, 0)], c02: [record(0, 0)] } });
    fixture.clients.c01.polls = [{ atMs: 100 }];
    fixture.clients.c02.polls = [{ atMs: 100 }];
    const result = labDrift(fixture);
    assertEqual(result.timebaseCheck.status, 'unestablished', 'wall clock absence is named');
    assertEqual(result.timeBasis, 'reconstructed-lab-time', 'unestablished timebase stays reconstructed');
  });

  await check('measurement lab drift: foreign records and half-step misses refuse or exclude', async () => {
    const records = Array.from({ length: 100 }, (_, index) => record(index, index));
    records[0] = record(100_000, 100_000);
    records[1] = record(100_001, 100_001);
    const refused = labDrift(evidence({ records: { c01: records, c02: records.map((item) => ({ ...item })) } }));
    assertEqual(refused.reason, 'foreign-timebase', 'more than one percent foreign records refuse');
    const edge = labDrift(evidence({ frameRate: 24, window: { startMs: 1_000, endMs: 1_021.1 }, records: {
      c01: [record(1_021, 1_021)], c02: [record(1_021, 1_021)],
    } }));
    assertEqual(edge.pairs[0].points, 0, 'a grid instant before any record is excluded');
    // 1 of 100 is exactly 1%, which is not more than 1%.
    const one = records.map((item, index) => (index === 1 ? record(1, 1) : item));
    assertEqual(labDrift(evidence({ records: { c01: one, c02: one.map((item) => ({ ...item })) } })).refused, undefined,
      'one percent foreign records is not refused');
  });

  // Each page's d = atMs − wallMs; host d is 0.4 in the fixture. Spread = max d − min d.
  const timebase = (c01, c02) => {
    const fixture = evidence({ records: { c01: [record(0, 0)], c02: [record(0, 0)] }, cadence: { c01: { presentIntervalMs: 10 }, c02: { presentIntervalMs: 10 } } });
    fixture.clients.c01.polls = c01;
    fixture.clients.c02.polls = c02;
    return labDrift(fixture);
  };
  const steady = (d) => [{ atMs: 1_000 + d, wallMs: 1_000 }, { atMs: 2_000 + d, wallMs: 2_000 }];

  await check('measurement lab drift: the timebase check fails on spread and on movement', async () => {
    const spread = timebase(steady(0.4), steady(2.6));
    assertNear(spread.timebaseCheck.spreadMs, 2.2, 1e-9, 'spread is 2.6 − 0.4');
    assertEqual(spread.timebaseCheck.status, 'failed', 'a 2.2 ms spread fails');
    assertEqual(spread.timeBasis, 'reconstructed-lab-time', 'a failed check stays reconstructed');
    assertNear(spread.pairs[0].floorMs, 10, 1e-9, 'a failed check adds no timebase bound');
    const within = timebase(steady(0.4), steady(2.3));
    assertEqual(within.timebaseCheck.status, 'met', 'a 1.9 ms spread is met');
    // c01: d 0 over its first 30 s, 2.5 over its last; median 1.25, so spread to 0.4 is 0.85.
    const moved = timebase([{ atMs: 0, wallMs: 0 }, { atMs: 10_000, wallMs: 10_000 }, { atMs: 100_002.5, wallMs: 100_000 }, { atMs: 110_002.5, wallMs: 110_000 }], steady(0.4));
    assertNear(moved.timebaseCheck.pages.c01.movedMs, 2.5, 1e-9, 'movement is last minus first');
    assertEqual(moved.timebaseCheck.status, 'failed', 'a page moving 2.5 ms fails with the spread under 2');
  });

  await check('measurement lab drift: positions are the frame on screen projected to the grid instant', async () => {
    // 24 fps. c01 shows frame k from k·step; c02 shows it 16 ms later. At grid instant k·step c02 still
    // shows frame k − 1, projected 25.67 ms on: k·step − 16. The nearest record would read 0.
    const step = 1000 / 24;
    const frames = Array.from({ length: 30 }, (_, k) => k);
    const result = labDrift(evidence({ frameRate: 24, window: { startMs: step, endMs: 20 * step - 1 }, records: {
      c01: frames.map((k) => record(k * step, k * step)), c02: frames.map((k) => record(k * step + 16, k * step)),
    } }));
    assertEqual(result.pairs[0].points, 19, 'every grid instant has a frame on screen');
    assertNear(result.pairs[0].signedMedianMs, 16, 1e-6, 'a viewer 16 ms behind reads 16, not 0 or a frame');
    // c02 shows one frame at 0 and nothing after: 41.7 ms later it is projected, 83.3 ms later it is stale.
    const stale = labDrift(evidence({ frameRate: 24, window: { startMs: 0, endMs: 3 * step }, records: {
      c01: frames.map((k) => record(k * step, k * step)), c02: [record(0, 0)],
    } }));
    assertEqual(stale.pairs[0].points, 2, 'a frame up to 62.5 ms old is projected');
    assertEqual(stale.pairs[0].missing, 1, 'a frame 83.3 ms old reads missing, not in sync');
  });
}
