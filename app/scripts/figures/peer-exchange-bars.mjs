import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';
import { BYTES_LINE_RE } from '../../public/lib/bytes-readout.mjs';

export const PEER_EXCHANGE_BARS = Object.freeze([
  { key: 'B1', read: 'peerExchange,attribution,peerId,errors.count' },
  { key: 'B2', read: 'peerEngineConfig' },
  { key: 'B3', read: 'kept.peerBytes' },
  { key: 'B4', read: 'attribution,records,missed,kept,chunkBytes,uploadBytes,connected,bytesLine,synced' },
  { key: 'B5', read: 'records(kind=attempt,source=p2p).peerId,peerIds' },
  { key: 'B6', read: 'chunkBytes.p2p,uploadBytes,records(kind=attempt,source=p2p).peerId' },
  { key: 'B7', read: 'records(kind=peer,event=connect).peerId' },
  { key: 'B8', read: 'hostLink.state,records(kind=attempt,kept).path,hostReceipts.records.url' },
]);

const isObject = (value) => value !== null && typeof value === 'object';
const isInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function typeMarker(value) {
  if (isObject(value) && typeof value.__type === 'string' && Object.keys(value).length === 1) return value.__type;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  return null;
}

function sameValue(actual, expected) {
  const expectedType = typeMarker(expected);
  const actualType = typeMarker(actual);
  if (expectedType) return actualType === expectedType;
  if (actualType) return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => sameValue(actual[index], item));
  if (isObject(expected)) {
    if (!isObject(actual) || Array.isArray(actual)) return false;
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    return JSON.stringify(expectedKeys) === JSON.stringify(actualKeys) && expectedKeys.every((key) => sameValue(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
}

function expectedCoreConfig({ defaultStreamConfig, defaultCommonConfig = {}, roomId, trackerUrl, iceServers }) {
  const stream = {
    ...defaultStreamConfig,
    swarmId: roomId,
    announceTrackers: [trackerUrl],
    rtcConfig: { iceServers },
  };
  return {
    ...defaultCommonConfig,
    mainStream: stream,
    secondaryStream: { ...stream, rtcConfig: { iceServers } },
  };
}

function viewerPages(rooms) {
  return rooms.flatMap((room) => (room.viewers ?? []).map((viewer) => ({ ...viewer, roomId: room.roomId })));
}

function attemptRecords(reading) {
  return Array.isArray(reading?.peerBytes?.records) ? reading.peerBytes.records : [];
}

function keptHttpPaths(reading) {
  const records = attemptRecords(reading);
  let dispositions;
  try { dispositions = attemptDispositions(records); } catch { return null; }
  return records
    .filter((record) => record.kind === 'attempt' && record.source === 'http' && dispositions.get(record.attemptId) === 'kept')
    .map((record) => record.path);
}

function bytesLineMatches(reading) {
  const match = BYTES_LINE_RE.exec((reading?.bytesLine ?? '').trim());
  if (!match) return false;
  const [, host, peers, uploaded, fraction, connected] = match;
  const peerBytes = reading.peerBytes?.kept?.peerBytes;
  const hostBytes = reading.peerBytes?.kept?.hostBytes;
  const uploadedBytes = Object.values(reading.peerBytes?.uploadBytes ?? {}).reduce((sum, value) => sum + value, 0);
  return Number(host) === hostBytes
    && Number(peers) === peerBytes
    && Number(uploaded) === uploadedBytes
    && fraction === ((peerBytes / (hostBytes + peerBytes)).toFixed(4))
    && Number(connected) === (reading.peerBytes?.connected?.length ?? -1);
}

function bar(key, pass, observed, read, status = 'evaluated') {
  return { key, pass: Boolean(pass), status, read, observed };
}

function noExercise(key, observed, read) {
  return bar(key, false, observed, read, 'not exercised');
}

function b1(rooms) {
  const observed = rooms.map((room) => ({
    roomId: room.roomId,
    hosts: (room.hosts ?? [room.host]).map((page) => ({ peerExchange: page?.peerExchange, peerId: page?.peerBytes?.peerId, peerIds: page?.peerBytes?.peerIds })),
    viewers: (room.viewers ?? []).map((page) => ({ peerExchange: page?.peerExchange, attribution: page?.peerBytes?.attribution, peerId: page?.peerBytes?.peerId, errors: page?.peerBytes?.errors })),
  }));
  const hostsPass = rooms.length > 0 && rooms.every((room) => (room.hosts ?? [room.host]).every((page) => page?.peerExchange === 'host' && page?.peerBytes?.peerId === null && JSON.stringify(page?.peerBytes?.peerIds ?? null) === '[]'));
  const viewersPass = viewerPages(rooms).every(({ peerExchange, peerBytes }) => peerExchange === 'on'
    && peerBytes?.attribution === 'engine-request'
    && typeof peerBytes?.peerId === 'string'
    && peerBytes.peerId.length > 0
    && peerBytes?.errors?.count === 0);
  return bar('B1', hostsPass && viewerPages(rooms).length > 0 && viewersPass, observed, PEER_EXCHANGE_BARS[0].read);
}

function b2(rooms, options) {
  const observed = viewerPages(rooms).map((page) => ({ roomId: page.roomId, peerEngineConfig: page.peerEngineConfig }));
  const pass = rooms.length > 0 && viewerPages(rooms).length > 0 && viewerPages(rooms).every((page) => sameValue(
    page.peerEngineConfig,
    expectedCoreConfig({ ...options, roomId: page.roomId }),
  ));
  return bar('B2', pass, observed, PEER_EXCHANGE_BARS[1].read);
}

function b3(rooms) {
  const observed = rooms.map((room) => ({ roomId: room.roomId, peerBytes: (room.viewers ?? []).map((page) => page?.peerBytes?.kept?.peerBytes ?? null) }));
  const pass = rooms.length > 0 && rooms.every((room) => (room.viewers ?? []).some((page) => Number(page?.peerBytes?.kept?.peerBytes) > 0));
  return bar('B3', pass, observed, PEER_EXCHANGE_BARS[2].read);
}

function b4(rooms) {
  const observed = [];
  let pass = true;
  for (const page of viewerPages(rooms)) {
    const reading = page.peerBytes ?? {};
    const records = Array.isArray(reading.records) ? reading.records : [];
    let dispositions = null;
    try { dispositions = attemptDispositions(records); } catch { pass = false; }
    const segments = records.filter((record) => record.kind === 'segment');
    const segmentPass = dispositions !== null && segments.length > 0 && segments.every((record) => isInteger(record.lengthBytes) && record.keptSumBytes === record.lengthBytes);
    const anomalyPass = records.every((record) => record.kind !== 'anomaly');
    const countersPass = reading.attribution === 'engine-request' && reading.missed === 0 && reading.errors?.count === 0;
    const linePass = page.synced === true && bytesLineMatches(page);
    pass = pass && segmentPass && anomalyPass && countersPass && linePass;
    observed.push({ roomId: page.roomId, synced: page.synced, segmentCount: segments.length, attribution: reading.attribution, missed: reading.missed, errors: reading.errors, bytesLine: page.bytesLine, linePass });
  }
  return bar('B4', pass && observed.length > 0, observed, PEER_EXCHANGE_BARS[3].read);
}

function publishedIds(room) {
  return new Set((room.viewers ?? []).flatMap((page) => page?.peerBytes?.peerIds ?? []));
}

function b5(rooms) {
  const observed = [];
  let pass = true;
  for (const room of rooms) {
    const ids = publishedIds(room);
    for (const page of room.viewers ?? []) {
      const own = new Set(page.peerBytes?.peerIds ?? []);
      const attempts = attemptRecords(page).filter((record) => record.kind === 'attempt' && record.source === 'p2p');
      for (const attempt of attempts) {
        const other = [...ids].some((id) => id === attempt.peerId && !own.has(id));
        pass = pass && typeof attempt.peerId === 'string' && other;
      }
      observed.push({ roomId: room.roomId, own: [...own], attempts: attempts.map((attempt) => attempt.peerId) });
    }
  }
  return bar('B5', pass, observed, PEER_EXCHANGE_BARS[4].read);
}

function b6(rooms) {
  const observed = [];
  let pass = true;
  for (const room of rooms) {
    const otherIds = new Set(rooms.filter((candidate) => candidate !== room).flatMap((candidate) => [...publishedIds(candidate)]));
    const names = new Set();
    for (const page of room.viewers ?? []) {
      for (const key of Object.keys(page.peerBytes?.chunkBytes?.p2p ?? {})) names.add(key);
      for (const key of Object.keys(page.peerBytes?.uploadBytes ?? {})) names.add(key);
      for (const record of attemptRecords(page)) if (record.kind === 'attempt' && record.source === 'p2p') names.add(record.peerId);
    }
    const crossed = [...names].filter((id) => otherIds.has(id));
    pass = pass && crossed.length === 0;
    observed.push({ roomId: room.roomId, names: [...names], otherIds: [...otherIds], crossed });
  }
  return bar('B6', pass, observed, PEER_EXCHANGE_BARS[5].read);
}

function b7(rooms) {
  const observed = [];
  let pass = true;
  for (const room of rooms) {
    const otherIds = new Set(rooms.filter((candidate) => candidate !== room).flatMap((candidate) => [...publishedIds(candidate)]));
    const connects = (room.viewers ?? []).flatMap((page) => attemptRecords(page).filter((record) => record.kind === 'peer' && record.event === 'connect').map((record) => record.peerId));
    const crossed = connects.filter((id) => otherIds.has(id));
    pass = pass && crossed.length === 0;
    observed.push({ roomId: room.roomId, connects, otherIds: [...otherIds], crossed });
  }
  return bar('B7', pass, observed, PEER_EXCHANGE_BARS[6].read);
}

function b8(rooms) {
  const observed = [];
  let pass = true;
  for (const page of viewerPages(rooms)) {
    const paths = keptHttpPaths(page);
    const receipts = page.hostReceipts?.records ?? [];
    const receiptPaths = new Set(receipts.map((record) => record.url));
    const pathsPass = paths !== null && paths.every((path) => receiptPaths.has(path));
    const linkPass = page.hostLink?.state === 'open';
    pass = pass && linkPass && pathsPass;
    observed.push({ roomId: page.roomId, state: page.hostLink?.state, paths, receiptPaths: [...receiptPaths] });
  }
  return bar('B8', pass && observed.length > 0, observed, PEER_EXCHANGE_BARS[7].read);
}

export function evaluatePeerExchange({ rooms = [], defaults = {} } = {}) {
  const bars = [b1(rooms), b2(rooms, defaults), b3(rooms), b4(rooms)];
  const sharing = bars[2].pass;
  bars.push(sharing ? b5(rooms) : noExercise('B5', { reason: 'B3 failed' }, PEER_EXCHANGE_BARS[4].read));
  bars.push(sharing ? b6(rooms) : noExercise('B6', { reason: 'B3 failed' }, PEER_EXCHANGE_BARS[5].read));
  bars.push(sharing ? b7(rooms) : noExercise('B7', { reason: 'B3 failed' }, PEER_EXCHANGE_BARS[6].read));
  bars.push(b8(rooms));
  return { pass: bars.every((entry) => entry.pass), bars, byKey: Object.fromEntries(bars.map((entry) => [entry.key, entry])) };
}
