// Independent checks for the peer-attempt byte accounting.

import { cohortSegments, declaresResponseSettle, finite, inWindow, pathOf, recordsOf, responseRecords, safe, tagsOf } from './peer-evidence.mjs';

const mediaPath = (value) => /\/media\/.*\.m4s$/i.test(pathOf(value));

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

function allReceipts(input) {
  return tagsOf(input).flatMap((tag) => {
    const requests = Array.isArray(input.clients?.[tag]?.requests) ? input.clients[tag].requests : [];
    return requests.map((receipt, index) => ({ tag, receipt, key: receiptKey(receipt, index) }))
      .filter(({ receipt }) => mediaPath(receipt?.url));
  });
}

function settledRecords(input) {
  return declaresResponseSettle(input.condition) ? responseRecords(input.originSettled) : responseRecords(input.originEnd);
}

function responseIdParts(value) {
  const match = typeof value === 'string' && value.match(/^(.*):(\d+)$/);
  return match ? { prefix: match[1], sequence: Number(match[2]) } : null;
}

function excusedResponseEvidence(input, pairing) {
  const receipts = pairing.allReceipts ?? allReceipts(input);
  const carried = new Set(receipts.map(({ receipt }) => receipt?.originResponseId).filter(Boolean));
  const started = new Set(responseRecords(input.originStart).map((record) => record?.originResponseId));
  const settled = new Map(settledRecords(input).map((record) => [record?.originResponseId, record]));
  const candidates = responseRecords(input.originEnd).map((response) => settled.get(response?.originResponseId) ?? response).filter((response) => {
    const kind = response?.kind;
    return (kind === 'segment' || kind === 'media') && response.aborted === true
      && response.originResponseId && !started.has(response.originResponseId)
      && !carried.has(response.originResponseId);
  });
  const eligible = [];
  for (const tag of tagsOf(input)) {
    for (const pair of pairing.byClient[tag]?.pairs ?? []) {
      const receipt = pair.receipt;
      if (receipt.originResponseId !== null || receipt.canceled !== true || receipt.bodyBytes !== 0
        || pair.attempt.bytes !== 0) continue;
      const matching = candidates.filter((response) => response.clientTag === tag
        && pathOf(response.urlPath) === pathOf(receipt.url)
        && overlaps(response, pair.attempt, receipts));
      for (const response of matching) eligible.push({ tag, pair, response });
    }
  }
  const byReceipt = new Map();
  const byResponse = new Map();
  for (const entry of eligible) {
    const receiptKeyValue = `${entry.tag}:${entry.pair.receiptKey}`;
    byReceipt.set(receiptKeyValue, [...(byReceipt.get(receiptKeyValue) ?? []), entry]);
    byResponse.set(entry.response.originResponseId, [...(byResponse.get(entry.response.originResponseId) ?? []), entry]);
  }
  const uniqueEntries = eligible
    .filter((entry) => byReceipt.get(`${entry.tag}:${entry.pair.receiptKey}`)?.length === 1
      && byResponse.get(entry.response.originResponseId)?.length === 1);
  const unique = uniqueEntries
    .map((entry) => ({
      tag: entry.tag,
      requestId: entry.pair.receipt.requestId,
      originResponseId: entry.response.originResponseId,
      delivered: entry.response.delivered,
    }));
  const excusedRequestKeys = new Set(uniqueEntries.map((entry) => JSON.stringify([entry.tag, entry.pair.receiptKey])));
  const excusedResponseIds = new Set(unique.map((entry) => entry.originResponseId));
  const groups = new Map();
  const groupFor = (tag, path) => {
    const key = JSON.stringify([tag, path]);
    const group = groups.get(key) ?? { receipts: [], responses: [] };
    groups.set(key, group);
    return group;
  };
  for (const tag of tagsOf(input)) {
    for (const pair of pairing.byClient[tag]?.pairs ?? []) {
      const receipt = pair.receipt;
      if (receipt.originResponseId !== null || receipt.canceled !== true || receipt.bodyBytes !== 0
        || pair.attempt.bytes !== 0) continue;
      const requestKey = JSON.stringify([tag, pair.receiptKey]);
      if (!excusedRequestKeys.has(requestKey)) groupFor(tag, pathOf(receipt.url)).receipts.push({ tag, pair });
    }
  }
  for (const response of candidates) {
    if (excusedResponseIds.has(response.originResponseId)) continue;
    groupFor(response.clientTag, pathOf(response.urlPath)).responses.push(response);
  }
  const result = [...unique];
  for (const group of groups.values()) {
    if (group.receipts.length < 1 || group.receipts.length !== group.responses.length) continue;
    const parsed = group.responses.map((response) => ({ response, id: responseIdParts(response.originResponseId) }));
    if (parsed.some(({ id }) => !id) || new Set(parsed.map(({ id }) => id.prefix)).size !== 1) continue;
    const orderedReceipts = [...group.receipts].sort((left, right) => {
      const start = (Number.isFinite(left.pair.receipt.startMs) ? left.pair.receipt.startMs : Infinity)
        - (Number.isFinite(right.pair.receipt.startMs) ? right.pair.receipt.startMs : Infinity);
      if (start) return start;
      return (Number.isFinite(left.pair.receipt.seq) ? left.pair.receipt.seq : Infinity)
        - (Number.isFinite(right.pair.receipt.seq) ? right.pair.receipt.seq : Infinity);
    });
    const orderedResponses = parsed.sort((left, right) => left.id.sequence - right.id.sequence);
    if (!orderedResponses.every(({ response }, index) => overlaps(response, orderedReceipts[index].pair.attempt, receipts))) continue;
    for (let index = 0; index < orderedResponses.length; index += 1) {
      const { response } = orderedResponses[index];
      if (excusedResponseIds.has(response.originResponseId)) throw new Error(`excusal-duplicate:${response.originResponseId}`);
      excusedResponseIds.add(response.originResponseId);
      const pair = orderedReceipts[index].pair;
      result.push({ tag: pair.tag, requestId: pair.receipt.requestId,
        originResponseId: response.originResponseId, delivered: response.delivered });
    }
  }
  return result;
}

