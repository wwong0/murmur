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

  await check('harness peer arm: readiness waits for peer settings before reading', async () => {
    let settingsReads = 0;
    const session = {
      tag: 'c01', role: 'viewer',
      tab: { evaluate: async (expression) => {
        if (expression === '__app.peerExchange()') return ++settingsReads < 3 ? null : 'on';
        return {
          buildId: 'build-a', peerExchange: settingsReads >= 3 ? 'on' : null,
          positionOffset: { ms: 0, error: null }, peerBytes: { attribution: 'engine-request', peerId: 'p1' },
        };
      } },
    };
    const manifestBody = { clients: {} };
    const manifestFile = { get: () => manifestBody, merge: Object.assign, write() {} };
    const options = armFor({ delivery: 'host', peerExchange: true, clients: 1 })
      .prepareClientOptions({ condition: { positionOffsetMsByClient: { c01: 0 } }, manifestFile });
    const deadline = { waitFor: async (_label, read, done) => {
      let value = await read();
      while (!done(value)) value = await read();
      return value;
    } };
    await options.afterReady(session, { deadline, readyTimeoutMs: 1000 });
    assertEqual(settingsReads, 3, 'settings were read until non-null');
    assertEqual(session.peerReadyReading.peerExchange, 'on', 'ready reading is on');
  });

  await check('harness arms: a host run places its window after cadence, a peer run before its playback wait', async () => {
    const opened = async (condition) => {
      const steps = [];
      const body = {};
      await armFor(condition).openWindow({
        sessions: [{ tag: 'c01', role: 'viewer', tab: { evaluate: async () => ({ playing: true }) } }],
        condition,
        establishCadence: async () => { steps.push('cadence'); return { source: 'constructed' }; },
        manifestFile: { merge: (value) => { steps.push(...Object.keys(value)); Object.assign(body, value); }, write() { steps.push('write'); } },
        placeWindow: () => ({ startMs: 0 }),
        drainAll: async () => { steps.push('drain'); },
      });
      return { steps, body };
    };
    const host = await opened({ delivery: 'host', clients: 1 });
    assertEqual(JSON.stringify(host.steps), JSON.stringify(['cadence', 'cadence', 'window']), 'host: cadence, then cadence and window merged');
    const peer = await opened({ delivery: 'host', peerExchange: true, clients: 1 });
    assertEqual(JSON.stringify(peer.steps), JSON.stringify(['window', 'multiplierDenominator', 'drain', 'startWait', 'write', 'drain', 'cadence', 'cadence']),
      'peer: window, denominator, the drained wait, its record, a drain, then cadence');
    assertEqual(peer.body.startWait.playingAtMs.c01 !== null, true, 'the playing viewer is recorded');
  });

  await check('harness peer arm: playback wait records late starts inside its deadline', async () => {
    let clock = 0;
    const calls = { c01: 0, c02: 0 };
    const sessions = ['c01', 'c02'].map((tag) => ({ tag, role: 'viewer', tab: {
      evaluate: async () => ({ playing: ++calls[tag] >= (tag === 'c02' ? 3 : 1) }),
    } }));
    const result = await armFor({ delivery: 'host', peerExchange: true }).waitForPlayback({
      sessions, window: { startMs: 31_050 }, now: () => clock,
      sleep: async () => { clock += 500; },
    });
    assertEqual(result.deadlineMs, 1_050, 'playback deadline is the ceiling before the window');
    assertEqual(result.playingAtMs.c01, 0, 'first viewer starts immediately');
    assertEqual(result.playingAtMs.c02, 1_000, 'late viewer is observed on the third poll');
  });

  await check('harness peer arm: the playback wait drains at its start and every drain interval', async () => {
    // One viewer never plays, so the wait runs to its deadline: 0 → 1 050 ms in 500 ms sleeps.
    let clock = 0;
    const drainedAt = [];
    const sessions = [{ tag: 'c01', role: 'viewer', tab: { evaluate: async () => ({ playing: false }) } }];
    await armFor({ delivery: 'host', peerExchange: true }).waitForPlayback({
      sessions, window: { startMs: 31_050 }, now: () => clock,
      sleep: async () => { clock += 500; }, drain: async () => { drainedAt.push(clock); }, drainEveryMs: 1_000,
    });
    assertEqual(JSON.stringify(drainedAt), JSON.stringify([0, 1_000]), 'drained at the start and after one interval');
  });
}
