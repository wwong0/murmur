import { driftSeriesCsv, driftSvg } from '../../figures/drift-plot.mjs';
import { publish } from '../../figures/publication.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

const TAGS = ['c01', 'c02', 'c03'];
const WINDOW = { startMs: 100, endMs: 2_100, excludedPrefixMs: 0, measureWindowMs: 2_000 };

const byClient = (value) => Object.fromEntries(TAGS.map((tag) => [tag, value]));

function publishedFixture(driftSeriesByClient = { c01: [1, null, 3, null, 5], c02: [null, 2, null, 4, null], c03: [0, 1, 2, null, 4] }) {
  return publish('drift', {
    condition: { name: 'plot', capacityMbps: 10, runLengthMs: 2_000, criterion: { statistic: 'median', targetMs: 40 } },
    window: WINDOW,
    content: { frameRate: 2 },
    uplinkUtilisationMean: 0.4,
    uplinkUtilisationPeak: 0.5,
    capacityBitsPerSecond: 10_000_000,
    qdiscBacklogBytesMean: 100,
    qdiscOverlimitsInWindow: 2,
    qdiscBacklogNonzeroFraction: 0.5,
    standingQueueDelayMsP50NearestRank: 1,
    standingQueueDelayMsP99: 2,
    clockHalfWidthMsP50ByClient: byClient(3),
    clockHalfWidthMsP99ByClient: byClient(4),
    clockDelayTermMsP50ByClient: byClient(2),
    clockDelayTermMsP99ByClient: byClient(3),
    clockAgeTermMsP50ByClient: byClient(1),
    clockAgeTermMsP99ByClient: byClient(2),
    controllerBandMsP50ByClient: byClient(5),
    controllerBandMsP99ByClient: byClient(6),
    controllerStoppingThresholdMsP50ByClient: byClient(7),
    controllerStoppingThresholdMsP99ByClient: byClient(8),
    thresholdUsableFractionByClient: byClient(1),
    settlingByClient: { c01: { settlingMs: 12, mode: 'settled', thresholdUsable: true }, c02: { settlingMs: 12, mode: 'settled', thresholdUsable: true }, c03: { settlingMs: 12, mode: 'settled', thresholdUsable: true } },
    presentIntervalMsByClient: byClient(16.667),
    cadenceClassificationByClient: { c01: 'synthetic-fixed', c02: 'synthetic-fixed', c03: 'synthetic-fixed' },
    clockFirstEstimateMsByClient: byClient(250),
    clockJoinCountByClient: byClient(1),
    clockProbesAbandonedByClient: byClient(0),
    clockProbeAbandonedFractionByClient: byClient(0),
    driftSeriesByClient,
    epochsByClient: { c01: [1], c02: [1], c03: [1] },
    pairwiseDriftAbsMsMedian: 2,
    pairwiseDriftAbsMsP99: 3,
    pairwiseDriftAbsMsMedianLowerEnd: 1,
    pairwiseDriftAbsMsP99LowerEnd: 2,
    pairwiseDriftAbsMsMedianUpperEnd: 3,
    pairwiseDriftAbsMsP99UpperEnd: 4,
    instrumentFloorMsP50: 1,
    instrumentFloorMsP99: 2,
    floorDelayTermMsP50: 0.5,
    floorDelayTermMsP99: 1,
    floorAgeTermMsP50: 0.25,
    floorAgeTermMsP99: 0.5,
    floorPresentIntervalMs: 0.25,
    pairwiseDriftPointsUsed: 5,
    excludedMissingRecord: 0,
    excludedEpochMismatch: 0,
    pairwiseDriftAbsMsMedianByPair: { 'c01|c02': 2 },
    pairwiseDriftPointsUsedByPair: { 'c01|c02': 5 },
    excludedMissingRecordByPair: { 'c01|c02': 0 },
    excludedEpochMismatchByPair: { 'c01|c02': 0 },
    pairsWithoutFigure: [],
    criterionVerdict: { statistic: 'median', targetMs: 40, verdict: 'met', statisticOfLowerEnds: 1, statisticOfUpperEnds: 3, largestFloorTerm: 'delay' },
    p99Verdict: { statistic: 'p99', targetMs: 100, verdict: 'met', statisticOfLowerEnds: 2, statisticOfUpperEnds: 4, largestFloorTerm: 'delay' },
    realtimeFactorByClient: byClient(1),
    droppedFrameFractionByClient: byClient(0),
    evaluationSkipsByClient: byClient(0),
    clockBestDelayMsP50ByClient: byClient(10),
    clockBestDelayMsP95ByClient: byClient(11),
    clockBestDelayMsP99ByClient: byClient(12),
    echoRoundTripMsP50ByClient: byClient(20),
    echoRoundTripMsP95ByClient: byClient(21),
    echoRoundTripMsP99ByClient: byClient(22),
  }, { declaredClientTags: TAGS });
}

