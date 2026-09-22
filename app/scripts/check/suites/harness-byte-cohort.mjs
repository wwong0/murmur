import fs from 'node:fs';
import { check, assert, assertEqual } from '../harness.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';
import { isPublishedFigure, publish } from '../../figures/publication.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';
import { decideFinalization } from '../../harness-run.mjs';

const METHOD = 'client-receipt-cohort-v1';
const tags = ['A', 'B'];
const media = (id, tag, path, bytes) => ({
  originResponseId: id, clientTag: tag, urlPath: `/media/${path}.m4s`,
  kind: 'segment', delivered: bytes, expectedBytes: bytes, aborted: false,
});
const receipt = (id, path, bytes, endMs) => ({
  originResponseId: id, url: `http://origin/media/${path}.m4s`, bodyBytes: bytes,
  startMs: 5, endMs, finished: true, canceled: false,
});
const initResponse = (id, tag, bytes) => ({
  originResponseId: id, clientTag: tag, urlPath: '/media/init.mp4',
  kind: 'init', delivered: bytes, expectedBytes: bytes, aborted: false,
});
const initReceipt = (id, bytes, endMs) => ({
  originResponseId: id, url: 'http://origin/media/init.mp4', bodyBytes: bytes,
  startMs: 5, endMs, finished: true, canceled: false,
});
const pathBucket = (bytes, hits) => ({ hits, completedHits: hits, bytesDelivered: bytes, expectedBytes: bytes });
const clientBucket = (bytes) => ({ mediaBytesDelivered: bytes, abortedMediaBytesDelivered: 0, segmentBytesDelivered: bytes, initBytesDelivered: 0 });

function fixture() {
  const polls = [10, 20].map((atMs, i) => ({
    atMs, stalls: { epoch: 'one', count: 0 }, controller: { polls: i },
    quality: { totalVideoFrames: 24 * i, droppedVideoFrames: 0 },
  }));
  const records = [11, 19].map((displaySharedMs, i) => ({
    displaySharedMs, mediaMs: displaySharedMs, seq: i + 1, presentedFrames: i + 1,
  }));
  return {
    byteAccountingMethod: METHOD,
    declaredClientTags: tags,
    window: { startMs: 10, endMs: 20, startSnapshotAtMs: 10, endSnapshotAtMs: 20 },
    content: { identity: 'constructed', frameRate: 24 },
    condition: { name: 'baseline-control-fixture', capacityMbps: 10, publishes: true,
      bars: { recordCoverageMin: 0.95, droppedFrameFractionMax: 0.02,
        peerFractionAbsMax: 0.02, originClientAgreementAbsMax: 0.02 } },
    cadence: Object.fromEntries(tags.map((tag) => [tag, { classification: 'synthetic-fixed', presentIntervalMs: 16.7 }])),
    cdpQualification: { status: 'passed', statSizeBytes: 100, bodyBytesFromChunks: 100, bodyBytesFromTotal: 100 },
    originStart: {
      responseAccountingVersion: 2, mediaBytesDelivered: 100, abortedMediaBytesDelivered: 0,
      byPath: { '/media/a.m4s': pathBucket(100, 1) }, byClient: { A: clientBucket(100) },
      responseRecords: [media('1:1', 'A', 'a', 100)],
    },
    originEnd: {
      responseAccountingVersion: 2, mediaBytesDelivered: 350, abortedMediaBytesDelivered: 0,
      byPath: { '/media/a.m4s': pathBucket(200, 2), '/media/b.m4s': pathBucket(150, 1) },
      byClient: { A: clientBucket(250), B: clientBucket(100) },
      responseRecords: [media('1:1', 'A', 'a', 100), media('1:2', 'A', 'b', 150), media('2:1', 'B', 'a', 100)],
    },
    clients: Object.fromEntries(tags.map((tag) => [tag, {
      requestTimebase: 'measure-window',
      requests: tag === 'A' ? [receipt('1:1', 'a', 100, 12), receipt('1:2', 'b', 150, 22)] : [receipt('2:1', 'a', 100, 15)],
      polls, records, finalPlayback: { begun: 1 }, driftLogMissed: 0, maxDriftDrainGapMs: 1,
    }])),
  };
}

function evaluate(input, figures = computeFigures(input)) {
  const context = { ...input, ...figures };
  return { figures, evaluation: evaluateRefusals({ ...input, publicationContext: context }),
    publishedByte: publish('byte', figures, context) };
}

