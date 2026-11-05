// Pure arithmetic for retained measurement streams.

import { median, percentile } from '../../public/lib/frame-drift.mjs';
import { computeReceiptCohort } from './receipt-cohort.mjs';
import { computePeerFigures, PEER_ATTEMPT_COHORT_METHOD } from './peer-figures.mjs';
import { computePeerChecks, pairResponseEvidence } from './peer-checks.mjs';
import { peerSpacing } from './peer-spacing.mjs';
import { computeNoP2pSteady } from './nop2p-steady.mjs';
import { distanceBehindRows } from './distance-behind.mjs';
import { rosterEventReading } from './roster-event.mjs';
import { aheadForGood, doubleStalls } from './ahead-for-good.mjs';
import { riseRecovery } from './rise-recovery.mjs';
import { settledDrift } from './settled-drift.mjs';
import { removesMember } from '../harness/roster-kinds.mjs';
import { countedRealtimeFactor, notPresenting } from '../harness/not-presenting.mjs';

export const PEER_FRACTION_ABS_MAX = 0.02;

const finite = (value) => Number.isFinite(value);
const present = (value) => value !== undefined && value !== null;
const numberOr = (value, fallback = undefined) => (finite(value) ? value : fallback);

function peerRecordsByKind(clients, kind) {
  return Object.fromEntries(Object.entries(clients ?? {}).map(([tag, client]) => [tag,
    Array.isArray(client?.peerRecords) ? client.peerRecords.filter((record) => record?.kind === kind) : undefined]));
}

/** Dispatch the two churn readers after the retained streams have been loaded. */
export function computeHarnessFigureKinds(input = {}) {
  const kinds = input.condition?.figureKinds ?? [];
  const clients = input.clients ?? {};
  const byClient = (field) => Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, client?.[field]]));
  const result = {};
  if (kinds.includes('roster-event')) {
    result.rosterEvent = rosterEventReading({ condition: input.condition, event: input.rosterEvent,
      presence: input.presence, drift: byClient('records'),
      polls: { ...input.viewerPolls, host: input.hostPoll }, attempts: peerRecordsByKind(clients, 'attempt'),
      segments: peerRecordsByKind(clients, 'segment'), asks: input.asks, timebase: input.timebase,
      content: input.content, pagePolls: byClient('polls'), starts: byClient('starts'), window: input.window,
      seek: input.seek, capacitySchedule: input.capacitySchedule });
  }
  if (kinds.includes('rise-recovery')) result.riseRecovery = riseRecovery({ ...input, rosterReading: result.rosterEvent });
  if (kinds.includes('ahead-for-good')) {
    const tags = input.declaredClientTags ?? Object.keys(clients);
    const ahead = aheadForGood({ condition: input.condition, tags, window: input.window, event: null,
      seek: input.seek, capacitySchedule: input.capacitySchedule, drift: byClient('records'),
      polls: { ...input.viewerPolls, host: input.hostPoll }, pagePolls: byClient('polls'), timebase: input.timebase });
    result.aheadForGood = ahead;
    result.doubleStalls = { row: 'double-stalls', status: 'published', byClient: doubleStalls({
      drift: byClient('records'), polls: { ...input.viewerPolls, host: input.hostPoll }, tags,
      fromMs: ahead.readySharedMs ?? -Infinity, toMs: ahead.endSharedMs ?? Infinity,
      aheadForGoodAtSharedMs: ahead.aheadForGoodAtSharedMs }) };
  }
  if (kinds.includes('settled-drift')) {
    result.settledDrift = settledDrift({ tags: input.declaredClientTags ?? Object.keys(clients), window: input.window,
      timebase: input.timebase, drift: byClient('records'), pagePolls: byClient('polls'), hostPoll: input.hostPoll,
      gapMs: input.condition?.churn?.stall?.gapMs ?? 250 });
  }
  if (kinds.includes('distance-behind')) {
    // No recovered instant: a viewer with no drift stream is why, and is named.
    const streamless = Object.entries(clients).filter(([, client]) => !Array.isArray(client?.records))
      .map(([tag]) => tag);
    result.distanceBehind = finite(input.distanceBehindAtMs)
      ? distanceBehindRows({ condition: input.condition, clients: input.clients, viewerPolls: input.viewerPolls,
        pagePolls: byClient('polls'), hostPoll: input.hostPoll,
        capacitySchedule: input.capacitySchedule, timebase: input.timebase, atMs: input.distanceBehindAtMs })
      : streamless.length ? { status: 'evidence-failure', rows: [], reason: 'drift-stream-missing', clients: streamless }
        : { status: input.distanceBehindUnavailableReason === 'timebase-offset-missing' ? 'evidence-failure' : 'not-exercised',
          rows: [], reason: input.distanceBehindUnavailableReason ?? 'recovery-unavailable' };
  }
  return result;
}

