import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';

const bars = { responseCutShortMaxBytes: 1_129_000, conservationChannelBytes: 10, conservationRelativeMax: 0.05 };

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
        peerTotalsA: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} } },
        peerTotalsB: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} } } },
      B: { peerRecords: [
        { kind: 'attempt', attemptId: 2, path: '/media/seg-00001.m4s', source: 'p2p', peerId: 'A', startMs: 1, endMs: 10, bytes: 100 },
        { kind: 'segment', path: '/media/seg-00001.m4s', lengthBytes: 100, completedAtMs: 20, keptAttemptIds: [2] },
      ], requests: [], peerTotalsA: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 }, chunkBytes: { p2p: { A: 100 } } },
        peerTotalsB: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 }, chunkBytes: { p2p: { A: 100 } } } },
    },
    ...overrides,
  };
  return input;
}

function names(result) { return result.map((entry) => entry.check); }

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

  await check('peer checks: conservation catches the lower bound and bounds tolerance', async () => {
    const red = base();
    red.clients.B.peerTotalsB.chunkBytes.p2p.A = 89;
    const conservation = computePeerChecks(red, bars)[3];
    assert(!conservation.passed && conservation.failures.some((failure) => failure.type === 'conservation-mismatch'), 'lower conservation bound is red');
    assert(computePeerChecks(base(), bars)[3].passed, 'conservation twin is green');
    const unbounded = base();
    unbounded.clients.B.peerRecords.push({ kind: 'peer', event: 'close', peerId: 'A' });
    const bounded = computePeerChecks(unbounded, bars)[3];
    assertEqual(bounded.toleranceRefusals.length, 1, 'large close count is separately refused');
    assert(bounded.passed, 'unbounded tolerance is not misreported as a failed conservation inequality');
    // Equal fields: totals A/B, channel bytes, relative maximum, and every attempt record.
    assertEqual(red.clients.A.peerTotalsA.uploadBytes.B, 100, 'conservation mutation keeps sender A total');
  });
}
