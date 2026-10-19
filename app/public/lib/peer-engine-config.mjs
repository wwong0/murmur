import { validateEngineWindows, PRODUCT_ENGINE_WINDOWS } from './engine-windows.mjs';
import { isFileIdentity } from './title-fields.mjs';

export const HOST_LOAD_NO_BYTES_TIMEOUT_MS = 15_000;
export const PRODUCT_STREAM_CONFIG = Object.freeze({
  ...PRODUCT_ENGINE_WINDOWS,
  httpNotReceivingBytesTimeoutMs: HOST_LOAD_NO_BYTES_TIMEOUT_MS,
});

function requireString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`peerEngineConfig: ${name} must be a string`);
  return value;
}

export function peerEngineConfig({ roomId, trackerUrl, iceServers, titleId = null, windows = null } = {}) {
  requireString(roomId, 'roomId');
  requireString(trackerUrl, 'trackerUrl');
  if (!Array.isArray(iceServers)) throw new TypeError('peerEngineConfig: iceServers must be an array');
  if (titleId !== null && !isFileIdentity(titleId)) {
    throw new TypeError('peerEngineConfig: titleId must match v1:<64 lowercase hexadecimal characters>');
  }
  if (windows !== null && windows !== undefined) {
    const result = validateEngineWindows(windows);
    if (result.error) throw new TypeError(`peerEngineConfig: ${result.error}`);
    windows = result.windows;
  }

  const core = Object.freeze({
    swarmId: titleId === null ? roomId : `${roomId}:${titleId}`,
    announceTrackers: Object.freeze([trackerUrl]),
    rtcConfig: Object.freeze({ iceServers }),
    ...(windows ?? PRODUCT_ENGINE_WINDOWS),
    httpNotReceivingBytesTimeoutMs: HOST_LOAD_NO_BYTES_TIMEOUT_MS,
  });
  return Object.freeze({ core });
}