function difference(after, before, field) {
  const right = Number(after?.[field] ?? 0);
  const left = Number(before?.[field] ?? 0);
  if (!finite(right) || !finite(left) || right < left) throw new Error(`counter ${field} is not monotonic`);
  return right - left;
}

function pathDifference(after, before, path) {
  const current = after?.byPath?.[path] ?? {};
  const prior = before?.byPath?.[path] ?? {};
  return {
    hits: difference(current, prior, 'hits'),
    completedHits: difference(current, prior, 'completedHits'),
    bytesDelivered: difference(current, prior, 'bytesDelivered'),
    expectedBytes: difference(current, prior, 'expectedBytes'),
  };
}

function originWindow(start, end) {
  if (!start || !end) return { byClient: {} };
  const paths = new Set([...Object.keys(start?.byPath ?? {}), ...Object.keys(end?.byPath ?? {})]);
  let segmentBytesDeliveredInWindow = 0;
  let mediaBytesDeliveredInWindow = difference(end, start, 'mediaBytesDelivered');
  let abortedMediaBytesDeliveredInWindow = difference(end, start, 'abortedMediaBytesDelivered');
  let segmentHitsInWindow = 0;
  let distinctSegmentsCompletedInWindow = 0;
  let distinctSegmentsPartialOnlyInWindow = 0;
  const completedSegmentSizes = [];

  for (const path of paths) {
    const delta = pathDifference(end, start, path);
    const isSegment = path.startsWith('/media/') && path.endsWith('.m4s');
    if (!isSegment) continue;
    segmentBytesDeliveredInWindow += delta.bytesDelivered;
    segmentHitsInWindow += delta.hits;
    if (delta.completedHits > 0) {
      distinctSegmentsCompletedInWindow += 1;
      const size = delta.hits > 0 ? delta.expectedBytes / delta.hits : NaN;
      if (!finite(size) || size < 0) throw new Error(`segment ${path} has no finite size`);
      completedSegmentSizes.push(size);
    } else if (delta.hits > 0) {
      distinctSegmentsPartialOnlyInWindow += 1;
    }
  }

  const distinctSegmentBytesConsumedInWindow = completedSegmentSizes.reduce((sum, size) => sum + size, 0);
  return {
    mediaBytesDeliveredInWindow,
    abortedMediaBytesDeliveredInWindow,
    segmentBytesDeliveredInWindow,
    distinctSegmentBytesConsumedInWindow,
    distinctSegmentsCompletedInWindow,
    distinctSegmentsPartialOnlyInWindow,
    segmentHitsInWindow,
    originWasteFraction: mediaBytesDeliveredInWindow > 0
      ? abortedMediaBytesDeliveredInWindow / mediaBytesDeliveredInWindow
      : undefined,
    byClient: clientDeltas(start, end),
  };
}

