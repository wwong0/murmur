import { median } from '../../public/lib/frame-drift.mjs';
import { finite, recordsOf, tagsOf } from './peer-evidence.mjs';
import { seekInstants, segmentIndex } from './seek-evidence.mjs';

const orderedDrift = (client) => (Array.isArray(client?.records) ? client.records : [])
  .filter((record) => finite(record?.displaySharedMs) && finite(record?.mediaMs))
  .sort((left, right) => left.displaySharedMs - right.displaySharedMs);

function interpolate(left, right, instant) {
  if (right.displaySharedMs === left.displaySharedMs) return left.mediaMs;
  const fraction = (instant - left.displaySharedMs)
    / (right.displaySharedMs - left.displaySharedMs);
  return left.mediaMs + (right.mediaMs - left.mediaMs) * fraction;
}

function positionAt(records, instant, seek) {
  if (seek && instant >= seek.effectiveSharedMs) {
    const afterSeek = records.find((record) => record.displaySharedMs >= seek.effectiveSharedMs);
    if (!afterSeek || instant < afterSeek.displaySharedMs) return seek.landingMs;
    const post = records.filter((record) => record.displaySharedMs >= seek.effectiveSharedMs);
    const left = post.filter((record) => record.displaySharedMs <= instant).at(-1);
    const right = post.find((record) => record.displaySharedMs >= instant);
    return left && right ? interpolate(left, right, instant) : null;
  }
  const left = records.filter((record) => record.displaySharedMs <= instant).at(-1);
  const right = records.find((record) => record.displaySharedMs >= instant);
  if (!left || !right) return null;
  if (seek && left.displaySharedMs < seek.effectiveSharedMs
    && right.displaySharedMs > seek.effectiveSharedMs) return null;
  return interpolate(left, right, instant);
}

function heldAt(position, records, instant, segmentMs) {
  if (!finite(position)) return null;
  const completed = new Set(records.filter((record) => finite(record?.completedAtMs)
    && record.completedAtMs <= instant).map((record) => segmentIndex(record.path))
    .filter((index) => Number.isInteger(index) && index >= 0));
  const k0 = Math.floor(position / segmentMs);
  if (!completed.has(k0)) return 0;
  let end = k0;
  while (completed.has(end + 1)) end += 1;
  const value = (end + 1) * segmentMs - position;
  if (value < 0) throw new Error('held-ahead-negative');
  return value;
}

function round100(value) {
  return Math.round(value / 100) * 100;
}

export function computeHeldAhead({ input = {}, clients = input.clients ?? {}, tags = tagsOf(input),
  window = input.window, segmentSeconds = input.segmentSeconds } = {}) {
  const startMs = Number(window?.startMs);
  const endMs = Number(window?.endMs);
  const segmentMs = Number(segmentSeconds) * 1000;
  if (!finite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  if (!finite(startMs) || !finite(endMs) || !(endMs > startMs)) return null;
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (!seconds) return null;
  const seek = seekInstants(input);
  const times = Array.from({ length: seconds }, (_, index) => startMs + index * 1000);
  const heldValues = Object.fromEntries(tags.map((tag) => [tag, []]));
  const positionsByClient = Object.fromEntries(tags.map((tag) => [tag, []]));
  const unavailable = Object.fromEntries(tags.map((tag) => [tag, 0]));
  const spread = [];
  for (const instant of times) {
    const positions = {};
    for (const tag of tags) {
      const position = positionAt(orderedDrift(clients[tag]), instant, seek);
      positionsByClient[tag].push(position);
      if (!finite(position)) {
        unavailable[tag] += 1;
        continue;
      }
      positions[tag] = position;
      const value = heldAt(position, recordsOf(clients[tag]), instant, segmentMs);
      if (value === null) unavailable[tag] += 1;
      else heldValues[tag].push(value);
    }
    if (Object.keys(positions).length === tags.length) {
      const values = Object.values(positions);
      spread.push(round100(Math.max(...values) - Math.min(...values)));
    }
  }
  const heldAheadMsMedianByClient = Object.fromEntries(tags.map((tag) => {
    const values = heldValues[tag].slice().sort((left, right) => left - right);
    return [tag, values.length ? median(values) : null];
  }));
  const roomValues = Object.values(heldAheadMsMedianByClient).filter(finite).sort((a, b) => a - b);
  const spreadValues = spread.slice().sort((left, right) => left - right);
  const parkAdvanceMsByClient = seek ? Object.fromEntries(tags.map((tag) => {
    const position = Number(input.seek?.viewers?.[tag]?.restart?.positionMs);
    return [tag, finite(position) ? position - seek.landingMs : null];
  })) : undefined;
  return {
    heldAheadMsMedianByClient,
    heldAheadMsRoomMedian: roomValues.length ? median(roomValues) : null,
    positionSpreadMsMedian: spreadValues.length ? median(spreadValues) : null,
    positionSpreadSecondsUsed: spread.length,
    positionUnavailableSecondsByClient: unavailable,
    ...(parkAdvanceMsByClient ? { parkAdvanceMsByClient } : {}),
    positionsByClient,
  };
}
