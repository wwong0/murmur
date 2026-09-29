import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';
import { computePeerFigures } from '../../figures/peer-figures.mjs';

const bars = {
  responseCutShortMaxBytes: 1_129_000, conservationChannelBytes: 131_071,
  conservationRelativeMax: 0.05, conservationDeliveryGapMs: 3_000,
};

function base(overrides = {}) {
  return {
    window: { startMs: 0, endMs: 100 }, declaredClientTags: ['A', 'B'], condition: { bars },
    cdpQualification: { receipt: { requestId: 'qualification' } }, content: { segmentSizes: [100, 100] },
    originEnd: { responseRecords: [{ originResponseId: 'r1', clientTag: 'A', kind: 'segment',
      urlPath: '/media/seg-00000.m4s', delivered: 100, expectedBytes: 100 }] },
    clients: {
      A: { peerRecords: [
        { kind: 'attempt', attemptId: 1, path: '/media/seg-00000.m4s', source: 'http', peerId: null,
          startMs: 1, endMs: 10, bytes: 100 },
        { kind: 'segment', path: '/media/seg-00000.m4s', lengthBytes: 100, completedAtMs: 20, keptAttemptIds: [1] },
      ], requests: [{ requestId: 'req1', url: '/media/seg-00000.m4s', originResponseId: 'r1',
        startMs: 1, endMs: 10, bodyBytes: 100, expectedBytes: 100, finished: true, canceled: false }],
        peerTotalsA: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} },
          readStartedAtMs: 0, readEndedAtMs: 10 },
        peerTotalsB: { peerId: 'A', peerIds: ['A'], uploadBytes: { B: 100 }, chunkBytes: { p2p: {} },
          readStartedAtMs: 3_030, readEndedAtMs: 3_040 } },
      B: { peerRecords: [
        { kind: 'attempt', attemptId: 2, path: '/media/seg-00001.m4s', source: 'p2p', peerId: 'A',
          startMs: 1, endMs: 10, bytes: 100 },
        { kind: 'segment', path: '/media/seg-00001.m4s', lengthBytes: 100, completedAtMs: 20, keptAttemptIds: [2] },
      ], requests: [], peerTotalsA: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 },
        chunkBytes: { p2p: { A: 100 } }, readStartedAtMs: 20, readEndedAtMs: 30 },
        peerTotalsB: { peerId: 'B', peerIds: ['B'], uploadBytes: { A: 0 }, chunkBytes: { p2p: { A: 100 } },
          readStartedAtMs: 3_050, readEndedAtMs: 3_060 } },
    },
    ...overrides,
  };
}

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
    { requestId: 'host:2', url: '/media/seg-00000.m4s', originResponseId: 'host:2', startMs: 0, headMs: 10,
      endMs: -1, bodyBytes: 0, finished: false, canceled: true },
    { requestId: 'req2', url: '/media/seg-00001.m4s', originResponseId: null, startMs: 50, headMs: null,
      endMs: 90, bodyBytes: 0, expectedBytes: 1_269_966, finished: false, canceled: true },
    { requestId: 'host:4', url: '/media/seg-00000.m4s', originResponseId: 'host:4', startMs: 80, headMs: 100,
      endMs: -1, bodyBytes: 0, finished: false, canceled: true },
  );
  return input;
}

function ambiguous2() {
  const input = excusable();
  input.window.endMs = 200;
  input.clients.A.requests.find((entry) => entry.requestId === 'host:4').startMs = 20;
  input.clients.A.requests.find((entry) => entry.requestId === 'host:4').headMs = 200;
  input.clients.A.requests.push({ requestId: 'host:6', url: '/media/seg-00000.m4s', originResponseId: 'host:6',
    startMs: 120, headMs: 300, endMs: -1, bodyBytes: 0, finished: false, canceled: true });
  input.originEnd.responseRecords.push({ originResponseId: 'host:5', clientTag: 'A', kind: 'segment',
    urlPath: '/media/seg-00001.m4s', delivered: 444_720, expectedBytes: 1_269_966, aborted: true });
  input.clients.A.peerRecords.push({ kind: 'attempt', attemptId: 4, path: '/media/seg-00001.m4s',
    source: 'http', peerId: null, startMs: 100, endMs: 150, bytes: 0 });
  input.clients.A.requests.find((entry) => entry.requestId === 'req2').startMs = 50;
  input.clients.A.requests.find((entry) => entry.requestId === 'req2').endMs = 90;
  input.clients.A.requests.push({ requestId: 'req3', url: '/media/seg-00001.m4s', originResponseId: null,
    startMs: 100, headMs: null, endMs: 150, bodyBytes: 0, expectedBytes: 1_269_966, finished: false, canceled: true });
  // host:3 has [L=0,U=200], host:5 has [L=20,U=300]. req2 [50,90] and req3 [100,150]
  // each overlap both responses, so every receipt x response edge is true.
  return input;
}

