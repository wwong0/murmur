import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';
import { computePeerFigures } from '../../figures/peer-figures.mjs';
import { remainingRoom } from '../../figures/harness-figures.mjs';

const bars = {
  responseCutShortMaxBytes: 1_129_000, conservationChannelBytes: 131_071,
  conservationRelativeMax: 0.05, conservationDeliveryGapMs: 3_000,
};

function base(overrides = {}) {
  const input = {
    window: { startMs: 0, endMs: 100 }, declaredClientTags: ['A', 'B'], condition: { bars },
    cdpQualification: { receipt: { requestId: 'qualification' } }, content: { segmentSizes: [100, 100] },
    originEnd: { responseRecords: [{ originResponseId: 'r1', clientTag: 'A', kind: 'segment', urlPath: '/media/seg-00000.m4s', delivered: 100, expectedBytes: 100 }] },
    clients: {
      A: { peerRecords: [
        { kind: 'attempt', attemptId: 1, path: '/media/seg-00000.m4s', source: 'http', peerId: null, startMs: 1, endMs: 10, bytes: 100 },
        { kind: 'segment', path: '/media/seg-00000.m4s', lengthBytes: 100, completedAtMs: 20, keptAttemptIds: [1] },
      ], requests: [{ requestId: 'req1', url: '/media/seg-00000.m4s', originResponseId: 'r1', startMs: 1, endMs: 10, bodyBytes: 100, expectedBytes: 100, finished: true, canceled: false }],
        peerTotalsA: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} }, readStartedAtMs: 0, readEndedAtMs: 10 },
        peerTotalsB: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} }, readStartedAtMs: 3_030, readEndedAtMs: 3_040 } },
      B: { peerRecords: [
        { kind: 'attempt', attemptId: 2, path: '/media/seg-00001.m4s', source: 'p2p', peerId: 'A', startMs: 1, endMs: 10, bytes: 100 },
        { kind: 'segment', path: '/media/seg-00001.m4s', lengthBytes: 100, completedAtMs: 20, keptAttemptIds: [2] },
      ], requests: [], peerTotalsA: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 }, chunkBytes: { p2p: { A: 100 } }, readStartedAtMs: 20, readEndedAtMs: 30 },
        peerTotalsB: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 }, chunkBytes: { p2p: { A: 100 } }, readStartedAtMs: 3_050, readEndedAtMs: 3_060 } },
    },
    ...overrides,
  };
  return input;
}

function names(result) { return result.map((entry) => entry.check); }

function excusable() {
  const input = base({
    originStart: { mediaBytesDelivered: 0, responseRecords: [] },
    originEnd: { mediaBytesDelivered: 655_280, responseRecords: [...base().originEnd.responseRecords] },
  });
  input.originEnd.responseRecords.push({ originResponseId: 'host:3', clientTag: 'A', kind: 'segment',
    urlPath: '/media/seg-00001.m4s', delivered: 655_280, expectedBytes: 1_269_966, aborted: true });
  input.clients.A.peerRecords.push({ kind: 'attempt', attemptId: 3, path: '/media/seg-00001.m4s',
    source: 'http', peerId: null, startMs: 50, endMs: 90, bytes: 0 });
  input.clients.A.requests.push(
    { requestId: 'host:2', url: '/media/seg-00000.m4s', originResponseId: 'host:2', startMs: 0, headMs: 10, endMs: -1, bodyBytes: 0, finished: false, canceled: true },
    { requestId: 'req2', url: '/media/seg-00001.m4s', originResponseId: null, startMs: 50, headMs: null, endMs: 90, bodyBytes: 0, expectedBytes: 1_269_966, finished: false, canceled: true },
    { requestId: 'host:4', url: '/media/seg-00000.m4s', originResponseId: 'host:4', startMs: 80, headMs: 100, endMs: -1, bodyBytes: 0, finished: false, canceled: true },
  );
  return input;
}

