import { assert, assertEqual, check } from '../harness.mjs';
import { evaluateRefusals, refusalReasonSetIsUnique } from '../../harness/refusals.mjs';

// P9 opportunity: host run receives viewer-tagged room media; mutation: skip
// viewer tags in viewerHttpLeak; named red assertion: "P9 viewer leak refuses";
// restoration: reverted by hand to staged tree; green rerun: npm run check.
// P10 opportunity: media interface must carry at least delivered bytes;
// mutation: compare against half delivered bytes; named red assertion: "P10
// uplink below delivered refuses"; restoration: reverted by hand to staged
// tree; green rerun: npm run check.
// P11 opportunity: receipt evidence can be lost or reset; mutation: drop the
// receipt-health checks; named red assertion: "P11 receipt log refuses";
// restoration: reverted by hand to staged tree; green rerun: npm run check.

const condition = {
  name: 'constructed-host',
  delivery: 'host',
  publishes: false,
  clients: 2,
  bars: { recordCoverageMin: 0, droppedFrameFractionMax: 1, driftLogMissedMax: 0 },
};
const client = {
  finalPlayback: { begun: 1 },
  records: [{ seq: 1, displaySharedMs: 0, mediaMs: 0, presentedFrames: 0 }, { seq: 2, displaySharedMs: 100, mediaMs: 100, presentedFrames: 1 }],
  polls: [{ atMs: 0, quality: { droppedVideoFrames: 0, totalVideoFrames: 0 }, stalls: { epoch: 'e' } }, { atMs: 100, quality: { droppedVideoFrames: 0, totalVideoFrames: 1 }, stalls: { epoch: 'e' } }],
  driftLogMissed: 0,
  maxDriftDrainGapMs: 0,
};

function evidence({ c02Bytes = 0, c00Bytes = 0, txBytes = 210_000_000, missed = 0, reset = false, delivery = 'host' } = {}) {
  return {
    condition: { ...condition, delivery },
    window: { startMs: 0, endMs: 100 },
    declaredClientTags: ['c01', 'c02'],
    clients: { c01: { ...client }, c02: { ...client } },
    originStart: { mediaBytesDelivered: 0, byClient: {}, unattributedMediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 210_000_000, byClient: {}, unattributedMediaBytesDelivered: 0 },
    roomFinal: { counters: { byClient: { c00: { mediaBytesDelivered: c00Bytes }, c02: { mediaBytesDelivered: c02Bytes } }, unattributedMediaBytesDelivered: 0 } },
    linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 100, txBytes }],
    receiptHealth: { c01: { missed, reset }, c02: { missed: 0, reset: false } },
  };
}

function has(result, reason) {
  return result.reasonSet.includes(reason);
}

export default async function hostOriginRefusalsSuite() {
  await check('host-origin refusals: P9 viewer leak refuses and host-tagged bytes pass', async () => {
    const leaked = evaluateRefusals(evidence({ c02Bytes: 1_300_000 }));
    assert(has(leaked, 'viewer-media-over-http'), 'P9 viewer leak refuses');
    assertEqual(leaked.reasons.find((entry) => entry.reason === 'viewer-media-over-http').tag, 'c02', 'P9 names leaked viewer');
    assertEqual(leaked.reasons.find((entry) => entry.reason === 'viewer-media-over-http').bytes, 1_300_000, 'P9 names leaked bytes');
    const hostOnly = evaluateRefusals(evidence({ c00Bytes: 1_300_000 }));
    assertEqual(has(hostOnly, 'viewer-media-over-http'), false, 'P9 host-tagged source bytes do not leak');
    const unattributed = evaluateRefusals({ ...evidence(), roomFinal: { counters: { byClient: {}, unattributedMediaBytesDelivered: 1 } } });
    assert(has(unattributed, 'viewer-media-over-http'), 'P9 unattributed media refuses');
  });

  await check('host-origin refusals: P10 uplink below delivered refuses at the strict boundary', async () => {
    const below = evaluateRefusals(evidence({ txBytes: 209_999_999 }));
    const reason = below.reasons.find((entry) => entry.reason === 'host-uplink-below-delivered');
    assert(reason, 'P10 uplink below delivered refuses');
    assertEqual(reason.txBytes, 209_999_999, 'P10 names interface bytes');
    assertEqual(reason.deliveredMediaBytes, 210_000_000, 'P10 names delivered bytes');
    const equal = evaluateRefusals(evidence({ txBytes: 210_000_000 }));
    assertEqual(has(equal, 'host-uplink-below-delivered'), false, 'P10 equal uplink is not below delivered');
  });

  await check('host-origin refusals: P11 discarded and reset receipt logs refuse', async () => {
    assert(has(evaluateRefusals(evidence({ missed: 1 })), 'receipt-log-discarded-records'), 'P11 missed receipts refuse');
    assert(has(evaluateRefusals(evidence({ reset: true })), 'receipt-log-reset'), 'P11 reset receipts refuse');
  });

  await check('host-origin refusals: reason set is unique and HTTP evidence is unchanged', async () => {
    assertEqual(refusalReasonSetIsUnique(), true, 'declared refusal reasons are unique');
    const http = evaluateRefusals(evidence({ delivery: 'http', c02Bytes: 1_300_000 }));
    assertEqual(has(http, 'viewer-media-over-http'), false, 'HTTP evidence does not gain host leak refusal');
    assertEqual(has(http, 'host-uplink-below-delivered'), false, 'HTTP evidence does not gain host uplink refusal');
    assertEqual(has(http, 'receipt-log-discarded-records'), false, 'HTTP evidence does not gain host receipt refusal');
  });
}
