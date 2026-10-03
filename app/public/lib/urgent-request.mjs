// Which of a viewer's host requests are urgent (design.md D9): the playlist, and
// the segments from its own position across D3's ready runway. Pure: the page
// supplies the position, and the playlist text the host link already carried.

const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)/;

function resolvedPath(uri, playlistPath) {
  try {
    return new URL(uri, `http://host.invalid${playlistPath}`).pathname;
  } catch {
    return null;
  }
}

/** Each media URI's resolved path → its `{ startMs, endMs }`, or null without `#EXTINF`. */
export function parseSegmentTimes(text, playlistPath) {
  if (typeof text !== 'string' || typeof playlistPath !== 'string') return null;
  const times = new Map();
  let startMs = 0;
  let durationMs = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const extinf = EXTINF_RE.exec(line);
    if (extinf) {
      durationMs = Number(extinf[1]) * 1000;
      continue;
    }
    if (line === '' || line.startsWith('#') || durationMs === null) continue;
    const path = resolvedPath(line, playlistPath);
    if (path !== null && Number.isFinite(durationMs)) times.set(path, { startMs, endMs: startMs + durationMs });
    startMs += Number.isFinite(durationMs) ? durationMs : 0;
    durationMs = null;
  }
  return times.size > 0 ? times : null;
}

export function requestIsUrgent({ path, positionMs, segments, runwayMs }) {
  if (typeof path !== 'string') return false;
  if (path.endsWith('.m3u8')) return true;
  const span = segments?.get?.(path);
  if (!span || !Number.isFinite(positionMs) || !Number.isFinite(runwayMs) || runwayMs < 0) return false;
  if (span.endMs <= positionMs) return false;
  return span.startMs <= positionMs || span.startMs < positionMs + runwayMs;
}
