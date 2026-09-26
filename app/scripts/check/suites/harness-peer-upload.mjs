import { assert, assertEqual, check } from '../harness.mjs';
import { armFor } from '../../harness/arms.mjs';

const condition = {
  delivery: 'host', peerExchange: true, clients: 1,
  bars: { responseSettleGapMs: 3_000 },
};

function base({ interfaceEnd = 43_000_000, uploadEnd = 40_000_000, viewerLinkEnd = true } = {}) {
  const input = {
    condition,
    window: { startMs: 1_000, endMs: 2_000 },
    originStart: { mediaBytesDelivered: 0, byClient: {}, unattributedMediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 0, byClient: {}, unattributedMediaBytesDelivered: 0 },
    originSettled: { atMs: 5_000, counters: { responseRecords: [] } },
    roomFinal: { counters: { byClient: {}, unattributedMediaBytesDelivered: 0 } },
    linkSamples: [{ atMs: 1_000, txBytes: 0 }, { atMs: 2_000, txBytes: 1 }],
    peerReadings: { c01: { peerExchange: 'on', attribution: 'engine-request', peerId: 'self' } },
    viewerLinkStart: { clients: { c01: { atMs: 2_000, txBytes: 0 } } },
    viewerLinkEnd: viewerLinkEnd ? { clients: { c01: { atMs: 5_001, txBytes: interfaceEnd } } } : null,
    peerBoundaryStart: { clients: { c01: { uploadBytes: { peer: 0 }, chunkBytes: { p2p: { peer: 0 } } } } },
    peerBoundaryEnd: { clients: { c01: { uploadBytes: { peer: uploadEnd }, chunkBytes: { p2p: { peer: 0 } } } } },
  };
  return input;
}

function reasons(input) {
  const found = [];
  armFor(condition).refusals(input, (reason, scope, detail) => found.push({ reason, scope, detail }));
  return found;
}

function has(reasonsFound, reason) {
  return reasonsFound.find((entry) => entry.reason === reason);
}

export default async function harnessPeerUploadSuite() {
  await check('T6 4.3: 40 MB peer upload against 38 MB interface refuses by viewer tag', async () => {
    const found = reasons(base({ interfaceEnd: 38_000_000 }));
    const refusal = has(found, 'peer-bytes-bypassed-shaped-link');
    assert(refusal, 'peer upload larger than interface refuses');
    assertEqual(refusal.detail.tag, 'c01', 'bypass refusal names c01');
    assertEqual(refusal.detail.uploadBytes, 40_000_000, 'bypass refusal reports upload delta');
  });

  await check('T6 4.3: 40 MB peer upload against 43 MB interface passes', async () => {
    const found = reasons(base({ interfaceEnd: 43_000_000 }));
    assert(!has(found, 'peer-bytes-bypassed-shaped-link'), 'peer upload within interface does not refuse');
    assert(!has(found, 'viewer-interface-evidence-unavailable'), 'complete interface evidence is available');
  });

  await check('T6 4.3: missing end link file refuses as viewer-interface-evidence-unavailable', async () => {
    const found = reasons(base({ viewerLinkEnd: false }));
    const refusal = has(found, 'viewer-interface-evidence-unavailable');
    assert(refusal, 'missing end link file refuses as unavailable');
    assertEqual(refusal.detail.tag, 'c01', 'unavailable refusal names c01');
  });

  await check('T6 4.3: an undeclared settle bar does not evaluate legacy link evidence', async () => {
    const found = reasons({ ...base({ interfaceEnd: 38_000_000 }), condition: { ...condition, bars: {} } });
    assert(!has(found, 'peer-bytes-bypassed-shaped-link'), 'legacy condition skips bypass refusal');
    assert(!has(found, 'viewer-interface-evidence-unavailable'), 'legacy condition skips unavailable refusal');
  });
}