function clientDeltas(start, end) {
  const tags = new Set([...Object.keys(start?.byClient ?? {}), ...Object.keys(end?.byClient ?? {})]);
  return Object.fromEntries([...tags].map((tag) => [tag, {
    mediaBytesDelivered: difference(end?.byClient?.[tag], start?.byClient?.[tag], 'mediaBytesDelivered'),
    abortedMediaBytesDelivered: difference(end?.byClient?.[tag], start?.byClient?.[tag], 'abortedMediaBytesDelivered'),
    segmentBytesDelivered: difference(end?.byClient?.[tag], start?.byClient?.[tag], 'segmentBytesDelivered'),
    initBytesDelivered: difference(end?.byClient?.[tag], start?.byClient?.[tag], 'initBytesDelivered'),
  }]));
}

function tagsFrom(input, clients) {
  return input.declaredClientTags
    ?? input.clientTags
    ?? input.context?.declaredClientTags
    ?? Object.keys(clients);
}

function eventTime(record) {
  return record?.displaySharedMs ?? record?.atMs ?? record?.endMs ?? record?.t4 ?? record?.at;
}

function recordsInWindow(records, window) {
  const source = Array.isArray(records) ? records : [];
  if (!window || !finite(window.startMs) || !finite(window.endMs)) return source;
  return source.filter((record) => {
    const at = eventTime(record);
    return present(at) && at >= window.startMs && at <= window.endMs;
  });
}

function recordsFor(client, window) {
  return recordsInWindow(client.records, window)
    .filter((record) => record && typeof record === 'object');
}

function pollsFor(client, window) {
  return recordsInWindow(client.polls, window)
    .filter((record) => record && typeof record === 'object');
}

