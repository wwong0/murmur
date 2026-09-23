// Constructed D6 figures; the plain-line trap is named G9 (6b design.md D6).

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { DEFAULT_BARS } from '../../drift-figures.mjs';
import { MAX_RATE_DEVIATION } from '../../../public/lib/drift-controller.mjs';
import { measurementRecord, sample } from '../drift-figure-fixtures.mjs';
import {
  maxRateCompletion,
  maxRateEvidence,
  startResiduals,
  stepFit,
  stepFits,
} from '../../figures/start-requalification.mjs';

const FRAME_RATE = 24;
const FRAME_MS = 1000 / FRAME_RATE;
const START = { afterSeq: 0, attemptId: 'a' };

const stepRecords = ({ rate = 1, displayStepAt = null, mediaStepAt = null, count = 72 } = {}) => Array.from({ length: count }, (_, index) => ({
  seq: index + 1,
  epochMs: 1,
  mediaMs: rate * index * FRAME_MS + (mediaStepAt !== null && index >= mediaStepAt ? 11 : 0),
  displaySharedMs: index * FRAME_MS + (displayStepAt !== null && index >= displayStepAt ? 11 : 0),
  clock: { offsetMs: 0 },
}));

function maxWindow({ removeSaturated = false, changedEpoch = false } = {}) {
  const polls = [];
  for (let index = 0; index < 40; index += 1) {
    if (!removeSaturated) polls.push(sample({ atMs: index * 250, polls: index + 1, rate: 1 + MAX_RATE_DEVIATION }));
  }
  if (removeSaturated) polls.push(sample({ atMs: 0, polls: 1, rate: 1 + MAX_RATE_DEVIATION }));
  const startPoll = removeSaturated ? 2 : 41;
  for (let index = 0; index < 120; index += 1) {
    polls.push(sample({ atMs: 10_000 + index * 250, polls: startPoll + index, rate: 1.0008 }));
  }
  const records = Array.from({ length: 801 }, (_, index) => measurementRecord({
    localMs: index * 50,
    rate: 1.0008,
    interceptMs: -20,
    epochMs: changedEpoch && index === 400 ? 2 : 1,
  }));
  const disturbance = {
    injected: true,
    playResolvedLocalMs: 0,
    pauseCallLocalMs: 0,
    observationMs: 40_000,
    playbackBefore: { opens: 1, begun: 1, retargets: 0 },
    playbackAfter: { opens: 1, begun: 1, retargets: 0 },
  };
  return { records, polls, disturbance };
}

const evidence = (options) => {
  const input = maxWindow(options);
  return maxRateEvidence({ ...input, driftLogMissed: 0, bars: DEFAULT_BARS });
};