function overlaps(response, receipt, receipts) {
  const responseId = responseIdParts(response.originResponseId);
  if (!responseId) return false;
  const bracket = receipts
    .map(({ receipt: other }) => ({ receipt: other, id: responseIdParts(other?.originResponseId) }))
    .filter(({ id }) => id?.prefix === responseId.prefix);
  const lowerValues = bracket.filter(({ id }) => id.sequence < responseId.sequence)
    .map(({ receipt: other }) => other.startMs).filter(finite);
  const upperValues = bracket.filter(({ id }) => id.sequence > responseId.sequence)
    .map(({ receipt: other }) => other.headMs).filter(finite);
  if (!lowerValues.length || !upperValues.length) return false;
  const lower = Math.max(...lowerValues);
  const upper = Math.min(...upperValues);
  return lower <= receipt.endMs && upper >= receipt.startMs;
}

function hostByResponseId(input) {
  const result = new Map();
  for (const record of settledRecords(input)) {
    if (record?.originResponseId) result.set(record.originResponseId, record);
  }
  return result;
}

function qualificationIds(input) {
  const receipt = input.cdpQualification?.receipt ?? {};
  return new Set([receipt.requestId, receipt.originResponseId].filter(Boolean));
}

function inWindowReceipt(receipt, window) {
  return inWindow(receipt?.endMs, window);
}

function responseAgrees(receipt, response, tolerances) {
  if (!receipt || !response || !safe(receipt.bodyBytes) || !safe(response.delivered)) return false;
  if (receipt.finished === true) return receipt.bodyBytes === response.delivered;
  if (receipt.canceled === true) {
    const delta = response.delivered - receipt.bodyBytes;
    return delta >= 0 && delta <= Number(tolerances.responseCutShortMaxBytes);
  }
  return false;
}

