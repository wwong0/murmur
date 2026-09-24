import { computePeerFigures } from '../../figures/peer-figures.mjs';
import { computeFigures } from '../../figures/harness-figures.mjs';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';

const WINDOW = { startMs: 0, endMs: 100 };
const SIZES = [1_000, 2_000, 1_306_761];

function attempt(id, path, source, bytes, startMs = 10, endMs = 20, peerId = null) {
  return { kind: 'attempt', attemptId: id, path, source, peerId, startMs, endMs, end: 'loaded', bytes };
}

function segment(path, lengthBytes, keptAttemptIds) {
  return { kind: 'segment', path, lengthBytes, startMs: 10, completedAtMs: 30, keptAttemptIds };
}

function fixture(overrides = {}) {
  const a = [
    attempt(1, '/media/seg-00000.m4s', 'http', 1_000),
    attempt(2, '/media/seg-00001.m4s', 'p2p', 2_000, 10, 20, 'B'),
    attempt(3, '/media/seg-00002.m4s', 'http', 400_000),
    attempt(4, '/media/seg-00002.m4s', 'p2p', 906_761, 21, 25, 'B'),
    attempt(7, '/media/seg-00003.m4s', 'http', 300, 10, 20),
    attempt(8, '/media/seg-00004.m4s', 'p2p', 50, 10, 20, 'B'),
    { kind: 'discard', attemptIds: [7], reason: 'constructed' },
    segment('/media/seg-00000.m4s', 1_000, [1]),
    segment('/media/seg-00001.m4s', 2_000, [2]),
    segment('/media/seg-00002.m4s', 1_306_761, [3, 4]),
  ];
  const b = [
    attempt(11, '/media/seg-00000.m4s', 'p2p', 1_000, 10, 20, 'A'),
    attempt(12, '/media/seg-00001.m4s', 'http', 2_000),
    attempt(13, '/media/seg-00002.m4s', 'p2p', 500, 10, 20, 'A'),
    attempt(14, '/media/seg-00002.m4s', 'http', 1_306_261, 21, 25),
    segment('/media/seg-00000.m4s', 1_000, [11]),
    segment('/media/seg-00001.m4s', 2_000, [12]),
    segment('/media/seg-00002.m4s', 1_306_761, [13, 14]),
  ];
  const receipts = [
    { requestId: 'a1', url: '/media/seg-00000.m4s', originResponseId: 'ra1', startMs: 10, endMs: 20, bodyBytes: 1_000, expectedBytes: 1_000, finished: true, canceled: false },
    { requestId: 'a3', url: '/media/seg-00002.m4s', originResponseId: 'ra3', startMs: 10, endMs: 20, bodyBytes: 400_000, expectedBytes: 1_306_761, finished: false, canceled: true },
    { requestId: 'adiscard', url: '/media/seg-00003.m4s', originResponseId: 'rdiscard', startMs: 10, endMs: 20, bodyBytes: 300, expectedBytes: 300, finished: true, canceled: false },
    { requestId: 'b2', url: '/media/seg-00001.m4s', originResponseId: 'rb2', startMs: 10, endMs: 20, bodyBytes: 2_000, expectedBytes: 2_000, finished: true, canceled: false },
    { requestId: 'b4', url: '/media/seg-00002.m4s', originResponseId: 'rb4', startMs: 21, endMs: 25, bodyBytes: 1_306_261, expectedBytes: 1_306_761, finished: false, canceled: true },
  ];
  const originResponses = [
    { originResponseId: 'ra1', clientTag: 'A', kind: 'segment', urlPath: '/media/seg-00000.m4s', delivered: 1_000, expectedBytes: 1_000 },
    { originResponseId: 'ra3', clientTag: 'A', kind: 'segment', urlPath: '/media/seg-00002.m4s', delivered: 400_000, expectedBytes: 1_306_761 },
    { originResponseId: 'rdiscard', clientTag: 'A', kind: 'segment', urlPath: '/media/seg-00003.m4s', delivered: 300, expectedBytes: 300 },
    { originResponseId: 'rb2', clientTag: 'B', kind: 'segment', urlPath: '/media/seg-00001.m4s', delivered: 2_000, expectedBytes: 2_000 },
    { originResponseId: 'rb4', clientTag: 'B', kind: 'segment', urlPath: '/media/seg-00002.m4s', delivered: 1_306_261, expectedBytes: 1_306_761 },
  ];
  return {
    window: WINDOW,
    declaredClientTags: ['A', 'B'],
    content: { segmentSizes: SIZES },
    cdpQualification: { receipt: { requestId: 'qualification' } },
    originStart: { mediaBytesDelivered: 0, responseRecords: [] },
    originEnd: { mediaBytesDelivered: 1_709_561, responseRecords: originResponses },
    clients: {
      A: { peerRecords: a, requests: receipts.slice(0, 3), peerTotalsA: { peerId: 'A', peerIds: ['A'] }, peerTotalsB: { peerId: 'A', peerIds: ['A'] } },
      B: { peerRecords: b, requests: receipts.slice(3), peerTotalsA: { peerId: 'B', peerIds: ['B'] }, peerTotalsB: { peerId: 'B', peerIds: ['B'] },
        ...overrides.clients?.B },
    },
    ...overrides,
  };
}

