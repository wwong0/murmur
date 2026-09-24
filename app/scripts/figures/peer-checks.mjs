// Independent checks for the peer-attempt byte accounting.

import { attemptDispositions } from '../../public/lib/peer-bytes.mjs';

const finite = (value) => Number.isFinite(value);
const safe = (value) => Number.isSafeInteger(value) && value >= 0;
const pathOf = (value) => String(value ?? '').split(/[?#]/, 1)[0];
const mediaPath = (value) => /\/media\/.*\.m4s$/i.test(pathOf(value));

function tagsOf(input) {
  return input.declaredClientTags ?? input.clientTags ?? Object.keys(input.clients ?? {});
}

function recordsOf(client) {
  return Array.isArray(client?.peerRecords) ? client.peerRecords : [];
}

function inWindow(value, window) {
  return finite(value) && finite(window?.startMs) && finite(window?.endMs)
    && value >= window.startMs && value < window.endMs;
}

function originSnapshot(value) {
  return value?.counters ?? value ?? {};
}

function responseRecords(value) {
  const records = originSnapshot(value).responseRecords;
  return Array.isArray(records) ? records : [];
}

function receiptKey(receipt, index) {
  return receipt?.requestId ?? `receipt-${index}`;
}

function qualifies(receipt, qualificationRequestId) {
  return receipt?.requestId !== qualificationRequestId;
}

function receiptsFor(client, qualificationRequestId) {
  const receipts = Array.isArray(client?.requests) ? client.requests : [];
  return receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => qualifies(receipt, qualificationRequestId) && mediaPath(receipt?.url))
    .map(({ receipt, index }) => ({ receipt, key: receiptKey(receipt, index) }));
}

function hostByResponseId(input) {
  const result = new Map();
  for (const record of responseRecords(input.originEnd)) {
    if (record?.originResponseId) result.set(record.originResponseId, record);
  }
  return result;
}

function attemptsFor(client) {
  return recordsOf(client)
    .filter((record) => record?.kind === 'attempt' && record.source === 'http' && mediaPath(record.path))
    .sort((left, right) => (left.startMs ?? Infinity) - (right.startMs ?? Infinity)
      || (left.seq ?? 0) - (right.seq ?? 0));
}

/** Pair receipts to engine HTTP attempts in start order, independently of checks. */
export function pairResponseEvidence(input = {}) {
  const qualificationRequestId = input.cdpQualification?.receipt?.requestId;
  const host = hostByResponseId(input);
  const byClient = {};
  for (const tag of tagsOf(input)) {
    const client = input.clients?.[tag] ?? {};
    const receipts = receiptsFor(client, qualificationRequestId)
      .sort((left, right) => (left.receipt.startMs ?? Infinity) - (right.receipt.startMs ?? Infinity)
        || (left.receipt.seq ?? 0) - (right.receipt.seq ?? 0));
    const attempts = attemptsFor(client);
    const used = new Set();
    const pairs = [];
    const unmatchedReceipts = [];
    for (const entry of receipts) {
      const candidate = attempts.find((attempt) => !used.has(attempt.attemptId)
        && attempt.path === pathOf(entry.receipt.url)
        && finite(attempt.startMs) && finite(entry.receipt.startMs)
        && attempt.startMs <= entry.receipt.startMs);
      if (!candidate) {
        unmatchedReceipts.push(entry);
        continue;
      }
      used.add(candidate.attemptId);
      pairs.push({ tag, receipt: entry.receipt, receiptKey: entry.key, attempt: candidate,
        host: host.get(entry.receipt.originResponseId) });
    }
    const unmatchedAttempts = attempts.filter((attempt) => !used.has(attempt.attemptId));
    byClient[tag] = { receipts, attempts, pairs, unmatchedReceipts, unmatchedAttempts };
  }
  return { byClient, host };
}

function cohortSegments(client, window) {
  return recordsOf(client).filter((record) => record?.kind === 'segment'
    && inWindow(record.completedAtMs, window));
}

function responseAgreement(input, tolerances) {
  const pairing = pairResponseEvidence(input);
  const failures = [];
  let exercised = false;
  for (const tag of tagsOf(input)) {
    const entry = pairing.byClient[tag] ?? { receipts: [], attempts: [], pairs: [], unmatchedReceipts: [], unmatchedAttempts: [] };
    const cohortReceipts = entry.receipts.filter(({ receipt }) => inWindow(receipt.endMs, input.window));
    if (cohortReceipts.length || entry.attempts.some((attempt) => inWindow(attempt.endMs, input.window))) exercised = true;
    const cohortKeys = new Set(cohortReceipts.map(({ receipt, key }) => `${key}:${receipt.originResponseId ?? ''}`));
    const cohortPairs = entry.pairs.filter((pair) => cohortKeys.has(`${pair.receiptKey}:${pair.receipt.originResponseId ?? ''}`));
    for (const { receipt, key } of cohortReceipts) {
      const pair = cohortPairs.find((candidate) => candidate.receiptKey === key);
      if (!pair) {
        failures.push({ tag, type: 'receipt-unpaired', requestId: receipt.requestId });
        continue;
      }
      if (!pair.host) {
        failures.push({ tag, type: 'host-response-unpaired', requestId: receipt.requestId,
          originResponseId: receipt.originResponseId });
        continue;
      }
      const hostDelivered = pair.host.delivered;
      const receiptBytes = receipt.bodyBytes;
      const attemptBytes = pair.attempt.bytes;
      if (receipt.finished === true) {
        const expected = receipt.expectedBytes;
        if (![hostDelivered, receiptBytes, expected, attemptBytes].every(safe)
          || !(hostDelivered === receiptBytes && receiptBytes === expected && expected === attemptBytes)) {
          failures.push({ tag, type: 'finished-byte-mismatch', requestId: receipt.requestId,
            hostDelivered, receiptBytes, expected, attemptBytes });
        }
      } else if (receipt.canceled === true) {
        const delta = safe(receiptBytes) && safe(attemptBytes) ? receiptBytes - attemptBytes : NaN;
        const hostDelta = safe(hostDelivered) && safe(receiptBytes) ? hostDelivered - receiptBytes : NaN;
        if (delta !== 0 || !finite(hostDelta) || hostDelta < 0
          || hostDelta > Number(tolerances.responseCutShortMaxBytes)) {
          failures.push({ tag, type: 'cut-short-byte-mismatch', requestId: receipt.requestId,
            hostDelivered, receiptBytes, attemptBytes, hostDelta });
        }
      } else {
        failures.push({ tag, type: 'receipt-disposition-unknown', requestId: receipt.requestId });
      }
    }
    const pairedCohortAttempts = new Set(cohortPairs.map((pair) => pair.attempt.attemptId));
    for (const attempt of entry.attempts) {
      if (inWindow(attempt.endMs, input.window) && !pairedCohortAttempts.has(attempt.attemptId)) {
        failures.push({ tag, type: 'attempt-unpaired', attemptId: attempt.attemptId, path: attempt.path });
      }
    }
  }
  return { check: 'response-agreement', passed: failures.length === 0, failures, exercised };
}

function segmentSum(input) {
  const pairing = pairResponseEvidence(input);
  const failures = [];
  let exercised = false;
  for (const tag of tagsOf(input)) {
    const client = input.clients?.[tag] ?? {};
    const byAttempt = new Map((pairing.byClient[tag]?.pairs ?? []).map((pair) => [pair.attempt.attemptId, pair]));
    for (const segment of cohortSegments(client, input.window)) {
      exercised = true;
      let total = 0;
      for (const attemptId of segment.keptAttemptIds ?? []) {
        const attempt = recordsOf(client).find((record) => record?.kind === 'attempt' && record.attemptId === attemptId);
        if (!attempt) {
          failures.push({ tag, type: 'kept-attempt-missing', attemptId, path: segment.path });
        } else if (attempt.source === 'http') {
          const pair = byAttempt.get(attemptId);
          if (!pair || !safe(pair.receipt.bodyBytes)) {
            failures.push({ tag, type: 'kept-http-receipt-missing', attemptId, path: segment.path });
          } else total += pair.receipt.bodyBytes;
        } else if (attempt.source === 'p2p' && safe(attempt.bytes)) {
          total += attempt.bytes;
        } else {
          failures.push({ tag, type: 'kept-peer-bytes-missing', attemptId, path: segment.path });
        }
      }
      if (!safe(segment.lengthBytes) || total !== segment.lengthBytes) {
        failures.push({ tag, type: 'segment-sum-mismatch', path: segment.path,
          expected: segment.lengthBytes, actual: total });
      }
    }
  }
  return { check: 'segment-sum', passed: failures.length === 0, failures, exercised };
}

function peerIdMembership(input) {
  const tags = tagsOf(input);
  const idsByTag = Object.fromEntries(tags.map((tag) => [tag,
    new Set(Array.isArray(input.clients?.[tag]?.peerTotalsA?.peerIds)
      ? input.clients[tag].peerTotalsA.peerIds.filter((id) => typeof id === 'string') : [])]));
  const allIds = new Set(tags.flatMap((tag) => [...idsByTag[tag]]));
  const failures = [];
  let exercised = false;
  for (const tag of tags) {
    for (const attempt of recordsOf(input.clients?.[tag]).filter((record) => record?.kind === 'attempt' && record.source === 'p2p')) {
      exercised = true;
      const matchesOther = tags.some((other) => other !== tag && idsByTag[other].has(attempt.peerId));
      if (!matchesOther) failures.push({ tag, peerId: attempt.peerId ?? null, known: allIds.has(attempt.peerId) });
    }
  }
  return { check: 'peer-id-membership', passed: failures.length === 0, failures, exercised };
}

function totalAt(value, field, key) {
  const source = field.split('.').reduce((current, name) => current?.[name], value)?.[key];
  return source === undefined ? 0 : source;
}

function conservation(input, tolerances) {
  const tags = tagsOf(input);
  const failures = [];
  const toleranceRefusals = [];
  const totals = Object.fromEntries(tags.map((tag) => [tag, input.clients?.[tag] ?? {}]));
  const complete = tags.length > 1 && tags.every((tag) => {
    const client = totals[tag];
    return client.peerTotalsA?.peerId && client.peerTotalsB?.peerId
      && client.peerTotalsA.chunkBytes && client.peerTotalsA.uploadBytes
      && client.peerTotalsB.chunkBytes && client.peerTotalsB.uploadBytes;
  });
  if (!complete) {
    failures.push({ type: 'totals-unavailable' });
    return { check: 'conservation', passed: false, failures, exercised: false, toleranceRefusals };
  }
  for (const sender of tags) for (const receiver of tags) {
    if (sender === receiver) continue;
    const senderA = totals[sender].peerTotalsA;
    const senderB = totals[sender].peerTotalsB;
    const receiverA = totals[receiver].peerTotalsA;
    const receiverB = totals[receiver].peerTotalsB;
    const U_A = totalAt(senderA, 'uploadBytes', receiverA.peerId);
    const U_B = totalAt(senderB, 'uploadBytes', receiverB.peerId);
    const D_A = totalAt(receiverA, 'chunkBytes.p2p', senderA.peerId);
    const D_B = totalAt(receiverB, 'chunkBytes.p2p', senderA.peerId);
    const closes = recordsOf(totals[receiver]).filter((record) => record?.kind === 'peer'
      && record.event === 'close' && record.peerId === senderA.peerId).length;
    const T = Number(tolerances.conservationChannelBytes) * (1 + closes);
    const bound = Math.max(Number(tolerances.conservationChannelBytes),
      Number(tolerances.conservationRelativeMax) * U_B);
    const detail = { sender, receiver, U_A, U_B, D_A, D_B, closes, T, bound };
    if (T > bound) {
      toleranceRefusals.push(detail);
      continue;
    }
    if (!(D_A <= U_B && U_A - T <= D_B)) failures.push({ type: 'conservation-mismatch', ...detail });
  }
  return { check: 'conservation', passed: failures.length === 0, failures, exercised: true, toleranceRefusals };
}

export function computePeerChecks(input = {}, tolerances = {}) {
  const bars = { ...(input.condition?.bars ?? {}), ...tolerances };
  return [
    responseAgreement(input, bars),
    segmentSum(input),
    peerIdMembership(input),
    conservation(input, bars),
  ];
}

export const runPeerChecks = computePeerChecks;
export const checkResponseAgreement = responseAgreement;
export const checkSegmentSum = segmentSum;
export const checkPeerIdMembership = peerIdMembership;
export const checkConservation = conservation;
