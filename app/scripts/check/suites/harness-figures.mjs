// Constructed section-6 arithmetic and publication cases.
// Counter-only fixtures preserve legacy retained-run recomputation. Version 2
// receipts are exercised by receipt-cohort and harness-byte-cohort suites.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeFigures, guardRegimes, PEER_FRACTION_ABS_MAX } from '../../figures/harness-figures.mjs';
import { bytesByClientCsv, publish, utilisationCsv } from '../../figures/publication.mjs';
import { recomputeRunDirectory } from '../../harness-figures.mjs';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';

const WINDOW = { startMs: 0, endMs: 180_000, startSnapshotAtMs: 10, endSnapshotAtMs: 190_000 };

function counters({ media = 0, segment = 0, aborted = 0, byPath = {}, byClient = {} } = {}) {
  return {
    mediaBytesDelivered: media,
    segmentBytesDelivered: segment,
    abortedMediaBytesDelivered: aborted,
    byPath,
    byClient,
  };
}

function threeSegments(hits = 5) {
  return Object.fromEntries([0, 1, 2].map((index) => [`/media/seg-${index}.m4s`, {
    hits,
    completedHits: hits,
    bytesDelivered: hits * 1_000_000,
    expectedBytes: hits * 1_000_000,
  }]));
}

function requestRecord(url, bodyBytes, { startMs = 0, endMs = 100, finished = true, canceled = false } = {}) {
  return {
    requestId: `${url}-${bodyBytes}`,
    url,
    startMs,
    endMs,
    finished,
    canceled,
    headerBytes: 23,
    bodyBytesFromChunks: bodyBytes,
    bodyBytesFromTotal: bodyBytes,
    bodyBytes,
    source: 'total',
  };
}

function pollRecord(atMs, index) {
  return {
    atMs,
    clock: {
      bestDelayMs: [1, 2, 3, 4][index],
      probes: { issued: [0, 1, 3, 4][index] },
      counters: { lost: [0, 0, 1, 1][index] },
    },
    controller: { polls: [100, 101, 103, 104][index] },
    quality: { totalVideoFrames: [0, 1_065, 2_131, 3_197][index], droppedVideoFrames: [0, 0, 0, 1][index] },
    stalls: { epoch: 'constructed-epoch', count: [0, 100, 200, 265][index] },
  };
}

function echoRecord(t1, index) {
  return {
    t1,
    roundTripMs: [10, 20, 30, 40][index],
    probes: { issued: [0, 1, 3, 4][index] },
    counters: { lost: [0, 0, 1, 1][index] },
  };
}

function fixture(overrides = {}) {
  const records = Array.from({ length: 3_037 }, (_, index) => {
    const progress = index / 3_036;
    return {
      displaySharedMs: progress * 180_000,
      mediaMs: progress * 133_200,
      totalVideoFrames: Math.round(progress * 3_197),
      presentedFrames: 1 + Math.round(progress * 3_196),
    };
  });
  return {
    window: WINDOW,
    declaredClientTags: ['A'],
    content: { identity: 'step0-content-media-v1', frameRate: 24 },
    condition: { name: 'constructed', capacityMbps: 10, capacityBitsPerSecond: 10_000_000 },
    capacityBitsPerSecond: 10_000_000,
    originStart: counters({ byClient: { A: { mediaBytesDelivered: 0, abortedMediaBytesDelivered: 0, segmentBytesDelivered: 0, initBytesDelivered: 0 } } }),
    originEnd: counters({ media: 8_000_000, segment: 8_000_000, byClient: { A: { mediaBytesDelivered: 8_000_000, abortedMediaBytesDelivered: 0, segmentBytesDelivered: 8_000_000, initBytesDelivered: 0 } } }),
    clients: {
      A: {
        records,
        requestTimebase: 'measure-window',
        requests: [requestRecord('/media/seg-00000.m4s', 8_000_000)],
        polls: [0, 125, 250, 375].map((atMs, index) => pollRecord(atMs, index)),
        echoRecords: [0, 125, 250, 375].map((t1, index) => echoRecord(t1, index)),
      },
    },
    linkSamples: [
      { atMs: 0, txBytes: 0, qdisc: { backlogBytes: 5, drops: 10, overlimits: 20 } },
      { atMs: 180_000, txBytes: 225_000_000, qdisc: { backlogBytes: 15, drops: 12, overlimits: 23 } },
    ],
    ...overrides,
  };
}

