// Change 10a T6: the `behind-past` rows that need every viewer's streams — the
// skip's landing (B6), its resync (B7), the other viewers (B8) and the residual
// table (B9) — on one constructed run with hand-computed expectations. Pure.

import { assertEqual, check } from '../harness.mjs';
import { behindReading, resyncAfter } from '../../figures/behind.mjs';

const OTHERS = ['c01', 'c02', 'c04', 'c05'];
const CONDITION = {
  clients: 5,
  disturbance: { pauseMs: 1500 },
  behind: { case: 'past', skipDecisionMaxMs: 4000, abandonedToleranceMs: 300, startLatenessMaxMs: 600,
    resync: { windowMs: 1000, medianMaxMs: 40, holdMs: 30000, maxMs: 2000 } },
};
const DISTURBANCE = { injected: true, pauseCallLocalMs: 0, playResolvedLocalMs: 1000, observationMs: 90000 };
const COUNTERS = { opens: 1, begun: 1, retargets: 0, reparks: 0 };

/** One drift record every 100 ms of shared time from 10 000, seq from `firstSeq`. */
const records = (driftAt, { firstSeq = 1, count = 400 } = {}) => Array.from({ length: count }, (_, index) => ({
  seq: firstSeq + index, displaySharedMs: 10_000 + index * 100, driftMs: driftAt(index * 100),
}));

/**
 * c03 skips at the observation's second poll and its skip start follows seq 100.
 * Its drift after the skip is `c03Drift(ms since its first frame)`; the others sit at 0.
 */
function run({ c03Drift = () => 0, skipStart = {}, starts, otherLast = {}, omit = null } = {}) {
  const polls = [
    { atMs: 1000, playback: { ...COUNTERS, skips: 0, lastSkipAbandonedMs: null } },
    { atMs: 3000, playback: { ...COUNTERS, skips: 1, begun: 2, lastSkipAbandonedMs: -1500 } },
    { atMs: 80_000, playback: { ...COUNTERS, skips: 1, begun: 2, lastSkipAbandonedMs: -1500 } },
  ];
  const first = { attemptId: 1, afterSeq: 0, latenessMs: 0, reparks: 0, reprojections: 0, coverElapsedMs: null };
  const skip = { attemptId: 2, afterSeq: 100, skipOf: 1, abandonedDriftMs: -1500, latenessMs: 12, reparks: 0,
    reprojections: 0, coverElapsedMs: null, ...skipStart };
  const others = Object.fromEntries(OTHERS.filter((tag) => tag !== omit).map((tag) => [tag, {
    // The first poll precedes the observation and holds the viewer's own start, which B8 must not read.
    polls: [
      { atMs: 0, playback: { skips: 0, opens: 0, begun: 0, retargets: 0, reparks: 0 } },
      { atMs: 1000, playback: { ...COUNTERS, skips: 0 } },
      { atMs: 80_000, playback: { ...COUNTERS, skips: 0, ...(otherLast[tag] ?? {}) } },
    ],
    records: records(() => 0),
    starts: [first],
  }]));
  return behindReading({
    condition: CONDITION,
    disturbance: DISTURBANCE,
    polls,
    records: records((ms) => c03Drift(ms), { firstSeq: 101 }),
    starts: starts ?? [first, skip],
    others,
  });
}

const row = (reading, name) => reading.find((candidate) => candidate.row === name);
const statuses = (reading) => JSON.stringify(reading.map((candidate) => [candidate.row, candidate.status]));

