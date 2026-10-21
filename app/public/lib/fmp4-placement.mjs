// public/lib/fmp4-placement.mjs
//
// Where a load's media time sits on the element's timeline. hls.js hands the
// SourceBuffer a timestamp offset with every media append; the first video
// sample's decode time plus that offset, less the fragment's playlist start,
// is the placement. Pure: boxes in, numbers out, no hls.js import.
//
// Under public/lib/: no DOM, no page access.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'moof', 'traf']);
const PLACEMENT_AGREES_MS = 0.5;

function* boxesIn(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { type, body: at + header, end: at + size };
    at += size;
  }
}

function walk(bytes, start, end, visit) {
  for (const box of boxesIn(bytes, start, end)) {
    visit(box);
    if (CONTAINERS.has(box.type)) walk(bytes, box.body, box.end, visit);
  }
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/**
 * Track id → { handler, timescale } from a top-level `moov`, or null.
 * @param {Uint8Array} bytes
 */
export function trackTimescales(bytes) {
  const data = asBytes(bytes);
  if (!data) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sawMoov = false;
  for (const box of boxesIn(data, 0, data.length)) if (box.type === 'moov') sawMoov = true;
  if (!sawMoov) return null;
  const tracks = new Map();
  let current = null;
  walk(data, 0, data.length, (box) => {
    const version = data[box.body];
    if (box.type === 'tkhd') {
      current = { id: view.getUint32(box.body + (version === 1 ? 20 : 12)), handler: null, timescale: null };
      tracks.set(current.id, current);
    } else if (box.type === 'mdhd' && current) {
      current.timescale = view.getUint32(box.body + (version === 1 ? 20 : 12));
    } else if (box.type === 'hdlr' && current) {
      current.handler = String.fromCharCode(...data.subarray(box.body + 8, box.body + 12));
    }
  });
  return tracks;
}

/**
 * The first video `traf`'s base decode time in seconds, or null.
 * @param {Uint8Array} bytes
 * @param {Map<number, {handler: string, timescale: number}>} tracks
 */
export function videoDecodeSeconds(bytes, tracks) {
  const data = asBytes(bytes);
  if (!data || !tracks) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let trackId = null;
  let found = null;
  walk(data, 0, data.length, (box) => {
    if (found !== null) return;
    if (box.type === 'traf') trackId = null;
    else if (box.type === 'tfhd') trackId = view.getUint32(box.body + 4);
    else if (box.type === 'tfdt' && trackId !== null) {
      const track = tracks.get(trackId);
      if (track?.handler !== 'vide' || !(track.timescale > 0)) return;
      const ticks = data[box.body] === 1 ? Number(view.getBigUint64(box.body + 4)) : view.getUint32(box.body + 4);
      found = ticks / track.timescale;
    }
  });
  return found;
}

/** One tracker per player; `reset` at each load. */
export function createPlacementTracker() {
  let placementMs = null;
  let source = null;
  let tracks = null;
  let pendingWriteMs = null;
  let disagreements = 0;
  let lastDisagreementMs = null;

  function reset() {
    placementMs = null;
    source = null;
    tracks = null;
    pendingWriteMs = null;
    disagreements = 0;
    lastDisagreementMs = null;
  }

  function none() {
    placementMs = 0;
    source = 'none';
  }

  function onAppend({ data, offset, playlistOffsetS, parent } = {}) {
    if (parent !== 'main') return;
    const bytes = asBytes(data);
    const initTracks = bytes ? trackTimescales(bytes) : null;
    if (initTracks) {
      tracks = initTracks;
      return;
    }
    if (!tracks || !bytes || !Number.isFinite(offset) || !Number.isFinite(playlistOffsetS)) return;
    const decodeS = videoDecodeSeconds(bytes, tracks);
    if (decodeS === null) return;
    // Rounded to a microsecond: float noise must not turn a placement of 0 into 1e-13.
    const p = Math.round(1e6 * (decodeS + offset - playlistOffsetS)) / 1000;
    if (placementMs === null) {
      placementMs = p;
      source = 'hls-append';
    } else if (Math.abs(p - placementMs) > PLACEMENT_AGREES_MS) {
      disagreements += 1;
      lastDisagreementMs = p;
    }
  }

  function noteWrite(mediaMs) {
    if (placementMs === null) pendingWriteMs = mediaMs;
  }

  function elementSeconds(mediaMs) {
    if (placementMs === null) {
      noteWrite(mediaMs);
      return mediaMs / 1000;
    }
    return (mediaMs + placementMs) / 1000;
  }

  function mediaMs(elementMs) {
    if (placementMs === null || !Number.isFinite(elementMs)) return null;
    return elementMs - placementMs;
  }

  function takePendingWrite() {
    if (placementMs === null || pendingWriteMs === null) return null;
    const mediaWriteMs = pendingWriteMs;
    pendingWriteMs = null;
    return placementMs === 0 ? null : { elementSeconds: (mediaWriteMs + placementMs) / 1000 };
  }

  function snapshot() {
    return { placementMs, source, disagreements, lastDisagreementMs };
  }

  return { reset, none, onAppend, noteWrite, elementSeconds, mediaMs, takePendingWrite, snapshot };
}
