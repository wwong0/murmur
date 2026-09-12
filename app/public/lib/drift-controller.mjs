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
//  - U (`bandMs`) is the measurement band AND the origin the correction is
//    measured from; S (`stoppingThresholdMs`) is only where the client may stop.
//    An absent measurement is published as absent, never as zero.
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
/**
 * f — the smallest command deviation the controller may write. The DEFAULT is
 * zero, which disables the floor. A positive f is not a calibration (D7 stays
 * F3): it is the owner-adopted D8 value below, and the page passes it in only
 * after the pitch treatment has been established (design.md D8).
 */
export const MIN_COMMAND_DEVIATION = 0;
/**
 * The adopted f: 1/881 + 1e-6, the widest modelled copy region in
 * {44.1, 48, 96} kHz plus one ppm of headroom. A frozen literal, because the
 * formula (`commandThresholdFor`) lives in test machinery a product module may
 * not import; the d8-product-integration suite proves the two are one number.
 */
export const D8_COMMAND_THRESHOLD = 0.0011360737797956866;
/** Floating-point slack near 1.0 for the command-range check. Never a ppm allowance. */
export const COMMAND_TOLERANCE = 8 * Number.EPSILON;
/** The owner-approved ceiling on an accepted stopping threshold. Fixed: an
 *  override may not raise it, and may not lower it either (ms). */
export const MAX_STOPPING_THRESHOLD_MS = 20;

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
  MIN_COMMAND_DEVIATION,
  MAX_STOPPING_THRESHOLD_MS,
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

/**
 * L — the error the smallest worthwhile command closes in one time constant.
 * The mapping reuses TIME_CONSTANT_MS rather than a second tunable, so a change
 * to the correction's speed cannot silently move the allowance under it.
 */
export function actuatorAllowanceMs(floorRate, timeConstantMs) {
  return floorRate * timeConstantMs;
}

/**
 * The threshold set a poll publishes, from inputs that do not require a
 * controller to supply. U is the larger measurement arm and stays the origin
 * the correction is measured from; S = U + L is the region the client must be
 * inside to stop. `measurementLimit` names the arm that set U, and says
 * `clock-and-dispersion` only on exact equality — a tie needs no tolerance
 * constant, because there is nothing between two numbers that are the same one.
 * With no dispersion there is no window, so U and everything above it is
 * absent rather than zero.
 */
export function thresholdComponents({ halfWidthMs, spreadMs, allowanceMs }) {
  const clockArm = Number.isFinite(halfWidthMs) ? halfWidthMs : null;
  const dispersionArm = Number.isFinite(spreadMs) ? spreadMs : null;
  if (dispersionArm === null) return { bandMs: null, measurementLimit: null, requiredStoppingThresholdMs: null };
  const bandMs = Math.max(clockArm ?? 0, dispersionArm);
  let measurementLimit = 'dispersion';
  if (clockArm !== null && clockArm > dispersionArm) measurementLimit = 'clock';
  else if (clockArm !== null && clockArm === dispersionArm) measurementLimit = 'clock-and-dispersion';
  return { bandMs, measurementLimit, requiredStoppingThresholdMs: bandMs + allowanceMs };
}

/**
 * The shortest time the rate authority could need to reach the stopping
 * threshold — a lower bound on closing, never a predicted settling time.
 * A zero authority closes nothing it is not already inside: that is 0 ms when
 * there is no excess and NO FIGURE AT ALL when there is, rather than the
 * Infinity or NaN the division produces and JSON would flatten to `null`
 * anyway, indistinguishable from a value that was never computed.
 */
export function shortestCloseMs(estimateMs, thresholdMs, maxRateDeviation) {
  const excess = Math.max(0, Math.abs(estimateMs) - thresholdMs);
  if (excess === 0) return 0;
  const close = excess / maxRateDeviation;
  return Number.isFinite(close) ? close : null;
}

/**
 * Which limit is holding a client that declined to correct. The caller has
 * already established the error is inside S; inside U as well, it is the
 * measurement that cannot resolve the error, and beyond U it is the allowance
 * added on top of it. At f = 0 the two thresholds coincide and only the first
 * arm is reachable — see the branch note above MIN_COMMAND_DEVIATION.
 */