function unreceivedResponses(input, pairing, tolerances) {
  if (!declaresResponseSettle(input.condition)) return null;
  const started = new Set(responseRecords(input.originStart).map((record) => record?.originResponseId));
  const qualification = qualificationIds(input);
  const receipts = pairing.allReceipts ?? allReceipts(input);
  const carriedInWindow = new Set(receipts
    .filter(({ receipt }) => inWindowReceipt(receipt, input.window))
    .map(({ receipt }) => receipt?.originResponseId)
    .filter(Boolean));
  const host = hostByResponseId(input);
  const excused = new Map((pairing.excused ?? []).map((entry) => [entry.originResponseId, entry]));
  const candidates = responseRecords(input.originEnd).filter((response) => {
    return (response?.kind === 'segment' || response?.kind === 'media') && mediaPath(response?.urlPath)
      && response?.originResponseId && !started.has(response.originResponseId)
      && !qualification.has(response.originResponseId) && !carriedInWindow.has(response.originResponseId);
  });
  const report = { count: candidates.length, bytes: 0, excused: { count: 0, bytes: 0 }, laterReceived: { count: 0, bytes: 0 } };
  const failures = [];
  for (const candidate of candidates) {
    const response = host.get(candidate.originResponseId) ?? candidate;
    const bytes = safe(response?.delivered) ? response.delivered : 0;
    report.bytes += bytes;
    if (excused.has(candidate.originResponseId)) {
      report.excused.count += 1;
      report.excused.bytes += bytes;
      continue;
    }
    const later = receipts.find(({ receipt }) => receipt?.originResponseId === candidate.originResponseId
      && !inWindowReceipt(receipt, input.window) && responseAgrees(receipt, response, tolerances));
    if (later) {
      report.laterReceived.count += 1;
      report.laterReceived.bytes += bytes;
      continue;
    }
    failures.push({ type: 'host-response-unreceived', originResponseId: candidate.originResponseId, bytes });
  }
  return { report, failures };
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
  const pairing = { byClient, host, allReceipts: allReceipts(input) };
  pairing.excused = excusedResponseEvidence(input, pairing);
  pairing.unreceived = unreceivedResponses(input, pairing, input.condition?.bars ?? {});
  return pairing;
}

