import { assertEqual, check } from '../harness.mjs';
import { gapCount, gapCountSet } from '../../measure/gap-count.mjs';

function record(L, drift) { return { displaySharedMs: L, mediaMs: L, driftMs: drift, clock: { offsetMs: 0 } }; }

export default async function measureGapCountSuite() {
  await check('measurement gap count: weighted bins, no-frame time and skips', async () => {
    const evidence = { run: 'gaps', condition: { name: 'healthy-condition' }, manifest: {}, tags: ['c01'], seek: null, rosterEvent: null,
      clients: { c01: { drift: [record(0, 5), record(50, -15), record(100, 30), record(150, -50), record(200, 0)], polls: [
        { atMs: 0, clock: { offsetMs: 0 }, playback: { skips: 0, startAtSharedMs: 0, reparks: 0 } },
        { atMs: 3_000, clock: { offsetMs: 0 }, playback: { skips: 1, lastSkipAtSharedMs: 3_000, lastSkipAbandonedMs: 2_000, reparks: 0 } },
      ] } } };
    const result = gapCount(evidence).viewers.c01;
    assertEqual(result.bins['[0,10)'], 50, 'small-gap bin is weighted');
    assertEqual(result.bins['[10,20)'], 50, 'medium-gap bin is weighted');
    assertEqual(result.bins['[20,40)'], 50, 'large-gap bin is weighted');
    assertEqual(result.bins['[40,100)'], 50, 'over-40 bin is weighted');
    assertEqual(result.playingMs, 200, 'last record contributes no interval');
    assertEqual(result.p50Ms, 15, 'weighted median is hand-computable');
    assertEqual(result.secondsAbove40PerHour, 900, 'per-hour scaling uses playing time');
    assertEqual(result.farSkips[0].cause, 'start', 'start wins skip attribution');
  });

  await check('measurement gap count: seek, multiple, unattributed and capacity-drop causes', async () => {
    const poll = (atMs, skips, playback = {}) => ({ atMs, clock: { offsetMs: 0 }, playback: { skips, ...playback } });
    const result = gapCount({ run: 'causes', manifest: { capacitySchedule: { drop: { appliedAtMs: 200_000 } } },
      // The condition declares the drop; only the manifest carries the instant it was applied.
      condition: { capacitySchedule: { drop: { atMs: 1 } } }, timebase: { offsetMs: 1_000 }, tags: ['c01'],
      seek: { host: { atSharedMs: 99_000 } }, clients: { c01: { drift: [], polls: [
        poll(0, 0, { startAtSharedMs: 0 }),
        poll(50_000, 1, { lastSkipAtSharedMs: 50_000 }),
        // After the seek the page carries the seek's start; the skip is the seek's, not a start's.
        poll(99_600, 1, { startAtSharedMs: 99_500 }),
        poll(100_000, 3, { lastSkipAtSharedMs: 100_000 }),
        poll(200_600, 4, { lastSkipAtSharedMs: 200_500 }),
        poll(201_600, 5, { lastSkipAtSharedMs: 201_500 }),
      ] } } }).viewers.c01.farSkips;
    assertEqual(result.map((skip) => skip.cause).join(','), 'unattributed,seek,unattributed,capacity-drop',
      'causes, with the drop at its applied instant on the shared clock');
    assertEqual(result[1].increment, 2, 'two skips between polls are counted');
    assertEqual(result[1].multiple, true, 'and flagged multiple');
  });

  await check('measurement gap count: no-frame intervals do not become gap time', async () => {
    const result = gapCount({ run: 'empty-gap', manifest: {}, condition: {}, tags: ['c01'], clients: {
      c01: { drift: [record(0, 20), record(400, 20)], polls: [] },
    } }).viewers.c01;
    assertEqual(result.noFrameMs, 400, 'long interval is no-frame time');
    assertEqual(result.playingMs, 0, 'long interval is excluded from playing time');
    assertEqual(result.p50Ms, null, 'no gap percentile is null');
  });

  await check('measurement gap count: class pooling excludes unmapped runs', async () => {
    const reading = gapCount({ run: 'mapped', condition: { name: 'healthy-condition' }, manifest: {}, tags: ['c01'], clients: {
      c01: { drift: [record(0, 1), record(50, 1)], polls: [] },
    } });
    const other = { ...reading, condition: 'unknown-condition' };
    const result = gapCountSet({ runs: { mapped: reading, other } }, { 'healthy-condition': 'healthy' });
    assertEqual(result.healthy.playingMs, 50, 'mapped class is pooled');
    assertEqual(result.unmapped.length, 1, 'unmapped run is listed');
  });
}