export const DECLINING_REASONS = Object.freeze(['measurement-limit', 'actuator-limit']);
export function decliningReason(estimateMs, bandMs) {
  return Math.abs(estimateMs) <= bandMs ? DECLINING_REASONS[0] : DECLINING_REASONS[1];
}

/**
 * The construction contract, checked before `apply` can be handed anything, so
 * a settings mistake is a throw at startup rather than a rate at the player.
 */
function validateSettings(settings) {
  const floor = settings.MIN_COMMAND_DEVIATION;
  const refuse = (message) => { throw new RangeError(`drift-controller: ${message}`); };
  const finite = ['MIN_COMMAND_DEVIATION', 'TIME_CONSTANT_MS', 'MAX_RATE_DEVIATION', 'RATE_EPSILON'];
  for (const name of finite) if (!Number.isFinite(settings[name])) refuse(`${name} must be a finite number, got ${settings[name]}`);
  if (floor < 0) refuse(`MIN_COMMAND_DEVIATION must not be negative, got ${floor}`);
  if (settings.TIME_CONSTANT_MS <= 0) refuse(`TIME_CONSTANT_MS must be positive, got ${settings.TIME_CONSTANT_MS}`);
  if (settings.MAX_RATE_DEVIATION < 0 || settings.MAX_RATE_DEVIATION >= 1) refuse(`MAX_RATE_DEVIATION must be in [0, 1), got ${settings.MAX_RATE_DEVIATION}`);
  // A floor past the authority names a command the loop can never write.
  if (floor > settings.MAX_RATE_DEVIATION) refuse(`MIN_COMMAND_DEVIATION ${floor} exceeds the rate authority ${settings.MAX_RATE_DEVIATION}`);
  if (settings.RATE_EPSILON < 0) refuse(`RATE_EPSILON must not be negative, got ${settings.RATE_EPSILON}`);
  if (settings.MAX_STOPPING_THRESHOLD_MS !== MAX_STOPPING_THRESHOLD_MS) refuse(`MAX_STOPPING_THRESHOLD_MS is fixed at ${MAX_STOPPING_THRESHOLD_MS}, got ${settings.MAX_STOPPING_THRESHOLD_MS}`);
}

