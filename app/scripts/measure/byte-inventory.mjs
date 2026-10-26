import { labInstant } from './lab-position.mjs';

const finite = (value) => Number.isFinite(value);
const LIMIT_BYTES = 4_294_967_296;
const segmentPattern = /seg-(\d+)\.m4s$/;

function refusal(run, detail) {
  return { reader: 'byte-inventory', version: 1, run, refused: true, reason: 'stream-missing', detail };
}

function indexOfPath(path) {
  const match = String(path ?? '').match(segmentPattern);
  return match ? Number(match[1]) : null;
}

function segmentGeometry(content) {
  const durations = Array.isArray(content?.segmentDurations) ? content.segmentDurations : [];
  const starts = [0];
  for (const duration of durations) starts.push(starts.at(-1) + Number(duration) * 1000);
  return { durations, starts };
}

function sizeOf(content, index) {
  return Number.isSafeInteger(index) && Number.isFinite(content?.segmentSizes?.[index]) ? content.segmentSizes[index] : null;
}

function bytesOf(record) {
  return finite(record?.bytes) && record.bytes >= 0 ? record.bytes : 0;
}

function completedByIndex(records, content) {
  const completed = new Map();
  for (const record of records ?? []) {
    if (record?.kind !== 'segment') continue;
    const index = indexOfPath(record.path);
    if (!Number.isSafeInteger(index) || !finite(sizeOf(content, index))) continue;
    const previous = completed.get(index);
    if (!previous || (finite(record.completedAtMs) && record.completedAtMs < previous.completedAtMs)) {
      completed.set(index, { index, record, completedAtMs: record.completedAtMs });
    }
  }
  return completed;
}

function watchedIndexes(drift, geometry) {
  const indexes = new Set();
  let largest = null;
  for (const record of drift ?? []) {
    const mediaMs = record?.mediaMs;
    if (!finite(mediaMs)) continue;
    largest = largest === null ? mediaMs : Math.max(largest, mediaMs);
    const index = geometry.starts.findIndex((start, candidate) => start <= mediaMs
      && (candidate + 1 >= geometry.starts.length || mediaMs < geometry.starts[candidate + 1]));
    if (index >= 0) indexes.add(index);
  }
  return { indexes, largest };
}

function storedSeries(completed, content) {
  const values = [...completed.values()].filter((entry) => finite(entry.completedAtMs)).sort((a, b) => a.completedAtMs - b.completedAtMs);
  if (!values.length) return [];
  const first = values[0].completedAtMs;
  const last = values.at(-1).completedAtMs;
  const boundaries = [];
  for (let atMs = first; atMs <= last; atMs += 60_000) boundaries.push(atMs);
  if (boundaries.at(-1) !== last) boundaries.push(last);
  return boundaries.map((atMs) => ({ atMs, storedBytes: values.filter((entry) => entry.completedAtMs <= atMs)
    .reduce((sum, entry) => sum + sizeOf(content, entry.index), 0) }));
}

function finalFlush(evidence) {
  const window = evidence.manifest?.window;
  const recordingEnd = finite(window?.endMs) ? window.endMs + (evidence.manifest.recordingTailMs ?? 0) : null;
  const viewers = {};
  let unreadable = !finite(recordingEnd);
  for (const tag of evidence.tags) {
    const lastDrift = (evidence.clients[tag]?.drift ?? []).map(labInstant).filter(finite).at(-1);
    // Raw page and harness wall ms: the same lab base as `window.endMs` and `L` (design D3).
    const lastPoll = (evidence.clients[tag]?.polls ?? []).map((poll) => poll?.atMs).filter(finite).at(-1);
    const driftLogMissed = evidence.manifest?.clients?.[tag]?.driftLogMissed;
    const peerLogMissed = evidence.manifest?.clients?.[tag]?.peerLogHealth?.missed ?? null;
    const lag = finite(recordingEnd) && finite(lastDrift) && finite(lastPoll)
      ? { driftMs: recordingEnd - lastDrift, pollMs: recordingEnd - lastPoll, ms: Math.max(recordingEnd - lastDrift, recordingEnd - lastPoll) } : null;
    if (!lag || !Number.isSafeInteger(driftLogMissed)) unreadable = true;
    viewers[tag] = { lastDriftMs: lastDrift ?? null, lastPollMs: lastPoll ?? null, lagMs: lag?.ms ?? null,
      driftLogMissed: Number.isSafeInteger(driftLogMissed) ? driftLogMissed : null, peerLogMissed };
  }
  const hostLast = (evidence.hostPoll ?? []).map((poll) => poll?.harnessAfterMs).filter(finite).at(-1);
  const originLast = (evidence.originLink ?? []).map((sample) => sample?.atMs).filter(finite).at(-1);
  const hostLagMs = finite(recordingEnd) && finite(hostLast) ? recordingEnd - hostLast : null;
  const originLagMs = finite(recordingEnd) && finite(originLast) ? recordingEnd - originLast : null;
  if (!finite(hostLagMs) || !finite(originLagMs)) unreadable = true;
  const allGood = !unreadable && Object.values(viewers).every((viewer) => viewer.lagMs <= 1_000
    && viewer.driftLogMissed === 0 && (viewer.peerLogMissed === null || viewer.peerLogMissed === 0))
    && hostLagMs <= 1_000 && originLagMs <= 1_000;
  return { recordingEndMs: recordingEnd, viewers, hostLagMs, originLagMs,
    status: unreadable ? 'unreadable' : allGood ? 'met' : 'failed' };
}