function publicationContext() {
  return {
    declaredClientTags: ['A'],
    condition: { name: 'constructed', capacityMbps: 10 },
    window: WINDOW,
    content: { identity: 'step0-content-media-v1', frameRate: 24 },
    originWasteFraction: 0,
    realtimeFactorByClient: { A: 0.74 },
    stallCountByClient: { A: 265 },
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

export default async function harnessFiguresSuite() {
  await check('harness figures: every arithmetic case uses the declared population', async () => {
    const figures = computeFigures({
      ...fixture({
        originStart: counters({ byPath: {} }),
        originEnd: counters({ media: 15_000_000, segment: 15_000_000, byPath: threeSegments() }),
      }),
    });
    assertNear(figures.hostUploadMultiplier, 5, 1e-12, 'five hits over three distinct 1 MB segments produce multiplier 5');
    assertEqual(figures.distinctSegmentsCompletedInWindow, 3, 'three completed segment paths are distinct');
    assertEqual(figures.segmentHitsInWindow, 15, 'three paths with five hits produce 15 hits');
    assertEqual(figures.distinctSegmentsPartialOnlyInWindow, 0, 'no partial-only path is counted as completed');
    assertNear(figures.originWasteFraction, 0, 1e-12, 'complete segments have no waste');

    const starved = computeFigures({
      ...fixture({
        originStart: counters({ byPath: {} }),
        originEnd: counters({ media: 15_000_000, segment: 15_000_000, byPath: threeSegments() }),
        window: { ...WINDOW, endMs: 40_000 },
      }),
    });
    assertNear(starved.hostUploadMultiplier, 5, 1e-12, 'wall-clock spanning 40 segments does not change the distinct-segment denominator');

    const waste = computeFigures({
      ...fixture({
        originStart: counters(),
        originEnd: counters({ media: 10_000_000, segment: 10_000_000, aborted: 250_000 }),
      }),
    });
    assertNear(waste.originWasteFraction, 0.025, 1e-12, '250 KB waste over 10 MB delivered is 0.025');
  });

  await check('harness figures: peer fractions are two-sided and impossible values hard-error', async () => {
    const clean = computeFigures(fixture());
    assertNear(clean.peerByteFractionByClient.A, 0, 1e-12, 'equal origin and client bytes produce zero peer fraction');
    assert(Math.abs(clean.peerByteFractionByClient.A) <= PEER_FRACTION_ABS_MAX, 'the control fraction meets the two-sided tolerance');
    assertNear(clean.originVsClientBytesByClient.A.differenceBytes, 0, 1e-12, 'completed origin and client totals agree');

    let error;
    try {
      computeFigures(fixture({ clients: { A: { ...fixture().clients.A, requests: [requestRecord('/media/seg-00000.m4s', 8_000_000)] } }, originEnd: counters({ media: 9_000_000, segment: 9_000_000, byClient: { A: { mediaBytesDelivered: 9_000_000, abortedMediaBytesDelivered: 0 } } }) }));
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, 'an origin total above the client total is physically impossible');
    assert(error.message.includes('peerByteFractionByClient[A]'), 'the impossible fraction names its client field');
  });

  await check('harness figures: CDP request arithmetic excludes overhead and separates canceled media', async () => {
    const requests = [
      requestRecord('/media/before.m4s', 90, { startMs: -100, endMs: -1 }),
      requestRecord('/index.html', 500, { startMs: 0, endMs: 100 }),
      requestRecord('/assets/player.js', 700, { startMs: 0, endMs: 100 }),
      requestRecord('/media/master.m3u8', 1_000, { startMs: 0, endMs: 100 }),
      requestRecord('/other/not-media.m4s', 2_000, { startMs: 0, endMs: 100 }),
      requestRecord('/media/seg-00000.m4s', 8_000_000, { startMs: 50, endMs: 100 }),
      requestRecord('/media/init.mp4', 1_000, { startMs: 80, endMs: 140 }),
      requestRecord('/media/seg-00001.m4s', 250_000, { startMs: 100, endMs: 140, finished: false, canceled: true }),
      requestRecord('/media/after.m4s', 120, { startMs: 180_000, endMs: 180_001 }),
      requestRecord('/media/failed.m4s', 333, { startMs: 80, endMs: 100, finished: false }),
    ];
    const figures = computeFigures(fixture({
      originEnd: counters({ media: 8_301_000, segment: 8_001_000, aborted: 300_000, byClient: { A: { mediaBytesDelivered: 8_301_000, abortedMediaBytesDelivered: 300_000, segmentBytesDelivered: 8_001_000, initBytesDelivered: 0 } } }),
      clients: { A: { ...fixture().clients.A, requests } },
    }));
    assertEqual(figures.clientReceivedMediaBytesByClient.A, 8_001_000, 'only completed .m4s and .mp4 body bytes are counted');
    assertEqual(figures.originMediaBytesByClient.A, 8_001_000, 'completed origin bytes exclude origin aborted waste');
    assertEqual(figures.originVsClientBytesByClient.A.differenceBytes, 0, 'canceled media is removed from completed origin/client totals');
    assertNear(figures.peerByteFractionByClient.A, 0, 1e-12, 'overhead and canceled bytes do not alter the completed peer fraction');
    assertEqual(figures.abortedQueuedResidualBytesByClient.A, 50_000, 'canceled media body contributes to the aborted queued residual');
    const missingTimebase = computeFigures(fixture({ clients: { A: { ...fixture().clients.A, requestTimebase: undefined } } }));
    assertEqual(missingTimebase.clientReceivedMediaBytesByClient?.A, undefined, 'missing CDP timebase contract leaves request bytes unavailable');
  });

  await check('harness figures: timestamp-less records do not enter a declared window', async () => {
    const base = fixture().clients.A;
    const figures = computeFigures(fixture({
      clients: { A: { ...base, records: [{ mediaMs: -1_000, totalVideoFrames: 99_999 }, ...base.records] } },
    }));
    assertNear(figures.realtimeFactorByClient.A, 0.74, 1e-12, 'finite-window realtime ignores timestamp-less records');
  });

  await check('harness figures: realtime quality, coverage, utilisation and skip fields retain populations', async () => {
    const figures = computeFigures(fixture());
    assertNear(figures.realtimeFactorByClient.A, 0.74, 1e-12, 'media over shared time is 0.74 realtime');
    assertNear(figures.realtimeFactorFromFrameQualityByClient.A, 3_197 / (24 * 180), 1e-12, 'frame quality uses total video frames over the window');
    assertNear(figures.coverageRatioByClient.A, 3_037 / 3_197, 1e-12, 'coverage uses canonical drift records over presented frames');
    assertEqual(figures.stallCountByClient.A, 265, 'stall count is a windowed poll counter delta');
    assertNear(figures.droppedFrameFractionByClient.A, 1 / 3_197, 1e-12, 'dropped frames divide by total video frames, which includes dropped frames');
    assert(Math.abs(figures.droppedFrameFractionByClient.A - (1 / 3_198)) > 1e-12, 'dropped-frame denominator does not add dropped frames twice');
    const edgePolls = fixture().clients.A.polls.map((record) => ({ ...record, quality: { ...record.quality } }));
    edgePolls.forEach((record, index) => {
      record.quality.totalVideoFrames = [0, 25, 50, 100][index];
      record.quality.droppedVideoFrames = [0, 0, 0, 2][index];
    });
    const edge = computeFigures(fixture({ clients: { A: { ...fixture().clients.A, polls: edgePolls } } }));
    assertNear(edge.droppedFrameFractionByClient.A, 0.02, 1e-12, 'the declared 0.02 dropped-frame bar is represented exactly at its edge');
    assertEqual(figures.presentedFramesByClient.A, 3_197, 'presented frame count is retained');
    assertNear(figures.uplinkUtilisationMean, 1, 1e-12, '225 MB over 180 seconds at 10 Mbps is full utilisation');
    assertNear(figures.uplinkUtilisationPeak, 1, 1e-12, 'the only link interval has full utilisation');
    assertEqual(figures.qdiscBacklogBytesPeak, 15, 'qdisc peak is read from qdisc samples');
    assertEqual(figures.qdiscDropsInWindow, 2, 'qdisc drops are a counter difference');
    assertEqual(figures.qdiscOverlimitsInWindow, 3, 'qdisc overlimits are a counter difference');
    assertEqual(figures.evaluationSkipsByClient.A, 1, '100, 101, 103, 104 has one skipped evaluation');
    assertEqual(figures.pollIntervalMsP50.A, 125, 'poll p50 uses the declared interval samples');
    assertEqual(figures.pollIntervalMsP95.A, 125, 'poll p95 uses nearest rank');
    assertEqual(figures.pollIntervalMsMax.A, 125, 'poll max names the poll interval population');
  });

  await check('harness figures: clock best-delay and echo round-trip fields name separate populations', async () => {
    const figures = computeFigures(fixture());
    assertEqual(figures.clockBestDelayMsP50ByClient.A, 2.5, 'clock p50 is from best-delay samples');
    assertEqual(figures.clockBestDelayMsP95ByClient.A, 4, 'clock p95 is nearest-rank');
    assertEqual(figures.clockBestDelayMsP99ByClient.A, 4, 'clock p99 is nearest-rank');
    assertEqual(figures.clockLossFraction.A, 0.25, 'clock loss is lost over issued probes');
    assertEqual(figures.echoRoundTripMsP50ByClient.A, 25, 'echo p50 is from round-trip samples');
    assertEqual(figures.echoRoundTripMsP95ByClient.A, 40, 'echo p95 is nearest-rank');
    assertEqual(figures.echoRoundTripMsP99ByClient.A, 40, 'echo p99 is nearest-rank');
    assertEqual(figures.echoLossFraction.A, 0.25, 'echo loss is separate from clock loss');
  });

  // The records above carry cumulative probe counters. echo-probe.mjs writes
  // exactly { seq, t1, t4, rttMs, lost } per probe, and a lost probe has no t4
  // (d1-findings.md Q2). The edge probes separate placement by t1 from by t4.
  await check('harness figures: echo loss reads the flag echo-probe.mjs actually writes', async () => {
    const probe = (seq, t1, rttMs) => (rttMs === null
      ? { seq, t1, t4: null, rttMs: null, lost: true }
      : { seq, t1, t4: t1 + rttMs, rttMs, lost: false });
    const emitted = [
      probe(0, -5, 25),
      probe(1, 0, 10),
      probe(2, 125, 20),
      probe(3, 250, null),
      probe(4, 375, 40),
      probe(5, 179_990, 40),
    ];
    const input = fixture();
    const figures = computeFigures({ ...input, clients: { A: { ...input.clients.A, echoRecords: emitted } } });
    assertEqual(figures.echoLossFraction.A, 0.2, 'one lost probe in five sent inside the window');
    assertEqual(figures.echoRoundTripMsP50ByClient.A, 30, 'round trips of probes sent inside the window, the lost one contributing none');
    assertEqual(figures.echoRoundTripMsP99ByClient.A, 40, 'the surviving samples keep nearest rank');
  });

  await check('harness figures: publication refuses exact missing context and CSV has no side door', async () => {
    const missing = publish('byte', {}, { condition: { name: 'constructed', capacityMbps: 10 }, window: WINDOW, content: { identity: 'x', frameRate: 24 }, declaredClientTags: ['A'], realtimeFactorByClient: { A: 0.74 }, stallCountByClient: { A: 1 } });
    assertEqual(missing.published, false, 'a byte figure without waste context is refused');
    assertEqual(missing.missing, 'originWasteFraction', 'the refusal names originWasteFraction');
    let csvError;
    try {
      bytesByClientCsv({ peerByteFractionByClient: { A: 0 } });
    } catch (error) {
      csvError = error;
    }
    assert(csvError?.message.includes('published figure'), 'raw arithmetic cannot bypass publication into CSV');
    const published = publish('byte', computeFigures(fixture()), publicationContext());
    assert(published && !published.published, 'a successful publication is the figure itself, not a refusal wrapper');
    assert(bytesByClientCsv(published).startsWith('tag,originMediaBytes'), 'byte CSV is generated only from the branded published figure');
    assert(utilisationCsv(published).startsWith('uplinkUtilisationMean'), 'utilisation CSV is generated from the same publication');
  });

  await check('harness figures: regime guard names both incompatible conditions', async () => {
    const result = guardRegimes([
      { name: 'baseline-nop2p-10', condition: { capacityMbps: 10, clients: 2 } },
      { name: 'baseline-nop2p-8', condition: { capacityMbps: 8, clients: 2 } },
    ]);
    assertEqual(result.combined, false, 'different capacities cannot produce a combined figure');
    assert(result.reason.includes('baseline-nop2p-10') && result.reason.includes('baseline-nop2p-8'), 'regime refusal names both conditions');
  });

  await check('harness figures: retained-directory recomputation is deeply identical', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-figures-'));
    try {
      const input = fixture();
      writeJson(path.join(runDir, 'manifest.json'), {
        condition: input.condition,
        window: input.window,
        content: input.content,
        declaredClientTags: ['A'],
        context: publicationContext(),
        clients: { A: { requestTimebase: 'measure-window' } },
      });
      writeJson(path.join(runDir, 'origin-counters-start.json'), input.originStart);
      writeJson(path.join(runDir, 'origin-counters-end.json'), input.originEnd);
      fs.writeFileSync(path.join(runDir, 'client-A.drift.ndjson'), input.clients.A.records.map((record) => JSON.stringify(record)).join('\n'));
      fs.writeFileSync(path.join(runDir, 'client-A.poll.ndjson'), input.clients.A.polls.map((record) => JSON.stringify(record)).join('\n'));
      fs.writeFileSync(path.join(runDir, 'client-A.requests.ndjson'), input.clients.A.requests.map((record) => JSON.stringify(record)).join('\n'));
      fs.writeFileSync(path.join(runDir, 'client-A.echo.ndjson'), input.clients.A.echoRecords.map((record) => JSON.stringify(record)).join('\n'));
      fs.writeFileSync(path.join(runDir, 'origin-link.ndjson'), input.linkSamples.map((record) => JSON.stringify(record)).join('\n'));
      const first = recomputeRunDirectory(runDir);
      const second = recomputeRunDirectory(runDir);
      assertEqual(JSON.stringify(first.figures), JSON.stringify(second.figures), 'two offline recomputations match every arithmetic value');
      assertEqual(JSON.stringify(first.publishedByte), JSON.stringify(second.publishedByte), 'two offline recomputations match byte-for-byte');
      assertEqual(JSON.stringify(first.csv), JSON.stringify(second.csv), 'two offline CSV generations match byte-for-byte');

      const drift = input.clients.A.records.map((record) => ({ ...record }));
      drift.at(-1).mediaMs = 100_000;
      fs.writeFileSync(path.join(runDir, 'client-A.drift.ndjson'), drift.map((record) => JSON.stringify(record)).join('\n'));
      assert(first.figures.realtimeFactorByClient.A !== recomputeRunDirectory(runDir).figures.realtimeFactorByClient.A, 'canonical drift stream changes realtime recomputation');
      fs.writeFileSync(path.join(runDir, 'client-A.drift.ndjson'), input.clients.A.records.map((record) => JSON.stringify(record)).join('\n'));

      const requests = input.clients.A.requests.map((record) => ({ ...record }));
      requests[0].bodyBytes += 1_000;
      fs.writeFileSync(path.join(runDir, 'client-A.requests.ndjson'), requests.map((record) => JSON.stringify(record)).join('\n'));
      assertEqual(recomputeRunDirectory(runDir).figures.clientReceivedMediaBytesByClient.A, 8_001_000, 'request prefix outside the window is excluded from recomputation');
      requests.find((record) => record.url === '/media/seg-00000.m4s').bodyBytes += 1_000;
      fs.writeFileSync(path.join(runDir, 'client-A.requests.ndjson'), requests.map((record) => JSON.stringify(record)).join('\n'));
      assertEqual(recomputeRunDirectory(runDir).figures.clientReceivedMediaBytesByClient.A, 8_002_000, 'canonical requests stream changes in-window body recomputation');
      fs.writeFileSync(path.join(runDir, 'client-A.requests.ndjson'), input.clients.A.requests.map((record) => JSON.stringify(record)).join('\n'));

      const polls = input.clients.A.polls.map((record) => ({ ...record, clock: { ...record.clock }, stalls: { ...record.stalls } }));
      polls.at(-1).clock.bestDelayMs = 40;
      polls.at(-1).stalls.count = 300;
      fs.writeFileSync(path.join(runDir, 'client-A.poll.ndjson'), polls.map((record) => JSON.stringify(record)).join('\n'));
      const pollChanged = recomputeRunDirectory(runDir).figures;
      assertEqual(pollChanged.stallCountByClient.A, 300, 'canonical poll stream supplies the window stall delta');
      assertEqual(pollChanged.clockBestDelayMsP99ByClient.A, 40, 'canonical poll stream supplies clock best-delay distribution');
      fs.writeFileSync(path.join(runDir, 'client-A.poll.ndjson'), input.clients.A.polls.map((record) => JSON.stringify(record)).join('\n'));

      const echo = input.clients.A.echoRecords.map((record) => ({ ...record }));
      echo[0].roundTripMs = 100;
      fs.writeFileSync(path.join(runDir, 'client-A.echo.ndjson'), echo.map((record) => JSON.stringify(record)).join('\n'));
      assertEqual(recomputeRunDirectory(runDir).figures.echoRoundTripMsP50ByClient.A, 35, 'canonical echo stream supplies round-trip distribution');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
}
