import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerFigures } from '../../figures/peer-figures.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';
import { armFor } from '../../harness/arms.mjs';

const bars = {
  responseCutShortMaxBytes: 100,
  responseSettleGapMs: 3_000,
};

const window = { startMs: 0, endMs: 1_000 };

function response(delivered) {
  return {
    originResponseId: 'host:1', clientTag: 'A', kind: 'segment',
    urlPath: '/media/seg-00000.m4s', delivered, expectedBytes: 100, aborted: true,
  };
}

function base(overrides = {}) {
  return {
    condition: { delivery: 'host', peerExchange: true, bars },
    window,
    declaredClientTags: ['A'],
    originStart: { responseRecords: [] },
    originEnd: { responseRecords: [response(10)] },
    originSettled: { atMs: 4_000, responseRecords: [response(20)] },
    content: { segmentSizes: [100] },
    cdpQualification: { receipt: { requestId: 'qualification', originResponseId: 'qualification:1' } },
    clients: {
      A: {
        peerRecords: [{ kind: 'attempt', attemptId: 1, path: '/media/seg-00000.m4s', source: 'http',
          startMs: 890, endMs: 927, bytes: 20 }],
        requests: [{ requestId: 'req-1', url: '/media/seg-00000.m4s', originResponseId: 'host:1',
          startMs: 900, endMs: 927, bodyBytes: 20, expectedBytes: 100, finished: false, canceled: true }],
      },
    },
    ...overrides,
  };
}

function responseResult(input) {
  return computePeerChecks(input, input.condition.bars)[0];
}

function refusalReasons(input) {
  const reasons = [];
  armFor(input.condition).refusals(input, (reason) => reasons.push(reason));
  return reasons;
}

export default async function peerSettleSuite() {
  await check('T4(a): settled host response pairs a cancellation 73 ms before the boundary', async () => {
    const result = responseResult(base());
    assert(result.passed, `settled response should pair: ${JSON.stringify(result.failures)}`);
    assertEqual(result.failures.length, 0, 'settled response has no agreement failures');
  });

  await check('T4(b): without the settle bar the end snapshot is the comparand', async () => {
    const input = base({ condition: { ...base().condition, bars: { responseCutShortMaxBytes: 100 } } });
    const result = responseResult(input);
    assert(!result.passed, 'the end snapshot shortfall is refused without the settle bar');
    assert(result.failures.some((failure) => failure.type === 'cut-short-byte-mismatch'), 'the end snapshot names the byte mismatch');
  });

  await check('T4(c): an end-snapshot host response with no receipt refuses by id', async () => {
    const input = base({
      originStart: { mediaBytesDelivered: 0, responseRecords: [] },
      originEnd: { mediaBytesDelivered: 50, responseRecords: [{ ...response(50), originResponseId: 'host:2' }] },
      originSettled: { atMs: 4_000, responseRecords: [{ ...response(50), originResponseId: 'host:2' }] },
      clients: { A: { peerRecords: [], requests: [] } },
    });
    const result = responseResult(input);
    assert(!result.passed, 'an unreceived host response is refused');
    const failure = result.failures.find((entry) => entry.type === 'host-response-unreceived');
    assertEqual(failure?.originResponseId, 'host:2', 'the refusal names the unreceived response');
    const figures = computePeerFigures(input);
    assertEqual(JSON.stringify(figures.hostResponsesUnreceived), JSON.stringify({
      count: 1, bytes: 50, excused: { count: 0, bytes: 0 }, laterReceived: { count: 0, bytes: 0 },
    }), 'the unreceived response report carries count and bytes');
  });

  await check('T4(d): a later receipt passes and is counted under laterReceived', async () => {
    const input = base({
      originStart: { mediaBytesDelivered: 0, responseRecords: [] },
      originEnd: { mediaBytesDelivered: 50, responseRecords: [{ ...response(50), originResponseId: 'host:2' }] },
      originSettled: { atMs: 4_000, responseRecords: [{ ...response(50), originResponseId: 'host:2' }] },
      clients: { A: { peerRecords: [], requests: [{ requestId: 'req-later', url: '/media/seg-00000.m4s',
        originResponseId: 'host:2', startMs: 1_050, endMs: 1_100, bodyBytes: 50, expectedBytes: 50,
        finished: true, canceled: false }] } },
    });
    const result = responseResult(input);
    assert(result.passed, `a later receipt should satisfy F5: ${JSON.stringify(result.failures)}`);
    assertEqual(JSON.stringify(result.hostResponsesUnreceived?.laterReceived), JSON.stringify({ count: 1, bytes: 50 }),
      'the later receipt is reported');
    const figures = computePeerFigures(input);
    assertEqual(JSON.stringify(figures.hostResponsesUnreceived?.laterReceived), JSON.stringify({ count: 1, bytes: 50 }),
      'published figures retain the later receipt report');
  });

  await check('T4(e): the settle gap is a strict 2999/3000 ms refusal boundary', async () => {
    const condition = { delivery: 'host', peerExchange: true, clients: 0, bars };
    const evidence = (atMs) => ({
      condition, window, declaredClientTags: [],
      originStart: { mediaBytesDelivered: 0 }, originEnd: { mediaBytesDelivered: 0 },
      originSettled: { atMs, counters: { responseRecords: [] } },
      roomFinal: { byClient: {}, unattributedMediaBytesDelivered: 0 },
      linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 1_000, txBytes: 0 }],
    });
    const short = refusalReasons(evidence(3_999));
    assert(short.includes('response-settle-gap-short'), '2999 ms after the end is refused');
    const exact = refusalReasons(evidence(4_000));
    assert(!exact.includes('response-settle-gap-short'), '3000 ms after the end passes');
  });
}
