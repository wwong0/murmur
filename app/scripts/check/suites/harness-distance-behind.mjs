import { assertEqual, assertNear, check } from '../harness.mjs';
import { distanceBehind, distanceBehindRows } from '../../figures/distance-behind.mjs';
import { computeHarnessFigureKinds } from '../../figures/harness-figures.mjs';

const timebase = { offsetMs: 5_000, wallOffsetMs: -3_000 };
const condition = { reading: { criteria: { distanceBehind: { maxMs: 600, windowMs: 2_000, minRecords: 20 } } } };
const records = (driftMs, count = 20, startMs = 1_000) => Array.from({ length: count }, (_, index) => ({
  displaySharedMs: startMs + index * 100, driftMs,
}));
const viewerPoll = (atSharedMs, positionMs = 12_345) => ({
  harnessBeforeMs: atSharedMs - 5_000 - 1,
  harnessAfterMs: atSharedMs - 5_000 + 1,
  state: { positionMs },
});
const pagePoll = (atSharedMs, skips, estimateMs = null) => ({ atMs: atSharedMs - 10, clock: { offsetMs: 10 },
  controller: { estimateMs }, playback: { opens: 1, begun: 1, retargets: 0, reparks: 0, skips } });
const hostPoll = Array.from({ length: 7 }, (_, index) => ({ sharedMs: index * 500 }));
const rowFor = (driftMs, count = 20, overrides = {}) => distanceBehindRows({ condition,
  clients: { c01: { records: records(driftMs, count) } }, viewerPolls: { c01: [viewerPoll(2_900)] },
  pagePolls: { c01: [pagePoll(2_000, 2), pagePoll(2_900, 3)] }, hostPoll, capacitySchedule: { drop: { readBackAtMs: -3_000 } },
  timebase, atMs: 2_900, ...overrides }).rows[0];

export default async function harnessDistanceBehindSuite() {
  await check('10b H12: distance is the negated shared-clock drift median and the bar is two-sided', async () => {
    const positive = distanceBehind({ records: records(-22_000), atMs: 2_900, windowMs: 2_000, minRecords: 20 });
    assertNear(positive.distanceBehindMs, 22_000, 0, 'negative drift is 22 seconds behind');
    assertEqual(positive.status, 'available', 'the pure distance reader returns an available value');
    assertEqual(rowFor(-600).status, 'met', '600ms behind is inclusive');
    assertEqual(rowFor(-601).status, 'missed', '601ms behind misses');
    assertEqual(rowFor(601).status, 'missed', '601ms ahead also misses');
  });

  await check('10b H12: fewer than 20 records is missed and keeps the approximate poll figure', async () => {
    // The state's anchor position is not the viewer's: 99 000 here must not be published.
    const row = rowFor(-100, 19, { viewerPolls: { c01: [viewerPoll(2_900, 99_000)] },
      pagePolls: { c01: [pagePoll(2_000, 2, -41_000), pagePoll(2_900, 3, -42_000), pagePoll(3_000, 3, -7)] } });
    assertEqual(row.status, 'missed', '19 records do not establish a presentation');
    assertEqual(row.reason, 'not-presenting', 'the refusal names the absent presentation');
    assertEqual(row.pollDistanceBehindMs, 42_000, 'the last poll at or before the instant gives the approximate distance');
    assertEqual(row.pollApproximate, true, 'and it is labelled approximate');
    assertEqual(rowFor(-100, 19).pollDistanceBehindMs, null, 'a poll with no estimate publishes none');
  });

  await check('10b: with no recovered instant, a viewer without a drift stream is an evidence failure', async () => {
    const reading = (clients) => computeHarnessFigureKinds({ condition: { ...condition, figureKinds: ['distance-behind'] },
      clients, distanceBehindUnavailableReason: 'recovery-unavailable' }).distanceBehind;
    const cut = reading({ c01: { records: records(-100) }, c02: {} });
    assertEqual(cut.status, 'evidence-failure', 'a cut stream is not a room that was not exercised');
    assertEqual(cut.reason, 'drift-stream-missing', 'the missing stream is the reason');
    assertEqual(JSON.stringify(cut.clients), JSON.stringify(['c02']), 'and its viewer is named');
    const whole = reading({ c01: { records: records(-100) }, c02: { records: records(-100) } });
    assertEqual(whole.status, 'not-exercised', 'every stream present and no recovery is not exercised');
  });

  await check('10b H12: a 1400ms shared host gap across the instant has no distance value', async () => {
    const dense = records(-100, 20, -1_200);
    const result = distanceBehind({ records: dense, atMs: 700, windowMs: 2_000, minRecords: 20,
      lastPollAtMs: 700, hostPolls: [{ sharedMs: 0 }, { sharedMs: 1_400 }] });
    assertEqual(result.status, 'unreadable', 'the host gap refuses the distance');
    assertEqual(result.reason, 'host-poll-gap', 'the host gap is named');
    assertEqual(result.hostPollGap.gapMs, 1_400, 'the exact gap is retained');
  });
}
