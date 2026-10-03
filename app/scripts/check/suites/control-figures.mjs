import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { evidenceRefusals } from '../../harness/control-evidence.mjs';
import {
  computeControlFigures, estimateFigure, holdRecoveries, holds, recoverySpans, recoveryTime, sweepFigures, timebaseJoin, widenedBars,
} from '../../figures/control-figures.mjs';

const BARS = {
  steadyUtilisationMax: 0.90, steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25, steadyRealtimeMin: 0.98, steadyPaceBoundMax: 0.10,
};

function polls() {
  return [
    { harnessBeforeMs: 0, harnessAfterMs: 10, pageWallMs: 1_000, sharedMs: 100, clock: { halfWidthMs: 2 }, state: { held: true, lineage: 'l', version: 1, atSharedMs: 100 } },
    { harnessBeforeMs: 40_000, harnessAfterMs: 40_010, pageWallMs: 41_000, sharedMs: 40_100, clock: { halfWidthMs: 3 }, state: { held: false, lineage: 'l', version: 2, atSharedMs: 42_600 } },
  ];
}

function join() {
  return { c01: { joined: [{ cdpMs: 1, recvSharedMs: 30_000 }] }, c02: { joined: [{ cdpMs: 2, recvSharedMs: 40_000 }] } };
}

function baseInput(overrides = {}) {
  return {
    condition: { peerExchange: true, bars: BARS },
    declaredClientTags: ['c01', 'c02'], clients: { c01: { records: [], polls: [] }, c02: { records: [], polls: [] } },
    hostPoll: polls(), viewerPolls: { c01: [], c02: [] }, clockJoin: join(),
    resumes: { records: [{ seq: 1, identity: { lineage: 'l', version: 1 }, cause: 'ready', issuedAtSharedMs: 42_000, holdMs: 42_500 }], evicted: 0 },
    hostPace: { intervals: [], estimate: { bytesPerSecond: 1_200_000, intervalsBehind: 5, linkBoundTotal: 5 }, paceBytesPerSecond: 1_020_000, fraction: 0.85 },
    hostPaceFinal: { estimate: { bytesPerSecond: 1_200_000, intervalsBehind: 5, linkBoundTotal: 5 }, paceBytesPerSecond: 1_020_000, fraction: 0.85 },
    capacityBeforeReadings: { rate: { got: 10_000_000 } }, window: { startMs: 0, endMs: 180_000 }, segmentSeconds: 4,
    seek: null, ...overrides,
  };
}

