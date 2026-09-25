// Peer-attempt cohort arithmetic. Inputs are retained evidence, not live pages.

import { attemptDispositions, keptBytes } from '../../public/lib/peer-bytes.mjs';
import { pairResponseEvidence } from './peer-checks.mjs';

export const PEER_ATTEMPT_COHORT_METHOD = 'peer-attempt-cohort-v1';

const finite = (value) => Number.isFinite(value);
const safe = (value) => Number.isSafeInteger(value) && value >= 0;
const pathOf = (value) => String(value ?? '').split(/[?#]/, 1)[0];

function tagsOf(input) {
  return input.declaredClientTags ?? input.clientTags ?? Object.keys(input.clients ?? {});
}

function recordsOf(client) {
  return Array.isArray(client?.peerRecords) ? client.peerRecords : [];
}

function originSnapshot(value) {
  return value?.counters ?? value ?? {};
}

function difference(after, before, field) {
  const right = Number(originSnapshot(after)?.[field]);
  const left = Number(originSnapshot(before)?.[field]);
  if (!finite(right) || !finite(left) || right < left) throw new Error(`counter ${field} is not monotonic`);
  return right - left;
}

function inWindow(value, window) {
  return finite(value) && finite(window?.startMs) && finite(window?.endMs)
    && value >= window.startMs && value < window.endMs;
}

function segmentIndex(path) {
  const match = pathOf(path).match(/\/seg-(\d+)\.m4s$/i);
  return match ? Number(match[1]) : null;
}

// The same completion cohort peer-checks.mjs reads; a second rule would split them.
function cohortForClient(records, window) {
  return records.filter((segment) => segment?.kind === 'segment' && inWindow(segment.completedAtMs, window));
}

function segmentLengths(input, cohorts) {
  const sizes = input.content?.segmentSizes ?? input.segmentSizes;
  if (!Array.isArray(sizes)) throw new Error('content segmentSizes are unavailable');
  const lengths = new Map();
  for (const [tag, segments] of Object.entries(cohorts)) {
    for (const segment of segments) {
      const index = segmentIndex(segment.path);
      const expected = index === null ? undefined : sizes[index];
      if (!safe(expected) || !safe(segment.lengthBytes) || expected !== segment.lengthBytes) {
        throw new Error(`segment-length-mismatch:${tag}:${segment.path}`);
      }
      const previous = lengths.get(segment.path);
      if (previous !== undefined && previous !== segment.lengthBytes) {
        throw new Error(`segment-length-mismatch:${segment.path}`);
      }
      lengths.set(segment.path, segment.lengthBytes);
    }
  }
  return lengths;
}

function hostResponseSet(input, pairing) {
  const startIds = new Set(responseRecords(input.originStart).map((record) => record?.originResponseId));
  const qualificationId = input.cdpQualification?.receipt?.originResponseId;
  const responses = responseRecords(input.originEnd).filter((record) => {
    const kind = record?.kind;
    return (kind === 'segment' || kind === 'media') && pathOf(record.urlPath).endsWith('.m4s')
      && record.originResponseId && !startIds.has(record.originResponseId)
      && record.originResponseId !== qualificationId;
  });
  const byResponseId = new Map();
  for (const response of responses) byResponseId.set(response.originResponseId, response);
  const pairs = new Map();
  for (const entry of Object.values(pairing.byClient)) {
    for (const pair of entry.pairs) {
      if (pair.receipt.originResponseId) pairs.set(pair.receipt.originResponseId, pair);
    }
  }
  const excused = (pairing.excused ?? []).map((entry) => byResponseId.get(entry.originResponseId))
    .filter(Boolean);
  return { responses: [...byResponseId.values()], pairs, excused };
}

function responseRecords(value) {
  const records = originSnapshot(value).responseRecords;
  return Array.isArray(records) ? records : [];
}

function peerWaste(records, dispositions, window) {
  return records.filter((record) => record?.kind === 'attempt' && record.source === 'p2p'
    && inWindow(record.endMs, window)
    && (dispositions.get(record.attemptId) === 'discarded' || dispositions.get(record.attemptId) === 'abandoned'))
    .reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0);
}

export function computePeerFigures(input = {}) {
  const tags = tagsOf(input);
  const window = input.window;
  const recordsByTag = Object.fromEntries(tags.map((tag) => [tag, recordsOf(input.clients?.[tag])]));
  const dispositions = Object.fromEntries(tags.map((tag) => [tag, attemptDispositions(recordsByTag[tag])]));
  const cohorts = Object.fromEntries(tags.map((tag) => [tag, cohortForClient(recordsByTag[tag], window)]));
  const lengths = segmentLengths(input, cohorts);
  const pairing = pairResponseEvidence(input);
  const keptHostBytesByClient = {};
  const keptPeerBytesByClient = {};
  const peerFractionByClient = {};
  const peerWasteBytesByClient = {};
  let totalHost = 0;
  let totalPeer = 0;
  for (const tag of tags) {
    const records = recordsByTag[tag];
    const cohortIds = new Set(cohorts[tag].flatMap((segment) => segment.keptAttemptIds ?? []));
    const host = records.filter((record) => record?.kind === 'attempt' && cohortIds.has(record.attemptId)
      && dispositions[tag].get(record.attemptId) === 'kept' && record.source === 'http')
      .reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0);
    const peer = records.filter((record) => record?.kind === 'attempt' && cohortIds.has(record.attemptId)
      && dispositions[tag].get(record.attemptId) === 'kept' && record.source === 'p2p')
      .reduce((sum, record) => sum + (safe(record.bytes) ? record.bytes : 0), 0);
    // Keep the publisher's whole-record invariant in this recompute path.
    keptBytes(records);
    keptHostBytesByClient[tag] = host;
    keptPeerBytesByClient[tag] = peer;
    const total = host + peer;
    peerFractionByClient[tag] = total > 0 ? peer / total : null;
    totalHost += host;
    totalPeer += peer;
    peerWasteBytesByClient[tag] = peerWaste(records, dispositions[tag], window);
  }
  const distinctSegmentBytesInWindow = [...lengths.values()].reduce((sum, value) => sum + value, 0);
  const mediaBytesDeliveredInWindow = difference(input.originEnd, input.originStart, 'mediaBytesDelivered');
  const hostResponses = hostResponseSet(input, pairing);
  const hostDeliveredBytesSettledInWindow = hostResponses.responses
    .reduce((sum, response) => sum + (safe(response.delivered) ? response.delivered : 0), 0);
  const hostWasteBytes = hostResponses.responses.reduce((sum, response) => {
    const pair = hostResponses.pairs.get(response.originResponseId);
    const disposition = pair && dispositions[pair.tag]?.get(pair.attempt.attemptId);
    return sum + (disposition === 'discarded' || disposition === 'abandoned'
      ? (safe(response.delivered) ? response.delivered : 0) : 0);
  }, 0) + hostResponses.excused.reduce((sum, response) => sum + (safe(response.delivered) ? response.delivered : 0), 0);
  const hostExcusedResponses = hostResponses.excused.length;
  const hostExcusedBytes = hostResponses.excused.reduce((sum, response) => sum + (safe(response.delivered) ? response.delivered : 0), 0);
  const peerCohortEmpty = tags.some((tag) => peerFractionByClient[tag] === null) || lengths.size === 0;
  return {
    byteAccountingMethod: PEER_ATTEMPT_COHORT_METHOD,
    keptHostBytesByClient,
    keptPeerBytesByClient,
    peerFractionByClient,
    peerFractionAggregate: totalHost + totalPeer > 0 ? totalPeer / (totalHost + totalPeer) : null,
    mediaBytesDeliveredInWindow,
    distinctSegmentBytesInWindow,
    distinctSegmentsCompletedInWindow: lengths.size,
    hostUploadMultiplier: distinctSegmentBytesInWindow > 0
      ? mediaBytesDeliveredInWindow / distinctSegmentBytesInWindow : null,
    hostWasteBytes,
    hostExcusedResponses,
    hostExcusedBytes,
    hostDeliveredBytesSettledInWindow,
    hostWasteFraction: hostDeliveredBytesSettledInWindow > 0
      ? hostWasteBytes / hostDeliveredBytesSettledInWindow : null,
    peerWasteBytesByClient,
    peerCohortEmpty,
    peerRefusalReasons: peerCohortEmpty ? ['peer-cohort-empty'] : [],
  };
}

export const peerFigures = computePeerFigures;
