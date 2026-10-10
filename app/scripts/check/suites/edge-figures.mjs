// 9b design.md D7: host copies, the prefetch wait, the room's position, the
// media-time ratio and the held-ahead at a span's end. Every number is written here.

import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import {
  aheadWhenRecovered, hostCopies, mediaTimeRatio, prefetchWait, roomPosition, slowExit,
} from '../../figures/edge-figures.mjs';
import { computeEdgeFigures } from '../../figures/edge-publication.mjs';
import { recoverySpans } from '../../figures/control-figures.mjs';

const WINDOW = { startMs: 100_000, endMs: 280_000 };
const WALL_OFFSET_MS = 5_000;
const SIZE = 1_400_000;
const SIZES = Array.from({ length: 60 }, () => SIZE);
const path = (index) => `/media/seg-${String(index).padStart(5, '0')}.m4s`;

// Forty segments, each asked for once by c01 at its own instant inside the window.
const firstAsks = () => Array.from({ length: 40 }, (_, index) => ({ seq: index + 1, index, path: path(index), startMs: index * 4_000,
  reason: 'first', rank: 0, atMs: 101_000 + index * 4_000 + WALL_OFFSET_MS }));
const fallbackAsks = () => Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, index, path: path(index), startMs: index * 4_000,
  reason: 'fallback-peer-failed', rank: 1, atMs: 102_000 + index * 4_000 + WALL_OFFSET_MS }));
const asks = (records, health = {}) => ({ records, wallOffsetMs: WALL_OFFSET_MS, evicted: 0, gaps: 0, ...health });
const bodies = (count, from = 0, prefix = 'r') => Array.from({ length: count }, (_, index) => ({ originResponseId: `${prefix}${from + index}`,
  urlPath: path(from + index), kind: 'segment', delivered: SIZE, expectedBytes: SIZE, aborted: false }));

const receipt = (startMs, waitMs, overrides = {}) => ({ requestId: `q${startMs}`, url: path(30), startMs, headMs: waitMs === null ? null : startMs + waitMs,
  endMs: startMs + 6_000, bodyBytes: SIZE, finished: true, urgent: false, near: false, ...overrides });
const HELD = { playing: false, held: true };
const pollsAt = (heldAheadMs, instants) => instants.map((at) => ({ harnessAfterMs: at, heldAhead: { heldAheadMs }, state: HELD }));

async function thrownBy(run) {
  try { await run(); } catch (error) { return error; }
  return null;
}