export default async function harnessBehindPastSuite() {
  await check('behind past: a skip that lands, resyncs and moves no one else meets B5 to B9', async () => {
    const reading = run();
    assertEqual(statuses(reading), JSON.stringify([['B5', 'met'], ['B6', 'met'], ['B7', 'met'], ['B8', 'met'], ['B9', 'met']]),
      'the past case returns its five rows and no inside row');
    assertEqual(row(reading, 'B5').skipDecisionMs, 2000, 'the skip shows 2 000 ms after the resume');
    assertEqual(row(reading, 'B7').resyncAfterMs, 0, 'a viewer in step from its first frame resyncs at once');
    assertEqual(row(reading, 'B9').startResidualsByClient.c03.length, 2, 'both of c03\'s starts are published');
    assertEqual(row(reading, 'B9').startResidualsByClient.c01[0].count, 24, 'a full start holds 24 records');
  });

  await check('behind past: resync is the time to the first window that holds, and its bar is two-sided', async () => {
    // 60 ms out for the first 1 500 ms, then in step: the first 1 000 ms window whose
    // median is under 40 ms starts at 1 000 (samples 1 000..2 000 hold five at 60 and six at 0).
    const late = run({ c03Drift: (ms) => (ms < 1500 ? 60 : 0) });
    assertEqual(row(late, 'B7').resyncAfterMs, 1000, 'the resync is read from the first frame after the skip');
    assertEqual(row(late, 'B7').status, 'met', '1 000 ms is inside the 2 000 ms bar');
    const slow = run({ c03Drift: (ms) => (ms < 2600 ? 60 : 0) });
    assertEqual(row(slow, 'B7').resyncAfterMs, 2100, 'a later resync is measured, not capped');
    assertEqual(row(slow, 'B7').status, 'missed', '2 100 ms is over the bar');
    const never = run({ c03Drift: () => 60 });
    assertEqual(JSON.stringify([row(never, 'B7').status, row(never, 'B7').resyncAfterMs]), '["missed",null]', 'no resync is missed');
    const edge = resyncAfter({ firstFrameSharedMs: 0, windowMs: 1000, medianMaxMs: 40, holdMs: 2000,
      pairs: [[0, 500, 1000, 1500, 2000, 2500, 3000, 3500].map((atMs) => ({ atMs, driftMs: atMs < 1000 ? 41 : -40 }))] });
    assertEqual(edge, 500, 'the bar is on the absolute drift and is inclusive at 40');
  });

  await check('behind past: the skip\'s landing is judged on lateness, re-parks and a missing stream', async () => {
    assertEqual(row(run({ skipStart: { latenessMs: 600 } }), 'B6').status, 'met', 'lateness of 600 ms is inside');
    const late = run({ skipStart: { latenessMs: 601 } });
    assertEqual(JSON.stringify([row(late, 'B6').status, row(late, 'B7').status]), '["missed","not-exercised"]', '601 ms misses, and B7 is not exercised');
    assertEqual(row(run({ skipStart: { reparks: 1 } }), 'B6').status, 'missed', 'a re-parked skip start misses');
    const absent = run({ omit: 'c04' });
    assertEqual(JSON.stringify([row(absent, 'B7').status, row(absent, 'B8').status]), '["evidence-failure","evidence-failure"]', 'a missing viewer is an evidence failure in both rows');
  });

  await check('behind past: another viewer whose counters move misses B8, one field at a time', async () => {
    for (const field of ['skips', 'opens', 'begun', 'reparks', 'retargets']) {
      const moved = run({ otherLast: { c04: { [field]: 5 } } });
      assertEqual(row(moved, 'B8').status, 'missed', `c04's ${field} moving in the observation misses`);
    }
  });

  await check('behind past: a start with no re-park count is malformed, one with no cover time is not', async () => {
    const first = { attemptId: 1, afterSeq: 0, latenessMs: 0, reparks: 0, reprojections: 0, coverElapsedMs: null };
    const skip = { attemptId: 2, afterSeq: 100, skipOf: 1, latenessMs: 12, reparks: 0, reprojections: 0, coverElapsedMs: null };
    assertEqual(row(run({ starts: [first, skip] }), 'B9').status, 'met', 'a null cover time is a start never re-projected');
    assertEqual(row(run({ starts: [first, { ...skip, reprojections: null }] }), 'B9').status, 'evidence-failure', 'a start without its re-projection count is malformed');
  });
}