function initOnlyFixture() {
  const input = fixture();
  input.originStart = {
    responseAccountingVersion: 2, mediaBytesDelivered: 0, abortedMediaBytesDelivered: 0,
    byPath: {}, byClient: { A: clientBucket(0), B: clientBucket(0) }, responseRecords: [],
  };
  input.originEnd = {
    responseAccountingVersion: 2, mediaBytesDelivered: 200, abortedMediaBytesDelivered: 0,
    byPath: { '/media/init.mp4': pathBucket(200, 2) },
    byClient: { A: clientBucket(100), B: clientBucket(100) },
    responseRecords: [initResponse('init:1', 'A', 100), initResponse('init:2', 'B', 100)],
  };
  input.clients = Object.fromEntries(tags.map((tag, index) => [tag, {
    ...input.clients[tag],
    requests: [initReceipt(`init:${index + 1}`, 100, 12 + index)],
  }]));
  return input;
}

export default async function harnessByteCohortSuite() {
  await check('byte cohort integration: both boundaries match receipts and the denominator counts the client union', async () => {
    const { figures, evaluation, publishedByte } = evaluate(fixture());
    assertEqual(figures.byteAccountingMethod, METHOD, 'the published method is explicit');
    assertEqual(figures.peerByteFractionByClient.A, 0, 'pre-window origin completion matches its in-window receipt');
    assertEqual(figures.peerByteFractionByClient.B, 0, 'second independent client matches');
    assertEqual(figures.originMediaBytesByClient.A, 100, 'end-straddling response is excluded on both sides');
    assertEqual(figures.distinctSegmentBytesConsumedInWindow, 100, 'one client-received path is counted once');
    assertEqual(figures.hostUploadMultiplier, 2.5, '250 upload bytes over the received union of 100 bytes');
    assertEqual(evaluation.refused, false, 'all original gates and both controls pass');
    assert(isPublishedFigure(publishedByte), 'eligible byte evidence receives the publication brand');
    assertEqual(decideFinalization({ evaluation, recomputed: { publishedByte } }).writeByte, true, 'eligible evidence reaches publication');
  });

  await check('byte cohort integration: unequal instruments remain unequal and stop baseline publication', async () => {
    const input = fixture();
    input.originEnd.responseRecords[0].delivered = 97;
    const { figures, evaluation, publishedByte } = evaluate(input);
    assert(Math.abs(figures.peerByteFractionByClient.A - 0.03) < 1e-12, 'a real 3 percent discrepancy is not clamped away');
    assert(evaluation.reasonSet.includes('peer-byte-control-above-declared-bar'), 'declared peer control rejects it');
    assert(evaluation.reasonSet.includes('origin-client-agreement-above-declared-bar'), 'independent declared agreement control rejects it');
    assertEqual(publishedByte.published, false, 'offline recomputation cannot publish the failed control either');
    const final = decideFinalization({ evaluation, recomputed: { publishedByte } });
    assertEqual(final.exitCode, 1, 'failed control exits nonzero');
    assertEqual(final.writeByte, false, 'failed control cannot write byte output');
    assertEqual(evaluation.figures.drift, true, 'byte-only failure preserves unrelated eligibility');
  });

  await check('byte cohort integration: controls use both signs and the condition setting', async () => {
    const input = fixture();
    const figures = computeFigures(input);
    for (const value of [-0.021, 0.021]) {
      const changed = { ...figures, peerByteFractionByClient: { A: value, B: 0 } };
      assert(evaluate(input, changed).evaluation.reasonSet.includes('peer-byte-control-above-declared-bar'), 'both signs beyond 2 percent refuse');
      const wider = structuredClone(input);
      wider.condition.bars.peerFractionAbsMax = 0.03;
      assertEqual(evaluate(wider, changed).evaluation.refused, false, 'the declared 3 percent bar is actually read');
    }
    for (const value of [-0.02, 0.02]) {
      assertEqual(evaluate(input, { ...figures, peerByteFractionByClient: { A: value, B: 0 } }).evaluation.refused, false, 'exact boundary is inclusive');
    }
    const mismatch = { ...figures, originVsClientBytesByClient: { A: { differenceFraction: -0.021 }, B: { differenceFraction: 0 } } };
    assert(evaluate(input, mismatch).evaluation.reasonSet.includes('origin-client-agreement-above-declared-bar'), 'agreement has its own opportunity independent of peer fraction');
  });

  await check('byte cohort integration: missing figures and stale accounting cannot publish', async () => {
    const input = fixture();
    const figures = computeFigures(input);
    for (const [field, reason] of [['peerByteFractionByClient', 'peer-byte-control-unavailable'], ['originVsClientBytesByClient', 'origin-client-agreement-unavailable']]) {
      const broken = { ...figures, [field]: { B: figures[field].B } };
      const result = evaluate(input, broken);
      assert(result.evaluation.reasonSet.includes(reason), 'missing per-client control is named');
      assertEqual(result.publishedByte.published, false, 'offline publication also refuses absent evidence');
      assertEqual(decideFinalization({ evaluation: result.evaluation, recomputed: result }).writeByte, false, 'finalization preserves the refusal');
    }
    const stale = structuredClone(input);
    delete stale.originEnd.responseAccountingVersion;
    let error;
    try { computeFigures(stale); } catch (caught) { error = caught; }
    assert(error instanceof Error, 'a declared new run cannot use a stale origin schema');
    const legacy = { ...figures };
    delete legacy.byteAccountingMethod;
    assertEqual(publish('byte', legacy, input).published, false, 'new context cannot publish an unmarked legacy figure');
  });

  await check('byte cohort integration: new-method publication reads and validates figure populations', async () => {
    const input = fixture();
    const figures = computeFigures(input);
    const context = { ...input, ...figures };
    const cases = [
      ['hostUploadMultiplier', undefined, 'missing multiplier is refused'],
      ['hostUploadMultiplier', Number.POSITIVE_INFINITY, 'nonfinite multiplier is refused'],
      ['hostUploadMultiplier', -1, 'negative multiplier is refused'],
      ['distinctSegmentBytesConsumedInWindow', undefined, 'missing distinct bytes are refused'],
      ['distinctSegmentBytesConsumedInWindow', Number.NaN, 'nonfinite distinct bytes are refused'],
      ['distinctSegmentBytesConsumedInWindow', 0, 'zero distinct bytes are refused'],
      ['originSegmentBytesDeliveredInWindow', undefined, 'missing origin bytes are refused'],
      ['originSegmentBytesDeliveredInWindow', Number.NaN, 'nonfinite origin bytes are refused'],
      ['originSegmentBytesDeliveredInWindow', -1, 'negative origin bytes are refused'],
      ['distinctSegmentsCompletedInWindow', undefined, 'missing segment count is refused'],
      ['distinctSegmentsCompletedInWindow', 0, 'zero segment count is refused'],
      ['distinctSegmentsCompletedInWindow', 1.5, 'fractional segment count is refused'],
    ];
    for (const [field, value, message] of cases) {
      const broken = { ...figures };
      if (value === undefined) delete broken[field];
      else broken[field] = value;
      const published = publish('byte', broken, context);
      assertEqual(published.published, false, message);
      assertEqual(published.missing, field, `${message} by exact field`);
      assertEqual(decideFinalization({ evaluation: { refused: false }, recomputed: { publishedByte: published } }).writeByte, false, `${message} at finalization`);
    }
  });

  await check('byte cohort integration: zero origin numerator is valid and init-only cohorts refuse by denominator', async () => {
    const input = fixture();
    const figures = computeFigures(input);
    const zeroOrigin = { ...figures, originSegmentBytesDeliveredInWindow: 0, hostUploadMultiplier: 0 };
    const context = { ...input, ...figures };
    const publishedZero = publish('byte', zeroOrigin, context);
    assert(isPublishedFigure(publishedZero), 'zero origin numerator and multiplier remain publishable');
    assertEqual(decideFinalization({ evaluation: { refused: false }, recomputed: { publishedByte: publishedZero } }).writeByte, true, 'zero numerator reaches finalization');

    const initInput = initOnlyFixture();
    const initFigures = computeFigures(initInput);
    assertEqual(initFigures.distinctSegmentsCompletedInWindow, 0, 'init-only cohort has no completed segments');
    const initPublication = publish('byte', initFigures, { ...initInput, ...initFigures });
    assertEqual(initPublication.published, false, 'init-only cohort cannot publish a byte figure');
    assertEqual(initPublication.missing, 'hostUploadMultiplier', 'init-only refusal names the missing multiplier field');
    assertEqual(decideFinalization({ evaluation: { refused: false }, recomputed: { publishedByte: initPublication } }).writeByte, false, 'init-only refusal cannot finalize byte output');
  });

  await check('byte cohort integration: a retained version-2 origin requires a declared method', async () => {
    const retained = JSON.parse(fs.readFileSync(new URL('../../../results/6a-repair-qual/origin-counters-end.json', import.meta.url), 'utf8'));
    const originEnd = retained.counters ?? retained;
    assertEqual(originEnd.responseAccountingVersion, 2, 'retained origin evidence uses version 2');
    let error;
    try { computeFigures({ originEnd }); } catch (caught) { error = caught; }
    assert(error instanceof Error, 'missing method on retained version-2 evidence errors');
    assert(error.message.includes('explicitly declared byte accounting method'), 'missing method error names the required declaration');
  });
}