function throws(action) {
  try { action(); return false; } catch { return true; }
}

export default async function harnessDriftPlotSuite() {
  await check('harness drift plot G6: both writers refuse unpublished and refused figures', async () => {
    for (const writer of [driftSeriesCsv, driftSvg]) {
      assertEqual(throws(() => writer({})), true, 'unbranded input is refused');
      assertEqual(throws(() => writer({ published: false })), true, 'publication refusal is refused');
      // Complete in every field but the brand, so only the gate can refuse it.
      assertEqual(throws(() => writer(JSON.parse(JSON.stringify(publishedFixture())))), true, 'G6 unbranded complete figure is refused');
    }
  });

  await check('harness drift plot: CSV grid and SVG polylines use published series only', async () => {
    const published = publishedFixture();
    const expected = 'gridIndex,gridMs,c01,c02,c03\n0,100,1,,0\n1,600,,2,1\n2,1100,3,,2\n3,1600,,4,\n4,2100,5,,4\n';
    assertEqual(driftSeriesCsv(published), expected, 'five hand-computed grid rows retain null cells');
    const svg = driftSvg(published);
    const polylines = [...svg.matchAll(/<polyline\b[^>]*points="([^"]*)"/g)];
    assertEqual(polylines.length, 3, 'one polyline is emitted per client');
    assertEqual(polylines[0][1].trim().split(/\s+/).length, 3, 'c01 has three non-null points');
    assertEqual(polylines[1][1].trim().split(/\s+/).length, 2, 'c02 has two non-null points');
    assertEqual(polylines[2][1].trim().split(/\s+/).length, 4, 'c03 has four non-null points');
    assert(svg.includes('drift (ms)'), 'SVG labels drift in milliseconds');
    assert(svg.includes('time from window start (ms)'), 'SVG labels elapsed time in milliseconds');
    assertEqual((svg.match(/class="criterion"/g) ?? []).length, 2, 'SVG has plus and minus criterion lines');
  });

  await check('harness drift plot: a not-drawn criterion plots the series with no target lines', async () => {
    const published = publishedFixture();
    const notDrawn = publish('drift', { ...published, condition: { name: 'plot', capacityMbps: 10, runLengthMs: 2_000 },
      criterionVerdict: { verdict: 'not-drawn', reason: 'design.md D5' } }, { declaredClientTags: TAGS });
    const svg = driftSvg(notDrawn);
    assertEqual((svg.match(/class="criterion"/g) ?? []).length, 0, 'no criterion line is drawn');
    assertEqual([...svg.matchAll(/<polyline\b/g)].length, 3, 'the three series are still drawn');
    // A verdict that names a criterion but lost its target is still refused.
    const lost = publish('drift', { ...published, condition: { name: 'plot', capacityMbps: 10, runLengthMs: 2_000 },
      criterionVerdict: { statistic: 'median', verdict: 'met' } }, { declaredClientTags: TAGS });
    assertEqual(throws(() => driftSvg(lost)), true, 'a drawn verdict without a target is refused');
  });

  await check('harness drift plot: an hour-long series draws, scaled by its largest sample', async () => {
    const long = () => Array.from({ length: 170_000 }, (_, index) => (index % 7) - 3);
    const series = { c01: long(), c02: long(), c03: long() };
    series.c02[123_456] = -250;
    const svg = driftSvg(publishedFixture(series));
    // Extent 250: the +40 ms line sits at 28 + (250 - 40) / 500 * 388.
    assert(svg.includes('y1="190.960"'), 'the criterion line is placed against the series extent of 250 ms');
    assertEqual([...svg.matchAll(/<polyline\b/g)].length, 3, 'all three long series are drawn');
  });
}