export default async function peerChecksSuite() {
  await check('peer checks: all four execute and pass on the constructed twin', async () => {
    const result = computePeerChecks(base(), bars);
    assertEqual(JSON.stringify(names(result)), JSON.stringify(['response-agreement', 'segment-sum', 'peer-id-membership', 'conservation']), 'all checks run');
    assert(result.every((entry) => entry.passed && entry.exercised), 'constructed baseline passes every exercised check');
  });

  await check('peer checks: response agreement catches receipt and cut-short bounds', async () => {
    const receipt = base();
    receipt.clients.A.requests[0].bodyBytes = 101;
    const red = computePeerChecks(receipt, bars)[0];
    assert(!red.passed && red.failures.some((failure) => failure.type === 'finished-byte-mismatch'), 'receipt one byte over engine is red');
    assert(!computePeerChecks(receipt, bars)[1].passed, 'segment sum observes receipt bytes independently');
    const cut = base();
    cut.clients.A.requests[0] = { ...cut.clients.A.requests[0], canceled: true, finished: false, bodyBytes: 10 };
    cut.clients.A.peerRecords[0] = { ...cut.clients.A.peerRecords[0], bytes: 10 };
    cut.originEnd.responseRecords[0] = { ...cut.originEnd.responseRecords[0], delivered: 10 + 1_129_001 };
    const cutRed = computePeerChecks(cut, bars)[0];
    assert(!cutRed.passed, 'cut-short host overshoot is red');
    cut.originEnd.responseRecords[0].delivered = 10 + 1_129_000;
    assert(computePeerChecks(cut, bars)[0].passed, 'cut-short exact upper bound is green');
    // Fields held equal in both twins: path, requestId, start/end, expectedBytes, attempt id, and window.
    assertEqual(cut.clients.A.requests[0].requestId, receipt.clients.A.requests[0].requestId, 'receipt twin keeps request identity');
  });

  await check('peer checks: the qualification receipt is excluded by its request id and only by it', async () => {
    // An in-window receipt no engine attempt made, as the harness's own fetch is.
    const withQualification = (declaredId) => {
      const input = base({ cdpQualification: { receipt: { requestId: declaredId } } });
      input.clients.A.requests.push({ requestId: 'qualification', url: '/media/seg-00001.m4s', originResponseId: 'rq', startMs: 2, endMs: 30, bodyBytes: 100, expectedBytes: 100, finished: true, canceled: false });
      return input;
    };
    assert(computePeerChecks(withQualification('qualification'), bars)[0].passed, 'excluded qualification receipt leaves agreement green');
    const red = computePeerChecks(withQualification('other'), bars)[0];
    assert(!red.passed && red.failures.some((failure) => failure.type === 'receipt-unpaired' && failure.requestId === 'qualification'), 'the same receipt, not declared, is unpaired');
  });

  await check('peer checks: segment sum uses receipt bytes, peer membership uses another viewer', async () => {
    const sum = base();
    sum.clients.B.peerRecords[0].bytes = 99;
    const sumRed = computePeerChecks(sum, bars)[1];
    assert(!sumRed.passed && sumRed.failures.some((failure) => failure.type === 'segment-sum-mismatch'), 'one peer byte short is red');
    const sumTwin = base();
    assert(computePeerChecks(sumTwin, bars)[1].passed, 'segment-sum twin is green');
    const membership = base();
    membership.clients.B.peerRecords[0].peerId = 'B';
    const memberRed = computePeerChecks(membership, bars)[2];
    assert(!memberRed.passed, 'receiver-own peer id is red');
    assert(computePeerChecks(base(), bars)[2].passed, 'membership twin is green');
    // Equal fields: both segment lengths, kept ids, byte totals, and every peer id except the mutated one.
    assertEqual(sum.clients.B.peerRecords[0].path, sumTwin.clients.B.peerRecords[0].path, 'sum twin keeps path');
    assertEqual(membership.clients.B.peerRecords[0].attemptId, 2, 'membership mutation keeps attempt id');
  });

  await check('10b peer checks: a leave is checked among the members that remain, its peer id still a member', async () => {
    const left = (kind) => {
      const input = base({ declaredClientTags: ['A', 'B', 'C'], condition: { bars, rosterEvent: { kind } },
        rosterEvent: { kind, client: 'C' }, context: { clients: { C: { peerId: 'C' } } } });
      input.clients.C = { peerRecords: [], requests: [] };
      input.clients.A.peerRecords.push({ kind: 'attempt', attemptId: 9, path: '/media/seg-00009.m4s', source: 'p2p', peerId: 'C', startMs: 1, endMs: 2, bytes: 0 });
      return input;
    };
    const by = (result, name) => result.find((entry) => entry.check === name);
    const room = remainingRoom(left('leave-clean'));
    assertEqual(JSON.stringify(room.declaredClientTags), JSON.stringify(['A', 'B']), 'the departed member is not in the room read');
    assertEqual(JSON.stringify(room.departedPeerIds), JSON.stringify(['C']), 'its peer id is carried');
    const remaining = computePeerChecks(room, bars);
    assertEqual(by(remaining, 'conservation').exercised, true, 'conservation is exercised among the two that remain');
    assertEqual(by(remaining, 'peer-id-membership').passed, true, 'an attempt on the departed member is a member\'s');
    const stranger = computePeerChecks({ ...room, departedPeerIds: [] }, bars);
    assertEqual(by(stranger, 'peer-id-membership').passed, false, 'the same attempt with no departed id is a stranger\'s');
    const dropped = remainingRoom(left('drop-socket'));
    assertEqual(JSON.stringify(dropped.declaredClientTags), JSON.stringify(['A', 'B', 'C']), 'a member that only lost its socket stays in the room read');
    assertEqual(by(computePeerChecks(dropped, bars), 'conservation').exercised, false, 'and its missing totals are not excused');
  });

  await check('peer checks: conservation catches the lower bound and bounds tolerance', async () => {
    const red = base();
    red.clients.B.peerTotalsB.chunkBytes.p2p.A = 89;
    const conservation = computePeerChecks(red, bars)[3];
    assert(!conservation.passed && conservation.failures.some((failure) => failure.type === 'conservation-mismatch'), 'lower conservation bound is red');
    assert(computePeerChecks(base(), bars)[3].passed, 'conservation twin is green');
    const unbounded = base();
    unbounded.clients.B.peerRecords.push(
      { kind: 'peer', event: 'close', peerId: 'A' },
      { kind: 'peer', event: 'close', peerId: 'A' },
    );
    const bounded = computePeerChecks(unbounded, bars)[3];
    assertEqual(bounded.toleranceRefusals.length, 1, 'large close count is separately refused');
    assert(bounded.passed, 'unbounded tolerance is not misreported as a failed conservation inequality');
    // Equal fields: totals A/B, channel bytes, relative maximum, and every attempt record.
    assertEqual(red.clients.A.peerTotalsA.uploadBytes.B, 100, 'conservation mutation keeps sender A total');
  });

  await check('peer checks: delivery gap is independent of byte tolerance', async () => {
    const oneShort = base();
    oneShort.clients.B.peerTotalsB.chunkBytes.p2p.A = 99;
    const noClose = computePeerChecks(oneShort, bars)[3];
    assert(!noClose.passed && noClose.failures.some((failure) => failure.type === 'conservation-mismatch'), 'no-close one byte short is red');
    assert(computePeerChecks(base(), bars)[3].passed, 'no-close exact total is green');

    const close = base();
    close.clients.A.peerTotalsA.uploadBytes.B = 200_000;
    close.clients.A.peerTotalsB.uploadBytes.B = 200_000;
    close.clients.B.peerTotalsA.chunkBytes.p2p.A = 200_000;
    close.clients.B.peerTotalsB.chunkBytes.p2p.A = 68_929;
    close.clients.B.peerRecords.push({ kind: 'peer', event: 'close', peerId: 'A' });
    assert(computePeerChecks(close, bars)[3].passed, 'one close allows exactly 131071 bytes');
    close.clients.B.peerTotalsB.chunkBytes.p2p.A = 68_928;
    assert(!computePeerChecks(close, bars)[3].passed, 'one close plus one byte is red');

    const short = base();
    short.clients.B.peerTotalsB.readStartedAtMs = 3_009;
    const shortResult = computePeerChecks(short, bars)[3];
    assert(!shortResult.passed && shortResult.failures.some((failure) => failure.type === 'delivery-gap-short'), '2999 ms gap is red');
    assert(computePeerChecks(base(), bars)[3].passed, '3000 ms gap is green');
    const missing = base();
    delete missing.clients.A.peerTotalsA.readEndedAtMs;
    const missingResult = computePeerChecks(missing, bars)[3];
    assert(!missingResult.passed && missingResult.failures.some((failure) => failure.type === 'delivery-gap-unrecorded'), 'missing timestamp is red');
    const absent = computePeerChecks(base(), { ...bars, conservationDeliveryGapMs: undefined })[3];
    assert(!absent.passed && absent.failures.some((failure) => failure.type === 'delivery-gap-unrecorded'), 'missing declared gap is red');
  });

  await check('peer checks: a unique bracketed abandoned response is excused', async () => {
    const input = excusable();
    const response = computePeerChecks(input, bars)[0];
    assert(response.passed, 'unique abandoned response is green');
    assertEqual(JSON.stringify(response.excused), JSON.stringify([
      { tag: 'A', requestId: 'req2', originResponseId: 'host:3', delivered: 655_280 },
    ]), 'excusal carries the response identity and bytes');
    const figures = computePeerFigures(input);
    assertEqual(figures.hostExcusedResponses, 1, 'one host response is counted as excused');
    assertEqual(figures.hostExcusedBytes, 655_280, 'excused response bytes are published');
    assertEqual(figures.hostWasteBytes, 655_280, 'excused response bytes are host waste');

    const twoCandidates = excusable();
    twoCandidates.originEnd.responseRecords.push({ originResponseId: 'host:5', clientTag: 'A', kind: 'segment',
      urlPath: '/media/seg-00001.m4s', delivered: 1, expectedBytes: 1_269_966, aborted: true });
    // host:5 gets a two-sided bracket of its own, so only uniqueness can keep it red.
    twoCandidates.clients.A.requests.push({ requestId: 'host:6', url: '/media/seg-00000.m4s', originResponseId: 'host:6',
      startMs: 85, headMs: 95, endMs: -1, bodyBytes: 0, finished: false, canceled: true });
    const ambiguousCandidates = computePeerChecks(twoCandidates, bars)[0];
    assert(!ambiguousCandidates.passed && ambiguousCandidates.failures.some((failure) => failure.type === 'host-response-unpaired'), 'two candidates stay red');

    const twoReceipts = excusable();
    twoReceipts.clients.A.peerRecords.push({ kind: 'attempt', attemptId: 4, path: '/media/seg-00001.m4s',
      source: 'http', peerId: null, startMs: 60, endMs: 90, bytes: 0 });
    twoReceipts.clients.A.requests.push({ requestId: 'req3', url: '/media/seg-00001.m4s', originResponseId: null,
      startMs: 60, headMs: null, endMs: 90, bodyBytes: 0, expectedBytes: 1_269_966, finished: false, canceled: true });
    const ambiguousReceipts = computePeerChecks(twoReceipts, bars)[0];
    assert(!ambiguousReceipts.passed && ambiguousReceipts.failures.some((failure) => failure.type === 'host-response-unpaired'), 'two receipts stay red');

    const after = excusable();
    after.clients.A.requests.find((entry) => entry.requestId === 'host:2').startMs = 200;
    const afterBracket = computePeerChecks(after, bars)[0];
    assert(!afterBracket.passed && afterBracket.failures.some((failure) => failure.type === 'host-response-unpaired'), 'bracket after attempt stays red');

    const oneSided = excusable();
    // The last response of a run: no later head to bound it from above.
    oneSided.clients.A.requests = oneSided.clients.A.requests.filter((entry) => entry.requestId !== 'host:4');
    const noUpper = computePeerChecks(oneSided, bars)[0];
    assert(!noUpper.passed && noUpper.failures.some((failure) => failure.type === 'host-response-unpaired'), 'a bracket with no upper side stays red');

    const bytes = excusable();
    bytes.clients.A.peerRecords.find((entry) => entry.attemptId === 3).bytes = 1;
    bytes.clients.A.requests.find((entry) => entry.requestId === 'req2').bodyBytes = 1;
    const oneByte = computePeerChecks(bytes, bars)[0];
    assert(!oneByte.passed && oneByte.failures.some((failure) => failure.type === 'host-response-unpaired'), 'one-byte receipt stays red');
  });
}
