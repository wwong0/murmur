// Which of a viewer's host requests are urgent (design.md D9): the playlist, and
// the segments from its own position across D3's ready runway. Pure: the page
// supplies the position, and the playlist text the host link already carried.

import { CONTROL_8B, CONTROL_PRODUCT } from './edge-control.mjs';
import { mediaMsAt } from './playback-state.mjs';

const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)/;

/**
 * The viewer's own position for D9. A created state has no mapping in effect
 * during its lead, and the page already loads: its position is then where that
 * state starts, the held creation's 0 (design.md D4, D9).
 */
export function urgentPositionMs(state, sharedMs) {
  const positionMs = mediaMsAt(state, sharedMs);
  if (positionMs !== null || !Number.isFinite(sharedMs)) return positionMs;
  const current = state?.current;
  if (!current || state.previous || !Number.isFinite(current.mediaMs) || !(sharedMs < current.atSharedMs)) return null;
  return current.mediaMs;
}

export function ownPositionMs({ control, state, sharedMs, elementMs }) {
  if (control === CONTROL_8B || state?.current?.held === true) return urgentPositionMs(state, sharedMs);
  if (Number.isFinite(elementMs) && elementMs >= 0) return elementMs;
  return urgentPositionMs(state, sharedMs);
}

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

export function requestClass({ control, path, positionMs, segments, runwayMs, nearMs }) {
  if (requestIsUrgent({ path, positionMs, segments, runwayMs })) return 'urgent';
  if (control !== CONTROL_PRODUCT || typeof path !== 'string' || !Number.isFinite(positionMs)
    || !Number.isFinite(nearMs) || nearMs < 0) return null;
  const span = segments?.get?.(path);
  if (!span || span.endMs <= positionMs || span.startMs > positionMs + nearMs) return null;
  return 'near';
}
