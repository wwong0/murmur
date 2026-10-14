// Q-a diagnostics over retained peer evidence and Step 0's playback window.

import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';
import { bytesForStretch, playedMediaAt } from './one-viewing.mjs';
import { cohortSegments, finite, inWindow, recordsOf, safe, tagsOf } from './peer-evidence.mjs';

export const STEP0_WINDOW_MS = 180_000;
export const STEP0_WARMUP_MS = 30_000;
export const SPAN_MS = 30_000;

const mediaRecords = (client, tag) => {
  const records = Array.isArray(client?.records)
    ? client.records.filter((record) => record && finite(record.displaySharedMs) && finite(record.mediaMs))
      .sort((left, right) => left.displaySharedMs - right.displaySharedMs)
    : [];
  if (records.length < 2) throw new Error(`qa-drift-evidence-unavailable:${tag}`);
  return records;
};

function instantAtMedia(records, target, tag) {
  if (!finite(target)) throw new Error(`qa-media-boundary-invalid:${tag}`);
  for (let index = 1; index < records.length; index++) {
    const left = records[index - 1];
    const right = records[index];
    if (target < left.mediaMs || target > right.mediaMs) continue;
    if (right.mediaMs === left.mediaMs) return left.displaySharedMs;
    const fraction = (target - left.mediaMs) / (right.mediaMs - left.mediaMs);
    return left.displaySharedMs + (right.displaySharedMs - left.displaySharedMs) * fraction;
  }
  if (target === records[0].mediaMs) return records[0].displaySharedMs;
  if (target === records.at(-1).mediaMs) return records.at(-1).displaySharedMs;
  throw new Error(`qa-media-boundary-unavailable:${tag}:${target}`);
}

/** The Step 0 interval for one viewer, anchored to that viewer's first media position. */
export function step0WindowForViewer(client, tag) {
  const records = mediaRecords(client, tag);
  const firstPlayedMs = records[0].mediaMs;
  const startMediaMs = firstPlayedMs + STEP0_WARMUP_MS;
  const endMediaMs = firstPlayedMs + STEP0_WARMUP_MS + STEP0_WINDOW_MS;
  return {
    startMs: instantAtMedia(records, startMediaMs, tag),
    endMs: instantAtMedia(records, endMediaMs, tag),
    startMediaMs,
    endMediaMs,
  };
}

function completedBytes(segments, tag) {
  const byPath = new Map();
  for (const segment of segments) {
    if (!safe(segment.lengthBytes)) throw new Error(`qa-segment-length-invalid:${tag}`);
    const path = String(segment.path ?? segment.runtimeId ?? '');
    if (!path || (byPath.has(path) && byPath.get(path) !== segment.lengthBytes)) {
      throw new Error(`qa-segment-length-mismatch:${tag}:${path}`);
    }
    byPath.set(path, segment.lengthBytes);
  }
  return [...byPath.values()].reduce((sum, bytes) => sum + bytes, 0);
}

function peerBytes(records, segments) {
  const dispositions = attemptDispositions(records);
  const ids = new Set(segments.flatMap((segment) => segment.keptAttemptIds ?? []));
  const kept = records.filter((record) => record?.kind === 'attempt'
    && ids.has(record.attemptId) && dispositions.get(record.attemptId) === 'kept');
  return {
    host: kept.filter((record) => record.source === 'http').reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0),
    peer: kept.filter((record) => record.source === 'p2p').reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0),
  };
}

// A span may open before a viewer's first drift record or close after its last.
function playedOrNull(client, tag, instant, allowMissing) {
  try {
    return playedMediaAt(client, tag, instant);
  } catch (error) {
    if (allowMissing && /drift-record|drift boundary/.test(error.message)) return null;
    throw error;
  }
}

function realtimeFactor(played, window, tag) {
  const wallMs = window.endMs - window.startMs;
  if (!(wallMs > 0)) throw new Error(`qa-window-duration-invalid:${tag}`);
  return (played.end - played.start) / wallMs;
}

