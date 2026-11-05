import { assert, assertEqual, check, waitEvent } from '../harness.mjs';
import { createFakeClock } from '../fake-channel.mjs';
import { createFakeRoomClient, createFakeRtcFactory } from '../fake-rtc.mjs';
import { computeReceiptCohort } from '../../figures/receipt-cohort.mjs';
import { createHostLink } from '../../../public/lib/host-link.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { ADDR_ROOM } from '../../../public/lib/envelope.mjs';

// P6 discrimination probe: opportunity is a canceled receipt joined to an aborted host record;
// mutation marks the receipt finished; named red assertion is "P6 aborted receipt is not finished";
// restoration is by hand to the staged tree; green rerun is npm run check.

const segment = new Uint8Array(256).map((_, index) => index);
const largeSegment = new Uint8Array(1_000_000);

function readSource(path) {
  if (path === '/media/seg-00000.m4s') return Promise.resolve({ status: 200, bytes: segment });
  if (path === '/media/seg-big.m4s') return Promise.resolve({ status: 200, bytes: largeSegment });
  return Promise.resolve({ status: 404, bytes: new Uint8Array() });
}

function stats() {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', id: 'pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', id: 'local', candidateType: 'host', address: '10.0.0.1' }],
    ['remote', { type: 'remote-candidate', id: 'remote', candidateType: 'host', address: '10.0.0.2' }],
  ]);
}

// F1 roster probes: opportunity is a real host room-client receiving a later joiner's offer,
// and a member-relayed `presence` naming a forged tag. Mutations: room-client ignores presence;
// then it accepts presence from any sender. Named reds: "F1 host resolves a later joiner's tag"
// and "F1 a member's relayed presence does not rewrite the tag". Restored to the staged tree.

function nextEnvelope(client, type, accept = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`no ${type} within ${timeoutMs}ms`)); }, timeoutMs);
    const off = client.on(type, (env) => {
      if (!accept(env)) return;
      clearTimeout(timer);
      off();
      resolve(env);
    });
  });
}

// The lookup answerHostOffer makes, read at the instant the offer arrives.
async function tagAtOffer(host, viewer) {
  const offer = nextEnvelope(host, 'host-link-offer', (env) => env.from === viewer.clientId);
  viewer.send({ type: 'host-link-offer', to: host.clientId, payload: { linkId: 'l', sdp: 'x' } });
  const env = await offer;
  return host.roster.find((member) => member.clientId === env.from)?.tabId ?? null;
}

async function joinAfter(host, viewer) {
  const announced = nextEnvelope(host, 'presence', (env) => env.payload?.event === 'join' && env.payload?.member?.tabId === 'c01');
  const joined = waitEvent(viewer, 'joined');
  viewer.connect();
  await joined;
  await announced;
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function settle(clock, ms = 2_000) {
  clock.advance(ms);
  await flush();
  clock.advance(ms);
  await flush();
}

function setup({ drain = 10_000, receiptCapacity = 4096 } = {}) {
  const clock = createFakeClock();
  const client = createFakeRoomClient({ clientId: 'viewer-1' });
  const origin = createHostOrigin({ clock, readSource, wallNow: clock.now });
  const rtc = createFakeRtcFactory({
    clock,
    stats: stats(),
    hostDrainBytesPerMs: drain,
    viewerDrainBytesPerMs: 10_000,
    onLink(link) { origin.attach(link.host, { viewerTag: 'c01' }); },
  });
  const originalSend = client.send;
  client.send = (message) => {
    originalSend(message);
    if (message.type === 'host-link-offer') {
      queueMicrotask(() => client.emit('host-link-answer', {
        from: message.to,
        payload: { linkId: message.payload.linkId, sdp: 'fake-answer' },
      }));
    }
    return message;
  };
  const link = createHostLink({
    client,
    RTCPeerConnection: rtc.RTCPeerConnection,
    clock,
    wallNow: clock.now,
    receiptCapacity,
  });
  client.emitEvent('joined', { clientId: 'viewer-1', roster: [{ clientId: 'host-1', role: 'host' }] });
  return { clock, origin, link, rtc };
}

function cohort(receipts, originSnapshot) {
  return computeReceiptCohort({
    declaredClientTags: ['c01'],
    window: { startMs: 0, endMs: 100_000 },
    originEnd: originSnapshot.counters,
    clients: {
      c01: {
        requestTimebase: 'measure-window',
        requests: receipts.map((receipt) => ({
          requestId: receipt.requestId,
          originResponseId: receipt.originResponseId,
          url: receipt.url,
          endMs: receipt.endMs,
          bodyBytes: receipt.bodyBytes,
          finished: receipt.finished,
          canceled: receipt.canceled,
        })),
      },
    },
  });
}

function expectError(fn, text) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error, `expected an error containing ${text}`);
  assert(error.message.includes(text), `error should name ${text}, got ${error.message}`);
}

