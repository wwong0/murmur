// Peer-attempt cohort arithmetic. Inputs are retained evidence, not live pages.

import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';
import { pairResponseEvidence } from './peer-checks.mjs';
import { bytesForStretch, computeOneViewing } from './one-viewing.mjs';
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

function hasDriftEvidence(input, tags) {
  return tags.every((tag) => Array.isArray(input.clients?.[tag]?.records)
    && input.clients[tag].records.length > 0);
}

function offsetsFor(input, tags) {
  const offsets = input.condition?.positionOffsetMsByClient ?? input.declaredOffsetMsByClient ?? {};
  return Object.fromEntries(tags.map((tag) => [tag, offsets[tag] ?? 0]));
}

function completedBytes(segments) {
  const byPath = new Map();
  for (const segment of segments) {
    const key = pathOf(segment.path);
    if (!byPath.has(key)) byPath.set(key, segment.lengthBytes);
  }
  return [...byPath.values()].reduce((sum, bytes) => sum + bytes, 0);
}

function downloadRatios(input, tags, cohorts, oneViewing) {
  const byClient = {};
  for (const tag of tags) {
    const bytes = completedBytes(cohorts[tag]);
    const stretch = oneViewing.playedMediaMsByClient[tag];
    // This calculation uses the viewer's own played positions, not the room
    // stretch.
    const segmentSizes = input.content?.segmentSizes ?? input.segmentSizes;
    const playedStart = stretch.start;
    const playedEnd = stretch.end;
    const durationMs = (segmentSizes?.length ?? 0) * (input.segmentSeconds ?? 4) * 1000;
    if (!finite(playedStart) || !finite(playedEnd) || playedEnd < playedStart
      || playedStart < 0 || playedEnd > durationMs) {
      throw new Error(`played-stretch-invalid:${tag}`);
    }
    const playedBytesForClient = bytesForStretch(playedStart, playedEnd, segmentSizes, input.segmentSeconds ?? 4);
    byClient[tag] = playedBytesForClient > 0 ? bytes / playedBytesForClient : null;
  }
  return byClient;
}

function steadyState({ input, tags, figures, cohorts, oneViewing }) {
  const bars = input.condition?.bars ?? {};
  const declared = ['steadyUtilisationMax', 'steadyDownloadRatioMin',
    'steadyDownloadRatioMax', 'steadyRealtimeMin'].every((name) => finite(bars[name]));
  const utilisation = {
    value: finite(figures.uplinkUtilisationMean) ? figures.uplinkUtilisationMean : null,
    bar: declared ? bars.steadyUtilisationMax : null,
  };
  utilisation.pass = declared && finite(utilisation.value) && utilisation.value <= utilisation.bar;
  const byClient = oneViewing ? downloadRatios(input, tags, cohorts, oneViewing) :
    Object.fromEntries(tags.map((tag) => [tag, null]));
  const downloadRatio = {
    byClient,
    bars: { min: declared ? bars.steadyDownloadRatioMin : null, max: declared ? bars.steadyDownloadRatioMax : null },
  };
  downloadRatio.pass = declared && tags.every((tag) => finite(byClient[tag])
    && byClient[tag] >= downloadRatio.bars.min && byClient[tag] <= downloadRatio.bars.max);
  const realtimeByClient = Object.fromEntries(tags.map((tag) => [tag,
    finite(figures.realtimeFactorByClient?.[tag]) ? figures.realtimeFactorByClient[tag] : null]));
  const realtime = {
    byClient: realtimeByClient,
    bar: declared ? bars.steadyRealtimeMin : null,
  };
  realtime.pass = declared && tags.every((tag) => finite(realtimeByClient[tag])
    && realtimeByClient[tag] >= realtime.bar);
  const legs = { utilisation, downloadRatio, realtime };
  let reason = null;
  if (!declared) reason = 'steady-state-bars-undeclared';
  else if (!utilisation.pass) reason = 'steady-state-utilisation';
  else if (!downloadRatio.pass) reason = 'steady-state-download-ratio';
  else if (!realtime.pass) reason = 'steady-state-realtime';
  return { steady: reason === null, legs, reason };
}

