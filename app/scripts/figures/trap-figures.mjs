import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';
import { finite, inWindow, recordsOf, safe, tagsOf } from './peer-evidence.mjs';
import { segmentIndex } from './seek-evidence.mjs';

function seekValues(input) {
  const seek = input.seek ?? input.context?.seek ?? {};
  const host = seek.host ?? {};
  const landingMs = Number(seek.landingMs ?? host.positionMs);
  const effectiveSharedMs = Number(seek.effectiveSharedMs ?? host.atSharedMs);
  if (!finite(landingMs) || !finite(effectiveSharedMs)) throw new Error('trap seek evidence is unavailable');
  const segmentSeconds = Number(input.segmentSeconds ?? seek.segmentSeconds ?? 4);
  if (!(segmentSeconds > 0) || !finite(segmentSeconds)) throw new Error('trap segment seconds are invalid');
  return {
    version: seek.version ?? host.version ?? null,
    landingMs,
    effectiveSharedMs,
    landingSegment: Math.floor(landingMs / (segmentSeconds * 1000)),
    segmentSeconds,
  };
}

function segmentEntries(records, window, tag) {
  return records.filter((record) => record?.kind === 'segment' && inWindow(record.completedAtMs, window))
    .map((record) => {
      const index = segmentIndex(record.path);
      if (!Number.isInteger(index) || index < 0) throw new Error(`trap-segment-index-unavailable:${tag}`);
      if (!safe(record.lengthBytes)) throw new Error(`trap-segment-length-invalid:${tag}:${record.path}`);
      return { record, index };
    });
}

export function trapCohorts(input = {}, { window = input.window, filterAfterEffective = 'all' } = {}) {
  const tags = tagsOf(input);
  const seek = seekValues(input);
  const cohorts = {};
  const preLandingSegmentsByClient = {};
  for (const tag of tags) {
    const entries = segmentEntries(recordsOf(input.clients?.[tag]), window, tag);
    const preLanding = entries.filter(({ index, record }) => index < seek.landingSegment
      && (filterAfterEffective === 'all' || filterAfterEffective === false
        || record.completedAtMs >= seek.effectiveSharedMs));
    const eligible = entries.filter(({ index, record }) => index >= seek.landingSegment
      || filterAfterEffective === false
      || (filterAfterEffective !== 'all' && record.completedAtMs < seek.effectiveSharedMs));
    cohorts[tag] = eligible.map(({ record }) => record);
    preLandingSegmentsByClient[tag] = {
      count: preLanding.length,
      bytes: preLanding.reduce((sum, entry) => sum + entry.record.lengthBytes, 0),
    };
  }
  return { ...seek, cohorts, preLandingSegmentsByClient };
}

export function peerFractionForCohorts(input = {}, cohorts = {}) {
  const tags = tagsOf(input);
  let totalHost = 0;
  let totalPeer = 0;
  const byClient = {};
  for (const tag of tags) {
    const records = recordsOf(input.clients?.[tag]);
    const dispositions = attemptDispositions(records);
    const ids = new Set((cohorts[tag] ?? []).flatMap((segment) => segment.keptAttemptIds ?? []));
    const kept = records.filter((record) => record?.kind === 'attempt' && ids.has(record.attemptId)
      && dispositions.get(record.attemptId) === 'kept');
    const host = kept.filter((record) => record.source === 'http').reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0);
    const peer = kept.filter((record) => record.source === 'p2p').reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0);
    const total = host + peer;
    byClient[tag] = total > 0 ? peer / total : null;
    totalHost += host;
    totalPeer += peer;
  }
  return {
    byClient,
    aggregate: totalHost + totalPeer > 0 ? totalPeer / (totalHost + totalPeer) : null,
  };
}

function counterDelta(polls, name, tag) {
  if (polls.length < 2) return null;
  const values = polls.map((poll) => poll.quality?.[name]);
  if (values.some((value) => !finite(value))) return null;
  const delta = values.at(-1) - values[0];
  if (delta < 0) throw new Error(`trap-quality-counter-reversed:${tag}:${name}`);
  return delta;
}

export function presentedFrameRealtimeFactorByClient(input = {}, window = input.window) {
  const tags = tagsOf(input);
  const frameRate = Number(input.content?.frameRate);
  const seconds = (Number(window?.endMs) - Number(window?.startMs)) / 1000;
  const result = {};
  for (const tag of tags) {
    const polls = (input.clients?.[tag]?.polls ?? []).filter((poll) => {
      const at = poll?.atMs ?? poll?.at ?? poll?.timeMs;
      return finite(at) && at >= window.startMs && at <= window.endMs;
    });
    const total = counterDelta(polls, 'totalVideoFrames', tag);
    const dropped = counterDelta(polls, 'droppedVideoFrames', tag);
    const presented = finite(total) && finite(dropped) ? total - dropped : null;
    if (finite(presented) && presented < 0) throw new Error(`trap-presented-frame-counter-reversed:${tag}`);
    result[tag] = finite(frameRate) && frameRate > 0 && seconds > 0 && finite(presented)
      ? presented / (frameRate * seconds) : null;
  }
  return result;
}

export function trapFigures(input = {}, window = input.window) {
  const cohort = trapCohorts(input, { window, filterAfterEffective: 'all' });
  const peer = peerFractionForCohorts(input, cohort.cohorts);
  return {
    ...cohort,
    peerFractionByClient: peer.byClient,
    peerFractionAggregate: peer.aggregate,
    presentedFrameRealtimeFactorByClient: presentedFrameRealtimeFactorByClient(input, window),
  };
}
