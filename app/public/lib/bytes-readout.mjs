// The bytes line is a direct view of the publisher's reading, not a second
// accounting pass over its records.

export const BYTES_LINE_RE =
  /^bytes: host (\d+) B · peers (\d+) B · uploaded (\d+) B · peer fraction (\d\.\d{4}) · (\d+) peers connected$/;
export const BYTES_LINE_NOTHING_KEPT_RE =
  /^bytes: nothing kept yet · uploaded (\d+) B · (\d+) peers connected$/;
export const BYTES_LINE_OFF = 'bytes: peer exchange off';
export const BYTES_LINE_HOST = 'bytes: host — not in the peer pool';
export const BYTES_LINE_UNAVAILABLE = 'bytes: attribution unavailable';

function uploadedBytes(uploadBytes) {
  return Object.values(uploadBytes ?? {}).reduce((total, bytes) => total + bytes, 0);
}

export function bytesText(reading) {
  if (reading?.attribution === 'unavailable') return BYTES_LINE_UNAVAILABLE;
  if (reading?.peerExchange === 'off') return BYTES_LINE_OFF;
  if (reading?.peerExchange === 'host') return BYTES_LINE_HOST;

  const hostBytes = reading?.kept?.hostBytes ?? 0;
  const peerBytes = reading?.kept?.peerBytes ?? 0;
  const uploaded = uploadedBytes(reading?.uploadBytes);
  const connected = reading?.connected?.length ?? 0;
  if (hostBytes + peerBytes === 0) {
    return `bytes: nothing kept yet · uploaded ${uploaded} B · ${connected} peers connected`;
  }
  const fraction = (peerBytes / (hostBytes + peerBytes)).toFixed(4);
  return `bytes: host ${hostBytes} B · peers ${peerBytes} B · uploaded ${uploaded} B · peer fraction ${fraction} · ${connected} peers connected`;
}