function responseAgreement(input, tolerances, pairing) {
  const failures = [];
  const excused = pairing.excused ?? [];
  const excusedKeys = new Set(excused.map((entry) => `${entry.tag}:${entry.requestId}`));
  let exercised = false;
  for (const tag of tagsOf(input)) {
    const entry = pairing.byClient[tag] ?? { receipts: [], attempts: [], pairs: [], unmatchedReceipts: [], unmatchedAttempts: [] };
    const cohortReceipts = entry.receipts.filter(({ receipt }) => inWindow(receipt.endMs, input.window));
    if (cohortReceipts.length || entry.attempts.some((attempt) => inWindow(attempt.endMs, input.window))) exercised = true;
    const cohortKeys = new Set(cohortReceipts.map(({ receipt, key }) => `${key}:${receipt.originResponseId ?? ''}`));
    const cohortPairs = entry.pairs.filter((pair) => cohortKeys.has(`${pair.receiptKey}:${pair.receipt.originResponseId ?? ''}`));
    for (const { receipt, key } of cohortReceipts) {
      if (excusedKeys.has(`${tag}:${receipt.requestId ?? key}`)) continue;
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
  if (pairing.unreceived) {
    exercised ||= pairing.unreceived.report.count > 0;
    failures.push(...pairing.unreceived.failures);
  }
  return {
    check: 'response-agreement', passed: failures.length === 0, failures, exercised, excused,
    ...(pairing.unreceived ? { hostResponsesUnreceived: pairing.unreceived.report } : {}),
  };
}

function segmentSum(input, pairing) {
  const failures = [];
  let exercised = false;
  for (const tag of tagsOf(input)) {
    const client = input.clients?.[tag] ?? {};
    const byAttempt = new Map((pairing.byClient[tag]?.pairs ?? []).map((pair) => [pair.attempt.attemptId, pair]));
    for (const segment of cohortSegments(recordsOf(client), input.window)) {
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

function cancelledPeerAttempts(client, peerId) {
  return recordsOf(client).filter((record) => record?.kind === 'attempt'
    && record.source === 'p2p' && record.peerId === peerId && record.end !== 'loaded');
}

function segmentIndex(path) {
  const match = pathOf(path).match(/(?:^|\/)seg-(\d+)\.m4s$/i);
  return match ? Number(match[1]) : null;
}

function cancelAllowance(input, queueLimitBytes, channelBytes, cancels) {
  const segmentSizes = input.content?.segmentSizes ?? input.segmentSizes;
  let allowance = 0;
  const failures = [];
  for (const attempt of cancels) {
    const index = segmentIndex(attempt.path);
    const size = index === null ? undefined : segmentSizes?.[index];
    const held = Number(attempt.heldAtEndBytes);
    if (index === null || !finite(size) || size < 0 || !finite(held) || held < 0) {
      failures.push({ type: 'conservation-segment-unknown', path: attempt.path ?? null, index });
      continue;
    }
    allowance += Math.min(Math.max(0, size - held), channelBytes + queueLimitBytes);
  }
  return { allowance, failures };
}

function conservation(input, tolerances) {
  const tags = tagsOf(input);
  const failures = [];
  const toleranceRefusals = [];
  const peerLinkQueues = input.peerLinkQueues ?? {};
  const shapedPairs = Object.keys(peerLinkQueues).length > 0;
  const pairs = [];
  const totals = Object.fromEntries(tags.map((tag) => [tag, input.clients?.[tag] ?? {}]));
  const gap = Number(tolerances.conservationDeliveryGapMs);
  if (!finite(gap) || gap < 0) {
    failures.push({ type: 'delivery-gap-unrecorded' });
    return { check: 'conservation', passed: false, failures, exercised: false, toleranceRefusals };
  }
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
    const readGap = Number(receiverB.readStartedAtMs) - Number(senderA.readEndedAtMs);
    if (!finite(readGap)) {
      failures.push({ type: 'delivery-gap-unrecorded', sender, receiver, readGap });
      continue;
    }
    if (readGap < gap) {
      failures.push({ type: 'delivery-gap-short', sender, receiver, requiredMs: gap, actualMs: readGap });
      continue;
    }
    const U_A = totalAt(senderA, 'uploadBytes', receiverA.peerId);
    const U_B = totalAt(senderB, 'uploadBytes', receiverB.peerId);
    const D_A = totalAt(receiverA, 'chunkBytes.p2p', senderA.peerId);
    const D_B = totalAt(receiverB, 'chunkBytes.p2p', senderA.peerId);
    const closes = recordsOf(totals[receiver]).filter((record) => record?.kind === 'peer'
      && record.event === 'close' && record.peerId === senderA.peerId).length;
    const cancels = cancelledPeerAttempts(totals[receiver], senderA.peerId);
    const channelBytes = Number(tolerances.conservationChannelBytes);
    const T = channelBytes * closes;
    const bound = Math.max(channelBytes,
      Number(tolerances.conservationRelativeMax) * U_B);
    const shaped = Object.prototype.hasOwnProperty.call(peerLinkQueues, sender);
    if (shaped) {
      const queueLimitBytes = Number(peerLinkQueues[sender]?.queueLimitBytes);
      if (!finite(queueLimitBytes) || queueLimitBytes < 0) {
        failures.push({ type: 'conservation-queue-unknown', sender, receiver, queueLimitBytes });
        continue;
      }
      const terms = cancelAllowance(input, queueLimitBytes, channelBytes, cancels);
      const allowance = T + terms.allowance;
      const pair = { sender, receiver, shaped: true, shortfall: U_A - D_B,
        allowance, closes, cancels: cancels.length };
      pairs.push(pair);
      failures.push(...terms.failures.map((failure) => ({ ...failure, sender, receiver })));
      const detail = { sender, receiver, U_A, U_B, D_A, D_B, closes,
        cancels: cancels.length, T, allowance, queueLimitBytes };
      if (!(D_A <= U_B && U_A - allowance <= D_B)) {
        failures.push({ type: 'conservation-mismatch', ...detail });
      }
      continue;
    }
    const detail = { sender, receiver, U_A, U_B, D_A, D_B, closes, T, bound };
    if (T > bound) {
      toleranceRefusals.push(detail);
    } else if (!(D_A <= U_B && U_A - T <= D_B)) {
      failures.push({ type: 'conservation-mismatch', ...detail });
    }
    if (shapedPairs) pairs.push({ sender, receiver, shaped: false, shortfall: U_A - D_B,
      allowance: T, closes, cancels: cancels.length });
  }
  return { check: 'conservation', passed: failures.length === 0, failures, exercised: true,
    toleranceRefusals, ...(shapedPairs ? { pairs } : {}) };
}

export function computePeerChecks(input = {}, tolerances = {}, pairing = pairResponseEvidence(input)) {
  const bars = { ...(input.condition?.bars ?? {}), ...tolerances };
  return [
    responseAgreement(input, bars, pairing),
    segmentSum(input, pairing),
    peerIdMembership(input),
    conservation(input, bars),
  ];
}