function mediaPath(url) {
  return String(url ?? '').split(/[?#]/, 1)[0];
}

function isMediaRequest(request) {
  return /\/media\/.*\.(?:m4s|mp4)$/i.test(mediaPath(request?.url));
}

function requestRecordsFor(client, window) {
  const requests = client.requests ?? client.requestRecords;
  if (!Array.isArray(requests) || !finite(window?.startMs) || !finite(window?.endMs)
    || client.requestTimebase !== 'measure-window') return undefined;
  return requests.filter((request) => {
    const at = request?.endMs ?? request?.eventMs ?? request?.atMs;
    return finite(at) && at >= window.startMs && at <= window.endMs;
  });
}

function clientMediaBytes(client, window) {
  const requests = requestRecordsFor(client, window);
  if (!requests) return undefined;
  let completedBytes = 0;
  let canceledBytes = 0;
  let canceledCount = 0;
  for (const request of requests) {
    if (!isMediaRequest(request) || !finite(request.bodyBytes) || request.bodyBytes < 0) continue;
    if (request.canceled === true) {
      canceledBytes += request.bodyBytes;
      canceledCount += 1;
    } else if (request.finished === true) {
      completedBytes += request.bodyBytes;
    }
  }
  return { completedBytes, canceledBytes, canceledCount };
}

function presentedFrames(records) {
  const values = records.map((record) => record.presentedFrames).filter(finite);
  return values.length ? values.at(-1) : undefined;
}

function cumulativeDelta(records, read) {
  if (records.length < 2) return undefined;
  const values = records.map(read);
  if (values.some((value) => !finite(value))) return undefined;
  const delta = values.at(-1) - values[0];
  if (delta < 0) throw new Error('poll counter is not monotonic');
  return delta;
}

function qualityCounter(records, name) {
  return cumulativeDelta(records, (record) => record.quality?.[name]);
}

function stallCount(records) {
  if (records.some((record) => !present(record.stalls?.epoch))
    || new Set(records.map((record) => record.stalls.epoch)).size !== 1) return undefined;
  return cumulativeDelta(records, (record) => record.stalls?.count);
}

function droppedFrames(records) {
  return qualityCounter(records, 'droppedVideoFrames');
}

function frameQualityFactor(polls, window, content) {
  const fps = content?.frameRate;
  const frames = qualityCounter(polls, 'totalVideoFrames');
  const seconds = window && finite(window.startMs) && finite(window.endMs)
    ? (window.endMs - window.startMs) / 1000
    : undefined;
  return finite(fps) && fps > 0 && finite(frames) && finite(seconds) && seconds > 0
    ? frames / (fps * seconds)
    : undefined;
}

// One client's entry in each `…ByClient` figure, keyed by the figure's name.
// A figure the client's evidence cannot support is left out.
function clientFigures(tag, client, origin, window, content, receipt, { bytes = true } = {}) {
  const records = recordsFor(client, window);
  const polls = pollsFor(client, window);
  const result = {};
  const originBucket = origin.byClient[tag];
  const originBytes = numberOr(originBucket?.mediaBytesDelivered);
  const originWaste = numberOr(originBucket?.abortedMediaBytesDelivered);
  const originCompletedBytes = receipt ? receipt.originCompletedBytes
    : finite(originBytes) && finite(originWaste) ? originBytes - originWaste : undefined;
  const clientBytes = clientMediaBytes(client, window);
  const receivedCompletedBytes = receipt ? receipt.clientCompletedBytes : numberOr(clientBytes?.completedBytes);
  const receivedAbortedBytes = numberOr(clientBytes?.canceledBytes);

  if (bytes && finite(originCompletedBytes) && finite(receivedCompletedBytes) && receivedCompletedBytes > 0) {
    const peerFraction = 1 - originCompletedBytes / receivedCompletedBytes;
    if (peerFraction < -0.10 || peerFraction > 1.0) {
      throw new RangeError(`peerByteFractionByClient[${tag}] physically impossible: ${peerFraction}`);
    }
    result.peerByteFractionByClient = peerFraction;
    result.clientReceivedMediaBytesByClient = receivedCompletedBytes;
    result.originMediaBytesByClient = originCompletedBytes;
    result.originVsClientBytesByClient = {
      differenceBytes: originCompletedBytes - receivedCompletedBytes,
      differenceFraction: (originCompletedBytes - receivedCompletedBytes) / receivedCompletedBytes,
    };
  }
  if (finite(originWaste) && finite(receivedAbortedBytes) && (originWaste > 0 || clientBytes?.canceledCount > 0)) {
    result.abortedQueuedResidualBytesByClient = originWaste - receivedAbortedBytes;
  }

  if (records.length >= 2) {
    const first = records[0];
    const last = records.at(-1);
    const displayAdvance = last.displaySharedMs - first.displaySharedMs;
    if (finite(displayAdvance) && displayAdvance > 0 && finite(last.mediaMs) && finite(first.mediaMs)) {
      result.realtimeFactorByClient = (last.mediaMs - first.mediaMs) / displayAdvance;
    }
  }
  const presentation = notPresenting(client.polls, window);
  // A counted viewer's frame-quality factor does not need two records.
  if (records.length >= 2 || presentation.counted) {
    const fromFrameQuality = frameQualityFactor(polls, window, content);
    if (finite(fromFrameQuality)) result.realtimeFactorFromFrameQualityByClient = fromFrameQuality;
  }
  if (presentation.counted) {
    result.realtimeFactorByClient = countedRealtimeFactor(records, window);
    result.noFrameMsByClient = presentation.noFrameMs;
  }
  const stalls = stallCount(polls);
  if (finite(stalls)) result.stallCountByClient = stalls;
  const presented = presentedFrames(records);
  if (finite(presented)) result.presentedFramesByClient = presented;
  const firstPresented = records[0]?.presentedFrames;
  const presentedSpan = finite(firstPresented) && finite(presented) ? presented - firstPresented + 1 : undefined;
  if (finite(presentedSpan) && presentedSpan > 0) result.coverageRatioByClient = records.length / presentedSpan;
  const dropped = droppedFrames(polls);
  const total = qualityCounter(polls, 'totalVideoFrames');
  if (finite(dropped) && finite(total) && total > 0) {
    result.droppedFrameFractionByClient = dropped / total;
  }

  return {
    ...result,
    ...pollFigures(polls),
    ...clockFigures(polls),
    ...echoFigures(echoRecordsInWindow(client.echoRecords, window)),
  };
}

// An echo probe is placed by its send instant: a lost probe has no t4, and
// placing by eventTime dropped every one of them.
function echoRecordsInWindow(records, window) {
  const source = Array.isArray(records) ? records : [];
  if (!window || !finite(window.startMs) || !finite(window.endMs)) return source;
  return source.filter((record) => finite(record?.t1) && record.t1 >= window.startMs && record.t1 <= window.endMs);
}

function percentileFields(values, prefix) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return {};
  return {
    [`${prefix}P50ByClient`]: median(sorted),
    [`${prefix}P95ByClient`]: percentile(sorted, 0.95),
    [`${prefix}P99ByClient`]: percentile(sorted, 0.99),
  };
}

function lossFraction(lost, issued) {
  return finite(issued) && issued > 0 && finite(lost) ? lost / issued : undefined;
}

function pollFigures(polls) {
  const samples = polls.map((sample) => ({
    atMs: sample.atMs ?? sample.at ?? sample.timeMs,
    polls: sample.polls ?? sample.controller?.polls,
  })).filter((sample) => finite(sample.polls));
  if (!samples.length) return {};
  const skips = samples.slice(1).reduce((sum, sample, index) => sum + Math.max(0, sample.polls - samples[index].polls - 1), 0);
  const intervals = samples.slice(1).map((sample, index) => sample.atMs - samples[index].atMs).filter((value) => finite(value) && value > 0);
  return {
    evaluationSkipsByClient: skips,
    ...(intervals.length ? {
      pollIntervalMsP50: median([...intervals].sort((a, b) => a - b)),
      pollIntervalMsP95: percentile([...intervals].sort((a, b) => a - b), 0.95),
      pollIntervalMsMax: Math.max(...intervals),
    } : {}),
  };
}

function clockFigures(polls) {
  const issued = cumulativeDelta(polls, (poll) => poll.clock?.probes?.issued);
  const lost = cumulativeDelta(polls, (poll) => poll.clock?.counters?.lost);
  return {
    ...percentileFields(polls.map((poll) => poll.clock?.bestDelayMs), 'clockBestDelayMs'),
    clockLossFraction: lossFraction(lost, issued),
  };
}

function echoFigures(records) {
  const roundTrips = records.map((record) => record.roundTripMs ?? record.echoRoundTripMs
    ?? (finite(record.t1) && finite(record.t4) ? record.t4 - record.t1 : undefined));
  const issued = cumulativeDelta(records, (record) => record.probes?.issued ?? record.echo?.probes?.issued);
  const lost = cumulativeDelta(records, (record) => record.counters?.lost ?? record.echo?.counters?.lost);
  // echo-probe.mjs writes a per-probe `lost` flag and no counter; the counters
  // here serve only the legacy fixtures.
  const flagged = records.filter((record) => typeof record.lost === 'boolean');
  return {
    ...percentileFields(roundTrips, 'echoRoundTripMs'),
    echoLossFraction: flagged.length
      ? flagged.filter((record) => record.lost).length / flagged.length
      : lossFraction(lost, issued),
  };
}

function linkFigures(samples, window, capacityBitsPerSecond) {
  const entries = recordsInWindow(samples, window).filter((sample) => finite(sample.txBytes ?? sample.tx_bytes));
  if (entries.length < 2 || !finite(capacityBitsPerSecond) || capacityBitsPerSecond <= 0) return {};
  const first = entries[0];
  const last = entries.at(-1);
  const firstTx = first.txBytes ?? first.tx_bytes;
  const lastTx = last.txBytes ?? last.tx_bytes;
  const firstAt = first.atMs ?? first.at ?? first.timeMs;
  const lastAt = last.atMs ?? last.at ?? last.timeMs;
  const durationMs = lastAt - firstAt;
  if (!(durationMs > 0)) return {};
  const rate = (lastTx - firstTx) * 8 / ((durationMs / 1000) * capacityBitsPerSecond);
  const intervalRates = entries.slice(1).map((entry, index) => {
    const deltaT = (entry.atMs ?? entry.at ?? entry.timeMs) - (entries[index].atMs ?? entries[index].at ?? entries[index].timeMs);
    return deltaT > 0 ? ((entry.txBytes ?? entry.tx_bytes) - (entries[index].txBytes ?? entries[index].tx_bytes)) * 8 / ((deltaT / 1000) * capacityBitsPerSecond) : NaN;
  }).filter(finite);
  const backlogValues = entries.map((entry) => entry.qdisc?.backlogBytes ?? entry.backlogBytes ?? entry.qdiscBacklogBytes);
  if (backlogValues.some((value) => value < 0)) throw new RangeError('qdisc backlog cannot be negative');
  const backlog = backlogValues.filter(finite);
  const qdiscFirst = first.qdisc ?? first;
  const qdiscLast = last.qdisc ?? last;
  const queueFields = backlogValues.every(finite) ? (() => {
    const delays = backlog.map((value) => value * 8 / capacityBitsPerSecond * 1000).sort((a, b) => a - b);
    return {
      qdiscBacklogNonzeroFraction: backlog.filter((value) => value > 0).length / backlog.length,
      qdiscBacklogBytesP99: percentile([...backlog].sort((a, b) => a - b), 0.99),
      standingQueueDelayMsP50NearestRank: percentile(delays, 0.5),
      standingQueueDelayMsP99: percentile(delays, 0.99),
    };
  })() : {};
  return {
    uplinkUtilisationMean: rate,
    uplinkUtilisationPeak: intervalRates.length ? Math.max(...intervalRates) : rate,
    capacityBitsPerSecond,
    ...(backlog.length ? { qdiscBacklogBytesMean: backlog.reduce((sum, value) => sum + value, 0) / backlog.length, qdiscBacklogBytesPeak: Math.max(...backlog) } : {}),
    ...queueFields,
    qdiscDropsInWindow: difference(qdiscLast, qdiscFirst, 'drops'),
    qdiscOverlimitsInWindow: difference(qdiscLast, qdiscFirst, 'overlimits'),
  };
}

export function computeFigures(input = {}) {
  const window = input.window;
  const originEnd = input.originEnd ?? input.origin?.end;
  const origin = originWindow(input.originStart ?? input.origin?.start, originEnd);
  const clients = input.clients ?? {};
  const tags = tagsFrom(input, clients);
  const method = input.byteAccountingMethod ?? input.context?.byteAccountingMethod;
  if (method === PEER_ATTEMPT_COHORT_METHOD) return computePeerRunFigures(input);
  if (method !== undefined && method !== null && method !== 'client-receipt-cohort-v1') {
    throw new Error(`unknown byte accounting method: ${method}`);
  }
  if (originEnd?.responseAccountingVersion === 2 && method == null) {
    throw new Error('version-2 origin evidence requires an explicitly declared byte accounting method');
  }
  const cohort = method != null
    ? computeReceiptCohort({ clients, declaredClientTags: tags, window, originEnd })
    : null;
  const distinctBytes = cohort?.distinctSegmentBytesConsumedInWindow ?? origin.distinctSegmentBytesConsumedInWindow;
  const { byClient: _byClient, segmentBytesDeliveredInWindow, ...originFigures } = origin;
  const result = {
    ...originFigures,
    ...(cohort ? {
      byteAccountingMethod: cohort.method,
      distinctSegmentBytesConsumedInWindow: distinctBytes,
      distinctSegmentsCompletedInWindow: cohort.distinctSegmentsCompletedInWindow,
      completedResponseCohortByClient: cohort.byClient,
    } : {}),
    originSegmentBytesDeliveredInWindow: segmentBytesDeliveredInWindow,
    hostUploadMultiplier: distinctBytes > 0
      ? segmentBytesDeliveredInWindow / distinctBytes
      : undefined,
    peerByteFractionByClient: {},
    originVsClientBytesByClient: {},
    abortedQueuedResidualBytesByClient: {},
    realtimeFactorByClient: {},
    realtimeFactorFromFrameQualityByClient: {},
    noFrameMsByClient: {},
    stallCountByClient: {},
    droppedFrameFractionByClient: {},
    presentedFramesByClient: {},
    coverageRatioByClient: {},
    evaluationSkipsByClient: {},
    pollIntervalMsP50: {},
    pollIntervalMsP95: {},
    pollIntervalMsMax: {},
    clockBestDelayMsP50ByClient: {},
    clockBestDelayMsP95ByClient: {},
    clockBestDelayMsP99ByClient: {},
    clockLossFraction: {},
    echoRoundTripMsP50ByClient: {},
    echoRoundTripMsP95ByClient: {},
    echoRoundTripMsP99ByClient: {},
    echoLossFraction: {},
  };

  for (const tag of tags) {
    const figures = clientFigures(tag, clients[tag] ?? {}, origin, window, input.content, cohort?.byClient[tag],
      { bytes: input.auxiliaryOnly !== true });
    for (const [name, value] of Object.entries(figures)) {
      if (value !== undefined) (result[name] ??= {})[tag] = value;
    }
  }

  Object.assign(result, linkFigures(input.linkSamples ?? input.utilisation?.samples ?? [], window, input.capacityBitsPerSecond ?? input.condition?.capacityBitsPerSecond));
  // The receipt cohort is the no-P2P arm's; the peer arm's one viewing is peer-figures.mjs's.
  if (input.multiplierDenominator === 'one-viewing' && cohort) {
    const tagsForSteady = tagsFrom(input, clients);
    const offsets = input.condition?.positionOffsetMsByClient ?? input.declaredOffsetMsByClient ?? {};
    const steady = computeNoP2pSteady({ input, figures: result, tags: tagsForSteady, offsets });
    result.multiplierDenominator = 'one-viewing';
    if (steady.unavailable) {
      delete result.hostUploadMultiplier;
      result.hostUploadMultiplierRefusal = {
        reason: 'one-viewing-unavailable',
        detail: steady.unavailable,
      };
    } else {
      result.oneViewingBytesInWindow = steady.oneViewingBytesInWindow;
      result.roomPositionSpreadMs = steady.roomPositionSpreadMs;
      result.steadyState = steady.steadyState;
      if (steady.steadyState.steady) {
        result.hostUploadMultiplier = segmentBytesDeliveredInWindow / steady.oneViewingBytesInWindow;
      } else {
        delete result.hostUploadMultiplier;
        result.hostUploadMultiplierRefusal = {
          reason: steady.steadyState.reason,
          failedLegs: Object.entries(steady.steadyState.legs)
            .filter(([, leg]) => leg.pass !== true)
            .map(([leg, value]) => ({ leg, value })),
          legs: steady.steadyState.legs,
        };
      }
    }
  }
  const disagreements = tags.filter((tag) => finite(result.realtimeFactorByClient[tag]) && finite(result.realtimeFactorFromFrameQualityByClient[tag])
    && Math.abs(result.realtimeFactorByClient[tag] - result.realtimeFactorFromFrameQualityByClient[tag]) > 0.05);
  if (disagreements.length) result.realtimeFactorDisagreement = disagreements;
  return stripUnavailable(result);
}

const PEER_AUXILIARY_FIELDS = [
  'realtimeFactorByClient', 'realtimeFactorFromFrameQualityByClient', 'stallCountByClient',
  'noFrameMsByClient',
  'droppedFrameFractionByClient', 'presentedFramesByClient', 'coverageRatioByClient',
  'evaluationSkipsByClient', 'pollIntervalMsP50', 'pollIntervalMsP95', 'pollIntervalMsMax',
  'clockBestDelayMsP50ByClient', 'clockBestDelayMsP95ByClient', 'clockBestDelayMsP99ByClient',
  'clockLossFraction', 'echoRoundTripMsP50ByClient', 'echoRoundTripMsP95ByClient',
  'echoRoundTripMsP99ByClient', 'echoLossFraction', 'uplinkUtilisationMean',
  'uplinkUtilisationPeak', 'capacityBitsPerSecond', 'qdiscBacklogBytesMean',
  'qdiscBacklogBytesPeak', 'qdiscDropsInWindow', 'qdiscOverlimitsInWindow',
  'qdiscBacklogNonzeroFraction', 'qdiscBacklogBytesP99', 'standingQueueDelayMsP50NearestRank',
  'standingQueueDelayMsP99',
];

function withoutVersion(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.counters) return { ...value, counters: { ...value.counters, responseAccountingVersion: undefined } };
  return { ...value, responseAccountingVersion: undefined };
}