function refusalFor(steady) {
  const failedLegs = Object.entries(steady.legs)
    .filter(([, leg]) => leg.pass !== true)
    .map(([name, leg]) => ({ leg: name, value: leg }));
  return { reason: steady.reason, failedLegs, legs: steady.legs };
}

const BOUNDARY_RECORD_MISSING = /^drift-record-(before|after)-boundary-unavailable:/;

// A legacy directory without drift records publishes its distinct-completed figure alone.
// A viewer that never started has no record at a boundary: refuse the multiplier and let
// the start-wait and never-played refusals name it — a throw here skips them (7c
// d1-findings.md F1).
function oneViewingDetails(input, tags, multiplierDenominator) {
  const required = multiplierDenominator === 'one-viewing';
  if (!hasDriftEvidence(input, tags)) {
    return required ? { unavailable: 'one-viewing-drift-evidence-unavailable' } : null;
  }
  try {
    return computeOneViewing({
      clients: input.clients,
      tags,
      window: input.window,
      offsets: offsetsFor(input, tags),
      segmentSizes: input.content?.segmentSizes ?? input.segmentSizes,
      segmentSeconds: input.segmentSeconds ?? 4,
    });
  } catch (error) {
    if (!BOUNDARY_RECORD_MISSING.test(error.message)) throw error;
    return required ? { unavailable: error.message } : null;
  }
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
  const responseAgreement = pairing.unreceived?.report;
  const hostFetchOnceRatio = distinctSegmentBytesInWindow > 0
    ? mediaBytesDeliveredInWindow / distinctSegmentBytesInWindow : null;
  const multiplierDenominator = input.multiplierDenominator ?? 'distinct-completed';
  const oneViewing = oneViewingDetails(input, tags, multiplierDenominator);
  const result = {
    byteAccountingMethod: PEER_ATTEMPT_COHORT_METHOD,
    keptHostBytesByClient,
    keptPeerBytesByClient,
    peerFractionByClient,
    peerFractionAggregate: totalHost + totalPeer > 0 ? totalPeer / (totalHost + totalPeer) : null,
    mediaBytesDeliveredInWindow,
    distinctSegmentBytesInWindow,
    distinctSegmentsCompletedInWindow: lengths.size,
    hostUploadMultiplier: hostFetchOnceRatio,
    hostFetchOnceRatio,
    multiplierDenominator,
    hostWasteBytes,
    hostExcusedResponses,
    hostExcusedBytes,
    hostDeliveredBytesSettledInWindow,
    hostWasteFraction: hostDeliveredBytesSettledInWindow > 0
      ? hostWasteBytes / hostDeliveredBytesSettledInWindow : null,
    ...(responseAgreement ? { hostResponsesUnreceived: responseAgreement } : {}),
    peerWasteBytesByClient,
    peerCohortEmpty,
    peerRefusalReasons: peerCohortEmpty ? ['peer-cohort-empty'] : [],
  };
  if (oneViewing?.unavailable) {
    delete result.hostUploadMultiplier;
    result.peerFractionSteady = false;
    result.hostUploadMultiplierRefusal = { reason: 'one-viewing-unavailable', detail: oneViewing.unavailable };
  } else if (oneViewing) {
    const state = steadyState({ input, tags, figures: {
      ...result,
      uplinkUtilisationMean: input.uplinkUtilisationMean,
      realtimeFactorByClient: input.realtimeFactorByClient,
    }, cohorts, oneViewing });
    result.oneViewingBytesInWindow = oneViewing.oneViewingBytesInWindow;
    result.roomPositionSpreadMs = oneViewing.roomPositionSpreadMs;
    result.peerFractionSteady = state.steady;
    result.steadyState = state;
    if (multiplierDenominator === 'one-viewing') {
      if (state.steady) result.hostUploadMultiplier = mediaBytesDeliveredInWindow / oneViewing.oneViewingBytesInWindow;
      else {
        delete result.hostUploadMultiplier;
        result.hostUploadMultiplierRefusal = refusalFor(state);
      }
    }
  }
  return result;
}

export { steadyState };
