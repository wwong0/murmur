import { check, assert, assertEqual, assertNear, sleep } from '../harness.mjs';
import { HTTP, server } from '../fixtures.mjs';
import { createRequestRecorder } from '../../harness/cdp-records.mjs';
import { computeReceiptCohort } from '../../figures/receipt-cohort.mjs';

const WINDOW = { startMs: 100, endMs: 200 };

function originRecord(originResponseId, clientTag, urlPath, delivered, { aborted = false, kind } = {}) {
  return {
    originResponseId,
    clientTag,
    urlPath,
    delivered,
    expectedBytes: delivered,
    aborted,
    kind: kind ?? (urlPath.endsWith('.m4s') ? 'segment' : 'init'),
  };
}

function request(originResponseId, url, bodyBytes, endMs, extra = {}) {
  return {
    requestId: `${originResponseId ?? 'missing'}-${url}`,
    originResponseId,
    url,
    endMs,
    bodyBytes,
    finished: true,
    canceled: false,
    ...extra,
  };
}

function input(records, clients, overrides = {}) {
  return {
    declaredClientTags: Object.keys(clients),
    window: WINDOW,
    originEnd: { responseAccountingVersion: 2, responseRecords: records },
    clients: Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, {
      requestTimebase: 'measure-window',
      requests: [],
      ...client,
    }])),
    ...overrides,
  };
}

function expectError(fn, text) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `expected an error containing ${text}`);
  assert(caught.message.includes(text), `error should name ${text}, got ${caught.message}`);
}

class FakeTab {
  constructor() { this.listeners = new Map(); }

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
    return () => this.listeners.set(name, listeners.filter((entry) => entry !== listener));
  }

  emit(name, params) {
    for (const listener of this.listeners.get(name) ?? []) listener(params);
  }
}