export default async function controlFiguresSuite() {
  await check('control figures: timebase join publishes shared and wall offsets', async () => {
    const result = timebaseJoin(polls());
    assertNear(result.offsetMs, 95, 0, 'shared minus harness midpoint is 95ms');
    assertNear(result.wallOffsetMs, 995, 0, 'page wall minus harness midpoint is 995ms');
    assertNear(result.halfWidthMs, 7, 0, 'largest bracket plus median clock half-width is 7ms');
  });

  await check('control figures: the start wait runs from the last viewer join', async () => {
    const result = holds({ hostPoll: polls(), resumes: baseInput().resumes.records, joins: join(), declaredViewers: ['c01', 'c02'], recordingEndShared: 100_000 });
    assertEqual(result.start.transitionSharedMs, 40_000, 'last viewer join defines transition');
    assertEqual(result.start.resumedAtSharedMs, 42_600, 'play effective instant defines resume');
    assertEqual(result.start.waitMs, 2_600, 'wait is measured in shared time');
  });

  await check('control figures: a hold that never resumes is published to recording end', async () => {
    const held = [{ ...polls()[0], state: { held: true, lineage: 'l', version: 1, atSharedMs: 100 } }];
    const result = holds({ hostPoll: held, resumes: [], joins: join(), declaredViewers: ['c01', 'c02'], recordingEndShared: 100_000 });
    assertEqual(result.start.resumed, false, 'unresumed hold is explicit');
    assertEqual(result.start.lengthMs, 99_900, 'unresumed hold reaches recording end');
  });

  await check('control figures: an additional held state is published without a transition', async () => {
    const extra = [...polls(), { harnessBeforeMs: 50_000, harnessAfterMs: 50_010, pageWallMs: 51_000,
      sharedMs: 50_100, clock: { halfWidthMs: 3 },
      state: { held: true, lineage: 'second', version: 1, atSharedMs: 50_100 } }];
    const result = holds({ hostPoll: extra, resumes: baseInput().resumes.records, joins: join(),
      declaredViewers: ['c01', 'c02'], recordingEndShared: 100_000 });
    const additional = result.entries.find((entry) => entry.kind === 'additional');
    assert(additional, 'additional held state is retained');
    assertEqual(additional.transitionSharedMs, null, 'additional hold has no transition');
  });

  await check('control figures: recovery is where the steady run of spans begins', async () => {
    const spans = [{ pass: false }, { pass: false }, { pass: true }, { pass: false }, { pass: true }, { pass: true }];
    assertEqual(recoveryTime(spans, 60_000).recoveryMs, 240_000, 'recovery starts after the fourth span');
    assertEqual(recoveryTime([{ pass: true }, { pass: false }], 60_000).recovered, false, 'a failing last span did not recover');
    assertEqual(recoveryTime([{ pass: false }, { incomplete: true }, { pass: true }, { pass: true }], 60_000).recoveryAtMostMs, 120_000, 'incomplete span bounds recovery');
  });

  await check('control figures: widened recovery bars include one edge segment', async () => {
    const bars = widenedBars(BARS, 60_000, 1, 4);
    assertNear(bars.downloadRatioMin, 0.8166666666666667, 1e-12, 'lower ratio bar widens');
    assertNear(bars.downloadRatioMax, 1.3833333333333333, 1e-12, 'upper ratio bar widens');
  });

  // A condition with no steady bars (p2p-scattered) publishes its spans with
  // null bars and no passing leg. Widening the absent bars gave NaN, which
  // withheld the run's byte figure (8b2 p2p-scattered attempt 1). The pair
  // differs only in bars. Red without the repair: both bars read NaN, not null.
  await check('control figures: a condition without steady bars publishes null recovery bars, never non-finite', async () => {
    const input = (bars) => baseInput({ condition: { peerExchange: true, bars }, declaredClientTags: ['c01'],
      clients: { c01: { records: [], polls: [] } },
      viewerPolls: { c01: [{ harnessAfterMs: 0 }, { harnessAfterMs: 60_000 }] }, linkSamples: [], capacityBitsPerSecond: 10_000_000 });
    const undeclared = recoverySpans({ input: input({ controlFloorMin: 0.5 }), transition: 0, recordingEnd: 60_000 }).spans[0];
    const declared = recoverySpans({ input: input(BARS), transition: 0, recordingEnd: 60_000 }).spans[0];
    assertEqual(undeclared.bars.downloadRatioMin, null, 'an undeclared lower ratio bar is null');
    assertEqual(undeclared.bars.downloadRatioMax, null, 'an undeclared upper ratio bar is null');
    assertEqual(undeclared.legs.downloadRatio.bars.min, null, 'the leg publishes the null bar');
    const numbers = [];
    JSON.stringify(undeclared, (key, value) => { if (typeof value === 'number') numbers.push([key, value]); return value; });
    assert(numbers.length > 0, 'the span holds numbers to test');
    assertEqual(numbers.filter(([, value]) => !Number.isFinite(value)).map(([key]) => key).join(','), '', 'no number in the span is non-finite');
    assertEqual(undeclared.pass, false, 'a span with no bars does not pass');
    assertEqual(undeclared.legs.realtime.pass, false, 'a null realtime bar passes nothing');
    assertNear(declared.bars.downloadRatioMin, 0.8166666666666667, 1e-12, 'the declared pair still widens');
  });

  await check('control figures: estimate ratio uses the read-back tbf rate', async () => {
    const result = estimateFigure({ hostPace: baseInput().hostPace, hostPaceFinal: baseInput().hostPaceFinal,
      capacityBeforeReadings: { rate: { got: 10_000_000 } }, window: { startMs: 0, endMs: 180_000 }, wallOffsetMs: 0 });
    assertNear(result.ratio, 0.96, 0, '1.20 MB/s is 0.96 of 10 Mbit/s');
    assertEqual(result.linkBoundTotal, 5, 'link-bound interval count is retained');
  });

  await check('control figures: a held viewer fails recovery rather than vanishing', async () => {
    const result = recoverySpans({ input: baseInput({ declaredClientTags: ['c01'], clients: { c01: { records: [], polls: [] } }, viewerPolls: { c01: [{ harnessAfterMs: 0, clock: { halfWidthMs: 1 } }, { harnessAfterMs: 60_000, clock: { halfWidthMs: 1 } }] }, linkSamples: [], capacityBitsPerSecond: 10_000_000 }), transition: 0, recordingEnd: 60_000 });
    assertEqual(result.spans[0].pass, false, 'held viewer makes the span fail');
    assert(result.spans[0].failedLegs.includes('realtime'), 'missing played stretch names realtime');
  });

  await check('control figures: sweep drift uses the shared window after the timebase join', async () => {
    const record = { displaySharedMs: 60_010, driftMs: 1, epochMs: 1,
      clock: { delayTermMs: 1, ageTermMs: 1, halfWidthMs: 2 } };
    const input = {
      timebase: { offsetMs: 100 }, declaredClientTags: ['c01', 'c02'], content: { frameRate: 10 },
      manifest: { cadence: { c01: { presentIntervalMs: 100 }, c02: { presentIntervalMs: 100 } } },
      clients: { c01: { records: [record] }, c02: { records: [{ ...record }] } },
      hostPoll: [], viewerPolls: {}, linkSamples: [], capacityBitsPerSecond: 10_000_000,
    };
    const result = sweepFigures({ input, spans: [{ window: { startMs: 0, endMs: 60_000 } }], resumedAtSharedMs: 0 });
    assertEqual(result[0].drift.pairwiseDriftPointsUsed, 1, 'shared-window drift record is retained');
  });

  // Each hold has its own spans, from its transition: a start's stop at the seek.
  await check('control figures: start and seek recovery are published separately, from each transition', async () => {
    const at = (harnessMs, state) => ({ harnessBeforeMs: harnessMs - 5, harnessAfterMs: harnessMs + 5,
      pageWallMs: harnessMs + 1_000, sharedMs: harnessMs + 100, clock: { halfWidthMs: 2 }, state });
    const started = { held: false, lineage: 'l', version: 2, atSharedMs: 42_600 };
    const hostPoll = [at(1_000, { held: true, lineage: 'l', version: 1, atSharedMs: 100 }), at(45_000, started),
      at(200_000, { held: true, lineage: 'l', version: 3, atSharedMs: 190_100 }),
      at(205_000, { held: false, lineage: 'l', version: 4, atSharedMs: 192_100 }), at(371_000, { held: false, lineage: 'l', version: 4, atSharedMs: 192_100 })];
    const seek = { host: { held: true, lineage: 'l', version: 3, atSharedMs: 190_100, positionMs: 240_000 } };
    const input = baseInput({ hostPoll, seek, linkSamples: [], capacityBitsPerSecond: 10_000_000 });
    const join = timebaseJoin(hostPoll);
    const held = { start: { transitionSharedMs: 40_000 }, seek: { transitionSharedMs: 190_100, resumedAtSharedMs: 192_100 } };
    const result = { recovery: holdRecoveries({ input, join, holds: held, recordingEndHarnessMs: 371_005 }) };
    result.sweep = sweepFigures({ input: { ...input, timebase: join }, spans: result.recovery.seek.spans, resumedAtSharedMs: 192_100 });
    assertEqual(result.recovery.start.spans.length, 2, 'two whole spans between the last join at 39,900 and the seek at 190,000');
    assertEqual(result.recovery.start.spans[0].window.startMs, 39_900, 'start spans begin at the last join in harness time');
    assertEqual(result.recovery.start.trailingMs, 30_100, 'the remainder before the seek is trailing');
    assertEqual(result.recovery.seek.spans.length, 3, 'three whole spans in the 181 s after the seek');
    assertEqual(result.recovery.seek.spans[0].window.startMs, 190_000, 'seek spans begin at the seek, not its resume');
    assertEqual(result.recovery.seek.result.unestablished, true, 'spans with no viewer polls are unestablished, never failed');
    assertEqual(result.sweep.length, 3, 'the sweep covers the seek spans');
    assertEqual(result.sweep[0].drift, null, 'no drift for a span that begins before the resume at 192,000');
    const noSeek = computeControlFigures(baseInput({ hostPoll: hostPoll.slice(0, 2).concat(at(165_000, started)), linkSamples: [], capacityBitsPerSecond: 10_000_000 }));
    assertEqual(noSeek.holds.start.waitMs, 2_600, 'the whole figure set agrees on the start wait');
    assertEqual(noSeek.recovery.seek, null, 'a condition without a seek has no seek recovery');
    assertEqual(noSeek.recovery.start.spans.length, 2, 'and its start spans run to the recording end');
  });

  await check('control figures: retained directories without control files recompute null control', async () => {
    assertEqual(computeControlFigures({ condition: { bars: BARS }, hostPoll: [] }), null, 'missing control evidence is not a throw');
  });

  await check('control figures: every evidence refusal reaches the control scope', async () => {
    const reasons = evidenceRefusals({ hostPace: { evicted: 1, records: [] }, resumes: { evicted: 1, records: [] }, hostPoll: [{ state: { held: false } }], seek: { host: { held: false } } });
    assertEqual(new Set(reasons.map((entry) => entry.reason)).size, 4, 'all refusal kinds are named separately');
  });

  // Mutation proof: joins at 30,000 and 40,000 ms give a 2,600 ms wait.
  // Opportunity: both joins are retained before the start resume. Action boundary:
  // holds(...).start.waitMs. Mutation: Math.min for Math.max turned the named
  // 2,600 ms assertion red; restoring it made this check green again.
  await check('control figures: a start wait is not measured from the first viewer', async () => {
    const result = holds({ hostPoll: polls(), resumes: baseInput().resumes.records, joins: join(), declaredViewers: ['c01', 'c02'], recordingEndShared: 100_000 });
    assertEqual(result.start.waitMs, 2_600, 'last-join action boundary is observed');
  });

  // Mutation proof: the held viewer is present in the poll population but has
  // no played stretch. Skipping it made the named realtime assertion pass; the
  // restored path keeps the span red and records the viewer as failed.
  await check('control figures: a held viewer cannot disappear from a span', async () => {
    const result = recoverySpans({ input: baseInput({ declaredClientTags: ['c01'], clients: { c01: { records: [], polls: [] } }, viewerPolls: { c01: [{ harnessAfterMs: 0 }, { harnessAfterMs: 60_000 }] }, linkSamples: [], capacityBitsPerSecond: 10_000_000 }), transition: 0, recordingEnd: 60_000 });
    assertEqual(result.spans[0].legs.realtime.pass, false, 'held viewer realtime leg is red');
  });

  // Mutation proof: issue time 42,000 differs from effective state time 42,600.
  // The effective-state assertion observes the resume boundary; using issue time
  // made the named 2,600 ms wait red, and restoring the path returned green.
  await check('control figures: the effective play instant defines the wait', async () => {
    const result = holds({ hostPoll: polls(), resumes: baseInput().resumes.records, joins: join(), declaredViewers: ['c01', 'c02'], recordingEndShared: 100_000 });
    assertEqual(result.start.resumedAtSharedMs, 42_600, 'effective state instant is retained');
    assertEqual(result.start.waitMs, 2_600, 'issue time is not used');
  });
}
