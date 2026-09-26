import { assert, assertEqual, check } from '../harness.mjs';
import { computePeerChecks } from '../../figures/peer-checks.mjs';
import { armFor } from '../../harness/arms.mjs';

const bars = {
  conservationChannelBytes: 131_071,
  conservationRelativeMax: 0.05,
  conservationDeliveryGapMs: 3_000,
};

function totals(peerId, upload, received, readStartedAtMs, readEndedAtMs) {
  const remote = peerId === 'A' ? 'B' : 'A';
  return {
    peerId,
    peerIds: [peerId],
    uploadBytes: { [remote]: upload },
    chunkBytes: { p2p: { [remote]: received } },
    readStartedAtMs,
    readEndedAtMs,
  };
}

function fixture({ shaped = true, records = null } = {}) {
  const peerRecords = records ?? [
    { kind: 'attempt', attemptId: 1, path: '/media/seg-00000.m4s', source: 'p2p', peerId: 'A', end: 'abort', heldAtEndBytes: 801_791 },
    { kind: 'attempt', attemptId: 2, path: '/media/seg-00001.m4s', source: 'p2p', peerId: 'A', end: 'error:peer-closed', heldAtEndBytes: 1_365_442 },
    { kind: 'peer', event: 'close', peerId: 'A' },
  ];
  return {
    declaredClientTags: ['A', 'B'],
    content: { segmentSizes: [1_000_000, 2_000_000] },
    condition: { bars },
    clients: {
      A: {
        peerRecords: [],
        peerTotalsA: totals('A', 1_000_000, 0, 0, 1),
        peerTotalsB: totals('A', 1_000_000, 0, 3_030, 3_031),
      },
      B: {
        peerRecords,
        peerTotalsA: totals('B', 0, 1_000_000, 20, 30),
        peerTotalsB: totals('B', 0, 299_907, 3_020, 3_030),
      },
    },
    ...(shaped ? { peerLinkQueues: { A: { queueLimitBytes: 504_000 } } } : {}),
  };
}

function conservation(input) {
  return computePeerChecks(input, bars)[3];
}

function pair(result, sender = 'A', receiver = 'B') {
  return result.pairs.find((entry) => entry.sender === sender && entry.receiver === receiver);
}

export default async function peerConservationShapedSuite() {
  await check('T6b: shaped cancels add segment remainder plus queue to one pair allowance', async () => {
    const result = conservation(fixture());
    const shaped = pair(result);
    assert(result.passed, 'shaped pair with physical cancel allowance passes');
    assertEqual(shaped.shortfall, 700_093, 'shaped pair publishes shortfall');
    assertEqual(shaped.allowance, 963_838, 'shaped pair publishes channel and cancel allowance');
    assertEqual(shaped.closes, 1, 'shaped pair publishes close count');
    assertEqual(shaped.cancels, 2, 'shaped pair publishes cancel count');
  });

  await check('T6b: shaped shortfall without a cancel allowance refuses conservation-mismatch', async () => {
    const records = [{ kind: 'peer', event: 'close', peerId: 'A' }];
    const result = conservation(fixture({ records }));
    assert(!result.passed, 'shaped pair with only one close is red');
    assert(result.failures.some((failure) => failure.type === 'conservation-mismatch'), 'shaped shortfall names conservation-mismatch');
  });

  await check('T6b: shaped receiver-over-sender remains an exact upper-bound failure', async () => {
    const input = fixture();
    input.clients.B.peerTotalsA.chunkBytes.p2p.A = 1_000_001;
    const result = conservation(input);
    assert(!result.passed, 'receiver one byte over sender is red');
    assert(result.failures.some((failure) => failure.type === 'conservation-mismatch'), 'upper-bound failure names conservation-mismatch');
  });

  await check('T6b: a cancel term is capped at channel plus the shaped queue', async () => {
    const input = fixture();
    input.clients.B.peerRecords[0] = { ...input.clients.B.peerRecords[0], heldAtEndBytes: 0 };
    const shaped = pair(conservation(input));
    assertEqual(shaped.allowance - (bars.conservationChannelBytes + 634_558), 635_071,
      'one oversized cancel contributes the 635071-byte cap');
  });

  await check('T6b: unshaped pairs retain the legacy tolerance refusal and no shaped pairs field', async () => {
    const input = fixture({ shaped: false });
    input.clients.B.peerRecords.push({ kind: 'peer', event: 'close', peerId: 'A' });
    const result = conservation(input);
    assert(result.passed, 'legacy tolerance refusal is not a conservation failure');
    assertEqual(result.toleranceRefusals.length, 1, 'legacy pair retains its tolerance refusal');
    assertEqual(result.pairs, undefined, 'legacy result has no shaped pairs field');
  });

  await check('T6b: a cancelled attempt with an unknown segment refuses by conservation-segment-unknown', async () => {
    const input = fixture();
    input.clients.B.peerRecords[0] = { ...input.clients.B.peerRecords[0], path: '/media/not-a-segment.m4s' };
    const result = conservation(input);
    assert(!result.passed, 'unknown cancelled segment is red');
    assert(result.failures.some((failure) => failure.type === 'conservation-segment-unknown'), 'unknown segment has its named failure');
  });

  await check('T6b: peer arm derives a 504000-byte queue from read-back rate, burst and latency', async () => {
    const arm = armFor({ delivery: 'host', peerExchange: true });
    const manifest = {
      condition: { clients: 1 },
      topology: {
        containers: { c01: 'client-1' },
        qdiscs: [{ container: 'client-1', network: 'wa-media', direction: 'egress', discipline: 'tbf',
          readBack: { readings: { rate: { got: 10_000_000 }, burst: { got: 4_000 }, latency: { got: 400 } } } }],
      },
    };
    const extras = arm.recomputeInputExtras(manifest);
    assertEqual(extras.peerLinkQueues.c01.queueLimitBytes, 504_000, 'read-back queue limit is 504000 bytes');
    manifest.topology.qdiscs[0].readBack.readings.latency.got = null;
    assertEqual(JSON.stringify(arm.recomputeInputExtras(manifest).peerLinkQueues), '{}', 'incomplete read-back is unshaped');
  });
}
