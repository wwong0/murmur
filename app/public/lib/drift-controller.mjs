// public/lib/drift-controller.mjs
//
// Pure drift control: one poll reads constructed records and hands `apply` a
// playback rate. No timers, DOM, position input or integral term can enter this
// loop, so a discontinuity cannot turn into an accidental seek.
//
// Rules that survive any edit:
//
//  - `driftMs` is media minus scheduled: positive means ahead of the room, so
//    its correction is below 1.
//  - The band's dispersion arm has no √n factor: display cadence is periodic, not
//    independent noise (design.md D1). Reintroducing it makes the band too narrow.
//  - `state().rate` is the last value handed to `apply`, not the value computed
//    this poll; settled must describe what the media element actually received.
//  - The half-width comes from a fresh `clock.read()` at poll time, never records.
//  - There is no integral term and no position input: this module can only adjust
//    playback rate, never seek.
//
// Under public/lib/: no DOM, no page access.

export const MAX_RATE_DEVIATION = 0.01;
export const TIME_CONSTANT_MS = 4000;
export const ESTIMATE_WINDOW_MS = 1000;
export const STALE_AFTER_MS = 500;
export const MIN_RECORDS = 8;
export const SETTLED_FOR_MS = 5000;
export const CLOSE_BUDGET_MS = 60000;
export const RATE_EPSILON = 1e-6;