export default async function harnessStartRequalSuite() {
  await check('start requalification: start residuals preserve signed medians and both bars', async () => {
    // 41.667ms is 1000/24; ±50ms is outside it on both signs.
    const records = [
      ...Array.from({ length: 24 }, (_, index) => ({ seq: index + 1, driftMs: -20, epochMs: 1 })),
      ...Array.from({ length: 24 }, (_, index) => ({ seq: index + 25, driftMs: 50, epochMs: 1 })),
      ...Array.from({ length: 24 }, (_, index) => ({ seq: index + 49, driftMs: -50, epochMs: 1 })),
      ...Array.from({ length: 12 }, (_, index) => ({ seq: index + 73, driftMs: 10, epochMs: 1 })),
    ];
    const starts = [0, 24, 48, 72].map((afterSeq, index) => ({ afterSeq, attemptId: `a${index}` }));
    const result = startResiduals({
      clients: { c02: { records, boundaries: { end: { playback: { starts } } } } },
      tags: ['c02'],
      content: { frameRate: FRAME_RATE },
    });
    const rows = result.startResidualsByClient.c02;
    assertEqual(rows.map((row) => row.status).join(','), 'met,missed,missed,short', 'met, ahead-missed, behind-missed and short are retained');
    assertEqual(rows[0].signedMedianMs, -20, 'the behind median keeps its negative sign');
    assertEqual(rows[1].signedMedianMs, 50, 'a positive median beyond +41.667 is missed');
    assertEqual(rows[2].signedMedianMs, -50, 'a negative median beyond -41.667 is missed');
    assertEqual(result.startResidualPopulation.count, 4, 'all starts count once');
    assertEqual(result.startResidualPopulation.met, 1, 'one start meets the two-sided bar');
    assertEqual(result.startResidualPopulation.missed, 2, 'both signs beyond the bar count as missed');
    assertEqual(result.startResidualPopulation.other, 1, 'short is not silently counted as met or missed');
  });

  await check('start requalification: line-plus-step fit separates rate from presentation', async () => {
    // 72 frames at 24fps, with an 11ms display step beginning at frame 24.
    const fitted = stepFit({ records: stepRecords({ displayStepAt: 24 }), start: START, frameRate: FRAME_RATE });
    assertEqual(fitted.status, 'ok', 'the 72-frame constructed population fits');
    assertNear(fitted.mediaRate, 1, 1e-9, 'media rate is unity despite the display step');
    assertNear(fitted.presentationStepMs, 11, 1e-9, 'display later is a positive presentation step');
    assertEqual(fitted.stepIndex, 24, 'the fitted step is at frame 24');
    assertNear(fitted.plainLineSlope, 0.9951221873697382, 1e-9, 'the step-free slope reproduces the hand figure');
    assertEqual(fitted.rateDeparture, false, 'G9: a plain-line slope departure is not a rate departure');

    const twin = stepFit({ records: stepRecords({ rate: 1.01 }), start: START, frameRate: FRAME_RATE });
    // 1.01 − 1 = 0.01, above the 0.002 rate-departure bar.
    assertNear(twin.mediaRate, 1.01, 1e-9, 'the twin has a genuine media-rate departure');
    assertEqual(twin.rateDeparture, true, 'the media-rate bar, not the plain line, reports departure');
    assert(Math.abs(twin.presentationStepMs) < 1e-6, 'the no-step twin has no presentation delay');
  });

  await check('start requalification: fit refusals and bounded step candidates are named', async () => {
    // 71 is one short of the fixed 72-frame population; candidates begin at 12.
    const short = stepFit({ records: stepRecords({ count: 71 }), start: START, frameRate: FRAME_RATE });
    assertEqual(short.status, 'absent', '71 records refuse the fit');
    assertEqual(short.reason, 'fewer-than-72-records', 'the short population names its refusal');

    const outside = stepFit({ records: stepRecords({ mediaStepAt: 6 }), start: START, frameRate: FRAME_RATE });
    assertEqual(outside.status, 'ok', 'a step outside the candidate range still fits');
    assert(outside.stepIndex !== 6, 'a step at frame 6 cannot be selected outside [12,60]');
  });

  await check('start requalification: stepFits maps every retained start by client', async () => {
    const result = stepFits({
      clients: { c02: { records: stepRecords({ displayStepAt: 24 }), starts: [START] } },
      tags: ['c02'],
      content: { frameRate: FRAME_RATE },
    });
    assertEqual(result.stepFitsByClient.c02.length, 1, 'one start produces one fit row');
    assertEqual(result.stepFitsByClient.c02[0].attemptId, 'a', 'the fit row retains its attempt id');
  });

  await check('maximum-rate evidence: qualifying saturated and plateau fits are accepted', async () => {
    // 40 saturated polls plus 120 plateau polls cover 40s at 250ms cadence.
    const result = evidence();
    assertEqual(result.status, 'ok', 'both constructed fit populations and preconditions pass');
    assert(result.qualifyingSaturated >= 1, 'the rate-ceiling stretch qualifies as saturated');
    assert(result.qualifyingPlateau >= 1, 'the below-ceiling stretch qualifies as plateau');
    assertEqual(result.records, 801, 'the full retained record count is reported');
    assertEqual(result.postDisturbanceDrift, true, 'the post-pause negative drift crosses the band');
    assertEqual(result.postDisturbanceRate, true, 'the post-pause saturated command is observed');
  });

  await check('maximum-rate evidence: missing saturation is not accepted', async () => {
    // One 1.01 poll proves exercise; too few saturated records fit the bar.
    const result = evidence({ removeSaturated: true });
    assertEqual(result.status, 'not-ok', 'a plateau without the saturated stretch is not enough');
    assertEqual(result.reason, 'missing-saturated-fit', 'the missing saturated fit is named');
    assertEqual(result.qualifyingSaturated, 0, 'the saturated count exposes the missing stretch');
  });

  await check('maximum-rate evidence: an uninjected client is a failed precondition', async () => {
    // The declared injection flag is false, so retained-looking fits cannot pass.
    const input = maxWindow();
    const result = maxRateEvidence({ ...input, disturbance: { ...input.disturbance, injected: false }, driftLogMissed: 0 });
    assertEqual(result.status, 'failed-precondition', 'an uninjected client cannot pass by having fit-shaped records');
    assertEqual(result.reason, 'not-injected', 'the injection precondition is named');
  });

  await check('maximum-rate evidence: an epoch change refuses the window', async () => {
    // One record moves from epoch 1 to 2 while the observation remains 40s.
    const result = evidence({ changedEpoch: true });
    assertEqual(result.status, 'refused', 'a room mapping epoch change refuses the window');
    assertEqual(result.reason, 'epoch-revision', 'the room-state refusal names the epoch revision');
  });

  await check('maximum-rate evidence: completion requires both disturbed clients', async () => {
    // The completion set is exactly two clients, not an arbitrary result count.
    const result = maxRateCompletion({ c02: { status: 'ok' }, c03: { status: 'not-ok', reason: 'missing-plateau-fit' } });
    assertEqual(result.ok, false, 'one non-ok client withholds completion');
    assertEqual(JSON.stringify(result.required), '["c02","c03"]', 'the completion set is fixed to c02 and c03');
    assertEqual(result.statusByClient.c03, 'not-ok', 'the failing client remains named');
    assertEqual(maxRateCompletion({ c02: { status: 'ok' }, c03: { status: 'ok' } }).ok, true, 'both ok clients complete');
  });
}