export default async function peerFiguresSuite() {
  await check('peer figures: cohort arithmetic uses kept attempts and peer ids', async () => {
    const figures = computePeerFigures(fixture());
    // A: 908,761/(401,000+908,761); B: 1,500/(1,308,261+1,500);
    // aggregate = 910,261/(1,309,761+1,309,761); multiplier = 1,709,561/(1,000+2,000+1,306,761).
    assertNear(figures.peerFractionByClient.A, 908_761 / 1_309_761, 1e-12, 'A peer fraction');
    assertNear(figures.peerFractionByClient.B, 1_500 / 1_309_761, 1e-12, 'B peer fraction');
    assertNear(figures.peerFractionAggregate, 910_261 / 2_619_522, 1e-12, 'aggregate peer fraction');
    assertNear(figures.hostUploadMultiplier, 1_709_561 / 1_309_761, 1e-12, 'host multiplier');
    assertEqual(figures.hostWasteBytes, 300, 'discarded host bytes are waste');
    assertEqual(figures.hostDeliveredBytesSettledInWindow, 1_709_561, 'host delivered denominator');
    assertNear(figures.hostWasteFraction, 300 / 1_709_561, 1e-15, 'host waste fraction');
    assertEqual(figures.peerWasteBytesByClient.A, 50, 'abandoned peer bytes are reported');
    assertEqual(figures.peerWasteBytesByClient.B, 0, 'B has no peer waste');
    assert(!('peerByteFractionByClient' in figures), 'legacy peer fraction is absent');
    assert(!('originWasteFraction' in figures), 'legacy origin waste is absent');
    const routed = computeFigures({ ...fixture(), byteAccountingMethod: 'peer-attempt-cohort-v1' });
    assertNear(routed.peerFractionByClient.A, figures.peerFractionByClient.A, 1e-12, 'harness routes peer fractions to peer figures');
  });

  await check('peer figures: length and disposition invariants are hard errors', async () => {
    let mismatch;
    try { computePeerFigures(fixture({ content: { segmentSizes: [999, 2_000, 1_306_761] } })); } catch (error) { mismatch = error; }
    assert(mismatch?.message.includes('segment-length-mismatch'), 'segment length mismatch is a hard error');
    let disposition;
    try { computePeerFigures(fixture({ clients: { A: { peerRecords: [{ kind: 'segment', path: '/media/seg-00000.m4s', lengthBytes: 1_000, completedAtMs: 30, keptAttemptIds: [99] }], requests: [] } } })); } catch (error) { disposition = error; }
    assert(disposition?.message.includes('segment claims unknown attempt'), 'throwing disposition is a hard error');
  });

  await check('peer figures: zero kept bytes is null and refuses the cohort', async () => {
    const value = fixture({ clients: { B: { peerRecords: [], requests: [], peerTotalsA: { peerId: 'B', peerIds: ['B'] }, peerTotalsB: { peerId: 'B', peerIds: ['B'] } } } });
    const figures = computePeerFigures(value);
    assertEqual(figures.peerFractionByClient.B, null, 'zero kept bytes is null, not zero');
    assert(figures.peerRefusalReasons.includes('peer-cohort-empty'), 'empty cohort refusal is retained');
  });
}
