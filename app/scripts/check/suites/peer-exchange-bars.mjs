import { assert, assertEqual, check } from '../harness.mjs';
import { bytesText } from '../../../public/lib/bytes-readout.mjs';
import { evaluatePeerExchange } from '../../figures/peer-exchange-bars.mjs';

const DEFAULTS = {
  isP2PUploadDisabled: false,
  isP2PDisabled: false,
  simultaneousHttpDownloads: 2,
  simultaneousP2PDownloads: 3,
  highDemandTimeWindow: 15,
  httpDownloadInitialTimeoutMs: 0,
  httpDownloadTimeWindow: 3000,
  p2pDownloadTimeWindow: 6000,
  webRtcMaxMessageSize: 65535,
  p2pNotReceivingBytesTimeoutMs: 2000,
  p2pInactiveLoaderDestroyTimeoutMs: 30000,
  httpNotReceivingBytesTimeoutMs: 3000,
  httpErrorRetries: 3,
  p2pErrorRetries: 3,
  announceTrackers: ['wss://tracker.novage.com.ua', 'wss://tracker.openwebtorrent.com'],
  rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] },
  validateP2PSegment: undefined,
  validateHTTPSegment: undefined,
  httpRequestSetup: undefined,
  swarmId: undefined,
  p2pMaxPeers: 50,
  p2pChurnMaxPeersMultiplier: 1.5,
  p2pChurnCleanupIntervalMs: 30000,
  p2pChurnGracePeriodMs: 15000,
  webRtcOffersCount: 5,
  webRtcOfferTimeoutMs: 50000,
  webRtcIceGatheringTimeoutMs: 5000,
  webRtcConnectionTimeoutMs: 15000,
};
const COMMON = { segmentMemoryStorageLimit: undefined, customSegmentStorageFactory: undefined, trackerClientVersionPrefix: '-PM0300-' };
const TRACKER = 'ws://tracker.test:8127';

function config(roomId) {
  const stream = { ...DEFAULTS, announceTrackers: [TRACKER], rtcConfig: { iceServers: [] }, swarmId: roomId };
  return { ...COMMON, mainStream: stream, secondaryStream: { ...stream, rtcConfig: { iceServers: [] } } };
}

function attempt(attemptId, source, peerId, path = '/media/seg-00010.m4s') {
  return { kind: 'attempt', attemptId, runtimeId: `${path}#${attemptId}`, path, source, peerId, bytes: source === 'p2p' ? 60 : 40, heldAtStartBytes: 0, heldAtEndBytes: source === 'p2p' ? 60 : 40 };
}

function viewer(roomId, own, remote, path = '/media/seg-00010.m4s') {
  const records = [
    attempt(1, 'http', null, path),
    attempt(2, 'p2p', remote, path),
    { kind: 'segment', runtimeId: path, path, lengthBytes: 100, completedAtMs: 3, keptAttemptIds: [1, 2], keptSumBytes: 100 },
    { kind: 'peer', event: 'connect', peerId: remote, atMs: 2 },
  ];
  const peerBytes = { attribution: 'engine-request', peerId: own, peerIds: [own], records, latestSeq: 4, missed: 0, kept: { hostBytes: 40, peerBytes: 60 }, chunkBytes: { http: 40, p2p: { [remote]: 60 } }, uploadBytes: { [remote]: 12 }, connected: [remote], errors: { count: 0, last: null } };
  return {
    peerExchange: 'on', synced: true, peerEngineConfig: config(roomId), peerBytes,
    bytesLine: bytesText(peerBytes), hostLink: { state: 'open' },
    hostReceipts: { records: [{ url: path, finished: true, canceled: false }], latestSeq: 1, missed: 0 },
  };
}

function host() {
  return { peerExchange: 'host', peerBytes: { attribution: null, peerId: null, peerIds: [], records: [], kept: { hostBytes: 0, peerBytes: 0 }, chunkBytes: { http: 0, p2p: {} }, uploadBytes: {}, connected: [], errors: { count: 0 } } };
}

function baseline() {
  return {
    rooms: [
      { roomId: 'room-a', host: host(), viewers: [viewer('room-a', 'a-v1', 'a-v2'), viewer('room-a', 'a-v2', 'a-v1')] },
      { roomId: 'room-b', host: host(), viewers: [viewer('room-b', 'b-v1', 'b-v2'), viewer('room-b', 'b-v2', 'b-v1')] },
    ],
  };
}

const options = { defaultStreamConfig: DEFAULTS, defaultCommonConfig: COMMON, trackerUrl: TRACKER, iceServers: [] };

function clone() { return structuredClone(baseline()); }

