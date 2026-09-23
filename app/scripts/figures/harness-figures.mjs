// Pure arithmetic for retained measurement streams.

import { median, percentile } from '../../public/lib/frame-drift.mjs';
import { computeReceiptCohort } from './receipt-cohort.mjs';

export const PEER_FRACTION_ABS_MAX = 0.02;

const finite = (value) => Number.isFinite(value);
const present = (value) => value !== undefined && value !== null;
const numberOr = (value, fallback = undefined) => (finite(value) ? value : fallback);

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
  return recordsInWindow(client.records ?? client.driftRecords, window)
    .filter((record) => record && typeof record === 'object');
}

function pollsFor(client, window) {
  return recordsInWindow(client.polls ?? client.pollRecords ?? client.controllerPolls, window)
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
  return cumulativeDelta(records, (record) => record.quality?.[name] ?? record.videoQuality?.[name]);
}

function stallCount(records) {
  if (records.some((record) => !present(record.stalls?.epoch))
    || new Set(records.map((record) => record.stalls.epoch)).size !== 1) return undefined;
  return cumulativeDelta(records, (record) => record.stalls?.count);
}

function droppedFrames(records) {
  return qualityCounter(records, 'droppedVideoFrames');
}

function clientFigures(tag, client, origin, window, content, receipt) {
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

  if (finite(originCompletedBytes) && finite(receivedCompletedBytes) && receivedCompletedBytes > 0) {
    const peerFraction = 1 - originCompletedBytes / receivedCompletedBytes;
    if (peerFraction < -0.10 || peerFraction > 1.0) {
      throw new RangeError(`peerByteFractionByClient[${tag}] physically impossible: ${peerFraction}`);
    }
    result.peerFraction = peerFraction;
    result.receivedMediaBytes = receivedCompletedBytes;
    result.originMediaBytes = originCompletedBytes;
    result.originVsClient = {
      differenceBytes: originCompletedBytes - receivedCompletedBytes,
      differenceFraction: (originCompletedBytes - receivedCompletedBytes) / receivedCompletedBytes,
    };
  }
  if (finite(originWaste) && finite(receivedAbortedBytes) && (originWaste > 0 || clientBytes?.canceledCount > 0)) {
    result.abortedQueuedResidualBytes = originWaste - receivedAbortedBytes;
  }

  if (records.length >= 2) {
    const first = records[0];
    const last = records.at(-1);
    const displayAdvance = last.displaySharedMs - first.displaySharedMs;
    if (finite(displayAdvance) && displayAdvance > 0 && finite(last.mediaMs) && finite(first.mediaMs)) {
      result.realtimeFactor = (last.mediaMs - first.mediaMs) / displayAdvance;
    }
    const fps = content?.frameRate ?? content?.fps;
    const frames = qualityCounter(polls, 'totalVideoFrames');
    const seconds = window && finite(window.startMs) && finite(window.endMs)
      ? (window.endMs - window.startMs) / 1000
      : undefined;
    if (finite(fps) && fps > 0 && finite(frames) && finite(seconds) && seconds > 0) {
      result.realtimeFactorFromFrameQuality = frames / (fps * seconds);
    }
  }
  const stalls = stallCount(polls);
  if (finite(stalls)) result.stallCount = stalls;
  const presented = presentedFrames(records);
  if (finite(presented)) result.presentedFrames = presented;
  const firstPresented = records[0]?.presentedFrames;
  const presentedSpan = finite(firstPresented) && finite(presented) ? presented - firstPresented + 1 : undefined;
  if (finite(presentedSpan) && presentedSpan > 0) result.coverageRatio = records.length / presentedSpan;
  const dropped = droppedFrames(polls);
  const total = qualityCounter(polls, 'totalVideoFrames');
  if (finite(dropped) && finite(total) && total > 0) {
    result.droppedFrameFraction = dropped / total;
  }

  return { result, records, polls };
}

function pollSamples(client, window) {
  const source = client.polls ?? client.pollRecords ?? client.controllerPolls ?? [];
  return recordsInWindow(source, window).map((sample) => ({
    atMs: sample?.atMs ?? sample?.at ?? sample?.timeMs,
    polls: typeof sample === 'number' ? sample : sample?.polls ?? sample?.controller?.polls,
  })).filter((sample) => finite(sample.polls));
}

function percentileFields(values, prefix) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return {};
  return {
    [`${prefix}P50`]: median(sorted),
    [`${prefix}P95`]: percentile(sorted, 0.95),
    [`${prefix}P99`]: percentile(sorted, 0.99),
  };
}

function perClientPollFigures(client, window) {
  const samples = pollSamples(client, window);
  if (!samples.length) return {};
  const skips = samples.slice(1).reduce((sum, sample, index) => sum + Math.max(0, sample.polls - samples[index].polls - 1), 0);
  const intervals = samples.slice(1).map((sample, index) => sample.atMs - samples[index].atMs).filter((value) => finite(value) && value > 0);
  return {
    evaluationSkips: skips,
    ...(intervals.length ? {
      pollIntervalMsP50: median([...intervals].sort((a, b) => a - b)),
      pollIntervalMsP95: percentile([...intervals].sort((a, b) => a - b), 0.95),
      pollIntervalMsMax: Math.max(...intervals),
    } : {}),
  };
}

