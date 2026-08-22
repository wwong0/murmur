// public/lib/clock-filter.mjs
//
// A cut-down NTP clock filter: four timestamps in, an offset against the room
// reference out, with an error bound the caller can act on. Every rule below is
// argued in change 2 design.md, D2 through D7. Three must survive any edit:
//
//  1. PURE — no timers, transport, DOM, or clock of its own; the caller passes
//     the instant it reads at, which is what makes every branch reachable
//     synchronously from constructed input.
//  2. The estimate is the SELECTED SAMPLE'S OWN OFFSET. The bound is stated in
//     terms of that one sample, so moving the estimate off it widens the true
//     error without widening the reported bound.
//  3. The step detector compares samples WITH EACH OTHER, never with the
//     reported estimate.
//
// Under public/lib/: no DOM, no page access — enforced by check-structure.mjs.

/**
 * How fast two clocks may pull apart: 40ppm, i.e. 2.4ms per minute. AN
 * ASSUMPTION ABOUT HARDWARE, not something this system derives — named so change
 * 6 can measure it and replace it.
 */
export const DEFAULT_DRIFT_RATE = 40e-6;

/**
 * Samples kept. THIS AND THE DRIVER'S STEADY CADENCE ARE ONE SETTING IN TWO
 * PLACES: their product is the span the window covers, and minimum-delay
 * selection assumes every sample in it measures the same offset.
 */
export const DEFAULT_WINDOW = 8;

/**
 * Consecutive contradicting samples required before the window re-anchors. Not a
 * defence against queueing spikes — the contradiction test handles those alone —
 * but against ONE corrupt sample purging a good window or being published.
 */
export const DEFAULT_CONFIRMATIONS = 2;

/**
 * DO NOT "SIMPLIFY" THE DELAY. `(t4 - t1) - (t3 - t2)` removes the reference's
 * own service time and every appearance of the true offset cancels out of it,
 * which is what makes delay a quality measure and a negative delay proof of a
 * misplaced timestamp rather than of a fast network.
 *
 * `atMs` is the sample's own time in the CLIENT's timebase, and is `t4`.
 *
 * @param {{t1: number, t2: number, t3: number, t4: number}} s
 */
export function deriveSample(s) {
  return {
    offsetMs: ((s.t2 - s.t1) + (s.t3 - s.t4)) / 2,
    delayMs: (s.t4 - s.t1) - (s.t3 - s.t2),
    atMs: s.t4,
  };
}

/**
 * The quietest sample, therefore the tightest guaranteed error bound. TIES GO TO
 * THE NEWEST — `<=`, not `<`: ties are the ordinary case on a quiet link, and
 * keeping the older one only adds age term.
 */
function minDelay(pool) {
  let best = null;
  for (const s of pool) if (best === null || s.delayMs <= best.delayMs) best = s;
  return best;
}

/**
 * @param {{windowSize?: number, driftRate?: number, confirmations?: number,
 *   reanchor?: boolean}} [config] `reanchor` is off only for the checks that
 *   measure how long plain window turnover takes to track a step
 */
