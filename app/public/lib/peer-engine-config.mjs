import { validateEngineWindows, PRODUCT_ENGINE_WINDOWS } from './engine-windows.mjs';

function requireString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`peerEngineConfig: ${name} must be a string`);
  return value;
}

export function peerEngineConfig({ roomId, trackerUrl, iceServers, windows = null } = {}) {
  requireString(roomId, 'roomId');
  requireString(trackerUrl, 'trackerUrl');
  if (!Array.isArray(iceServers)) throw new TypeError('peerEngineConfig: iceServers must be an array');
  if (windows !== null && windows !== undefined) {
    const result = validateEngineWindows(windows);
    if (result.error) throw new TypeError(`peerEngineConfig: ${result.error}`);
    windows = result.windows;
  }

  const core = Object.freeze({
    swarmId: roomId,
    announceTrackers: Object.freeze([trackerUrl]),
    rtcConfig: Object.freeze({ iceServers }),
    ...(windows ?? PRODUCT_ENGINE_WINDOWS),
  });
  return Object.freeze({ core });
}