export function createDriftController({ log, clock, apply, settings: overrides = {}, now }) {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
  validateSettings(settings);
  // Known from the settings alone, so it is published before the first poll and
  // survives every hold: nothing about a missing clock changes what the actuator
  // is allowed to ignore.
  const allowanceMs = actuatorAllowanceMs(settings.MIN_COMMAND_DEVIATION, settings.TIME_CONSTANT_MS);
  const floorRate = settings.MIN_COMMAND_DEVIATION;
  const positiveFloor = floorRate > 0;
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
  let measurementLimit = null;
  let requiredStoppingThresholdMs = null;
  let stoppingThresholdMs = null;
  let thresholdUsable = false;
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
  let budgetRefusals = 0;
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
    // NO HOLD PUBLISHES AN ACCEPTED THRESHOLD OR A LIVE CLOSE. Measurement
    // components describe what was measured and a hold may keep them; an
    // accepted S and a close figure are answers about the error this poll would
    // act on, and a poll that acted on nothing has none (design.md D3).
    stoppingThresholdMs = null;
    thresholdUsable = false;
    fastestCloseMs = null;
    mode = nextMode;
    reason = nextReason;
  }

  /**
   * Writes the RATE_EPSILON filter may not swallow once f is positive: entering
   * or leaving exact unity, and a change of direction. With the filter wider
   * than 2f either would otherwise leave the element commanded wrongly. Inert
   * at f = 0, where the filter is exactly the zero-floor one.
   */
  function transitionRequiresWrite(nextRate) {
    if (!positiveFloor || nextRate === rate) return false;
    if ((nextRate === BASE_RATE) !== (rate === BASE_RATE)) return true;
    return Math.sign(nextRate - BASE_RATE) !== Math.sign(rate - BASE_RATE);
  }

  /**
   * A CHECK, NOT A CLAMP. Just outside S the excess over U is at least L = f·T,
   * so the law already yields at least f; a failure here is a defect upstream,
   * never a value to round into range.
   */
  function assertCommandInRange(nextRate) {
    const deviation = Math.abs(nextRate - BASE_RATE);
    if (deviation === 0) return;
    if (deviation < floorRate - COMMAND_TOLERANCE) throw new RangeError(`drift-controller: applied deviation ${deviation} is below the command threshold ${floorRate}`);
    if (deviation > settings.MAX_RATE_DEVIATION + COMMAND_TOLERANCE) throw new RangeError(`drift-controller: applied deviation ${deviation} exceeds the rate authority ${settings.MAX_RATE_DEVIATION}`);
  }

  function applyRate(nextRate, atMs) {
    if (Math.abs(nextRate - rate) <= settings.RATE_EPSILON && !transitionRequiresWrite(nextRate)) return;
    assertCommandInRange(nextRate);
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
      measurementLimit,
      actuatorAllowanceMs: allowanceMs,
      requiredStoppingThresholdMs,
      stoppingThresholdMs,
      thresholdUsable,
      windowRecords,
      controlRecords,
      mode,
      reason,
      settings,
      correctionsApplied,
      polls,
      settlingMs,
      fastestCloseMs,
      counters: { drops: { ...drops }, restatements, budgetRefusals },
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
      measurementLimit = null;
      requiredStoppingThresholdMs = null;
      windowRecords = 0;
      controlRecords = 0;
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
    } else {
      estimateMs = null;
      spreadMs = null;
    }
    // Provisional until a branch below accepts them: these three say what was
    // measured, not what may be stopped inside.
    ({ bandMs, measurementLimit, requiredStoppingThresholdMs } = thresholdComponents({ halfWidthMs, spreadMs, allowanceMs }));

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
    } else if (positiveFloor && requiredStoppingThresholdMs > settings.MAX_STOPPING_THRESHOLD_MS) {
      // THE INPUT WAS VALID AND THE ANSWER IS A REFUSAL: measurement plus
      // allowance needs more room than the ceiling allows, so there is no S to
      // stop inside. `hold` publishes exact unity, no accepted S and no close,
      // and clears the dwell; the required S stays published and `settlingMs`
      // stays as history (design.md D8).
      budgetRefusals += 1;
      hold(atMs, 'resolution-budget-hold', 'stopping-threshold-over-budget');
    } else {
      // The one branch that acts on the measurement, so the one that accepts a
      // threshold. THE CORRECTION IS STILL MEASURED FROM U: S is where the
      // client may stop, not where the error is counted from, and at f = 0 the
      // two are the same number anyway (design.md D3).
      stoppingThresholdMs = requiredStoppingThresholdMs;
      thresholdUsable = true;
      const excess = Math.sign(estimateMs) * Math.max(0, Math.abs(estimateMs) - bandMs);
      fastestCloseMs = shortestCloseMs(estimateMs, stoppingThresholdMs, settings.MAX_RATE_DEVIATION);
      const correction = Math.max(-settings.MAX_RATE_DEVIATION, Math.min(settings.MAX_RATE_DEVIATION, -excess / settings.TIME_CONSTANT_MS));
      const inside = Math.abs(estimateMs) <= stoppingThresholdMs;
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
        // NO FINITE CLOSE IS BEYOND THE BUDGET TOO, and the budget is compared
        // against nothing else: `null > budget` and `Infinity > budget` are the
        // two ways this line has to be able to say "not closable from here".
        mode = fastestCloseMs === null || fastestCloseMs > settings.CLOSE_BUDGET_MS ? 'beyond-rate-authority' : 'correcting';
        reason = null;
      } else {
        if (insideBandAt === null) insideBandAt = atMs;
        // A CLIENT THAT NEVER CORRECTED HAS NOT CONVERGED — its threshold merely
        // covers its error, which is `declining`; settling is measured from the
        // first applied NON-UNITY write, so without one there is no time to
        // report. `correctionsApplied` counts returns to unity as well and is
        // not that event. The applied rate is no longer a conjunct here: it is
        // published beside the claim instead, and every path into this branch
        // has already asked for exactly normal speed (design.md D3).
        if (firstCorrectionAt !== null && atMs - insideBandAt >= settings.SETTLED_FOR_MS) {
          settledLatched = true;
          if (settlingMs === null) settlingMs = atMs - firstCorrectionAt;
        }
        mode = settledLatched ? 'settled' : 'declining';
        reason = settledLatched ? null : decliningReason(estimateMs, bandMs);
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