export default async function peerExchangeBarsSuite() {
  await check('peer-exchange bars: constructed two-room reading passes every bar', async () => {
    const result = evaluatePeerExchange({ ...baseline(), defaults: options });
    assertEqual(result.pass, true, 'all peer-exchange bars pass');
    assertEqual(result.bars.length, 8, 'all eight bars are evaluated');
    assert(result.bars.every((bar) => bar.pass), 'every bar passes');
  });

  const mutations = [
    ['B1', (reading) => { reading.rooms[0].viewers[0].peerExchange = 'off'; }],
    ['B2', (reading) => { reading.rooms[0].viewers[0].peerEngineConfig.mainStream.highDemandTimeWindow += 1; }],
    ['B3', (reading) => { for (const room of reading.rooms) for (const page of room.viewers) { page.peerBytes.kept.peerBytes = 0; page.bytesLine = bytesText(page.peerBytes); } }],
    ['B4', (reading) => { reading.rooms[0].viewers[0].bytesLine = reading.rooms[0].viewers[0].bytesLine.replace('peers 60 B', 'peers 61 B'); }],
    ['B5', (reading) => { reading.rooms[0].viewers[0].peerBytes.records[1].peerId = 'host-id'; }],
    ['B6', (reading) => { reading.rooms[0].viewers[0].peerBytes.chunkBytes.p2p = { 'b-v1': 60 }; }],
    ['B7', (reading) => { reading.rooms[0].viewers[0].peerBytes.records[3].peerId = 'b-v1'; }],
    ['B8', (reading) => { reading.rooms[0].viewers[0].hostReceipts.records = []; }],
  ];
  for (const [key, mutate] of mutations) {
    await check(`peer-exchange bars: ${key} fails on its named reading`, async () => {
      const reading = clone();
      mutate(reading);
      const result = evaluatePeerExchange({ ...reading, defaults: options });
      assertEqual(result.byKey[key].pass, false, `${key} fails`);
      const unaffected = result.bars.filter((bar) => !bar.pass).map((bar) => bar.key);
      if (key === 'B3') assertEqual(JSON.stringify(unaffected), JSON.stringify(['B3', 'B5', 'B6', 'B7']), 'B3 gates B5, B6 and B7');
      else assertEqual(JSON.stringify(unaffected), JSON.stringify([key]), `${key} is the only failed bar`);
    });
  }

  // Cases whose one change is read by more than one bar, with every bar that reads it named.
  const shared = [
    ['a cross-room id in an attempt', (reading) => { reading.rooms[0].viewers[0].peerBytes.records[1].peerId = 'b-v1'; }, ['B5', 'B6']],
    ['a kept sum off by one', (reading) => { reading.rooms[0].viewers[0].peerBytes.records[2].keptSumBytes = 101; }, ['B4']],
    ['an anomaly record', (reading) => { reading.rooms[0].viewers[0].peerBytes.records.push({ kind: 'anomaly', runtimeId: 'x', path: '/media/x', reason: 'end-held-mismatch' }); }, ['B4']],
    ['a line read apart from its reading', (reading) => { reading.rooms[0].viewers[0].synced = false; }, ['B4']],
  ];
  for (const [name, mutate, expected] of shared) {
    await check(`peer-exchange bars: ${name} fails exactly ${expected.join(' and ')}`, async () => {
      const reading = clone();
      mutate(reading);
      const result = evaluatePeerExchange({ ...reading, defaults: options });
      assertEqual(JSON.stringify(result.bars.filter((bar) => !bar.pass).map((bar) => bar.key)), JSON.stringify(expected), `${name} fails ${expected.join(', ')}`);
    });
  }

  await check('peer-exchange bars: B3 failure reports B5, B6 and B7 not exercised', async () => {
    const reading = clone();
    for (const room of reading.rooms) for (const page of room.viewers) { page.peerBytes.kept.peerBytes = 0; page.bytesLine = bytesText(page.peerBytes); }
    const result = evaluatePeerExchange({ ...reading, defaults: options });
    assertEqual(result.byKey.B5.status, 'not exercised', 'B5 is not exercised');
    assertEqual(result.byKey.B6.status, 'not exercised', 'B6 is not exercised');
    assertEqual(result.byKey.B5.pass, false, 'B5 cannot pass when unexercised');
    assertEqual(result.byKey.B6.pass, false, 'B6 cannot pass when unexercised');
    assertEqual(result.byKey.B7.status, 'not exercised', 'B7 is not exercised');
    assertEqual(result.byKey.B7.pass, false, 'B7 cannot pass when unexercised');
  });
}
