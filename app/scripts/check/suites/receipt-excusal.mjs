import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';

const receiptFields = {
  seq: 1, requestId: 'req-c01', url: '/media/seg-00000.m4s', originResponseId: null,
  status: 200, expectedBytes: 100, startMs: 0, headMs: null, endMs: 10, bodyBytes: 0,
  finished: false, canceled: true, urgent: false, source: 'http',
};

function fixture({ excusal = true, receipt = {}, settled = false, unreceivedBytes = 100, unreceivedExcusal = false } = {}) {
  const input = {
    window: { startMs: 0, endMs: 100 }, declaredClientTags: ['c01', 'c02'],
    condition: { excusals: {
      ...(excusal ? { bytelessCancelledReceipt: true } : {}),
      ...(unreceivedExcusal ? { bytelessUnreceivedResponse: true } : {}),
    } },
    originStart: { responseRecords: [] }, originEnd: { responseRecords: [] },
    originSettled: { responseRecords: [] },
    clients: {
      c01: { peerRecords: [{ kind: 'attempt', attemptId: 1, path: receiptFields.url,
        source: 'http', peerId: null, startMs: 0, endMs: 10, bytes: 0 }],
        requests: [{ ...receiptFields, ...receipt }] },
      c02: { peerRecords: [], requests: [] },
    },
  };
  if (settled) {
    const response = { originResponseId: 'host:1', clientTag: 'c01', kind: 'segment',
      urlPath: receiptFields.url, delivered: 100, expectedBytes: 100, aborted: false };
    input.condition.bars = { responseSettleGapMs: 1_000 };
    input.originEnd.responseRecords = [{ ...response, delivered: unreceivedBytes }];
    input.originSettled.responseRecords = [{ ...response, delivered: unreceivedBytes }];
  }
  return input;
}

function response(input) { return computePeerChecks(input)[0]; }

function byClient(result) {
  return JSON.stringify(result.excusedByteless?.byClient);
}

export default async function receiptExcusalSuite() {
  await check('receipt excusal: a byte-less cancelled receipt is excused and counted', async () => {
    const result = response(fixture());
    assert(result.passed, 'byte-less cancelled receipt passes response agreement');
    assertEqual(result.excusedByteless.count, 1, 'one receipt is excused');
    assertEqual(byClient(result), JSON.stringify({ c01: 1, c02: 0 }), 'every viewer tag has a count');
    assertEqual(JSON.stringify(result.excusedByteless.receipts), JSON.stringify([{ tag: 'c01', requestId: 'req-c01' }]),
      'the excused receipt identity is retained');
  });

  await check('receipt excusal: a receipt that carried a byte is not excused', async () => {
    const result = response(fixture({ receipt: { bodyBytes: 1 } }));
    assertEqual(JSON.stringify(result.failures.map(({ type, tag, requestId }) => [type, tag, requestId])),
      JSON.stringify([['host-response-unpaired', 'c01', 'req-c01']]), 'one byte leaves exactly that refusal');
    assertEqual(result.passed, false, 'a receipt that carried a byte refuses');
    assertEqual(result.excusedByteless.count, 0, 'a nonzero body is not excused');
  });

  await check('receipt excusal: a host response nobody received still refuses', async () => {
    const result = response(fixture({ settled: true }));
    assertEqual(JSON.stringify(result.failures.map(({ type, originResponseId }) => [type, originResponseId])),
      JSON.stringify([['host-response-unreceived', 'host:1']]), 'the unreceived response is the one failure, named');
  });

  await check('receipt excusal: a zero-byte unreceived host response is excused and counted', async () => {
    const result = response(fixture({ settled: true, unreceivedBytes: 0, unreceivedExcusal: true }));
    assert(result.passed, 'the declared zero-byte unreceived response passes');
    assertEqual(result.hostResponsesUnreceived.bytelessUnreceived.count, 1, 'one zero-byte response is excused');
    assertEqual(JSON.stringify(result.hostResponsesUnreceived.bytelessUnreceived.originResponseIds),
      JSON.stringify(['host:1']), 'the excused response identity is retained');
  });

  await check('receipt excusal: a one-byte unreceived host response still refuses', async () => {
    const result = response(fixture({ settled: true, unreceivedBytes: 1, unreceivedExcusal: true }));
    assertEqual(JSON.stringify(result.failures.map(({ type, originResponseId }) => [type, originResponseId])),
      JSON.stringify([['host-response-unreceived', 'host:1']]), 'one delivered byte remains a refusal');
    assertEqual(result.hostResponsesUnreceived.bytelessUnreceived.count, 0, 'a nonzero response is not excused');
  });

  await check('receipt excusal: without the unreceived excusal a zero-byte response refuses', async () => {
    const result = response(fixture({ settled: true, unreceivedBytes: 0, unreceivedExcusal: false }));
    assertEqual(JSON.stringify(result.failures.map(({ type, originResponseId }) => [type, originResponseId])),
      JSON.stringify([['host-response-unreceived', 'host:1']]), 'undeclared, a zero-byte response refuses');
    assertEqual(result.hostResponsesUnreceived.bytelessUnreceived, undefined, 'undeclared, no excusal report is published');
  });

  await check('receipt excusal: without the excusal the receipt refuses', async () => {
    const result = response(fixture({ excusal: false }));
    assertEqual(JSON.stringify(result.failures.map(({ type, tag, requestId }) => [type, tag, requestId])),
      JSON.stringify([['host-response-unpaired', 'c01', 'req-c01']]), 'undeclared, the receipt refuses');
    assertEqual('excusedByteless' in result, false, 'undeclared, the registered result keeps its shape');
  });

  await check('receipt excusal: a head but no bytes is not excused', async () => {
    const result = response(fixture({ receipt: { headMs: 1 } }));
    assert(!result.passed && result.failures.some((failure) => failure.type === 'host-response-unpaired'),
      'a finite head remains host-response-unpaired');
    assertEqual(result.excusedByteless.count, 0, 'a finite head is not excused');
  });

  // Each differs from the first case in one field of the receipt.
  await check('receipt excusal: a receipt that was not cancelled is not excused', async () => {
    const result = response(fixture({ receipt: { canceled: false } }));
    assertEqual(JSON.stringify(result.failures.map(({ type, tag, requestId }) => [type, tag, requestId])),
      JSON.stringify([['host-response-unpaired', 'c01', 'req-c01']]), 'not cancelled leaves exactly that refusal');
    assertEqual(result.excusedByteless.count, 0, 'a receipt that was not cancelled is not excused');
  });

  await check('receipt excusal: a receipt naming a response the host has no record of is not excused', async () => {
    const result = response(fixture({ receipt: { originResponseId: 'host:9' } }));
    assertEqual(JSON.stringify(result.failures.map(({ type, tag, originResponseId }) => [type, tag, originResponseId])),
      JSON.stringify([['host-response-unpaired', 'c01', 'host:9']]), 'the named response is the refusal');
    assertEqual(result.excusedByteless.count, 0, 'a receipt naming a response is not excused');
  });
}
