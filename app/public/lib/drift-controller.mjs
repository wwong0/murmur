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
//  - That arm is a range between quantiles and must never become a distance from
//    the centre — a MAD or a standard deviation collapses on a cadence at exactly
//    the poll where the estimate is furthest out. `spread` below says why.
//  - `state().rate` is the last value handed to `apply`, not the value computed
//    this poll; settled must describe what the media element actually received.
//  - The half-width comes from a fresh `clock.read()` at poll time, never records.
//  - `snapshot().polls` is the monotonic evaluation count; `poll()` advances it
//    before every branch, including no-clock and hold outcomes.
//  - Records accumulate in one post-clock site and are trimmed in one place
//    (design.md D4), so a no-clock poll leaves the log cursor untouched.
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

// Both statistics take a SORTED array, as frame-drift.mjs's pair next door do.
// One poll needs the median and the spread of the same window, and sorting once
// at the call site is what lets them share it.
function median(sorted) {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/**
 * The window's `p95 - p5`. A cadence puts its arms AT THE QUANTILES, so a range
 * between quantiles cannot be moved by which arm holds the majority (design.md
 * D1). No scale factor, so no constant: the quantity is the excursion itself.
 */
function spread(sorted) {
  return quantile(sorted, 0.95) - quantile(sorted, 0.05);
}

/**
 * The frame's own display instant on the LOCAL clock. `displaySharedMs` carries
 * whichever offset was in force when the record was taken, so anything asking
 * *when* rather than *where* must take that offset back off first.
 */
function displayLocalOf(record) {
  return record.displaySharedMs - record.clock.offsetMs;
}

export function createDriftController({ log, clock, apply, settings: overrides = {}, now }) {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
  let cursor = 0;
  let records = [];
  let lastReanchors = null;
  let lastSeenAt = null;
  let dropCutoffSeq = 0;
  let recordsSinceDrop = 0;
  let staleHold = false;
  let pendingSeams = [];
  let restatements = 0;
  let lastOffsetMs = null;
  let firstCorrectionAt = null;
  let insideBandAt = null;
  let settledLatched = false;
  let excursionAt = null;
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
  let polls = 0;
  let settlingMs = null;
  const seams = [];
  const drops = { seam: 0, reanchor: 0, stale: 0 };
  /**
   * Forget the dwell. `settled` is a claim about an UNBROKEN stretch inside the
   * band, so everything that breaks one has to clear the whole latch — a drop
   * that leaves `insideBandAt` standing hands the next latch a dwell it never
   * served.
   */
  function unlatch() {
    insideBandAt = null;
    settledLatched = false;
    excursionAt = null;
  }

  function drop(dropReason, atMs, cutoffSeq) {
    drops[dropReason] += 1;
    dropCutoffSeq = Math.max(dropCutoffSeq, cutoffSeq);
    recordsSinceDrop = 0;
    staleHold = dropReason === 'stale';
    unlatch();
    lastDrop = { reason: dropReason, atMs };
  }

  /**
   * Unity, and the label that says why it is not correcting. Every outcome that
   * is not a correction reduces to this — no clock, stale, too few records, no
   * estimate — and they must differ only in that label.
   */
  function hold(atMs, nextMode, nextReason) {
    applyRate(BASE_RATE, atMs);
    unlatch();
    mode = nextMode;
    reason = nextReason;
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
      polls,
      settlingMs,
      fastestCloseMs,
      counters: { drops: { ...drops }, restatements },
      lastDrop: lastDrop ? { ...lastDrop } : null,
    };
  }

  function poll() {
    polls += 1;
    const atMs = now();
    const estimate = clock.read();
    const offsetMs = estimate.offsetMs;

    const reanchors = estimate.counters?.reanchors;
    if (lastReanchors === null) lastReanchors = reanchors ?? 0;
    else if (Number.isFinite(reanchors)) {
      // EVERY record produced so far, not only those read by the last poll.
      // A re-anchor is observed at poll time, but the frames that arrived in
      // the gap before it were measured against the anchor it replaced — cut
      // at `beforeReadSeq` they survive, and a window straddling the event
      // averages two worlds into a confident zero. Over-dropping costs one
      // MIN_RECORDS hold; under-dropping costs a wrong answer.
      for (let i = lastReanchors; i < reanchors; i++) drop('reanchor', atMs, log.latestSeq);
      lastReanchors = reanchors;
    }
    for (const seam of pendingSeams) drop('seam', atMs, seam.afterSeq);
    pendingSeams = [];

    if (offsetMs === null) {
      // The one hold that also erases the measurement: with no offset there is
      // no window to have counted and no floor to have computed, and a stale
      // `fastestCloseMs` beside a `no-clock` mode reads as a live figure.
      estimateMs = null;
      bandMs = null;
      spreadMs = null;
      halfWidthMs = null;
      windowRecords = 0;
      controlRecords = 0;
      fastestCloseMs = null;
      hold(atMs, 'waiting', 'no-clock');
      return snapshot();
    }

    const beforeReadSeq = cursor;
    const read = log.read({ afterSeq: cursor });
    cursor = read.latestSeq;
    const incoming = read.records;
    for (const record of incoming) {
      records.push(record);
      if (record.seq > dropCutoffSeq) recordsSinceDrop += 1;
    }
    // WHEN THE NEWEST FRAME WAS SHOWN, not when this poll ran. A backlog read
    // late is old feedback: stamping it `now` hands the correction another
    // STALE_AFTER_MS over frames nobody is producing any more. The null case is
    // the first clock-bearing poll seeding itself — after it, `lastSeenAt` is
    // always a number.
    if (incoming.length > 0) {
      lastSeenAt = displayLocalOf(incoming.at(-1));
      staleHold = false;
    } else if (lastSeenAt === null) {
      lastSeenAt = atMs;
    }

    if (atMs - lastSeenAt >= settings.STALE_AFTER_MS && !staleHold) {
      drop('stale', atMs, cursor);
    }

    halfWidthMs = Number.isFinite(estimate.halfWidthMs) ? estimate.halfWidthMs : null;
    // Recency is judged on the LOCAL instant, so an offset step moves neither
    // the window nor its membership. Restating each record's drift onto the
    // current offset (below) while testing membership against the offset it was
    // recorded under is what emptied a full window at an ordinary step.
    const windowStart = atMs - settings.ESTIMATE_WINDOW_MS;
    const rolling = records.filter((record) => displayLocalOf(record) > windowStart);
    windowRecords = rolling.length;
    const controlWindow = rolling.filter((record) => record.seq > dropCutoffSeq);
    controlRecords = controlWindow.length;

    // Count records whose source estimate differs from the current one without
    // maintaining a parallel per-record cache; the arithmetic below is direct.
    // `beforeReadSeq` splits the control window into the records this poll read
    // and the ones it was already holding — a new record is restated on arrival,
    // a held one only on the poll that moved the offset under it.
    const offsetChanged = lastOffsetMs !== offsetMs;
    for (const record of controlWindow) {
      if (record.clock.offsetMs === offsetMs) continue;
      if (offsetChanged || record.seq > beforeReadSeq) restatements += 1;
    }
    lastOffsetMs = offsetMs;

    if (controlWindow.length > 0) {
      const values = controlWindow
        .map((record) => record.driftMs + record.clock.offsetMs - offsetMs)
        .sort((a, b) => a - b);
      estimateMs = median(values);
      spreadMs = spread(values);
      bandMs = Math.max(halfWidthMs ?? 0, spreadMs);
    } else {
      estimateMs = null;
      spreadMs = null;
      bandMs = null;
    }

    // `staleHold` alone: a poll can now READ a backlog and still be stale,
    // because staleness is the newest frame's age rather than this poll's luck.
    // Requiring an empty read here reported that case as `waiting`, naming a
    // shortage of records for a page that had stopped producing them.
    if (staleHold) {
      hold(atMs, 'stale', 'no-records');
    } else if (recordsSinceDrop < settings.MIN_RECORDS || estimateMs === null) {
      // Too few since the last drop, or too few inside the window: the same
      // shortage counted from the two ends, and it reports one reason.
      hold(atMs, 'waiting', 'too-few-records');
    } else {
      const excess = Math.sign(estimateMs) * Math.max(0, Math.abs(estimateMs) - bandMs);
      fastestCloseMs = Math.abs(excess) / settings.MAX_RATE_DEVIATION;
      const correction = Math.max(-settings.MAX_RATE_DEVIATION, Math.min(settings.MAX_RATE_DEVIATION, -excess / settings.TIME_CONSTANT_MS));
      const inside = Math.abs(estimateMs) <= bandMs;
      // ONE POLL DOES NOT UNLATCH `settled`. The window's composition is
      // occasionally unrepresentative for a single poll, so an excursion is
      // neither acted on nor believed until it has outlived one
      // ESTIMATE_WINDOW_MS — by which point every record in the window is new
      // and it cannot be composition. The horizon is that window, never a new
      // constant, and the cost of the hold is bounded in design.md D3.
      if (inside) excursionAt = null;
      else if (settledLatched && excursionAt === null) excursionAt = atMs;
      const believed = !inside && (!settledLatched || atMs - excursionAt >= settings.ESTIMATE_WINDOW_MS);
      // The correction is held with the label: a composition artifact is not
      // drift, and a `settled` coexisting with a rate off 1.0 would contradict
      // its own definition and 4b's browser bar with it.
      applyRate(believed ? BASE_RATE + correction : BASE_RATE, atMs);
      if (believed) {
        insideBandAt = null;
        settledLatched = false;
        mode = fastestCloseMs > settings.CLOSE_BUDGET_MS ? 'beyond-rate-authority' : 'correcting';
        reason = null;
      } else {
        if (insideBandAt === null) insideBandAt = atMs;
        // Every conjunct below has failed on its own (design.md D3).
        // A CLIENT THAT NEVER CORRECTED HAS NOT CONVERGED — its band merely
        // covers its error, which is `declining`; settling is measured from the
        // first applied correction, so without one there is no time to report.
        // And THE SAME EPSILON ON BOTH SIDES OF THE SAME QUESTION: `applyRate`
        // refuses to write within RATE_EPSILON of the last rate, so a client
        // parked just off unity never writes exact 1.0 again and `=== BASE_RATE`
        // holds it in `declining` forever.
        if (Math.abs(rate - BASE_RATE) <= settings.RATE_EPSILON && firstCorrectionAt !== null && atMs - insideBandAt >= settings.SETTLED_FOR_MS) {
          settledLatched = true;
          if (settlingMs === null) settlingMs = atMs - firstCorrectionAt;
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
