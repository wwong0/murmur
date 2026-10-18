export const STATUS_INTERVAL_MS = 1000;

import { FILE_IDENTITY_PATTERN } from './file-identity.mjs';

export function isValidHostName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

export function ownHostStatus({ mediaSource, hostFile, name, report = () => {} }) {
  if (mediaSource !== 'file') return { state: 'ready', fraction: null };
  if (hostFile?.state === 'ready') {
    const identity = hostFile.manifest?.identity;
    if (typeof identity !== 'string' || !FILE_IDENTITY_PATTERN.test(identity)) {
      report('host-status', new TypeError('ready host file has an invalid identity'));
      return { state: 'choosing', fraction: null };
    }
    return {
      state: 'ready', fraction: null, identity,
      ...(isValidHostName(name) ? { name } : {}),
    };
  }
  if (hostFile?.state === 'inspecting' || hostFile?.state === 'preparing') {
    return { state: 'preparing', fraction: Number.isFinite(hostFile.fraction) ? hostFile.fraction : 0 };
  }
  return {
    state: 'choosing',
    fraction: null,
  };
}

export function titleDue({ own, state } = {}) {
  if (own?.state !== 'ready' || typeof own.identity !== 'string' || state === null || state === undefined) return null;
  return state.title === own.identity ? null : own.identity;
}

export function statusDue({ nowMs, last, next, intervalMs = STATUS_INTERVAL_MS }) {
  if (last === null || last.state !== next.state) return true;
  return next.state === 'preparing'
    && next.fraction > last.fraction
    && nowMs - last.atMs >= intervalMs;
}

export function createHostStatusBook() {
  let stored = null;
  let received = 0;
  let disbelieved = 0;

  function accept(report, roster, atMs) {
    const host = roster.find((member) => member?.role === 'host');
    if (!host || report.from !== host.clientId) {
      disbelieved += 1;
      return 'disbelieved';
    }
    stored = {
      hostId: host.clientId, state: report.state, fraction: report.fraction,
      identity: report.identity ?? null, name: report.name ?? null, atMs,
    };
    received += 1;
    return 'believed';
  }

  function current(roster) {
    const host = roster.find((member) => member?.role === 'host');
    return stored && host?.clientId === stored.hostId
      ? stored
      : {
        state: 'unknown', fraction: null, hostId: null, atMs: null,
        identity: null, name: null,
      };
  }

  function counts() {
    return { received, disbelieved };
  }

  return { accept, current, counts };
}
