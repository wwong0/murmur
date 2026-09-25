// Peer-attempt cohort arithmetic. Inputs are retained evidence, not live pages.

import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';
import { pairResponseEvidence } from './peer-checks.mjs';
import { cohortSegments, finite, inWindow, originSnapshot, pathOf, recordsOf, responseRecords, safe, sumBytes, tagsOf } from './peer-evidence.mjs';

export const PEER_ATTEMPT_COHORT_METHOD = 'peer-attempt-cohort-v1';

const wasted = (disposition) => disposition === 'discarded' || disposition === 'abandoned';

function difference(after, before, field) {
  const right = Number(originSnapshot(after)?.[field]);
  const left = Number(originSnapshot(before)?.[field]);
  if (!finite(right) || !finite(left) || right < left) throw new Error(`counter ${field} is not monotonic`);
  return right - left;
}

function segmentIndex(path) {
  const match = pathOf(path).match(/\/seg-(\d+)\.m4s$/i);
  return match ? Number(match[1]) : null;
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

function peerWaste(records, dispositions, window) {
  return sumBytes(records.filter((record) => record?.kind === 'attempt' && record.source === 'p2p'
    && inWindow(record.endMs, window) && wasted(dispositions.get(record.attemptId))), 'bytes');
}

export function computePeerFigures(input = {}, pairing = pairResponseEvidence(input)) {
  const tags = tagsOf(input);
  const window = input.window;
  const recordsByTag = Object.fromEntries(tags.map((tag) => [tag, recordsOf(input.clients?.[tag])]));
  // attemptDispositions throws on a record set that claims an attempt twice —
  // the publisher's whole-record invariant, held on this recompute path too.
  const dispositions = Object.fromEntries(tags.map((tag) => [tag, attemptDispositions(recordsByTag[tag])]));
  const cohorts = Object.fromEntries(tags.map((tag) => [tag, cohortSegments(recordsByTag[tag], window)]));
  const lengths = segmentLengths(input, cohorts);
  const keptHostBytesByClient = {};
  const keptPeerBytesByClient = {};
  const peerFractionByClient = {};
  const peerWasteBytesByClient = {};
  let totalHost = 0;
  let totalPeer = 0;
  for (const tag of tags) {
    const records = recordsByTag[tag];
    const cohortIds = new Set(cohorts[tag].flatMap((segment) => segment.keptAttemptIds ?? []));
    const kept = records.filter((record) => record?.kind === 'attempt' && cohortIds.has(record.attemptId)
      && dispositions[tag].get(record.attemptId) === 'kept');
    const host = sumBytes(kept.filter((record) => record.source === 'http'), 'bytes');
    const peer = sumBytes(kept.filter((record) => record.source === 'p2p'), 'bytes');
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
  const hostDeliveredBytesSettledInWindow = sumBytes(hostResponses.responses, 'delivered');
  const hostExcusedResponses = hostResponses.excused.length;
  const hostExcusedBytes = sumBytes(hostResponses.excused, 'delivered');
  const hostWasteBytes = sumBytes(hostResponses.responses.filter((response) => {
    const pair = hostResponses.pairs.get(response.originResponseId);
    return wasted(pair && dispositions[pair.tag]?.get(pair.attempt.attemptId));
  }), 'delivered') + hostExcusedBytes;
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