function viewerFigure(input, tag, window, allowMissing) {
  const client = input.clients?.[tag] ?? {};
  const records = recordsOf(client);
  const segments = cohortSegments(records, window);
  const bytes = peerBytes(records, segments);
  const total = bytes.host + bytes.peer;
  const start = playedOrNull(client, tag, window.startMs, allowMissing);
  const end = playedOrNull(client, tag, window.endMs, allowMissing);
  const played = start === null || end === null ? null : { start, end };
  const segmentSizes = input.content?.segmentSizes ?? input.segmentSizes;
  const playedBytes = played && bytesForStretch(played.start, played.end, segmentSizes, input.segmentSeconds);
  const completed = completedBytes(segments, tag);
  return {
    window,
    completedSegments: segments.length,
    completedBytes: completed,
    keptHostBytes: bytes.host,
    keptPeerBytes: bytes.peer,
    peerFraction: total > 0 ? bytes.peer / total : null,
    realtimeFactor: played && realtimeFactor(played, window, tag),
    downloadRatio: playedBytes > 0 ? completed / playedBytes : null,
    playedMediaMs: played,
  };
}

function figuresForWindows(input, windowsByTag, allowMissing = false) {
  const tags = tagsOf(input);
  const byClient = Object.fromEntries(tags.map((tag) => [tag,
    viewerFigure(input, tag, windowsByTag[tag], allowMissing)]));
  const totalHost = Object.values(byClient).reduce((sum, figure) => sum + figure.keptHostBytes, 0);
  const totalPeer = Object.values(byClient).reduce((sum, figure) => sum + figure.keptPeerBytes, 0);
  return {
    peerFractionAggregate: totalHost + totalPeer > 0 ? totalPeer / (totalHost + totalPeer) : null,
    peerFractionByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].peerFraction])),
    realtimeFactorByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].realtimeFactor])),
    downloadRatioByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].downloadRatio])),
    completedSegmentsByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].completedSegments])),
    keptHostBytesByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].keptHostBytes])),
    keptPeerBytesByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].keptPeerBytes])),
    playedMediaMsByClient: Object.fromEntries(tags.map((tag) => [tag, byClient[tag].playedMediaMs])),
  };
}

function unionIntervals(intervals) {
  const sorted = intervals.filter((interval) => interval && interval.endMs > interval.startMs)
    .map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  const merged = [];
  for (const interval of sorted) {
    const prior = merged.at(-1);
    if (prior && interval.startMs <= prior.endMs) prior.endMs = Math.max(prior.endMs, interval.endMs);
    else merged.push(interval);
  }
  return merged;
}

function sampleAt(samples, instant) {
  if (instant < samples[0].atMs || instant > samples.at(-1).atMs) {
    throw new Error(`qa-link-boundary-unavailable:${instant}`);
  }
  for (let index = 1; index < samples.length; index++) {
    const left = samples[index - 1];
    const right = samples[index];
    if (instant > right.atMs) continue;
    if (right.atMs === left.atMs) return right.txBytes;
    const fraction = (instant - left.atMs) / (right.atMs - left.atMs);
    return left.txBytes + (right.txBytes - left.txBytes) * fraction;
  }
  return samples.at(-1).txBytes;
}

function linkUtilisation(samples, intervals, capacityBitsPerSecond) {
  const entries = (Array.isArray(samples) ? samples : []).map((sample) => ({
    atMs: sample.atMs ?? sample.at ?? sample.timeMs,
    txBytes: sample.txBytes ?? sample.tx_bytes,
  })).filter((sample) => finite(sample.atMs) && finite(sample.txBytes))
    .sort((left, right) => left.atMs - right.atMs);
  if (entries.length < 2 || !finite(capacityBitsPerSecond) || capacityBitsPerSecond <= 0) return null;
  for (let index = 1; index < entries.length; index++) {
    if (entries[index].txBytes < entries[index - 1].txBytes) throw new Error('qa-link-counter-reversed');
  }
  const union = unionIntervals(intervals);
  if (!union.length) return null;
  let bytes = 0;
  let durationMs = 0;
  for (const interval of union) {
    const startBytes = sampleAt(entries, interval.startMs);
    const endBytes = sampleAt(entries, interval.endMs);
    bytes += endBytes - startBytes;
    durationMs += interval.endMs - interval.startMs;
  }
  return durationMs > 0 ? bytes * 8 / (durationMs / 1000 * capacityBitsPerSecond) : null;
}