export default async function hostReceiptsSuite() {
  await check('host-receipts: a completed receipt matches its host record and cohort', async () => {
    const rig = setup();
    await flush();
    let head = null;
    let bodyBytes = 0;
    let errors = 0;
    rig.link.request({
      path: '/media/seg-00000.m4s',
      handlers: {
        onHead(value) { head = value; },
        onChunk(chunk) { bodyBytes += chunk.byteLength; },
        onError() { errors += 1; },
      },
    });
    await settle(rig.clock);
    const receiptResult = rig.link.receipts();
    const receipt = receiptResult.records[0];
    const originSnapshot = rig.origin.snapshot();
    const record = originSnapshot.counters.responseRecords.find((entry) => entry.originResponseId === head.rid);
    assertEqual(errors, 0, 'completed receipt has no link error');
    assert(receipt, 'completed receipt is retained');
    assert(record, 'completed receipt matches a host record by rid');
    assertEqual(receipt.originResponseId, record.originResponseId, 'receipt and host record share rid');
    assertEqual(receipt.url, record.urlPath, 'receipt and host record share path');
    assertEqual(receipt.bodyBytes, bodyBytes, 'receipt body bytes are independently summed');
    assertEqual(receipt.bodyBytes, record.delivered, 'receipt body bytes equal host delivered bytes');
    assertEqual(receipt.bodyBytes, receipt.expectedBytes, 'completed receipt body bytes equal expected length');
    assertEqual(receipt.finished, true, 'completed receipt is finished');
    assertEqual(receipt.canceled, false, 'completed receipt is not canceled');
    assertEqual(cohort([receipt], originSnapshot).byClient.c01.originCompletedBytes, segment.byteLength, 'receipt cohort includes host completed bytes');
    assertEqual(cohort([receipt], originSnapshot).byClient.c01.clientCompletedBytes, segment.byteLength, 'receipt cohort includes viewer completed bytes');
    assertEqual(JSON.stringify(rig.link.snapshot().addresses), JSON.stringify({ local: '10.0.0.1', remote: '10.0.0.2' }), 'selected pair addresses are carried in link snapshot');
    rig.link.close();
  });

  await check('host-receipts: an aborted viewer receipt excludes the aborted host record from the cohort', async () => {
    const rig = setup({ drain: 100 });
    await flush();
    let head = null;
    const handle = rig.link.request({
      path: '/media/seg-big.m4s',
      handlers: { onHead(value) { head = value; } },
    });
    await settle(rig.clock, 1);
    assert(head, 'aborted receipt has a head before abort');
    handle.abort();
    await settle(rig.clock);
    const receipt = rig.link.receipts().records[0];
    const originSnapshot = rig.origin.snapshot();
    const record = originSnapshot.counters.responseRecords.find((entry) => entry.originResponseId === head.rid);
    assertEqual(receipt.canceled, true, 'aborted receipt is canceled');
    assertEqual(receipt.finished, false, 'P6 aborted receipt is not finished');
    assert(record.aborted, 'aborted receipt matches an aborted host record');
    const result = cohort([receipt], originSnapshot);
    assertEqual(result.byClient.c01.completedResponses, 0, 'aborted receipt contributes no completed cohort response');
    assertEqual(result.byClient.c01.originCompletedBytes, 0, 'aborted receipt contributes no origin cohort bytes');
    assertEqual(result.byClient.c01.clientCompletedBytes, 0, 'aborted receipt contributes no client cohort bytes');
    expectError(() => cohort([{ ...receipt, finished: true, canceled: false }], originSnapshot), 'matched origin record marked aborted');
    rig.link.close();
  });

  await check('host-receipts: a host resolves the tag of a viewer that joins after it, and after it rejoins', async ({ client }) => {
    const host = client('host-tab', 'host');
    const hostJoined = waitEvent(host, 'joined');
    host.connect();
    await hostJoined;
    assertEqual(host.roster.length, 1, 'the host joined an empty room');

    const first = client('c01', 'viewer', { autoReconnect: false });
    await joinAfter(host, first);
    assertEqual(await tagAtOffer(host, first), 'c01', "F1 host resolves a later joiner's tag");

    // The server refuses a member's presence, so the forgery never reaches the host.
    const forged = nextEnvelope(first, 'error', (env) => env.payload?.code === 'bad-envelope');
    first.send({ type: 'presence', to: ADDR_ROOM, payload: { roster: [{ clientId: first.clientId, tabId: 'forged', role: 'viewer' }] } });
    await forged;
    assertEqual(await tagAtOffer(host, first), 'c01', "F1 a member's relayed presence does not rewrite the tag");

    const departed = first.clientId;
    const left = nextEnvelope(host, 'presence', (env) => env.payload?.event === 'leave');
    first.close();
    await left;
    const again = client('c01', 'viewer', { autoReconnect: false });
    await joinAfter(host, again);
    assert(again.clientId !== departed, 'the rejoin is a new member');
    assert(!host.roster.some((member) => member.clientId === departed), 'the departed member left the host roster');
    assertEqual(await tagAtOffer(host, again), 'c01', "F1 host resolves a rejoined viewer's tag");
  });

  await check('host-receipts: capacity evicts oldest receipts and exposes missed count', async () => {
    const rig = setup({ receiptCapacity: 3 });
    await flush();
    for (let id = 0; id < 5; id += 1) rig.link.request({ path: '/media/seg-00000.m4s' });
    await settle(rig.clock);
    const result = rig.link.receipts();
    assertEqual(result.missed, 2, 'receipt capacity reports two evictions');
    assertEqual(JSON.stringify(result.records.map((entry) => entry.seq)), JSON.stringify([3, 4, 5]), 'receipt capacity retains sequences three through five');
    assertEqual(result.latestSeq, 5, 'receipt capacity reports latest sequence five');
    assertEqual(rig.link.receipts(result.latestSeq).records.length, 0, 'receipts at latest sequence are empty');
    rig.link.close();
  });
}