function peerAuxiliaryFigures(input) {
  const context = input.context ? { ...input.context, byteAccountingMethod: undefined } : undefined;
  // The legacy byte columns are discarded here, so their guards must not abort a peer run.
  const legacy = computeFigures({ ...input, byteAccountingMethod: undefined, context, auxiliaryOnly: true,
    originEnd: withoutVersion(input.originEnd ?? input.origin?.end) });
  return Object.fromEntries(PEER_AUXILIARY_FIELDS
    .filter((field) => legacy[field] !== undefined).map((field) => [field, legacy[field]]));
}

/**
 * The room a leave left behind. The member it removed is in neither boundary, so the
 * peer checks are made among the others, with its peer id still a member's.
 */
export function remainingRoom(input = {}) {
  const departed = removesMember(input.condition?.rosterEvent?.kind) ? input.rosterEvent?.client : null;
  if (typeof departed !== 'string') return input;
  const tags = tagsFrom(input, input.clients ?? {}).filter((tag) => tag !== departed);
  const { [departed]: gone, ...clients } = input.clients ?? {};
  const peerId = input.context?.clients?.[departed]?.peerId;
  return { ...input, declaredClientTags: tags, clientTags: tags, clients,
    departedPeerIds: typeof peerId === 'string' ? [peerId] : [] };
}