export default async function receiptCohortSuite() {
  await check('receipt cohort: real response header identity matches retained origin bytes', async () => {
    const response = await fetch(`${HTTP}/media/seg-00000.m4s?cohort=real`, {
      headers: { 'X-App-Tab': 'receipt-real' },
    });
    const headers = Object.fromEntries(response.headers.entries());
    const bodyBytes = (await response.arrayBuffer()).byteLength;
    await sleep(5);
    const record = server.counters.snapshot().responseRecords.at(-1);
    assert(response.ok, 'the in-process media response succeeds');
    assert(record, 'the retained response record exists');
    assertEqual(headers['x-app-response-id'], record.originResponseId, 'the response header is the retained response identity');
    assertEqual(record.originResponseId, `${record.socketId}:${record.responseIndex}`, 'identity uses the retained socket position');
    assertEqual(record.clientTag, 'receipt-real', 'origin attribution retains the request tag');
    assertEqual(record.kind, 'segment', 'the retained kind is the media classifier result');
    assertEqual(record.delivered, bodyBytes, 'retained delivered bytes equal the independent body read');
    assertEqual(server.counters.snapshot().responseAccountingVersion, 2, 'the snapshot declares accounting version 2');

    const tab = new FakeTab();
    const recorder = createRequestRecorder(tab);
    tab.emit('Network.requestWillBeSent', {
      requestId: 'actual-response',
      timestamp: 1,
      wallTime: 1_000,
      request: { url: `${HTTP}/media/seg-00000.m4s?cohort=real` },
    });
    tab.emit('Network.responseReceived', {
      requestId: 'actual-response',
      timestamp: 1.01,
      response: { headers, encodedDataLength: 11 },
    });
    tab.emit('Network.dataReceived', { requestId: 'actual-response', encodedDataLength: bodyBytes });
    tab.emit('Network.loadingFinished', {
      requestId: 'actual-response', timestamp: 1.02, encodedDataLength: 11 + bodyBytes,
    });
    const recorded = recorder.flush(120);
    assertEqual(recorded[0].originResponseId, record.originResponseId, 'CDP retains the actual response header identity');
    assertEqual(recorded[0].bodyBytes, bodyBytes, 'CDP body bytes remain independent from the identity header');
    recorder.dispose();
  });

  await check('receipt cohort: inclusive end boundaries, cumulative origin join, cancellation and distinct segments', async () => {
    const records = [
      originRecord('old-1', 'A', '/media/edge.m4s?origin=old', 97),
      originRecord('edge-2', 'A', '/media/repeated.m4s', 100),
      originRecord('edge-3', 'B', '/media/repeated.m4s', 100),
      originRecord('init-4', 'B', '/media/init.mp4', 20, { kind: 'init' }),
      originRecord('cancel-5', 'A', '/media/canceled.m4s', 999),
    ];
    const result = computeReceiptCohort(input(records, {
      A: { requests: [
        request('old-1', 'http://origin.test/media/edge.m4s?client=query', 100, 100, { startMs: 50 }),
        request('edge-2', '/media/repeated.m4s', 100, 200),
        request('cancel-5', '/media/canceled.m4s', 999, 150, { finished: true, canceled: true }),
        request('outside-ignored', '/media/outside.m4s', 1, 201),
      ] },
      B: { requests: [
        request('edge-3', '/media/repeated.m4s', 100, 200),
        request('init-4', '/media/init.mp4', 20, 100),
      ] },
    }));
    assertEqual(result.method, 'client-receipt-cohort-v1', 'the cohort method is explicit');
    assertEqual(result.byClient.A.originCompletedBytes, 197, 'origin bytes sum matched delivered values, including the old cumulative record');
    assertEqual(result.byClient.A.clientCompletedBytes, 200, 'client bytes remain independently measured');
    assertEqual(result.byClient.A.completedResponses, 2, 'completed receipts include both inclusive boundaries');
    assertEqual(result.byClient.B.originCompletedBytes, 120, 'init bytes enter the peer comparison');
    assertEqual(result.byClient.B.clientCompletedBytes, 120, 'init client bytes enter independently');
    assertEqual(result.distinctSegmentsCompletedInWindow, 2, 'repeated segment paths count once in the denominator');
    assertEqual(result.distinctSegmentBytesConsumedInWindow, 200, 'the union uses each path size once');
  });

  await check('receipt cohort: empty cohorts are explicit and origin/client discrepancies are exposed', async () => {
    const empty = computeReceiptCohort(input([], { A: { requests: [] } }));
    assertEqual(empty.byClient.A.originCompletedBytes, 0, 'empty origin count is zero');
    assertEqual(empty.byClient.A.clientCompletedBytes, 0, 'empty client count is zero');
    assertEqual(empty.byClient.A.completedResponses, 0, 'empty receipt count is zero');
    assertEqual(empty.distinctSegmentBytesConsumedInWindow, 0, 'empty segment denominator is zero');

    const unequal = computeReceiptCohort(input(
      [originRecord('unequal-1', 'A', '/media/unequal.m4s', 97)],
      { A: { requests: [request('unequal-1', '/media/unequal.m4s', 100, 150)] } },
    ));
    assertEqual(unequal.byClient.A.originCompletedBytes, 97, 'origin discrepancy remains 97');
    assertEqual(unequal.byClient.A.clientCompletedBytes, 100, 'client discrepancy remains 100');
  });

  await check('receipt cohort: identity, attribution and byte evidence failures refuse', async () => {
    const base = () => input(
      [originRecord('base-1', 'A', '/media/base.m4s', 10)],
      { A: { requests: [request('base-1', '/media/base.m4s', 10, 150)] } },
    );
    expectError(() => computeReceiptCohort({ ...base(), originEnd: { responseAccountingVersion: 1, responseRecords: [] } }), 'responseAccountingVersion:2');
    expectError(() => computeReceiptCohort(input([originRecord(null, 'A', '/media/base.m4s', 10)], { A: { requests: [request('base-1', '/media/base.m4s', 10, 150)] } })), 'missing response identity');
    expectError(() => computeReceiptCohort(input([
      originRecord('duplicate', 'A', '/media/base.m4s', 10), originRecord('duplicate', 'A', '/media/base.m4s', 10),
    ], { A: { requests: [request('duplicate', '/media/base.m4s', 10, 150)] } })), 'duplicate origin response identity');
    expectError(() => computeReceiptCohort(input([], { A: { requests: [request('missing', '/media/base.m4s', 10, 150)] } })), 'unmatched origin response identity');
    expectError(() => computeReceiptCohort(input([originRecord('wrong-tag', 'B', '/media/base.m4s', 10)], { A: { requests: [request('wrong-tag', '/media/base.m4s', 10, 150)] } })), 'origin/client tag mismatch');
    expectError(() => computeReceiptCohort(input([originRecord('wrong-path', 'A', '/media/other.m4s', 10)], { A: { requests: [request('wrong-path', '/media/base.m4s', 10, 150)] } })), 'origin/client path mismatch');
    expectError(() => computeReceiptCohort(input([originRecord('aborted', 'A', '/media/base.m4s', 10, { aborted: true })], { A: { requests: [request('aborted', '/media/base.m4s', 10, 150)] } })), 'marked aborted');
    expectError(() => computeReceiptCohort(input([originRecord('bad-origin', 'A', '/media/base.m4s', -1)], { A: { requests: [request('bad-origin', '/media/base.m4s', 10, 150)] } })), 'malformed delivered bytes');
    expectError(() => computeReceiptCohort(input([originRecord('bad-client', 'A', '/media/base.m4s', 10)], { A: { requests: [request('bad-client', '/media/base.m4s', -1, 150)] } })), 'malformed bodyBytes');
    const noIdentity = base();
    delete noIdentity.clients.A.requests[0].originResponseId;
    expectError(() => computeReceiptCohort(noIdentity), 'missing response identity');
    const noTime = base();
    delete noTime.clients.A.requests[0].endMs;
    expectError(() => computeReceiptCohort(noTime), 'nonfinite endMs');
    const noAborted = base();
    delete noAborted.originEnd.responseRecords[0].aborted;
    expectError(() => computeReceiptCohort(noAborted), 'malformed aborted state');
  });

  await check('receipt cohort: CDP identity headers are case-insensitive and conflicting identities refuse', async () => {
    const tab = new FakeTab();
    const recorder = createRequestRecorder(tab);
    try {
      const start = () => tab.emit('Network.requestWillBeSent', {
        requestId: 'header', timestamp: 1, wallTime: 1000, request: { url: '/media/a.m4s' },
      });
      const respond = (headers) => tab.emit('Network.responseReceived', {
        requestId: 'header', timestamp: 1.01, response: { headers, encodedDataLength: 11 },
      });
      start();
      respond({ 'X-App-Response-Id': '1:1', 'x-app-response-id': '1:1' });
      tab.emit('Network.loadingFinished', { requestId: 'header', timestamp: 1.02, encodedDataLength: 21 });
      assertEqual(recorder.records[0].originResponseId, '1:1', 'mixed-case equal headers preserve identity');
      start();
      expectError(() => respond({ 'X-App-Response-Id': '1:1', 'x-app-response-id': '1:2' }), 'conflicting');
    } finally {
      recorder.dispose();
    }
  });

  await check('receipt cohort: duplicate receipts, conflicting segment sizes and missing client contracts refuse', async () => {
    const record = originRecord('reuse', 'A', '/media/reuse.m4s', 10);
    expectError(() => computeReceiptCohort(input([record], {
      A: { requests: [request('reuse', '/media/reuse.m4s', 10, 150), request('reuse', '/media/reuse.m4s', 10, 150)] },
    })), 'reuses response identity');
    expectError(() => computeReceiptCohort(input([
      originRecord('size-a', 'A', '/media/same.m4s', 10), originRecord('size-b', 'B', '/media/same.m4s', 11),
    ], {
      A: { requests: [request('size-a', '/media/same.m4s', 10, 150)] },
      B: { requests: [request('size-b', '/media/same.m4s', 11, 150)] },
    })), 'conflicting client bodyBytes');
    expectError(() => computeReceiptCohort(input([], { A: { requests: [] } }, { clients: { A: { requests: [] } } })), 'missing requestTimebase');
    expectError(() => computeReceiptCohort({ declaredClientTags: ['A'], window: WINDOW, originEnd: { responseAccountingVersion: 2, responseRecords: [] }, clients: { A: { requestTimebase: 'measure-window' } } }), 'missing requests/requestRecords');
  });
}
