export const STATUS_INTERVAL_MS = 1000;

export function ownHostStatus({ mediaSource, hostFile }) {
  if (mediaSource !== 'file' || hostFile?.state === 'ready') return { state: 'ready', fraction: null };
  return {
    state: 'preparing',
    fraction: hostFile?.state === 'preparing' && Number.isFinite(hostFile.fraction) ? hostFile.fraction : 0,
  };
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
    stored = { hostId: host.clientId, state: report.state, fraction: report.fraction, atMs };
    received += 1;
    return 'believed';
  }

  function current(roster) {
    const host = roster.find((member) => member?.role === 'host');
    return stored && host?.clientId === stored.hostId
      ? stored
      : { state: 'unknown', fraction: null, hostId: null, atMs: null };
  }

  function counts() {
    return { received, disbelieved };
  }

  return { accept, current, counts };
}