export function byteInventory(evidence) {
  const run = evidence?.run ?? null;
  if (evidence?.content === null) return refusal(run, 'content');
  for (const tag of evidence.tags ?? []) {
    if (evidence.clients[tag]?.peerBytes === null) return refusal(run, `peerBytes:${tag}`);
    if (evidence.clients[tag]?.drift === null) return refusal(run, `drift:${tag}`);
  }
  const content = evidence.content;
  const geometry = segmentGeometry(content);
  const perViewer = {};
  let hostMediaBytes = 0;
  let totalHttp = 0;
  let totalP2p = 0;
  const unionWatched = new Set();
  const allSegments = [];
  const lengthExamples = [];
  const receiptExamples = [];
  for (const tag of evidence.tags) {
    const client = evidence.clients[tag];
    const attempts = (client.peerBytes ?? []).filter((record) => record?.kind === 'attempt');
    const httpAttempts = attempts.filter((record) => record.source === 'http');
    const p2pAttempts = attempts.filter((record) => record.source === 'p2p');
    const httpBytes = httpAttempts.reduce((sum, record) => sum + bytesOf(record), 0);
    const p2pBytes = p2pAttempts.reduce((sum, record) => sum + bytesOf(record), 0);
    hostMediaBytes += httpBytes;
    totalHttp += httpBytes;
    totalP2p += p2pBytes;
    const watched = watchedIndexes(client.drift, geometry);
    for (const index of watched.indexes) unionWatched.add(index);
    const completed = completedByIndex(client.peerBytes, content);
    const storedBytes = [...completed.keys()].reduce((sum, index) => sum + sizeOf(content, index), 0);
    const prefetchLeftBytes = watched.largest === null ? 0 : [...completed.values()]
      .filter((entry) => !watched.indexes.has(entry.index) && geometry.starts[entry.index] >= watched.largest)
      .reduce((sum, entry) => sum + sizeOf(content, entry.index), 0);
    const peerId = evidence.manifest?.clients?.[tag]?.peerId;
    const uploadBytes = typeof peerId === 'string' && peerId.length
      ? evidence.tags.filter((other) => other !== tag).flatMap((other) => (evidence.clients[other]?.peerBytes ?? []))
        .filter((record) => record?.kind === 'attempt' && record.source === 'p2p' && record.peerId === peerId)
        .reduce((sum, record) => sum + bytesOf(record), 0)
      : null;
    const completedRecords = (client.peerBytes ?? []).filter((record) => record?.kind === 'segment');
    for (const record of completedRecords) {
      const index = indexOfPath(record.path);
      const expected = sizeOf(content, index);
      if (finite(expected) && record.lengthBytes !== expected && lengthExamples.length < 10) {
        lengthExamples.push({ tag, path: record.path, index, lengthBytes: record.lengthBytes, expectedBytes: expected });
      }
      if (finite(expected)) allSegments.push({ tag, index, record });
    }
    for (const receipt of client.receipts ?? []) {
      if (receipt?.finished === true && receipt.bodyBytes !== receipt.expectedBytes && receiptExamples.length < 10) {
        receiptExamples.push({ tag, requestId: receipt.requestId ?? null, bodyBytes: receipt.bodyBytes, expectedBytes: receipt.expectedBytes });
      }
    }
    perViewer[tag] = {
      httpBytes, p2pBytes, uploadBytes, ...(uploadBytes === null ? { uploadReason: 'peer-id-missing' } : {}),
      watchedSegments: [...watched.indexes].sort((a, b) => a - b),
      watchedBytes: [...watched.indexes].reduce((sum, index) => sum + (sizeOf(content, index) ?? 0), 0),
      prefetchLeftBytes, storedBytes, storedSeries: storedSeries(completed, content),
      peakStoredBytes: storedBytes < LIMIT_BYTES ? storedBytes : null,
      ...(storedBytes >= LIMIT_BYTES ? { peakReason: 'eviction-possible' } : {}),
    };
  }
  const transport = evidence.originLink?.length >= 2
    ? evidence.originLink.at(-1).txBytes - evidence.originLink[0].txBytes : null;
  const watchedUnionBytes = [...unionWatched].reduce((sum, index) => sum + (sizeOf(content, index) ?? 0), 0);
  return {
    reader: 'byte-inventory', version: 1, run,
    host: { mediaBytes: hostMediaBytes, transportBytes: transport, ...(transport === null ? { transportReason: 'origin-link-missing' } : {}) },
    viewers: perViewer,
    room: { hostMediaBytes, peerShare: totalHttp + totalP2p ? totalP2p / (totalHttp + totalP2p) : null,
      watchedUnionBytes, wholeRunCopies: watchedUnionBytes ? hostMediaBytes / watchedUnionBytes : null, label: 'reading' },
    agreement: {
      segmentLengthMismatches: { count: allSegments.filter(({ record, index }) => record.lengthBytes !== sizeOf(content, index)).length, examples: lengthExamples },
      receiptMismatches: { count: (evidence.tags.flatMap((tag) => evidence.clients[tag]?.receipts ?? [])
        .filter((receipt) => receipt?.finished === true && receipt.bodyBytes !== receipt.expectedBytes)).length, examples: receiptExamples },
    },
    finalFlush: finalFlush(evidence),
  };
}
