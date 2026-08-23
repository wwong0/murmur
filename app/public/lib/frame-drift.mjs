// public/lib/frame-drift.mjs
//
// Two pure pieces: one drift record derived from one displayed frame, and the
// bounded log a harness reads. No timers, no clock read, no DOM — the sampler
// next door supplies every instant (change 3a design.md D3 to D6).
//
// Rules that survive any edit:
//
//  1. A MISSING INPUT PRODUCES NO RECORD AND ONE NAMED COUNTER, never a zero
//     and never a substitute. A drift computed against a missing clock claims
//     this client is already aligned with the room (D4).
//  2. `video.currentTime` IS NOT READ HERE, IN ANY BRANCH, and is not an
//     acceptable fallback when frames stop arriving (`CONSTRAINTS.md` →
//     *Playback measurement*). Silence is reported as silence.
//  3. `driftMs` is media minus scheduled, so POSITIVE MEANS AHEAD OF THE ROOM
//     and change 4 corrects a positive error by slowing down.
//
// Under public/lib/: no DOM, no page access.

/** Two minutes at 30fps, sized against a harness polling about once a second. */
export const DEFAULT_CAPACITY = 3600;

/**
 * How far `expectedDisplayTime` may sit from the client's own reading of the
 * same timebase. WIDE ON PURPOSE: it catches a display timestamp from another
 * clock domain, wrong by hours — not jitter, wrong by a frame. The callback
 * fires shortly before display, so the honest value is a little ahead (D3).
 */
export const DISPLAY_WINDOW_MS = 1000;

/** One counter per reason, so "no records" can never mean "which input?". */
export const REFUSAL_REASONS = Object.freeze([
  'mediaTimeNotFinite',
  'displayTimeNotFinite',
  'displayTimeForeign',
  'noClock',
  'noEpoch',
]);

// The only way to build a refusal: an unlisted reason is `undefined` here and
// throws, rather than reaching the log as a NaN counter that serialises to null.
const REFUSED = Object.freeze(
  Object.fromEntries(REFUSAL_REASONS.map((reason) => [reason, Object.freeze({ ok: false, reason })]))
);

/**
 * One frame in, one record or one refusal out.
 *
 * `timeOriginMs + expectedDisplayTime` is the SAME CONSTRUCTION clock-sync and
 * room-client use for the client's timebase, and it must stay the same one, or
 * the offset is measured against one clock and applied to another.
 *
 * `localNowMs` is the caller's own reading taken in the callback — NOT the
 * callback's `now` argument, which comes from the same source as the metadata
 * and would agree with it about a foreign timebase.
 *
 * The clock is read AT THE FRAME'S DISPLAY INSTANT, so the age term in the
 * uncertainty describes the clock as it was when the frame was shown (D5).
 *
 * @param {{metadata: object, timeOriginMs: number, localNowMs: number,
 *   clock: {read: (atMs: number) => object}, timeline: {mediaMsAt: Function, epochMs: number|null},
 *   displayWindowMs?: number}} input
 */
