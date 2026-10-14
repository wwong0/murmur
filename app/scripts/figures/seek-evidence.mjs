const DEFAULT_HIGH_DEMAND_MS = 15_000;

export function segmentIndex(path) {
  const match = String(path ?? '').split(/[?#]/, 1)[0].match(/(?:^|\/)seg-(\d+)\.m4s$/i);
  return match ? Number(match[1]) : null;
}

// Where the room's seek landed and when it took effect, as the figures read them from
// the retained seek evidence; null when either is missing.
export function seekInstants(input) {
  const seek = input.seek ?? input.context?.seek ?? {};
  const host = seek.host ?? {};
  const landingMs = Number(seek.landingMs ?? host.positionMs);
  const effectiveSharedMs = Number(seek.effectiveSharedMs ?? host.atSharedMs);
  if (!Number.isFinite(landingMs) || !Number.isFinite(effectiveSharedMs)) return null;
  return { version: seek.version ?? host.version ?? null, landingMs, effectiveSharedMs,
    segmentSeconds: seek.segmentSeconds };
}

function appliedReading(value) {
  return value && typeof value === 'object'
    && typeof value.lineage === 'string'
    && Number.isInteger(value.version)
    && Number.isFinite(value.positionMs)
    && Number.isFinite(value.atSharedMs)
    ? value
    : null;
}

function sameApplied(left, right) {
  return appliedReading(left) !== null && appliedReading(right) !== null
    && left.lineage === right.lineage
    && left.version === right.version
    && left.positionMs === right.positionMs
    && left.atSharedMs === right.atSharedMs;
}

function segmentsBefore(records, effectiveSharedMs) {
  return (Array.isArray(records) ? records : []).filter((record) => record?.kind === 'segment'
    && Number.isFinite(record.completedAtMs)
    && record.completedAtMs < effectiveSharedMs);
}

function highestSegment(records) {
  const entries = records.map((record) => ({ record, index: segmentIndex(record.path) }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0);
  if (entries.length === 0) return null;
  return entries.reduce((highest, entry) => entry.index > highest.index ? entry : highest).index;
}

export function appliedSeekEvidence({ host, viewers = {}, peerRecords = {}, declaredClientTags = Object.keys(viewers), segmentSeconds, highDemandTimeWindowMs = DEFAULT_HIGH_DEMAND_MS } = {}) {
  const hostReading = appliedReading(host);
  if (!hostReading) throw new Error('seek host applied reading is unavailable');
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  if (!Number.isFinite(highDemandTimeWindowMs) || highDemandTimeWindowMs <= 0) throw new Error('seek high-demand window is invalid');
  const segmentMs = segmentSeconds * 1000;
  const landingSegment = Math.floor(hostReading.positionMs / segmentMs);
  const viewersEvidence = {};
  const notApplied = [];
  const landedOnHeldMedia = [];

  for (const tag of declaredClientTags) {
    const applied = appliedReading(viewers[tag]?.reading ?? viewers[tag]?.applied ?? viewers[tag]);
    const records = Array.isArray(peerRecords[tag]) ? peerRecords[tag] : viewers[tag]?.peerRecords ?? [];
    const before = segmentsBefore(records, hostReading.atSharedMs);
    const highest = highestSegment(before);
    const held = before
      .map((record) => ({ record, index: segmentIndex(record.path) }))
      .filter(({ index }) => Number.isInteger(index)
        && index * segmentMs < hostReading.positionMs + highDemandTimeWindowMs
        && (index + 1) * segmentMs > hostReading.positionMs);
    const viewer = {
      reading: applied,
      highestSegmentBeforeE: highest,
      kL: landingSegment,
      heldSegments: held.map(({ index }) => index),
    };
    viewersEvidence[tag] = viewer;
    if (!sameApplied(applied, hostReading)) notApplied.push({ tag, lastReading: applied });
    if (sameApplied(applied, hostReading) && held.length > 0) {
      landedOnHeldMedia.push({ tag, kL: landingSegment, highestHeldSegment: highest, heldSegments: viewer.heldSegments });
    }
  }

  return {
    host: hostReading,
    landingSegment,
    segmentSeconds,
    highDemandTimeWindowMs,
    viewers: viewersEvidence,
    notApplied,
    landedOnHeldMedia,
  };
}

export function appliedWithoutRestart(seek, tag) {
  const viewer = seek?.viewers?.[tag];
  const applied = viewer?.reading ?? viewer?.applied;
  return appliedReading(applied) !== null && viewer?.restart?.restarted === false;
}
