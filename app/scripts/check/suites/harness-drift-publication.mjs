import { attachClockJoinRecorder } from '../../harness/cdp-records.mjs';
import { driftContext, driftFigure } from '../../figures/drift-context.mjs';
import { DRIFT_FIELDS, isPublishedFigure, publish, requiredContextFields } from '../../figures/publication.mjs';
import { assert, assertEqual, check } from '../harness.mjs';

const TAGS = ['c01', 'c02'];
const WINDOW = { startMs: 0, endMs: 100, excludedPrefixMs: 10, measureWindowMs: 100 };

function settling(settlingMs = 12, correctionsApplied = 1) {
  const value = { settlingMs, mode: 'holding', thresholdUsable: true };
  Object.defineProperty(value, 'correctionsApplied', { value: correctionsApplied, enumerable: false });
  return value;
}

function byClient(value = 1) {
  return { c01: value, c02: value };
}

function completeFigure(overrides = {}) {
  return {
    condition: { name: 'constructed', capacityMbps: 10, runLengthMs: 100, criterion: { statistic: 'median', targetMs: 40 } },
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
    settlingByClient: { c01: settling(), c02: settling() },
    presentIntervalMsByClient: byClient(16.667),
    cadenceClassificationByClient: { c01: 'synthetic-fixed', c02: 'synthetic-fixed' },
    clockFirstEstimateMsByClient: byClient(250),
    clockJoinCountByClient: byClient(1),
    clockProbesAbandonedByClient: byClient(0),
    clockProbeAbandonedFractionByClient: byClient(0),
    driftSeriesByClient: { c01: [1, null, 3], c02: [2, 2, null] },
    epochsByClient: { c01: [1], c02: [1] },
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
    pairwiseDriftPointsUsed: 3,
    excludedMissingRecord: 0,
    excludedEpochMismatch: 0,
    pairwiseDriftAbsMsMedianByPair: { 'c01|c02': 2 },
    pairwiseDriftPointsUsedByPair: { 'c01|c02': 3 },
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
    ...overrides,
  };
}