export function deriveDriftRecord({ metadata, timeOriginMs, localNowMs, clock, timeline, displayWindowMs = DISPLAY_WINDOW_MS }) {
  const mediaTime = metadata ? metadata.mediaTime : undefined;
  if (!Number.isFinite(mediaTime)) return REFUSED.mediaTimeNotFinite;

  const expectedDisplayTime = metadata.expectedDisplayTime;
  if (!Number.isFinite(expectedDisplayTime) || !Number.isFinite(timeOriginMs)) return REFUSED.displayTimeNotFinite;

  const displayLocalMs = timeOriginMs + expectedDisplayTime;
  // Explicitly, because a comparison against a non-finite reading is FALSE:
  // written as a bare `>` this guard would wave through exactly the frames it
  // cannot judge.
  if (!Number.isFinite(localNowMs) || Math.abs(displayLocalMs - localNowMs) > displayWindowMs) {
    return REFUSED.displayTimeForeign;
  }

  const estimate = clock.read(displayLocalMs);
  // This counter reads zero in the product, so its zero is NOT evidence of a
  // good clock. NON-ZERO MEANS A PAGE BEGAN PLAYING BEFORE IT HAD ONE (D4).
  if (!estimate || !Number.isFinite(estimate.offsetMs)) return REFUSED.noClock;

  const displaySharedMs = displayLocalMs + estimate.offsetMs;
  const scheduledMediaMs = timeline.mediaMsAt(displaySharedMs);
  if (scheduledMediaMs === null) return REFUSED.noEpoch;

  const mediaMs = mediaTime * 1000;
  return {
    ok: true,
    record: {
      // On every record: a pairwise figure across clients holding different
      // epochs is meaningless, and D1's remaining hole makes that reachable.
      epochMs: timeline.epochMs,
      mediaMs,
      displaySharedMs,
      // The timeline's answer, not the arithmetic behind it — change 5 replaces
      // the implementation without touching the record.
      scheduledMediaMs,
      driftMs: mediaMs - scheduledMediaMs,
      presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : null,
      // Both parts of the half-width, separably — delay and age are different
      // diagnoses, and change 6 is obliged to tell them apart (D5).
      clock: {
        offsetMs: estimate.offsetMs,
        halfWidthMs: estimate.halfWidthMs,
        delayTermMs: estimate.delayTermMs,
        ageTermMs: estimate.ageTermMs,
        sampleCount: estimate.sampleCount,
      },
    },
  };
}

function median(sorted) {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank, so the value reported is one that was actually measured. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/**
 * The ring. `capacity` is a parameter rather than a constant so change 6 can
 * raise it for a slow poll without editing this module.
 *
 * @param {{capacity?: number}} [config]
 */
export function createDriftLog(config = {}) {
  const { capacity = DEFAULT_CAPACITY } = config;

  const counters = { framesOffered: 0 };
  for (const reason of REFUSAL_REASONS) counters[reason] = 0;

  const records = [];
  let nextSeq = 1;

  /**
   * Take one derivation. Refusals are counted here rather than at the call
   * site, so a frame that produced nothing is still visible as a frame.
   */
  function add(derived) {
    counters.framesOffered += 1;
    if (!derived.ok) {
      counters[derived.reason] += 1;
      return null;
    }
    const record = Object.freeze({ seq: nextSeq++, ...derived.record, clock: Object.freeze(derived.record.clock) });
    records.push(record);
    if (records.length > capacity) records.shift();
    return record;
  }

  /**
   * Everything after `afterSeq`, and how many records fell out of the ring
   * before this request could see them. A silent drop and a client that
   * produced fewer frames look identical — `missed` is the difference (D6).
   *
   * @param {{afterSeq?: number}} [query]
   */
  function read(query = {}) {
    const { afterSeq = 0 } = query;
    const oldestSeq = records.length > 0 ? records[0].seq : nextSeq;
    return {
      records: records.slice(Math.max(0, afterSeq + 1 - oldestSeq)),
      missed: Math.max(0, oldestSeq - afterSeq - 1),
      counters: { ...counters },
      capacity,
      latestSeq: nextSeq - 1,
    };
  }

  /**
   * OVER THE RECORDS THE RING HOLDS — a rolling window, not the run, and one
   * client against the room timeline rather than criterion 1's pairwise figure.
   * Report it under either of those names and change 6's own figures will look
   * like a contradiction (D5, D6).
   *
   * Empty is `null`, not 0: zero drift is what perfect synchronization looks
   * like.
   */
  function summary() {
    const sorted = records.map((r) => r.driftMs).sort((a, b) => a - b);
    const empty = sorted.length === 0;
    return {
      framesHeld: sorted.length,
      framesOffered: counters.framesOffered,
      capacity,
      medianDriftMs: empty ? null : median(sorted),
      p99DriftMs: empty ? null : percentile(sorted, 0.99),
      maxAbsDriftMs: empty ? null : Math.max(Math.abs(sorted[0]), Math.abs(sorted[sorted.length - 1])),
    };
  }

  return {
    add,
    read,
    summary,
    get counters() {
      return { ...counters };
    },
  };
}