function computePeerRunFigures(input) {
  const pairing = pairResponseEvidence(input);
  const auxiliary = peerAuxiliaryFigures(input);
  const room = remainingRoom(input);
  const figures = computePeerFigures({ ...room,
    uplinkUtilisationMean: auxiliary.uplinkUtilisationMean,
    realtimeFactorByClient: auxiliary.realtimeFactorByClient,
  }, pairing);
  const checks = computePeerChecks(room, input.condition?.bars ?? {}, pairing);
  const toleranceReasons = checks.flatMap((check) => check.toleranceRefusals ?? [])
    .map(() => 'peer-conservation-tolerance-unbounded');
  const spacing = peerSpacing({ clients: input.clients, tags: tagsFrom(input, input.clients ?? {}),
    condition: input.condition, window: input.window });
  const result = { ...auxiliary, ...figures, ...spacing, peerChecks: checks,
    peerRefusalReasons: [...(figures.peerRefusalReasons ?? []), ...toleranceReasons] };
  // A peer run still has the ordinary quality/drift figures, but no legacy byte columns.
  return stripUnavailable(result);
}

function stripUnavailable(value) {
  if (Array.isArray(value)) return value.map(stripUnavailable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, stripUnavailable(entry)]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function regimeKey(regime) {
  return JSON.stringify(canonical(regime ?? {}));
}

export function guardRegimes(runs) {
  const entries = (runs ?? []).map((run, index) => ({
    name: run.condition?.name ?? run.context?.condition?.name ?? run.name ?? `run-${index + 1}`,
    key: regimeKey(run.regime ?? run.context?.regime ?? run.condition ?? run.context),
  }));
  const groups = new Map();
  for (const entry of entries) groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry.name]);
  if (groups.size <= 1) return { combined: true, key: entries[0]?.key ?? regimeKey({}), conditions: entries.map((entry) => entry.name) };
  const conditions = entries.map((entry) => entry.name);
  return { combined: false, refused: true, reason: `regime-mismatch:${conditions.join(' vs ')}`, conditions, keys: [...groups.keys()] };
}
