// Room-position and one-viewing arithmetic over retained drift evidence.

import { median } from '../../public/lib/frame-drift.mjs';

const finite = (value) => Number.isFinite(value);

function orderedRecords(client) {
  const records = Array.isArray(client) ? client : client?.records;
  if (!Array.isArray(records)) throw new Error('drift records are unavailable');
  return records
    .filter((record) => record && typeof record === 'object')
    .sort((left, right) => left.displaySharedMs - right.displaySharedMs);
}

function recordAtOrBefore(records, instant) {
  return records.filter((record) => finite(record.displaySharedMs)
    && record.displaySharedMs <= instant).at(-1);
}

function recordAtOrAfter(records, instant) {
  return records.find((record) => finite(record.displaySharedMs)
    && record.displaySharedMs >= instant);
}

function offsetFor(offsets, tag) {
  const value = offsets?.[tag] ?? 0;
  if (!finite(value)) throw new Error(`declared offset is not finite:${tag}`);
  return value;
}

function requireRecord(record, tag, side, instant) {
  if (!record || !finite(record.mediaMs)) {
    throw new Error(`drift-record-${side}-boundary-unavailable:${tag}:${instant}`);
  }
  return record;
}

/** The room's position at a host-page instant, before taking the median. */
export function roomPositionForClient(client, tag, instant, declaredOffsetMs = 0) {
  if (!finite(instant)) throw new Error(`room instant is not finite:${tag}`);
  const records = orderedRecords(client);
  const record = requireRecord(recordAtOrBefore(records, instant), tag, 'before', instant);
  if (!finite(record.scheduledMediaMs) || !finite(record.displaySharedMs)) {
    throw new Error(`room drift record is malformed:${tag}:${instant}`);
  }
  return record.scheduledMediaMs - declaredOffsetMs + (instant - record.displaySharedMs);
}

/** Median room position and the spread used to detect disagreeing clocks. */
export function roomPositionAt({ clients = {}, tags = Object.keys(clients), instant, offsets = {} } = {}) {
  const byClient = Object.fromEntries(tags.map((tag) => [tag,
    roomPositionForClient(clients[tag], tag, instant, offsetFor(offsets, tag))]));
  const positions = Object.values(byClient).sort((left, right) => left - right);
  if (!positions.length) throw new Error(`room has no viewers at:${instant}`);
  return { positionMs: median(positions), spreadMs: positions.at(-1) - positions[0], byClient };
}

/** Interpolate a viewer's media position at a host-page boundary. */
export function playedMediaAt(client, tag, instant) {
  if (!finite(instant)) throw new Error(`media instant is not finite:${tag}`);
  const records = orderedRecords(client);
  const before = requireRecord(recordAtOrBefore(records, instant), tag, 'before', instant);
  const after = requireRecord(recordAtOrAfter(records, instant), tag, 'after', instant);
  if (!finite(before.displaySharedMs) || !finite(after.displaySharedMs)) {
    throw new Error(`drift boundary is malformed:${tag}:${instant}`);
  }
  if (after.displaySharedMs === before.displaySharedMs) return before.mediaMs;
  const fraction = (instant - before.displaySharedMs) / (after.displaySharedMs - before.displaySharedMs);
  return before.mediaMs + (after.mediaMs - before.mediaMs) * fraction;
}

/** Bytes of variable-sized segments intersecting the half-open media stretch. */
export function bytesForStretch(startMs, endMs, segmentSizes, segmentSeconds) {
  if (!finite(startMs) || !finite(endMs) || endMs < startMs) throw new Error('media stretch is invalid');
  if (!Array.isArray(segmentSizes) || !segmentSizes.length) throw new Error('segment sizes are unavailable');
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  const segmentMs = segmentSeconds * 1000;
  const durationMs = segmentSizes.length * segmentMs;
  if (startMs < 0 || endMs > durationMs) throw new Error('media stretch is outside content');
  let bytes = 0;
  for (let index = 0; index < segmentSizes.length; index++) {
    const size = segmentSizes[index];
    if (!finite(size) || size < 0) throw new Error(`segment size is invalid:${index}`);
    const segmentStart = index * segmentMs;
    const overlap = Math.max(0, Math.min(endMs, segmentStart + segmentMs) - Math.max(startMs, segmentStart));
    bytes += size * overlap / segmentMs;
  }
  return bytes;
}

/** Compute room stretch, viewer stretches, spread and one-viewing bytes. */
export function computeOneViewing({ clients = {}, tags = Object.keys(clients), window, offsets = {}, segmentSizes, segmentSeconds } = {}) {
  if (!finite(window?.startMs) || !finite(window?.endMs) || window.endMs < window.startMs) {
    throw new Error('measure window is invalid');
  }
  const start = roomPositionAt({ clients, tags, instant: window.startMs, offsets });
  const end = roomPositionAt({ clients, tags, instant: window.endMs, offsets });
  const roomPositionSpreadMs = { start: start.spreadMs, end: end.spreadMs };
  if (start.spreadMs > 1 || end.spreadMs > 1) throw new Error('room-position-spread-exceeds-1ms');
  const playedMediaMsByClient = Object.fromEntries(tags.map((tag) => [tag, {
    start: playedMediaAt(clients[tag], tag, window.startMs),
    end: playedMediaAt(clients[tag], tag, window.endMs),
  }]));
  const roomStretchMs = { start: start.positionMs, end: end.positionMs };
  return {
    roomStretchMs,
    roomPositionSpreadMs,
    roomPositionMsByClient: { start: start.byClient, end: end.byClient },
    playedMediaMsByClient,
    oneViewingBytesInWindow: bytesForStretch(start.positionMs, end.positionMs, segmentSizes, segmentSeconds),
  };
}
