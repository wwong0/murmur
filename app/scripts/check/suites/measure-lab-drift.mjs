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
    assertEqual(edge.pairs[0].points, 0, 'a record just beyond half an interval is excluded');
  });
}