function firstAttemptStart(input) {
  const starts = tagsOf(input).flatMap((tag) => recordsOf(input.clients?.[tag])
    .filter((record) => record?.kind === 'attempt' && finite(record.startMs)).map((record) => record.startMs));
  if (!starts.length) throw new Error('qa-media-attempt-evidence-unavailable');
  return Math.min(...starts);
}

function lastDriftInstant(input) {
  const instants = tagsOf(input).flatMap((tag) => (input.clients?.[tag]?.records ?? [])
    .map((record) => record?.displaySharedMs).filter(finite));
  if (!instants.length) throw new Error('qa-drift-evidence-unavailable');
  return Math.max(...instants);
}

function spansFor(input) {
  const startMs = firstAttemptStart(input);
  const endMs = lastDriftInstant(input);
  const spans = [];
  for (let cursor = startMs; cursor < endMs; cursor += SPAN_MS) {
    spans.push({ startMs: cursor, endMs: Math.min(cursor + SPAN_MS, endMs) });
  }
  return spans;
}

function capacityOf(input) {
  return input.capacityBitsPerSecond
    ?? input.condition?.capacityBitsPerSecond ?? input.condition?.capacityMbps * 1_000_000;
}

function spanFigure(input, window) {
  const tags = tagsOf(input);
  const windows = Object.fromEntries(tags.map((tag) => [tag, window]));
  const figures = figuresForWindows(input, windows, true);
  return {
    window,
    ...figures,
    uplinkUtilisationMean: linkUtilisation(input.linkSamples, [window], capacityOf(input)),
  };
}

/** Recompute Q-a for one retained run. */
export function recomputeQaRun(input, directory = undefined) {
  const tags = tagsOf(input);
  const windowsByClient = Object.fromEntries(tags.map((tag) => [tag,
    step0WindowForViewer(input.clients?.[tag], tag)]));
  const step0 = figuresForWindows(input, windowsByClient);
  const union = Object.values(windowsByClient);
  const step0Window = {
    windowsByClient,
    ...step0,
    uplinkUtilisationMean: linkUtilisation(input.linkSamples, union, capacityOf(input)),
  };
  const reproduces = step0.peerFractionAggregate !== null
    && step0.peerFractionAggregate <= 0.02
    && tags.every((tag) => finite(step0.realtimeFactorByClient[tag])
      && step0.realtimeFactorByClient[tag] < 0.98);
  return {
    ...(directory ? { directory } : {}),
    step0Window,
    reproduces,
    spans: spansFor(input).map((window) => spanFigure(input, window)),
  };
}

/** Combine the six registered runs and apply D5's registered outcome. */
export function recomputeQaReport(runs) {
  if (!Array.isArray(runs) || !runs.length) throw new Error('qa runs are unavailable');
  const results = runs.map(({ directory, input }) => recomputeQaRun(input, directory));
  const count = results.filter((result) => result.reproduces).length;
  const outcome = count === results.length ? 'reproduced' : count === 0 ? 'not reproduced' : 'mixed';
  return {
    diagnostic: true,
    criterion: false,
    method: 'qa-step0-playback-window-v1',
    thresholds: { peerFractionMax: 0.02, realtimeFactorMaxExclusive: 0.98 },
    windowDefinition: 'per viewer: first media position +30s through +210s',
    spanDefinition: '30s wall-time spans from earliest media attempt start to last drift record',
    outcome,
    runs: results,
  };
}

export { figuresForWindows, instantAtMedia, linkUtilisation, spansFor };
