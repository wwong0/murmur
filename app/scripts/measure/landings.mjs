import { landingSegments } from '../figures/landing.mjs';
import { harnessSharedMs, runwayMs, sharedWallMs } from '../figures/poll-coverage.mjs';

const finite = (value) => Number.isFinite(value);
const metricNames = ['hostCopiesSum', 'peerShare30s', 'backAheadMs', 'stallTotalMs', 'waitMs'];

function pathOf(value) { return String(value ?? '').split(/[?#]/, 1)[0]; }
function segmentIndex(value) { return Number(pathOf(value).match(/\/seg-(\d+)\.m4s$/)?.[1]); }
function sharedPage(evidence, value) { return sharedWallMs(evidence.timebase, value); }
function sharedControl(evidence, poll) {
  return harnessSharedMs(evidence.timebase, poll?.harnessBeforeMs, poll?.harnessAfterMs);
}
function allAttempts(evidence) {
  return Object.values(evidence.clients ?? {}).flatMap((client) => client?.peerBytes ?? [])
    .filter((record) => record?.kind === 'attempt');
}
function allSegments(evidence) {
  return Object.values(evidence.clients ?? {}).flatMap((client) => client?.peerBytes ?? [])
    .filter((record) => record?.kind === 'segment');
}
function frameGaps(records) {
  const values = (records ?? []).map((record) => record?.displaySharedMs).filter(finite).sort((a, b) => a - b);
  return values.slice(0, -1).map((startMs, index) => ({ startMs, gapMs: values[index + 1] - startMs }))
    .filter((gap) => gap.gapMs > 250);
}
function stallRow(evidence, tag, from, to) {
  const stalls = frameGaps(evidence.clients?.[tag]?.drift).filter((gap) => gap.startMs >= from && gap.startMs <= to);
  return { count: stalls.length, totalMs: stalls.reduce((sum, gap) => sum + gap.gapMs, 0) };
}
function firstStart(evidence) {
  const starts = (evidence.tags ?? []).flatMap((tag) => (evidence.clients?.[tag]?.polls ?? [])
    .map((poll) => poll?.playback?.startAtSharedMs).filter(finite));
  return starts.length ? Math.min(...starts) : null;
}
function startPosition(evidence) {
  return (evidence.hostPoll ?? []).map((poll) => poll?.state?.positionMs).find(finite) ?? null;
}
function waitFor(evidence, kind) {
  const holds = evidence.publishedFigures?.control?.holds ?? evidence.publishedFigures?.holds;
  const waitMs = holds?.[kind]?.waitMs;
  return finite(waitMs) ? { waitMs } : { waitMs: null, waitReason: 'waits-unpublished' };
}
function controlRefusal(evidence) {
  const record = evidence.assignmentControl;
  if (record === null || record === undefined) return { refused: true, reason: 'control-record-missing' };
  const expected = evidence.condition?.assignmentControl === '8b' ? '8b' : 'product';
  for (const reading of record.readings ?? []) {
    for (const [page, value] of Object.entries(reading.byPage ?? {})) {
      if (value?.control !== expected) return { refused: true, reason: 'control-mismatch', detail: page };
    }
  }
  if (!(record.readings ?? []).length) return { refused: true, reason: 'control-mismatch', detail: 'unknown-page' };
  return null;
}
function controlEnd(evidence) {
  const values = (evidence.hostPoll ?? []).map((poll) => sharedControl(evidence, poll)).filter(finite);
  return values.length ? values.at(-1) : null;
}
function backAhead(evidence, landingMs, nextLandingMs) {
  const last = finite(nextLandingMs) ? nextLandingMs : controlEnd(evidence);
  if (!finite(landingMs) || !finite(last)) return { backAheadMs: null, backAheadReason: 'never' };
  const values = Object.fromEntries((evidence.tags ?? []).map((tag) => [tag,
    (evidence.clients?.[tag]?.viewerControl ?? []).map((poll) => ({ poll, atMs: sharedControl(evidence, poll) }))
      .filter((entry) => finite(entry.atMs) && entry.atMs >= landingMs && entry.atMs <= last)
      .sort((a, b) => a.atMs - b.atMs)]));
  const candidates = [...new Set(Object.values(values).flat().map((entry) => entry.atMs))].sort((a, b) => a - b);
  for (const atMs of candidates) {
    if ((evidence.tags ?? []).every((tag) => {
      const later = values[tag].filter((entry) => entry.atMs >= atMs);
      return later.length > 0 && later.every((entry) => runwayMs(entry.poll, tag) > 15_000);
    })) return { backAheadMs: atMs - landingMs, backAheadAtSharedMs: atMs };
  }
  return { backAheadMs: null, backAheadReason: 'never' };
}
function landingRow(evidence, kind, landingMs, positionMs, nextLandingMs) {
  if (!finite(landingMs) || !finite(positionMs)) return { kind, unreadable: true, reason: `${kind}-landing-unavailable` };
  const content = evidence.content ?? {};
  const geometry = landingSegments({ positionMs, segmentSeconds: content.segmentSeconds,
    segmentDurations: content.segmentDurations, segmentCount: content.segmentCount, windowMs: 4_000 });
  if (!geometry) return { kind, instantSharedMs: landingMs, positionMs, segments: [], reason: 'segment-boundaries-unavailable' };
  const sizes = content.segmentSizes ?? [];
  const attempts = allAttempts(evidence);
  const segments = geometry.segmentsNeeded.map((index) => {
    const path = `/media/seg-${String(index).padStart(5, '0')}.m4s`;
    const expected = sizes[index];
    const bytes = attempts.filter((record) => record.source === 'http' && pathOf(record.path) === path)
      .reduce((sum, record) => sum + (Number(record.bytes) || 0), 0);
    const holders = allSegments(evidence).filter((record) => pathOf(record.path) === path)
      .map((record) => sharedPage(evidence, record.completedAtMs)).filter(finite);
    const hostCopies = finite(expected) && expected > 0 ? bytes / expected : null;
    return { index, path, sizeBytes: finite(expected) ? expected : null, hostCopies,
      firstHolderMs: holders.length ? Math.min(...holders) - landingMs : null };
  });
  const peerWindow = attempts.filter((record) => ['http', 'p2p'].includes(record.source))
    .map((record) => ({ record, endMs: sharedPage(evidence, record.endMs) }))
    .filter((entry) => finite(entry.endMs) && entry.endMs >= landingMs && entry.endMs <= landingMs + 30_000);
  const hostBytes30s = peerWindow.filter(({ record }) => record.source === 'http')
    .reduce((sum, entry) => sum + (Number(entry.record.bytes) || 0), 0);
  const peerBytes30s = peerWindow.filter(({ record }) => record.source === 'p2p')
    .reduce((sum, entry) => sum + (Number(entry.record.bytes) || 0), 0);
  const denominator = hostBytes30s + peerBytes30s;
  const stalls = Object.fromEntries((evidence.tags ?? []).map((tag) => [tag, stallRow(evidence, tag, landingMs, landingMs + 30_000)]));
  const stallTotalMs = Object.values(stalls).reduce((sum, row) => sum + row.totalMs, 0);
  return { kind, instantSharedMs: landingMs, instantMs: landingMs, positionMs, segment: geometry.index,
    playlistOffsetMs: geometry.offsetMs, segmentsNeeded: geometry.segmentsNeeded, segments,
    hostCopiesSum: segments.reduce((sum, row) => sum + (row.hostCopies ?? 0), 0),
    peerShare30s: denominator ? peerBytes30s / denominator : null, hostBytes30s, peerBytes30s,
    ...backAhead(evidence, landingMs, nextLandingMs), stalls, stallTotalMs, ...waitFor(evidence, kind) };
}

export function landings(evidence) {
  const refusal = controlRefusal(evidence);
  if (refusal) return { reader: 'landings', version: 1, run: evidence.run ?? null, ...refusal };
  const startMs = firstStart(evidence);
  const seekMs = evidence.seek ? evidence.seek.effectiveSharedMs : null;
  const start = landingRow(evidence, 'start', startMs, startPosition(evidence), seekMs);
  const seek = evidence.seek
    ? (finite(seekMs) && finite(evidence.seek.landedPositionMs)
      ? landingRow(evidence, 'seek', seekMs, evidence.seek.landedPositionMs, null)
      : { kind: 'seek', unreadable: true, reason: 'seek-landing-unavailable' })
    : null;
  return { reader: 'landings', version: 1, run: evidence.run ?? null, start, seek };
}

function armValue(arm, kind) {
  const row = arm?.[kind];
  return row ? Object.fromEntries(metricNames.map((name) => [name, row[name] ?? null])) : null;
}
function differences(product, control) {
  return Object.fromEntries(metricNames.map((name) => [name,
    finite(product?.[name]) && finite(control?.[name]) ? product[name] - control[name] : null]));
}

export function landingPairs(pairs = []) {
  return { reader: 'landing-pairs', version: 1, pairs: pairs.map((pair, index) => {
    const product = Array.isArray(pair) ? pair[0] : pair?.product;
    const control = Array.isArray(pair) ? pair[1] : pair?.control;
    const result = { pair: index };
    for (const kind of ['start', 'seek']) {
      const productValues = armValue(product, kind);
      const controlValues = armValue(control, kind);
      if (!productValues && !controlValues) continue;
      result[kind] = { product: productValues, control: controlValues, difference: differences(productValues, controlValues) };
    }
    return result;
  }) };
}
