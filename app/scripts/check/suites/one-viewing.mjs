import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { bytesForStretch, computeOneViewing } from '../../figures/one-viewing.mjs';
import { computePeerFigures, steadyState } from '../../figures/peer-figures.mjs';

const BARS = {
  steadyUtilisationMax: 0.90,
  steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25,
  steadyRealtimeMin: 0.98,
};

function drift(positionStart, positionEnd, displayStart = 0, displayEnd = 7_000) {
  return [
    { displaySharedMs: displayStart, scheduledMediaMs: positionStart, mediaMs: positionStart },
    { displaySharedMs: displayEnd, scheduledMediaMs: positionEnd, mediaMs: positionEnd },
  ];
}

function steadyFixture(overrides = {}) {
  const tags = ['c01', 'c02'];
  const input = {
    condition: { bars: BARS },
    clients: { c01: {}, c02: {} },
    content: { segmentSizes: [1_000] },
    segmentSeconds: 1,
    window: { startMs: 0, endMs: 1_000 },
    ...overrides.input,
  };
  const oneViewing = { playedMediaMsByClient: {
    c01: { start: 0, end: 1_000 }, c02: { start: 0, end: 1_000 },
  } };
  const cohorts = {
    c01: [{ lengthBytes: 1_000 }], c02: [{ lengthBytes: 1_000 }],
  };
  return {
    input,
    tags,
    figures: { uplinkUtilisationMean: 0.8, realtimeFactorByClient: { c01: 1, c02: 1 }, ...overrides.figures },
    cohorts: overrides.cohorts ?? cohorts,
    oneViewing: overrides.oneViewing ?? oneViewing,
  };
}

function state(overrides = {}) {
  const fixture = steadyFixture(overrides);
  return steadyState(fixture);
}

export default async function oneViewingSuite() {
  await check('one viewing: pro-rates both boundary segments', async () => {
    assertNear(bytesForStretch(2_000, 9_000, [1_000, 2_000, 3_000], 4), 3_250, 0, '2s to 9s is 3250 bytes');
  });

  await check('one viewing: room position removes the declared offset', async () => {
    const clients = {
      c01: { records: drift(2_000, 9_000) },
      c02: { records: drift(32_000, 39_000) },
    };
    const result = computeOneViewing({ clients, tags: ['c01', 'c02'], window: { startMs: 0, endMs: 7_000 },
      offsets: { c01: 0, c02: 30_000 }, segmentSizes: [1_000, 2_000, 3_000], segmentSeconds: 4 });
    assertNear(result.roomStretchMs.start, 2_000, 0, 'room starts at 2s');
    assertNear(result.roomStretchMs.end, 9_000, 0, 'room ends at 9s');
    assertEqual(JSON.stringify(result.roomPositionSpreadMs), JSON.stringify({ start: 0, end: 0 }), 'offset viewers agree');
    assertNear(result.oneViewingBytesInWindow, 3_250, 0, 'room bytes are hand-computable');
  });

  await check('one viewing: each steady-state leg fails independently and names its value', async () => {
    const utilisation = state({ figures: { uplinkUtilisationMean: 0.91, realtimeFactorByClient: { c01: 1, c02: 1 } } });
    assertEqual(utilisation.steady, false, 'utilisation failure is not steady');
    assertEqual(utilisation.reason, 'steady-state-utilisation', 'utilisation failure is named');
    assertNear(utilisation.legs.utilisation.value, 0.91, 0, 'utilisation value is retained');

    const ratio = state({ cohorts: { c01: [{ lengthBytes: 940 }], c02: [{ lengthBytes: 1_260 }] } });
    assertEqual(ratio.steady, false, 'download-ratio failure is not steady');
    assertEqual(ratio.reason, 'steady-state-download-ratio', 'download-ratio failure is named');
    assertNear(ratio.legs.downloadRatio.byClient.c01, 0.94, 0, 'low ratio is retained');
    assertNear(ratio.legs.downloadRatio.byClient.c02, 1.26, 0, 'high ratio is retained');

    const realtime = state({ figures: { realtimeFactorByClient: { c01: 0.979, c02: 1 } } });
    assertEqual(realtime.steady, false, 'realtime failure is not steady');
    assertEqual(realtime.reason, 'steady-state-realtime', 'realtime failure is named');
    assertNear(realtime.legs.realtime.byClient.c01, 0.979, 0, 'realtime value is retained');
  });

  await check('one viewing: all legs pass and absent bars refuse the multiplier', async () => {
    const passing = state();
    assertEqual(passing.steady, true, 'all legs pass');
    assertEqual(passing.legs.utilisation.pass, true, 'utilisation passes');
    assertEqual(passing.legs.downloadRatio.pass, true, 'download ratio passes');
    assertEqual(passing.legs.realtime.pass, true, 'realtime passes');
    const control = state({ input: { condition: { bars: {} } } });
    assertEqual(control.steady, false, 'control without bars is not steady');
    assertEqual(control.reason, 'steady-state-bars-undeclared', 'missing bars are named');
  });

  await check('one viewing: a viewer with no drift record at a boundary refuses the multiplier by name', async () => {
    const input = {
      byteAccountingMethod: 'peer-attempt-cohort-v1',
      multiplierDenominator: 'one-viewing',
      declaredClientTags: ['c01', 'c02'],
      clients: { c01: { records: drift(0, 7_000) }, c02: { records: [] } },
      condition: { capacityMbps: 10, bars: BARS },
      content: { segmentSizes: [1_000, 1_000] },
      segmentSeconds: 4,
      window: { startMs: 0, endMs: 7_000 },
      originStart: { mediaBytesDelivered: 0 },
      originEnd: { mediaBytesDelivered: 0 },
    };
    const pairing = { byClient: { c01: { pairs: [] }, c02: { pairs: [] } }, excused: [] };
    const never = computePeerFigures(input, pairing);
    assertEqual(never.hostUploadMultiplierRefusal?.detail, 'one-viewing-drift-evidence-unavailable',
      'a viewer with no drift records refuses the multiplier');
    assertEqual(never.hostUploadMultiplier, undefined, 'no multiplier beside the refusal');
    assertEqual(never.peerFractionSteady, false, 'the peer fraction is labelled not steady');

    const late = computePeerFigures({ ...input, clients: { ...input.clients, c02: { records: drift(0, 3_000, 4_000, 7_000) } } }, pairing);
    assertEqual(late.hostUploadMultiplierRefusal?.reason, 'one-viewing-unavailable', 'a late starter refuses by reason');
    assert(late.hostUploadMultiplierRefusal?.detail.startsWith('drift-record-before-boundary-unavailable:c02:'),
      'the refusal names the viewer without a start-boundary record');

    const legacy = computePeerFigures({ ...input, multiplierDenominator: 'distinct-completed' }, pairing);
    assertEqual(legacy.multiplierDenominator, 'distinct-completed', 'legacy denominator remains tolerant');
    assertEqual(legacy.hostUploadMultiplierRefusal, undefined, 'a legacy directory refuses nothing for one viewing');
  });
}