function clientProbeFigures(records, prefix) {
  const values = records.map((record) => prefix === 'clockBestDelayMs'
    ? record.clock?.bestDelayMs
    : record.roundTripMs ?? record.echoRoundTripMs ?? (finite(record.t1) && finite(record.t4) ? record.t4 - record.t1 : undefined)).filter(finite);
  const result = percentileFields(values, prefix);
  const issued = cumulativeDelta(records, (record) => prefix.startsWith('clock')
    ? record.clock?.probes?.issued
    : record.probes?.issued ?? record.echo?.probes?.issued);
  const lost = cumulativeDelta(records, (record) => prefix.startsWith('clock')
    ? record.clock?.counters?.lost
    : record.counters?.lost ?? record.echo?.counters?.lost);
  // echo-probe.mjs marks each sample lost or not and publishes no cumulative
  // counter, so reading one here left echoLossFraction empty on every real run
  // while the fixture's manufactured counters kept the field green.
  const flagged = prefix.startsWith('clock') ? [] : records.filter((record) => typeof record.lost === 'boolean');
  if (flagged.length) result.echoLossFraction = flagged.filter((record) => record.lost).length / flagged.length;
  else if (finite(issued) && issued > 0 && finite(lost)) result[`${prefix.startsWith('clock') ? 'clock' : 'echo'}LossFraction`] = lost / issued;
  return result;
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
  const { byClient: originByClient, segmentBytesDeliveredInWindow, ...originFigures } = origin;
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
    const client = clients[tag] ?? {};
    const { result: figures, polls } = clientFigures(tag, client, { ...origin, byClient: originByClient }, window, input.content, cohort?.byClient[tag]);
    if (finite(figures.peerFraction)) result.peerByteFractionByClient[tag] = figures.peerFraction;
    if (finite(figures.receivedMediaBytes)) result.clientReceivedMediaBytesByClient ??= {};
    if (finite(figures.receivedMediaBytes)) result.clientReceivedMediaBytesByClient[tag] = figures.receivedMediaBytes;
    if (finite(figures.originMediaBytes)) result.originMediaBytesByClient ??= {};
    if (finite(figures.originMediaBytes)) result.originMediaBytesByClient[tag] = figures.originMediaBytes;
    if (figures.originVsClient) result.originVsClientBytesByClient[tag] = figures.originVsClient;
    if (finite(figures.abortedQueuedResidualBytes)) result.abortedQueuedResidualBytesByClient[tag] = figures.abortedQueuedResidualBytes;
    if (finite(figures.realtimeFactor)) result.realtimeFactorByClient[tag] = figures.realtimeFactor;
    if (finite(figures.realtimeFactorFromFrameQuality)) result.realtimeFactorFromFrameQualityByClient[tag] = figures.realtimeFactorFromFrameQuality;
    if (finite(figures.stallCount)) result.stallCountByClient[tag] = figures.stallCount;
    if (finite(figures.droppedFrameFraction)) result.droppedFrameFractionByClient[tag] = figures.droppedFrameFraction;
    if (finite(figures.presentedFrames)) result.presentedFramesByClient[tag] = figures.presentedFrames;
    if (finite(figures.coverageRatio)) result.coverageRatioByClient[tag] = figures.coverageRatio;
    const poll = perClientPollFigures(client, window);
    for (const [name, value] of Object.entries(poll)) if (finite(value)) {
      if (name === 'evaluationSkips') result.evaluationSkipsByClient[tag] = value;
      if (name.startsWith('pollInterval')) result[name][tag] = value;
    }
    const clock = clientProbeFigures(polls, 'clockBestDelayMs');
    const echo = clientProbeFigures(recordsInWindow(client.echoRecords, window), 'echoRoundTripMs');
    for (const [name, value] of Object.entries(clock)) if (finite(value)) {
      if (name.startsWith('clockBestDelayMs')) result[`${name}ByClient`][tag] = value;
      if (name === 'clockLossFraction') result.clockLossFraction[tag] = value;
    }
    for (const [name, value] of Object.entries(echo)) if (finite(value)) {
      if (name.startsWith('echoRoundTripMs')) result[`${name}ByClient`][tag] = value;
      if (name === 'echoLossFraction') result.echoLossFraction[tag] = value;
    }
  }

  Object.assign(result, linkFigures(input.linkSamples ?? input.utilisation?.samples ?? [], window, input.capacityBitsPerSecond ?? input.condition?.capacityBitsPerSecond));
  const disagreements = tags.filter((tag) => finite(result.realtimeFactorByClient[tag]) && finite(result.realtimeFactorFromFrameQualityByClient[tag])
    && Math.abs(result.realtimeFactorByClient[tag] - result.realtimeFactorFromFrameQualityByClient[tag]) > 0.05);
  if (disagreements.length) result.realtimeFactorDisagreement = disagreements;
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

export function regimeKey(regime) {
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

export function combineRuns(runs) {
  const guard = guardRegimes(runs);
  if (!guard.combined) throw new Error(guard.reason);
  return runs.length === 1 ? computeFigures(runs[0]) : { runs: runs.map(computeFigures), regime: guard.key };
}

export { median, percentile };