function deleteField(value, field) {
  const match = field.match(/^([^[]+)\[(.+)\]$/);
  if (match) delete value[match[1]][match[2]];
  else {
    const parts = field.split('.');
    let owner = value;
    for (const part of parts.slice(0, -1)) owner = owner[part];
    delete owner[parts.at(-1)];
  }
}

function fakeTab() {
  const listeners = new Map();
  return {
    on(name, callback) {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
    emit(name, params) { listeners.get(name)?.(params); },
  };
}

function frame(type, timestamp) {
  return { timestamp, response: { payloadData: JSON.stringify({ type }) } };
}

export default async function harnessDriftPublicationSuite() {
  await check('harness drift publication G1: every declared context field refuses by name', async () => {
    const complete = completeFigure();
    const required = requiredContextFields('drift', { declaredClientTags: TAGS });
    // Spec 3.1 item 2, copied by hand so a field dropped from the module is caught here.
    const specFields = ['condition.name', 'condition.capacityMbps', 'condition.runLengthMs', 'window.startMs', 'window.endMs', 'window.excludedPrefixMs', 'window.measureWindowMs', 'content.frameRate', 'uplinkUtilisationMean', 'uplinkUtilisationPeak', 'capacityBitsPerSecond', 'qdiscBacklogBytesMean', 'qdiscOverlimitsInWindow', 'qdiscBacklogNonzeroFraction', 'standingQueueDelayMsP50NearestRank', 'standingQueueDelayMsP99', 'clockHalfWidthMsP50ByClient', 'clockHalfWidthMsP99ByClient', 'clockDelayTermMsP50ByClient', 'clockDelayTermMsP99ByClient', 'clockAgeTermMsP50ByClient', 'clockAgeTermMsP99ByClient', 'controllerBandMsP50ByClient', 'controllerBandMsP99ByClient', 'controllerStoppingThresholdMsP50ByClient', 'controllerStoppingThresholdMsP99ByClient', 'thresholdUsableFractionByClient', 'settlingByClient', 'presentIntervalMsByClient', 'cadenceClassificationByClient', 'instrumentFloorMsP50', 'instrumentFloorMsP99', 'floorDelayTermMsP50', 'floorDelayTermMsP99', 'floorAgeTermMsP50', 'floorAgeTermMsP99', 'floorPresentIntervalMs', 'pairwiseDriftAbsMsMedian', 'pairwiseDriftAbsMsP99', 'criterionVerdict', 'realtimeFactorByClient', 'droppedFrameFractionByClient', 'evaluationSkipsByClient', 'clockBestDelayMsP50ByClient', 'clockBestDelayMsP95ByClient', 'clockBestDelayMsP99ByClient', 'echoRoundTripMsP50ByClient', 'echoRoundTripMsP95ByClient', 'echoRoundTripMsP99ByClient'];
    for (const field of specFields) assert(DRIFT_FIELDS.includes(field), `G1 spec field ${field} is required`);
    const perClientFieldCount = DRIFT_FIELDS.filter((field) => field.endsWith('ByClient')).length;
    assertEqual(required.length, DRIFT_FIELDS.length + perClientFieldCount, 'declared per-client fields expand for both tags');
    const results = required.map((field) => {
      const figure = structuredClone(complete);
      deleteField(figure, field);
      return { field, result: publish('drift', figure, { declaredClientTags: TAGS }) };
    });
    for (const { field, result } of results) {
      assertEqual(result.published, false, `${field} is refused`);
      assertEqual(result.missing, field, `${field} is named`);
    }
    const stableFields = ['condition', 'window', 'content', 'uplinkUtilisationMean', 'uplinkUtilisationPeak', 'capacityBitsPerSecond', 'qdiscBacklogBytesMean', 'qdiscOverlimitsInWindow', 'qdiscBacklogNonzeroFraction', 'standingQueueDelayMsP50NearestRank', 'standingQueueDelayMsP99', 'clockHalfWidthMsP50ByClient', 'clockHalfWidthMsP99ByClient', 'clockDelayTermMsP50ByClient', 'clockDelayTermMsP99ByClient', 'clockAgeTermMsP50ByClient', 'clockAgeTermMsP99ByClient', 'controllerBandMsP50ByClient', 'controllerBandMsP99ByClient', 'controllerStoppingThresholdMsP50ByClient', 'controllerStoppingThresholdMsP99ByClient', 'thresholdUsableFractionByClient', 'settlingByClient', 'presentIntervalMsByClient', 'cadenceClassificationByClient', 'clockFirstEstimateMsByClient', 'clockJoinCountByClient', 'clockProbesAbandonedByClient', 'clockProbeAbandonedFractionByClient', 'driftSeriesByClient', 'epochsByClient', 'pairwiseDriftAbsMsMedian', 'pairwiseDriftAbsMsP99', 'pairwiseDriftAbsMsMedianLowerEnd', 'pairwiseDriftAbsMsP99LowerEnd', 'pairwiseDriftAbsMsMedianUpperEnd', 'pairwiseDriftAbsMsP99UpperEnd', 'instrumentFloorMsP50', 'instrumentFloorMsP99', 'floorDelayTermMsP50', 'floorDelayTermMsP99', 'floorAgeTermMsP50', 'floorAgeTermMsP99', 'floorPresentIntervalMs', 'pairwiseDriftPointsUsed', 'excludedMissingRecord', 'excludedEpochMismatch', 'pairwiseDriftAbsMsMedianByPair', 'pairwiseDriftPointsUsedByPair', 'excludedMissingRecordByPair', 'excludedEpochMismatchByPair', 'pairsWithoutFigure', 'criterionVerdict', 'p99Verdict', 'realtimeFactorByClient', 'droppedFrameFractionByClient', 'evaluationSkipsByClient', 'clockBestDelayMsP50ByClient', 'clockBestDelayMsP95ByClient', 'clockBestDelayMsP99ByClient', 'echoRoundTripMsP50ByClient', 'echoRoundTripMsP95ByClient', 'echoRoundTripMsP99ByClient'];
    const nullFigure = completeFigure({ settlingByClient: { c01: settling(null), c02: settling(null) } });
    const settlingFields = ['mode', 'thresholdUsable'];
    for (const tag of TAGS) for (const field of settlingFields) assertEqual(nullFigure.settlingByClient[tag][field], complete.settlingByClient[tag][field], `${tag} settling ${field} agrees across pair`);
    for (const field of stableFields.filter((field) => field !== 'settlingByClient')) assertEqual(JSON.stringify(complete[field]), JSON.stringify(nullFigure[field]), `${field} agrees across settling pair`);
    const published = publish('drift', nullFigure, { declaredClientTags: TAGS });
    assertEqual(isPublishedFigure(published), true, 'null settling with mode and usability publishes');
  });

  await check('harness drift publication G8: zero settling without correction is refused', async () => {
    const result = publish('drift', completeFigure({ settlingByClient: { c01: settling(0, 0), c02: settling() } }), { declaredClientTags: TAGS });
    assertEqual(result.published, false, 'zero settling is refused');
    assertEqual(result.missing, 'settling-zero-without-correction', 'zero settling names its refusal');
  });

  await check('harness drift publication: context carries clock terms and join burst bars', async () => {
    const clients = {
      c01: {
        records: [
          { displaySharedMs: 10, clock: { halfWidthMs: 3, delayTermMs: 2, ageTermMs: 1 } },
          { displaySharedMs: 20, clock: { halfWidthMs: 5, delayTermMs: 4, ageTermMs: 1 } },
        ],
        polls: [
          { atMs: 10, clock: { probes: { issued: 4, abandoned: 1 }, counters: { impossible: 0 } }, controller: { bandMs: 5, stoppingThresholdMs: 7, thresholdUsable: false, settlingMs: null, mode: 'holding', correctionsApplied: 1 } },
          { atMs: 20, clock: { probes: { issued: 8, abandoned: 2 }, counters: { impossible: 0 } }, controller: { bandMs: 9, stoppingThresholdMs: 11, thresholdUsable: true, settlingMs: 12, mode: 'settled', correctionsApplied: 1 } },
        ],
      },
      c02: { records: [], polls: [] },
    };
    const tab = fakeTab();
    const recorder = attachClockJoinRecorder(tab);
    tab.emit('Network.webSocketFrameReceived', frame('joined', 1));
    tab.emit('Network.webSocketFrameSent', frame('echo', 1.05));
    tab.emit('Network.webSocketFrameReceived', frame('echo-reply', 1.25));
    tab.emit('Network.webSocketFrameReceived', frame('joined', 2));
    tab.emit('Network.webSocketFrameReceived', frame('echo-reply', 2.25));
    const join = recorder.snapshot();
    recorder.dispose();
    const context = driftContext({ clients, tags: TAGS, window: WINDOW, manifest: { cadence: { c01: { presentIntervalMs: 16.667, classification: 'synthetic-fixed' } } }, clockJoin: { c01: join, c02: { timebase: 'cdp-monotonic', joined: [], echoSent: [], echoReplies: [] } } });
    assertEqual(context.clockFirstEstimateMsByClient.c01, 250, 'first estimate is 250ms from matching CDP clocks');
    assertEqual(context.clockJoinCountByClient.c01, 2, 'rejoin increments the join count');
    assertEqual(context.clockProbesAbandonedByClient.c01, 2, 'last poll supplies abandoned probes');
    assertEqual(context.clockProbeAbandonedFractionByClient.c01, 0.25, 'abandoned fraction is 2 / 8');
    assertEqual(context.thresholdUsableFractionByClient.c01, 0.5, 'usable fraction is one true poll of two');
    assertEqual(context.settlingByClient.c01.settlingMs, 12, 'settling uses the last in-window poll');
    assertEqual(context.clockFirstEstimateMsByClient.c02, undefined, 'no reply is absent, never zero');
    const impossible = driftContext({ clients: { c01: { polls: [{ atMs: 20, clock: { counters: { impossible: 1 } } }] } }, tags: ['c01'], window: WINDOW, clockJoin: { c01: join } });
    assertEqual(impossible.clockFirstEstimateMsByClient, undefined, 'impossible clock state removes first estimate');
  });

  await check('harness drift publication: assembly publishes one branded drift figure', async () => {
    const assembled = driftFigure({ figures: completeFigure(), pairwise: {}, context: { declaredClientTags: TAGS }, condition: completeFigure().condition, window: WINDOW, content: { frameRate: 2 } });
    const result = publish('drift', assembled, { declaredClientTags: TAGS });
    assertEqual(isPublishedFigure(result), true, 'drift assembly invokes the publication gate');
  });
}