export function createClockFilter(config = {}) {
  const {
    windowSize = DEFAULT_WINDOW,
    driftRate = DEFAULT_DRIFT_RATE,
    confirmations = DEFAULT_CONFIRMATIONS,
    reanchor = true,
  } = config;

  /** @type {{offsetMs: number, delayMs: number, atMs: number, eligible: boolean}[]} */
  let samples = [];

  /**
   * Consecutive accepted samples that each contradict `runAnchor`. THE ANCHOR IS
   * FROZEN for the life of the run, or a step whose samples are quieter than the
   * ones before it silently redefines the era it should be detected against.
   */
  let run = [];
  let runAnchor = null;

  const counters = { lost: 0, impossible: 0, reanchors: 0 };

  /**
   * A sample that contradicted the estimate on arrival cannot be published until
   * its run agrees with itself. Drop that gate and the first sample after a
   * server restart — indistinguishable in shape from a corrupt one — is
   * published the instant it lands, inside a bound that cannot see it is wrong.
   * With NOTHING eligible, fall back to the whole window: nothing there is
   * trustworthy, and `null` is not available to mean that (D9).
   */
  function select() {
    return minDelay(samples.filter((s) => s.eligible)) ?? minDelay(samples);
  }

  /**
   * Two samples measuring the same offset each lie within their own delay/2 of
   * it, and may have drifted apart since. Exceeding that is a contradiction, not
   * noise. No tuned constant, and the reported estimate is never consulted (D7).
   */
  function contradicts(a, b) {
    const allowed = a.delayMs / 2 + b.delayMs / 2 + driftRate * Math.abs(a.atMs - b.atMs);
    return Math.abs(a.offsetMs - b.offsetMs) > allowed;
  }

  function mutuallyConsistent(group) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (contradicts(group[i], group[j])) return false;
      }
    }
    return true;
  }

  /**
   * Feed one exchange; `null` is a lost one, counted rather than an error.
   *
   * An impossible sample is COUNTED AND DROPPED, NEVER THROWN — a throw here is
   * a correctness assertion inside shipped code, on a measured path
   * (CONSTRAINTS.md → *Verification*) — and never silently dropped, because the
   * counter is the seam the check reads to tell the two apart.
   *
   * @param {{t1: number, t2: number, t3: number, t4: number}|null} sample
   */
  function add(sample) {
    if (sample === null || sample === undefined) {
      counters.lost += 1;
      return { accepted: false, reason: 'lost' };
    }

    const derived = deriveSample(sample);
    if (!Number.isFinite(derived.offsetMs) || !Number.isFinite(derived.delayMs) || derived.delayMs < 0) {
      counters.impossible += 1;
      return { accepted: false, reason: 'impossible' };
    }

    // Against the sample being published NOW, before this one can influence the
    // selection.
    const anchor = runAnchor ?? select();
    const contradicting = anchor !== null && contradicts(derived, anchor);
    if (contradicting) {
      run.push(derived);
      // ONLY THE LAST K MATTER. Uncapped, one corrupt sample contradicts every
      // post-step sample after it, the run can never agree with itself again,
      // and the detector is off permanently rather than delayed.
      run = run.slice(-confirmations);
      runAnchor = anchor;
    } else {
      run = [];
      runAnchor = null;
    }

    // Enters the window, but cannot be published out of it until confirmed.
    derived.eligible = !contradicting;

    samples.push(derived);
    if (samples.length > windowSize) samples = samples.slice(-windowSize);

    if (run.length >= confirmations && mutuallyConsistent(run)) {
      // ELIGIBILITY DOES NOT DEPEND ON `reanchor`: switching the purge off must
      // not leave a window whose samples can never become publishable.
      for (const s of run) s.eligible = true;
      if (reanchor) {
        // Keeping the samples that DO agree with the newest is what stops a
        // false purge from lying: the re-seeded uncertainty comes from their own
        // delays, so a false positive costs a less certain clock rather than a
        // confidently wrong one.
        samples = samples.filter((s) => !contradicts(s, derived));
        counters.reanchors += 1;
      }
      run = [];
      runAnchor = null;
    }

    return { accepted: true };
  }

  /**
   * The estimate as of `nowMs`, in the caller's own timebase.
   *
   * `offsetMs` IS NULL, NOT ZERO, before the first accepted sample: zero claims
   * this client is already aligned with the room, which is indistinguishable
   * from success in every number downstream (D9).
   *
   * `halfWidthMs` is a bound, not a score. `delayTermMs` is delay/2 because both
   * one-way legs are non-negative — that single assumption is the whole proof.
   * `ageTermMs` IS NOT OPTIONAL: the window advances on samples, not on time,
   * and minimum-delay selection prefers a quiet old sample to noisy fresh ones,
   * so without it the worse the path gets the tighter the reported uncertainty
   * stays. `spreadMs` is a diagnostic, deliberately NOT in the bound.
   *
   * @param {number} nowMs
   */
  function read(nowMs) {
    const selected = select();
    if (selected === null) {
      return {
        offsetMs: null,
        halfWidthMs: null,
        delayTermMs: null,
        ageTermMs: null,
        ageMs: null,
        bestDelayMs: null,
        spreadMs: null,
        sampleCount: 0,
        counters: { ...counters },
      };
    }

    // Reading before the sample being read about is a caller bug whose reachable
    // direction NARROWS the bound. Refuse the negative age rather than report a
    // bound tighter than the one that was earned.
    const ageMs = Math.max(0, nowMs - selected.atMs);
    const delayTermMs = selected.delayMs / 2;
    const ageTermMs = driftRate * ageMs;

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of samples) {
      if (s.offsetMs < lo) lo = s.offsetMs;
      if (s.offsetMs > hi) hi = s.offsetMs;
    }

    return {
      offsetMs: selected.offsetMs,
      halfWidthMs: delayTermMs + ageTermMs,
      delayTermMs,
      ageTermMs,
      ageMs,
      bestDelayMs: selected.delayMs,
      spreadMs: hi - lo,
      sampleCount: samples.length,
      counters: { ...counters },
    };
  }

  return {
    add,
    read,
    get sampleCount() {
      return samples.length;
    },
    get counters() {
      return { ...counters };
    },
    /** The settings in force, so a caller logging an estimate can log what produced it. */
    get settings() {
      return { windowSize, driftRate, confirmations, reanchor };
    },
  };
}
