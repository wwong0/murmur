const finite = (value) => Number.isFinite(value);

function recordFor(raw, name) {
  return raw?.containers?.[name] ?? raw?.[name] ?? {};
}

function ipAddresses(record) {
  const value = typeof record.addresses === 'string' ? JSON.parse(record.addresses) : record.addresses;
  return (Array.isArray(value) ? value : []).flatMap((entry) => (entry.addr_info ?? []).map((info) => ({
    ifName: entry.ifname, address: info.local, family: info.family,
  }))).filter((entry) => entry.family === 'inet');
}

function endpoint(value) {
  const token = String(value).replace(/^\[/, '').replace(/\]$/, '');
  const colon = token.lastIndexOf(':');
  if (colon < 0) return { address: token, port: null };
  const port = Number(token.slice(colon + 1));
  return { address: token.slice(0, colon), port: Number.isFinite(port) ? port : null };
}

function sockets(text) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    return { local: endpoint(fields.at(-2)), remote: endpoint(fields.at(-1)) };
  });
}

function listeners(text) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).map((line) => endpoint(line.trim().split(/\s+/).at(-2)));
}

function qdiscs(record) {
  return Object.entries(record.qdiscs ?? {}).flatMap(([ifName, text]) => String(text).split(/\r?\n/).filter((line) => /^qdisc\s+\S+/.test(line)).map((line) => ({
    ifName, kind: line.match(/^qdisc\s+(\S+)/)?.[1] ?? null,
  })));
}

function mediaAddress(record, preferredPeer = null) {
  const addresses = ipAddresses(record).map((entry) => entry.address).filter((address) => address !== '127.0.0.1');
  return preferredPeer?.local?.address ?? addresses[0] ?? null;
}

function serverAddress(record) {
  const connection = sockets(record.established).find((entry) => entry.local.port === 8100);
  return connection?.local.address ?? mediaAddress(record);
}

export function topologyReadback({ raw = {}, declaredViewers = [] } = {}) {
  const originRaw = recordFor(raw, 'origin');
  const serverRaw = recordFor(raw, 'server');
  // The addresses resolved on the media subnet win over the socket lists: the
  // server sits on two networks, and its published port arrives on either.
  const resolved = raw?.mediaAddresses ?? {};
  const serverMediaAddress = resolved.server ?? serverAddress(serverRaw);
  const originConnections = sockets(originRaw.established);
  const hostConnection = originConnections.find((entry) => entry.remote.port === 8100 && entry.remote.address === serverMediaAddress);
  const originMediaAddress = resolved.origin ?? mediaAddress(originRaw, hostConnection);
  const originListeners = listeners(originRaw.listeners);
  const serverQdiscs = qdiscs(serverRaw);
  const refusals = [];
  const add = (reason) => { if (!refusals.includes(reason)) refusals.push(reason); };
  const viewers = {};
  for (const tag of declaredViewers) {
    const peers = [...new Set(sockets(recordFor(raw, tag).established)
      .filter((entry) => entry.remote.port === 8100).map((entry) => entry.remote.address))];
    const wsPeer = peers.length === 1 ? peers[0] : null;
    viewers[tag] = { wsPeer };
    if (peers.length !== 1) add('topology-viewer-ws-unread');
    else if (wsPeer === originMediaAddress) add('topology-viewer-via-origin');
  }
  if (serverQdiscs.some((entry) => ['tbf', 'netem', 'htb'].includes(entry.kind))) add('topology-server-shaped');
  if (originListeners.some((entry) => [8100, 8102].includes(entry.port) && entry.address !== '127.0.0.1')) add('topology-origin-exposed');
  if (!hostConnection) add('topology-host-room-unread');
  return {
    origin: { mediaAddress: originMediaAddress, listeners: originListeners },
    server: { mediaAddress: serverMediaAddress, qdiscs: serverQdiscs },
    viewers,
    host: { roomPeer: hostConnection?.remote.address ?? null },
    refusals,
  };
}

function counter(value, field) {
  const counters = value?.counters ?? value ?? {};
  const direct = Number(counters[field]);
  if (finite(direct) && direct >= 0) return direct;
  if (field !== 'mediaBytesDelivered') return null;
  const byClient = counters.byClient;
  if (!byClient || typeof byClient !== 'object') return null;
  const values = Object.values(byClient).map((entry) => Number(entry?.mediaBytesDelivered));
  return values.every((entry) => finite(entry) && entry >= 0) ? values.reduce((sum, entry) => sum + entry, 0) : null;
}

function delta(after, before) {
  const right = counter(after, 'mediaBytesDelivered');
  const left = counter(before, 'mediaBytesDelivered');
  return finite(right) && finite(left) && right >= left ? right - left : null;
}

export function hostSourceOnLoopback({ serverStart, serverEnd, mediaStart, mediaEnd, readback } = {}) {
  const mediaBytes = delta(mediaEnd, mediaStart);
  const serverBytes = delta(serverEnd, serverStart);
  const listeners = readback?.origin?.listeners ?? [];
  const mediaListener = listeners.find((entry) => entry.port === 8102);
  const localOnly = Boolean(mediaListener) && listeners
    .filter((entry) => entry.port === 8102)
    .every((entry) => entry.address === '127.0.0.1');
  const reasons = [];
  if (!(mediaBytes > 0)) reasons.push('media-instance-no-bytes');
  if (serverBytes !== 0) reasons.push('server-delivered-media');
  if (!localOnly) reasons.push('media-listener-not-loopback');
  return {
    answer: reasons.length === 0 ? 'loopback' : 'inconclusive',
    mediaBytes,
    serverBytes,
    reason: reasons.join(','),
  };
}