function ordered3() {
  const input = ambiguous2();
  const request = (id) => input.clients.A.requests.find((entry) => entry.requestId === id);
  const attempt = (id) => input.clients.A.peerRecords.find((entry) => entry.attemptId === id);
  request('host:4').startMs = 30;
  request('host:4').headMs = 30;
  request('host:6').startMs = 70;
  request('host:6').headMs = 70;
  input.clients.A.requests.push({ requestId: 'host:8', url: '/media/seg-00000.m4s', originResponseId: 'host:8',
    startMs: 120, headMs: 120, endMs: -1, bodyBytes: 0, finished: false, canceled: true });
  input.originEnd.responseRecords.push({ originResponseId: 'host:7', clientTag: 'A', kind: 'segment',
    urlPath: '/media/seg-00001.m4s', delivered: 111_000, expectedBytes: 1_269_966, aborted: true });
  request('req2').startMs = 20;
  request('req2').endMs = 40;
  attempt(3).startMs = 0;
  attempt(3).endMs = 40;
  request('req3').startMs = 40;
  request('req3').endMs = 80;
  attempt(4).startMs = 0;
  attempt(4).endMs = 80;
  input.clients.A.peerRecords.push({ kind: 'attempt', attemptId: 5, path: '/media/seg-00001.m4s',
    source: 'http', peerId: null, startMs: 60, endMs: 90, bytes: 0 });
  input.clients.A.requests.push({ requestId: 'req4', url: '/media/seg-00001.m4s', originResponseId: null,
    startMs: 60, headMs: null, endMs: 90, bodyBytes: 0, expectedBytes: 1_269_966, finished: false, canceled: true });
  // host:3 [0,30], host:5 [30,70], host:7 [70,120]. req2 [0,40] overlaps s1,s2 only;
  // req3 [0,80] overlaps all three; req4 [60,90] overlaps s2,s3 only.
  return input;
}

function crossed3() {
  const input = ordered3();
  const request = (id) => input.clients.A.requests.find((entry) => entry.requestId === id);
  const attempt = (id) => input.clients.A.peerRecords.find((entry) => entry.attemptId === id);
  request('host:2').startMs = 50;
  request('host:4').startMs = 0;
  request('host:4').headMs = 100;
  request('host:6').startMs = 0;
  request('host:6').headMs = 70;
  request('host:8').startMs = 0;
  request('host:8').headMs = 30;
  attempt(3).startMs = 0;
  attempt(3).endMs = 40;
  attempt(4).startMs = 20;
  attempt(4).endMs = 110;
  attempt(5).startMs = 40;
  attempt(5).endMs = 60;
  // host:3 [50,100], host:5 [50,70], host:7 [50,30]. req2 [0,40] overlaps none;
  // req3 [20,110] overlaps all three; req4 [40,60] overlaps host:3 and host:5 only.
  // The altered times leave the in-order r1-s1 pairing red.
  return input;
}

function unequalCounts() {
  const input = ambiguous2();
  input.clients.A.requests.find((entry) => entry.requestId === 'host:6').startMs = 20;
  input.clients.A.requests.push({ requestId: 'host:8', url: '/media/seg-00000.m4s', originResponseId: 'host:8',
    startMs: 160, headMs: 200, endMs: -1, bodyBytes: 0, finished: false, canceled: true });
  input.originEnd.responseRecords.push({ originResponseId: 'host:7', clientTag: 'A', kind: 'segment',
    urlPath: '/media/seg-00001.m4s', delivered: 1, expectedBytes: 1_269_966, aborted: true });
  // host:3 [0,200], host:5 [20,300], host:7 [20,200]; req2 [50,90] and req3 [100,150]
  // overlap all three, but |R|=2 and |S|=3, so no receipt x response pair is excused.
  return input;
}