const BASE_RATE = 1;
const MAD_SCALE = 1.4826;
const DEFAULT_SETTINGS = Object.freeze({
  MAX_RATE_DEVIATION,
  TIME_CONSTANT_MS,
  ESTIMATE_WINDOW_MS,
  STALE_AFTER_MS,
  MIN_RECORDS,
  SETTLED_FOR_MS,
  CLOSE_BUDGET_MS,
  RATE_EPSILON,
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spread(values, centre) {
  return MAD_SCALE * median(values.map((value) => Math.abs(value - centre)));
}

export function createDriftController({ log, clock, apply, settings: overrides = {}, now }) {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
  let cursor = 0;
  let records = [];
  let lastReanchors = null;
  let lastSeenAt = null;
  let polled = false;
  let dropCutoffSeq = 0;
  let recordsSinceDrop = 0;
  let staleHold = false;
  let pendingSeams = [];
  let restatements = 0;
  let lastOffsetMs = null;
  let firstCorrectionAt = null;
  let insideBandAt = null;
  let settledLatched = false;
  let estimateMs = null;
  let bandMs = null;
  let spreadMs = null;
  let halfWidthMs = null;
  let windowRecords = 0;
  let controlRecords = 0;
  let fastestCloseMs = null;
  let mode = 'waiting';
  let reason = 'no-clock';
  let lastDrop = null;
  let rate = BASE_RATE;
  let correctionsApplied = 0;
  let settlingMs = null;
  const seams = [];
  const drops = { seam: 0, reanchor: 0, stale: 0 };
  function drop(dropReason, atMs, cutoffSeq) {
    drops[dropReason] += 1;
    dropCutoffSeq = Math.max(dropCutoffSeq, cutoffSeq);
    recordsSinceDrop = 0;
    staleHold = dropReason === 'stale';
    insideBandAt = null;
    settledLatched = false;
    lastDrop = { reason: dropReason, atMs };
  }

  function applyRate(nextRate, atMs) {
    if (Math.abs(nextRate - rate) <= settings.RATE_EPSILON) return;
    apply(nextRate);
    rate = nextRate;
    correctionsApplied += 1;
    if (nextRate !== BASE_RATE && firstCorrectionAt === null) firstCorrectionAt = atMs;
  }

  function snapshot() {
    return {
      rate,
      estimateMs,
      bandMs,
      spreadMs,
      halfWidthMs,
      windowRecords,
      controlRecords,
      mode,
      reason,
      settings,
      correctionsApplied,
      settlingMs,
      fastestCloseMs,
      counters: { drops: { ...drops }, restatements },
      lastDrop: lastDrop ? { ...lastDrop } : null,
    };
  }

  function poll() {
    const atMs = now();
    const estimate = clock.read();
    const offsetMs = estimate.offsetMs;
    const beforeReadSeq = cursor;

    if (lastReanchors === null) lastReanchors = estimate.counters?.reanchors ?? 0;
    else {
      const advance = (estimate.counters?.reanchors ?? 0) - lastReanchors;
      if (advance > 0) {
        for (let i = 0; i < advance; i++) drop('reanchor', atMs, beforeReadSeq);
      }
      lastReanchors = estimate.counters?.reanchors ?? lastReanchors;
    }
    for (const seam of pendingSeams) drop('seam', atMs, seam.afterSeq);
    pendingSeams = [];

    const read = log.read({ afterSeq: cursor });
    cursor = read.latestSeq;
    const incoming = read.records;
    for (const record of incoming) {
      records.push(record);
      if (record.seq > dropCutoffSeq) recordsSinceDrop += 1;
    }
    if (incoming.length > 0) lastSeenAt = atMs;
    else if (!polled) lastSeenAt = atMs;
    if (incoming.length > 0) staleHold = false;
    polled = true;

    if (offsetMs !== null && lastSeenAt !== null && atMs - lastSeenAt >= settings.STALE_AFTER_MS && !staleHold) {
      drop('stale', atMs, cursor);
    }

    if (offsetMs === null) {
      estimateMs = null;
      bandMs = null;
      spreadMs = null;
      halfWidthMs = null;
      windowRecords = 0;
      controlRecords = 0;
      fastestCloseMs = null;
      insideBandAt = null;
      settledLatched = false;
      applyRate(BASE_RATE, atMs);
      mode = 'waiting';
      reason = 'no-clock';
      return snapshot();
    }

    halfWidthMs = Number.isFinite(estimate.halfWidthMs) ? estimate.halfWidthMs : null;
    const sharedNow = atMs + offsetMs;
    const windowStart = sharedNow - settings.ESTIMATE_WINDOW_MS;
    const rolling = records.filter((record) => record.displaySharedMs > windowStart);
    windowRecords = rolling.length;
    const controlWindow = rolling.filter((record) => record.seq > dropCutoffSeq);
    controlRecords = controlWindow.length;

    // Count records whose source estimate differs from the current one without
    // maintaining a parallel per-record cache; the arithmetic below is direct.
    const offsetChanged = lastOffsetMs === null || lastOffsetMs !== offsetMs;
    if (offsetChanged) {
      for (const record of controlWindow) {
        if (record.seq <= beforeReadSeq && record.clock.offsetMs !== offsetMs) restatements += 1;
      }
    }
    for (const record of incoming) {
      if (controlWindow.includes(record) && record.clock.offsetMs !== offsetMs) restatements += 1;
    }
    lastOffsetMs = offsetMs;

    if (controlWindow.length > 0) {
      const values = controlWindow.map((record) => record.driftMs + record.clock.offsetMs - offsetMs);
      estimateMs = median(values);
      spreadMs = spread(values, estimateMs);
      bandMs = Math.max(halfWidthMs ?? 0, spreadMs);
    } else {
      estimateMs = null;
      spreadMs = null;
      bandMs = null;
    }

    if (staleHold && incoming.length === 0) {
      applyRate(BASE_RATE, atMs);
      insideBandAt = null;
      settledLatched = false;
      mode = 'stale';
      reason = 'no-records';
    } else if (recordsSinceDrop < settings.MIN_RECORDS) {
      applyRate(BASE_RATE, atMs);
      insideBandAt = null;
      settledLatched = false;
      mode = 'waiting';
      reason = 'too-few-records';
    } else if (estimateMs === null) {
      applyRate(BASE_RATE, atMs);
      insideBandAt = null;
      settledLatched = false;
      mode = 'waiting';
      reason = 'too-few-records';
    } else {
      staleHold = false;
      const excess = Math.sign(estimateMs) * Math.max(0, Math.abs(estimateMs) - bandMs);
      fastestCloseMs = Math.abs(excess) / settings.MAX_RATE_DEVIATION;
      const correction = Math.max(-settings.MAX_RATE_DEVIATION, Math.min(settings.MAX_RATE_DEVIATION, -excess / settings.TIME_CONSTANT_MS));
      const nextRate = BASE_RATE + correction;
      applyRate(nextRate, atMs);
      if (Math.abs(estimateMs) > bandMs) {
        insideBandAt = null;
        settledLatched = false;
        mode = fastestCloseMs > settings.CLOSE_BUDGET_MS ? 'beyond-rate-authority' : 'correcting';
        reason = null;
      } else {
        if (insideBandAt === null) insideBandAt = atMs;
        if (rate === BASE_RATE && atMs - insideBandAt >= settings.SETTLED_FOR_MS) {
          settledLatched = true;
          if (settlingMs === null) settlingMs = firstCorrectionAt === null ? 0 : atMs - firstCorrectionAt;
        }
        mode = settledLatched ? 'settled' : 'declining';
        reason = null;
      }
    }

    records = rolling;
    return snapshot();
  }

  function markSeam({ afterSeq, epochMs, positionMs }) {
    const seam = { afterSeq, epochMs, positionMs };
    seams.push(seam);
    pendingSeams.push(seam);
  }

  return {
    poll,
    state: snapshot,
    markSeam,
    get seams() {
      return seams.map((seam) => ({ ...seam }));
    },
  };
}
