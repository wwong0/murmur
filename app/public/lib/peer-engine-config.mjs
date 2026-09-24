function requireString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`peerEngineConfig: ${name} must be a string`);
  return value;
}

export function peerEngineConfig({ roomId, trackerUrl, iceServers } = {}) {
  requireString(roomId, 'roomId');
  requireString(trackerUrl, 'trackerUrl');
  if (!Array.isArray(iceServers)) throw new TypeError('peerEngineConfig: iceServers must be an array');

  const core = Object.freeze({
    swarmId: roomId,
    announceTrackers: Object.freeze([trackerUrl]),
    rtcConfig: Object.freeze({ iceServers }),
  });
  return Object.freeze({ core });
}
