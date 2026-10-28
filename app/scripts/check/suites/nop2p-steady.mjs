import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';
import { computeNoP2pSteady } from '../../figures/nop2p-steady.mjs';
import { publish } from '../../figures/publication.mjs';

const BARS = {
  steadyUtilisationMax: 0.90,
  steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25,
  steadyRealtimeMin: 0.98,
};
const TAGS = ['c01', 'c02', 'c03', 'c04', 'c05'];

function request(tag, id = tag) {
  return { requestId: `${tag}-${id}`, url: '/media/seg-0.m4s', endMs: 500, finished: true,
    canceled: false, bodyBytes: 1_000, originResponseId: `${tag}-${id}` };
}

function fixture(txBytes = 375_000) {
  const byClient = Object.fromEntries(TAGS.map((tag) => [tag, {
    mediaBytesDelivered: 1_000, abortedMediaBytesDelivered: 0,
    segmentBytesDelivered: 1_000, initBytesDelivered: 0,
  }]));
  const records = [{ displaySharedMs: 0, scheduledMediaMs: 0, mediaMs: 0 },
    { displaySharedMs: 500, scheduledMediaMs: 500, mediaMs: 500 },
    { displaySharedMs: 1_000, scheduledMediaMs: 1_000, mediaMs: 1_000 }];
  const clients = Object.fromEntries(TAGS.map((tag) => [tag, {
    records, requestTimebase: 'measure-window', requests: [request(tag)],
    polls: [{ atMs: 0, controller: { polls: 0 }, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 }, stalls: { epoch: 'e', count: 0 } },
      { atMs: 1_000, controller: { polls: 4 }, quality: { totalVideoFrames: 24, droppedVideoFrames: 0 }, stalls: { epoch: 'e', count: 0 } }],
  }]));
  return {
    byteAccountingMethod: 'client-receipt-cohort-v1', multiplierDenominator: 'one-viewing',
    declaredClientTags: TAGS, window: { startMs: 0, endMs: 1_000, startSnapshotAtMs: 0, endSnapshotAtMs: 1_000 },
    content: { identity: 'constructed', frameRate: 24, segmentSizes: [1_000] }, segmentSeconds: 1,
    condition: { name: 'baseline-nop2p-steady', delivery: 'host', capacityMbps: 10, bars: BARS },
    capacityBitsPerSecond: 10_000_000, clients,
    originStart: { mediaBytesDelivered: 0, segmentBytesDelivered: 0, abortedMediaBytesDelivered: 0,
      byPath: {}, byClient: Object.fromEntries(TAGS.map((tag) => [tag, { mediaBytesDelivered: 0,
        abortedMediaBytesDelivered: 0, segmentBytesDelivered: 0, initBytesDelivered: 0 }])) },
    originEnd: { responseAccountingVersion: 2, mediaBytesDelivered: 5_000, segmentBytesDelivered: 5_000,
      abortedMediaBytesDelivered: 0, byPath: { '/media/seg-0.m4s': { hits: 5, completedHits: 5,
        bytesDelivered: 5_000, expectedBytes: 5_000 } }, byClient, responseRecords: TAGS.map((tag) => ({
          originResponseId: `${tag}-${tag}`, clientTag: tag, urlPath: '/media/seg-0.m4s', delivered: 1_000, aborted: false,
        })) },
    linkSamples: [{ atMs: 0, txBytes: 0, qdisc: { drops: 0, overlimits: 0 } },
      { atMs: 1_000, txBytes, qdisc: { drops: 0, overlimits: 0 } }],
  };
}

export default async function nop2pSteadySuite() {
  await check('no-P2P steady: five receipts divide host bytes by one viewing', async () => {
    const input = fixture();
    const figures = computeFigures(input);
    assertEqual(figures.multiplierDenominator, 'one-viewing', 'bars select one-viewing');
    assertNear(figures.oneViewingBytesInWindow, 1_000, 0, 'one viewing is the room stretch');
    assertNear(figures.hostUploadMultiplier, 5, 1e-12, 'five copies read five');
    assertEqual(figures.steadyState.steady, true, 'all steady legs pass');
    const published = publish('byte', figures, { ...input, declaredClientTags: TAGS });
    assertEqual(published.published, undefined, 'steady host figure is published');
  });

  await check('no-P2P steady: full uplink refuses the multiplier by utilisation', async () => {
    const figures = computeFigures(fixture(1_187_500));
    assertEqual(figures.hostUploadMultiplier, undefined, 'full uplink has no multiplier');
    assertEqual(figures.hostUploadMultiplierRefusal.reason, 'steady-state-utilisation', 'utilisation refusal is named');
    assertNear(figures.hostUploadMultiplierRefusal.failedLegs[0].value.value, 0.95, 1e-12, 'refusal carries utilisation value');
  });

  await check('no-P2P steady: undeclared bars retain distinct-completed arithmetic', async () => {
    const input = fixture();
    input.multiplierDenominator = 'distinct-completed';
    input.condition.bars = {};
    const figures = computeFigures(input);
    assertEqual(figures.multiplierDenominator, undefined, 'legacy arithmetic does not add one-viewing fields');
    assertNear(figures.hostUploadMultiplier, 5, 1e-12, 'legacy denominator remains distinct completed');
  });

  await check('no-P2P boundary loss holds the end and keeps playback figures', async () => {
    const input = fixture();
    input.clients.c01.records = [input.clients.c01.records[0], { displaySharedMs: 600, scheduledMediaMs: 600, mediaMs: 600 }];
    const figures = computeFigures(input);
    assert(figures.hostUploadMultiplier !== undefined || figures.hostUploadMultiplierRefusal?.reason.startsWith('steady-state-'), 'steady legs decide multiplier');
    const oneViewing = computeNoP2pSteady({ input, figures, tags: TAGS });
    assertEqual(oneViewing.playedMediaMsByClient.c01.end, 600, 'played end holds the last record');
    assertEqual(oneViewing.oneViewingHeldByClient.c01.end, 'held-last', 'held end is listed');
    assertEqual(figures.oneViewingBytesInWindow, 1000, 'one-viewing bytes remain available');
    assertEqual(figures.roomPositionSpreadMs.end, 0, 'room spread remains available');
    const realtime = TAGS.map((tag) => figures.realtimeFactorByClient?.[tag]);
    const stalls = TAGS.map((tag) => figures.stallCountByClient?.[tag]);
    assert(realtime.every(Number.isFinite), 'all five realtime factors remain finite');
    assert(stalls.every(Number.isFinite), 'all five stall counts remain finite');
    const published = publish('byte', figures, { ...input, declaredClientTags: TAGS });
    assert(published.published !== false, 'playback byte figure remains publishable without the multiplier');
    input.clients.c01.records = [];
    const missing = computeFigures(input);
    assertEqual(missing.hostUploadMultiplier, undefined, 'no records withholds multiplier');
    assertEqual(missing.hostUploadMultiplierRefusal?.reason, 'one-viewing-unavailable', 'no records names refusal');
    assert(TAGS.slice(1).every((tag) => Number.isFinite(missing.realtimeFactorByClient[tag])), 'other realtime factors remain');
    const otherRefusal = publish('byte', { ...figures, oneViewingBytesInWindow: undefined,
      hostUploadMultiplierRefusal: { reason: 'steady-state-utilisation' } }, { ...input, declaredClientTags: TAGS });
    assertEqual(otherRefusal.published, false, 'other refusals still require the complete one-viewing shape');
    assertEqual(otherRefusal.missing, 'oneViewingBytesInWindow', 'other refusal names the omitted one-viewing field');
  });
}