export default async function edgeFiguresSuite() {
  await check('edge figures: one first fetcher per segment reads one host copy, and a fallback copy is counted and named', async () => {
    const one = hostCopies({ asksByClient: { c01: asks(firstAsks()), c02: asks([]) }, hostResponses: bodies(40), segmentSizes: SIZES, window: WINDOW });
    assertEqual(one.segments, 40, 'forty segments were asked for');
    assertEqual(one.meanCopies, 1, 'forty asks and forty bodies read 1');
    assertEqual(JSON.stringify(one.distribution), '{"1":40}', 'every segment at one copy');
    assertEqual(JSON.stringify(one.asksByReason), '{"first":40}', 'all asked as first fetcher');
    const more = hostCopies({ asksByClient: { c01: asks(firstAsks()), c02: asks(fallbackAsks()) },
      hostResponses: [...bodies(40), ...bodies(10, 0, 'f')], segmentSizes: SIZES, window: WINDOW });
    assertEqual(more.meanCopies, 1.25, 'forty plus ten fallback bodies read 1.25');
    assertEqual(JSON.stringify(more.distribution), '{"1":30,"2":10}', 'ten segments at two copies');
    assertEqual(JSON.stringify(more.asksByReason), '{"first":40,"fallback-peer-failed":10}', 'the reasons split 40 and 10');
    assertEqual(more.perSegment[0].asks.map((ask) => `${ask.tag}:${ask.reason}`).join(' '), 'c01:first c02:fallback-peer-failed', 'each segment names who asked and why');
    const short = bodies(40).map((body, index) => (index === 0 ? { ...body, delivered: SIZE - 1 } : index === 1 ? { ...body, aborted: true } : body));
    assertEqual(JSON.stringify(hostCopies({ asksByClient: { c01: asks(firstAsks()) }, hostResponses: short, segmentSizes: SIZES, window: WINDOW }).distribution),
      '{"0":2,"1":38}', 'a short body and an aborted one are not copies');
  });

  await check('edge figures: an evicted ask record reads no figure, and no ask reads no mean', async () => {
    const evicted = hostCopies({ asksByClient: { c01: asks(firstAsks()), c02: asks([], { evicted: 3 }) }, hostResponses: bodies(40), segmentSizes: SIZES, window: WINDOW });
    assertEqual(JSON.stringify(evicted), '{"value":null,"reason":"ask-evidence-evicted","tag":"c02"}', 'eviction reads no figure and names the viewer');
    const gapped = hostCopies({ asksByClient: { c01: asks(firstAsks(), { gaps: 1 }) }, hostResponses: bodies(40), segmentSizes: SIZES, window: WINDOW });
    assertEqual(gapped.reason, 'ask-evidence-evicted', 'a seq gap is the same loss');
    const none = hostCopies({ asksByClient: { c01: asks([]) }, hostResponses: bodies(40), segmentSizes: SIZES, window: WINDOW });
    assertEqual(`${none.segments}/${none.meanCopies}`, '0/null', 'no ask: zero segments and no mean');
    const outside = hostCopies({ asksByClient: { c01: asks(firstAsks().map((ask) => ({ ...ask, atMs: ask.atMs + 400_000 }))) },
      hostResponses: bodies(40), segmentSizes: SIZES, window: WINDOW });
    assertEqual(outside.segments, 0, 'asks placed after the window count no segment');
    const control = await thrownBy(async () => hostCopies({ asksByClient: { c01: asks([{ ...firstAsks()[0], reason: 'control-8b' }]) },
      hostResponses: [], segmentSizes: SIZES, window: WINDOW }));
    assert(control?.message.includes('control-8b under the product control'), 'a control-8b ask under a product condition is a hard error');
    assertEqual(hostCopies({ asksByClient: { c01: asks([{ ...firstAsks()[0], reason: 'control-8b' }]) }, hostResponses: bodies(1),
      segmentSizes: SIZES, window: WINDOW, control: '8b' }).meanCopies, 1, 'and is counted under the 8b control');
    const impossible = await thrownBy(async () => hostCopies({ asksByClient: { c01: asks(firstAsks()) },
      hostResponses: bodies(40).map((body, index) => (index === 5 ? { ...body, aborted: true } : body)), segmentSizes: SIZES, window: WINDOW,
      receiptsByClient: { c01: [{ url: path(5), originResponseId: 'r5', bodyBytes: SIZE, finished: true }] } }));
    assert(impossible instanceof RangeError, 'a whole body received from a response the host did not deliver whole is a hard error');
  });

  await check('edge figures: the largest prefetch wait at the edge is published, with what is left out', async () => {
    const edge = { c01: pollsAt(9_000, [119_900, 139_900, 159_900, 179_900]), c02: pollsAt(40_000, [119_900]) };
    const result = prefetchWait({ receiptsByClient: { c01: [receipt(120_000, 400), receipt(140_000, 2_100), receipt(160_000, 4_600)] },
      viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 });
    assertEqual(`${result.maxAnswerMs}/${result.count}`, '4600/3', 'waits of 400, 2 100 and 4 600 read 4 600 over three');
    assertEqual(result.answerMsDistribution.medianMs, 2_100, 'with the distribution');
    assertEqual(result.maxDurationMs, 6_000, 'and the receipt\'s whole duration beside it');
    const ahead = prefetchWait({ receiptsByClient: { c02: [receipt(120_000, 9_000)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 });
    assertEqual(ahead.count, 0, 'a request made 40 000 ms ahead of the edge is not counted');
    const classes = prefetchWait({ receiptsByClient: { c01: [receipt(120_000, 400, { urgent: true }), receipt(120_000, 400, { near: true }),
      receipt(120_000, 400, { url: '/media/init.mp4' }), receipt(90_000, 400), receipt(180_500, 400)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 });
    assertEqual(classes.count, 1, 'urgent, near, non-segment and out-of-window receipts are left out; the one with a poll 600 ms before it counts');
    const stale = prefetchWait({ receiptsByClient: { c01: [receipt(182_000, 400)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 });
    assertEqual(stale.count, 0, 'a receipt whose last poll is 2 100 ms old has no held-ahead and is not counted');
    const unanswered = prefetchWait({ receiptsByClient: { c01: [receipt(120_000, null), receipt(140_000, 2_100)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 });
    assertEqual(`${unanswered.count}/${unanswered.unanswered}/${unanswered.maxAnswerMs}/${unanswered.answerMsDistribution.minMs}`, '2/1/2100/2100',
      'an unanswered receipt is counted as unanswered and is not a zero wait');
    const negative = await thrownBy(async () => prefetchWait({ receiptsByClient: { c01: [receipt(120_000, -5)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000 }));
    assert(negative instanceof RangeError, 'a negative wait is a hard error');
    const offset = prefetchWait({ receiptsByClient: { c01: [receipt(125_000, 400)] }, viewerPolls: edge, window: WINDOW, edgeMsBelow: 15_000,
      wallOffsetMsByClient: { c01: 5_000 } });
    assertEqual(offset.count, 1, 'a receipt is placed on the harness clock by its viewer\'s wall offset');
  });

  await check('edge figures: a room spread over thirty seconds is labelled, and its distance behind the room published', async () => {
    const hostPoll = [{ sharedMs: 0, state: { playing: true, held: false, positionMs: 0, atSharedMs: 0 } }];
    const drift = (behindMs) => ({ records: [{ displaySharedMs: 90_000, mediaMs: 90_000 - behindMs }, { displaySharedMs: 300_000, mediaMs: 300_000 - behindMs }] });
    const spread = roomPosition({ clients: { c01: drift(100), c02: drift(30_100) }, hostPoll, window: WINDOW, scatteredSpreadMsAbove: 4_000 });
    assertEqual(JSON.stringify(spread.behindMsMedianByClient), '{"c01":100,"c02":30100}', 'each viewer\'s median distance behind the room');
    assertEqual(spread.spreadMs, 30_000, 'the spread is 30 000 ms');
    assertEqual(spread.roomScattered, true, 'above 4 000 ms the room is labelled scattered');
    assertEqual(spread.secondsUsed, 180, 'over the window\'s 180 seconds');
    const tight = roomPosition({ clients: { c01: drift(100), c02: drift(4_100) }, hostPoll, window: WINDOW, scatteredSpreadMsAbove: 4_000 });
    assertEqual(`${tight.spreadMs}/${tight.roomScattered}`, '4000/false', 'a spread of exactly 4 000 ms is not above it');
    const none = roomPosition({ clients: { c01: { records: [] } }, hostPoll, window: WINDOW, scatteredSpreadMsAbove: 4_000 });
    assertEqual(`${none.spreadMs}/${none.roomScattered}/${none.behindMsMedianByClient.c01}`, 'null/null/null', 'no drift records: no value, not zero');
  });

  await check('edge figures: the media-time ratio is published beside the byte ratio and not tested', async () => {
    // 44 segments of 4 s finished over a played stretch of 179 592 ms: 0.98 in media time.
    const figures = { completedSegmentsByClient: { c01: 44 }, playedMediaMsByClient: { c01: { start: 100_000, end: 279_592 } } };
    assertNear(mediaTimeRatio(figures, ['c01'], 4).c01, 0.98, 0.0001, '176 000 ms of media over 179 592 ms played');
    assertEqual(mediaTimeRatio({ completedSegmentsByClient: { c01: 44 }, playedMediaMsByClient: { c01: null } }, ['c01'], 4).c01, null, 'no played stretch: no value');
    // The pair differs only in whether the condition is registered under 9b.
    const span = (reading) => recoverySpans({ input: { condition: { bars: {}, reading }, declaredClientTags: ['c01'],
      clients: { c01: { records: [], polls: [] } }, hostPoll: [], viewerPolls: { c01: [{ harnessAfterMs: 59_900, heldAhead: { heldAheadMs: 21_000 }, state: HELD }] },
      linkSamples: [], hostPace: null, capacityBitsPerSecond: 10_000_000 }, transition: 0, recordingEnd: 60_000 }).spans[0];
    const edge = span({ kind: 'control', hostPollCoverage: true });
    assertEqual(JSON.stringify(Object.keys(edge.downloadRatioMediaTime)), '["byClient"]', 'a 9b span publishes the media-time ratio');
    assert(!('downloadRatioMediaTime' in edge.legs), 'outside the legs, so no reader counts it');
    assertEqual(edge.heldAheadMsByClient.c01, 21_000, 'with each viewer\'s held-ahead at the span\'s end');
    const before = span({ kind: 'control' });
    assert(!('downloadRatioMediaTime' in before) && !('heldAheadMsByClient' in before), 'a span registered before 9b keeps its shape');
    assertEqual(JSON.stringify(edge.legs), JSON.stringify(before.legs), 'and the legs are the same either way');
  });

  await check('edge figures: ahead-when-recovered reads the earliest span from which the room recovered', async () => {
    const spans = [0, 1, 2].map((index) => ({ window: { startMs: index * 60_000, endMs: (index + 1) * 60_000 } }));
    const viewerPolls = { c01: pollsAt(20_000, [59_900, 119_900, 179_900]), c02: [...pollsAt(9_000, [59_900]), ...pollsAt(16_000, [119_900]), ...pollsAt(30_000, [178_200])] };
    const at = (result) => aheadWhenRecovered({ recovery: { spans, result }, viewerPolls, tags: ['c01', 'c02'], aheadMsMin: 15_000 });
    assertEqual(`${at({ recovered: true, recoveryMs: 0 }).atMs}/${at({ recovered: true, recoveryMs: 0 }).ahead}`, '60000/false', 'recovered at once, with c02 at 9 000 ms: not ahead');
    assertEqual(`${at({ recovered: true, recoveryMs: 60_000 }).atMs}/${at({ recovered: true, recoveryMs: 60_000 }).ahead}`, '120000/true', 'recovered from the second span, both above 15 000 ms: ahead');
    const early = at({ recovered: true, recoveryMs: null, recoveryAtMostMs: 120_000 });
    assertEqual(`${early.heldAheadMsByClient.c02}/${early.ahead}`, 'null/false', 'a poll 1 800 ms before the span\'s end is no value');
    assertEqual(at({ recovered: false, recoveryMs: null }), null, 'a room that did not recover has no reading');
  });

  await check('edge figures: a slow viewer\'s exit is published, or named as not exercised', async () => {
    const slowAsk = { ...firstAsks()[3], reason: 'fallback-slow-holder' };
    const exercised = slowExit({ asksByClient: { c01: asks([slowAsk, firstAsks()[4]]), c05: asks([]) }, window: WINDOW, slowTags: ['c05'], uploadBytesByClient: { c05: 2_500_000 } });
    assertEqual(`${exercised.slowExit}/${exercised.slowHolderAsksByClient.c01}/${exercised.uploadBytesByClient.c05}`, 'exercised/1/2500000', 'one slow-holder ask, and c05\'s upload');
    assertEqual(slowExit({ asksByClient: { c01: asks(firstAsks()) }, window: WINDOW, slowTags: ['c05'] }).slowExit, 'not-exercised', 'no such ask: not exercised');
    assertEqual(slowExit({ asksByClient: { c01: asks([slowAsk]) }, window: WINDOW, slowTags: [] }), null, 'a room with no slow viewer has no reading');
  });

  await check('edge figures: only a condition registered under 9b carries the block', async () => {
    const input = (reading) => ({ condition: { reading, qdiscs: [{ container: 'c01', discipline: 'tbf', params: { rate: '10mbit' } }, { container: 'c02', discipline: 'tbf', params: { rate: '1mbit' } }] },
      declaredClientTags: ['c01', 'c02'], clients: { c01: { requests: [], records: [] }, c02: { requests: [], records: [] } }, window: WINDOW,
      viewerPolls: {}, hostPoll: [], originStart: { responseRecords: bodies(2) }, originEnd: { counters: { responseRecords: bodies(42) } },
      cdpQualification: { receipt: { originResponseId: 'r39' } }, segmentSizes: SIZES });
    assertEqual(computeEdgeFigures({ input: input({ kind: 'control' }) }), null, 'a condition registered before 9b has none');
    const edge = computeEdgeFigures({ input: input({ kind: 'control', hostPollCoverage: true, behindHeldAheadMsBelow: 15_000, scatteredSpreadMsAbove: 4_000, aheadMsMin: 15_000 }),
      evidence: { asksByClient: { c01: asks(firstAsks()), c02: asks([]) }, askHealth: { c01: { evicted: 0 } }, hostStats: { start: { responses: 1 }, end: { responses: 9 } } } });
    assertEqual(JSON.stringify(edge.hostCopies.distribution), '{"0":3,"1":37}', 'responses settled before the start boundary, and the qualification\'s, are not copies');
    assertEqual(edge.slowExit.slowTags.join(','), 'c02', 'the viewer declared below the fastest is the slow one');
    assertEqual(edge.hostStats.end.responses, 9, 'the host\'s response counts are carried');
    assertEqual(edge.dropRecovery, null, 'a run with no schedule has no drop recovery');
  });
}