function twoPrefixes() {
  const input = ambiguous2();
  const response = input.originEnd.responseRecords.find((entry) => entry.originResponseId === 'host:5');
  response.originResponseId = 'other:5';
  input.clients.A.requests.push(
    { requestId: 'other:4', url: '/media/seg-00000.m4s', originResponseId: 'other:4', startMs: 20, headMs: 200,
      endMs: -1, bodyBytes: 0, finished: false, canceled: true },
    { requestId: 'other:6', url: '/media/seg-00000.m4s', originResponseId: 'other:6', startMs: 120, headMs: 300,
      endMs: -1, bodyBytes: 0, finished: false, canceled: true },
  );
  // host:3 [0,200] and other:5 [20,300]; req2 [50,90] and req3 [100,150] overlap both.
  // The two responses have different prefixes, so the group remains wholly red.
  return input;
}

function oneBMember() {
  const input = ambiguous2();
  input.clients.A.peerRecords.find((entry) => entry.attemptId === 3).bytes = 1;
  input.clients.A.requests.find((entry) => entry.requestId === 'req2').bodyBytes = 1;
  // host:3 [0,200] and host:5 [20,300]; req2 is 1 B and ineligible, leaving |R|=1, |S|=2.
  return input;
}

function response(result) { return result[0]; }

export default async function peerChecksGroupSuite() {
  await check('peer checks group: ambiguous2 pairs every receipt in order', async () => {
    const input = ambiguous2();
    const result = response(computePeerChecks(input, bars));
    assert(result.passed, 'ambiguous2 response agreement passes');
    assertEqual(JSON.stringify(result.excused), JSON.stringify([
      { tag: 'A', requestId: 'req2', originResponseId: 'host:3', delivered: 655_280 },
      { tag: 'A', requestId: 'req3', originResponseId: 'host:5', delivered: 444_720 },
    ]), 'ambiguous2 excused entries follow receipt start and response sequence order');
    const figures = computePeerFigures(input);
    assertEqual(figures.hostExcusedResponses, 2, 'ambiguous2 counts both host responses');
    assertEqual(figures.hostExcusedBytes, 1_100_000, 'ambiguous2 sums excused response bytes');
  });

  await check('peer checks group: ordered3 accepts only the in-order pairing', async () => {
    const result = response(computePeerChecks(ordered3(), bars));
    assert(result.passed, 'ordered3 response agreement passes');
    assertEqual(result.excused.length, 3, 'ordered3 excuses every response');
    assertEqual(JSON.stringify(result.excused.map((entry) => [entry.requestId, entry.originResponseId])),
      JSON.stringify([['req2', 'host:3'], ['req3', 'host:5'], ['req4', 'host:7']]),
      'ordered3 maps starts to sequence order');
  });

  await check('peer checks group: crossed3 rejects the crossed pairing', async () => {
    const result = response(computePeerChecks(crossed3(), bars));
    assert(!result.passed && result.failures.some((failure) => failure.type === 'host-response-unpaired'),
      'crossed3 remains host-response-unpaired');
    assertEqual(result.excused.length, 0, 'crossed3 excuses no response');
  });

  await check('peer checks group: unequal counts stay red and unexcused', async () => {
    const result = response(computePeerChecks(unequalCounts(), bars));
    assert(!result.passed && result.failures.some((failure) => failure.type === 'host-response-unpaired'),
      'unequal group remains host-response-unpaired');
    assertEqual(result.excused.length, 0, 'unequal group excuses nothing');
  });

  await check('peer checks group: two prefixes stay red and unexcused', async () => {
    const result = response(computePeerChecks(twoPrefixes(), bars));
    assert(!result.passed && result.failures.some((failure) => failure.type === 'host-response-unpaired'),
      'two prefixes remain host-response-unpaired');
    assertEqual(result.excused.length, 0, 'two prefixes excuse nothing');
  });

  await check('peer checks group: a one-byte member is ineligible', async () => {
    const result = response(computePeerChecks(oneBMember(), bars));
    assert(!result.passed && result.failures.some((failure) => failure.type === 'host-response-unpaired'),
      'one-byte member leaves host-response-unpaired');
    assertEqual(result.excused.length, 0, 'one-byte member excuses nothing');
  });
}
