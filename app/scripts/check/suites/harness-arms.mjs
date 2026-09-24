import { assert, assertEqual, check } from '../harness.mjs';
import { armFor } from '../../harness/arms.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';

const condition = {
  name: 'constructed-arm',
  publishes: false,
  clients: 2,
  bars: { recordCoverageMin: 0, droppedFrameFractionMax: 1, driftLogMissedMax: 0 },
};
const client = {
  finalPlayback: { begun: 1 },
  records: [{ seq: 1, displaySharedMs: 0, mediaMs: 0, presentedFrames: 0 }, { seq: 2, displaySharedMs: 100, mediaMs: 100, presentedFrames: 1 }],
  polls: [{ atMs: 0, quality: { droppedVideoFrames: 0, totalVideoFrames: 0 } }, { atMs: 100, quality: { droppedVideoFrames: 0, totalVideoFrames: 1 } }],
  driftLogMissed: 0,
  maxDriftDrainGapMs: 0,
};

function evidence(delivery, extras = {}) {
  return {
    condition: { ...condition, delivery },
    window: { startMs: 0, endMs: 100 },
    declaredClientTags: ['c01', 'c02'],
    clients: { c01: { ...client }, c02: { ...client } },
    originStart: { mediaBytesDelivered: 0, byClient: {}, unattributedMediaBytesDelivered: 0 },
    originEnd: { mediaBytesDelivered: 210_000_000, byClient: {}, unattributedMediaBytesDelivered: 0 },
    ...extras,
  };
}

export default async function harnessArmsSuite() {
  await check('harness arms: only HTTP and host are supported and missing delivery defaults to HTTP', async () => {
    assert(Object.isFrozen(armFor({ delivery: 'http' })), 'HTTP arm is frozen');
    assert(Object.isFrozen(armFor({ delivery: 'host' })), 'host arm is frozen');
    assertEqual(armFor({}).runDirPrefix, '6a', 'missing delivery selects HTTP');
    assertEqual(armFor({ delivery: 'http' }).runDirPrefix, '6a', 'HTTP run prefix');
    assertEqual(armFor({ delivery: 'host' }).runDirPrefix, '7a2', 'host run prefix');
    let failed = false;
    try { armFor({ delivery: 'peer' }); } catch { failed = true; }
    assert(failed, 'peer and unknown delivery values throw');
  });

  await check('harness arms: an HTTP run has one host, and a host run adds c00 with every client a viewer', async () => {
    const http = armFor({ delivery: 'http' }).members({ clients: 3 });
    assertEqual(JSON.stringify(http.declaredRoles), JSON.stringify(['host', 'viewer', 'viewer']), 'HTTP roles');
    assertEqual(JSON.stringify(http.declaredTags), JSON.stringify(['c01', 'c02', 'c03']), 'HTTP tags');
    const host = armFor({ delivery: 'host' }).members({ clients: 3 });
    assertEqual(JSON.stringify(host.declaredRoles), JSON.stringify(['host', 'viewer', 'viewer', 'viewer']), 'host roles');
    assertEqual(JSON.stringify(host.declaredTags), JSON.stringify(['c00', 'c01', 'c02', 'c03']), 'host tags');
  });

  await check('harness arms: refusal reasons retain the pre-refactor qualification and host choices', async () => {
    const http = evaluateRefusals({
      ...evidence('http'),
      requireCdpQualification: true,
      cdpQualification: { status: 'failed', reason: 'constructed' },
    });
    assertEqual(JSON.stringify(http.reasonSet), JSON.stringify(['cdp-byte-mapping-unqualified']), 'HTTP arm reasons');

    const host = evaluateRefusals({
      ...evidence('host', {
        roomFinal: { counters: { byClient: { c00: { mediaBytesDelivered: 1_300_000 }, c02: { mediaBytesDelivered: 1_300_000 } }, unattributedMediaBytesDelivered: 0 } },
        linkSamples: [{ atMs: 0, txBytes: 0 }, { atMs: 100, txBytes: 209_999_999 }],
        receiptHealth: { c01: { missed: 1, reset: true }, c02: { missed: 0, reset: false } },
      }),
      requireCdpQualification: true,
      cdpQualification: { status: 'failed', reason: 'constructed' },
    });
    assertEqual(JSON.stringify(host.reasonSet), JSON.stringify([
      'link-receipt-mapping-unqualified',
      'viewer-media-over-http',
      'host-uplink-below-delivered',
      'receipt-log-discarded-records',
      'receipt-log-reset',
    ]), 'host arm reasons');
  });
}
