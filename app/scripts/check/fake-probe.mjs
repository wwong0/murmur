// scripts/check/fake-probe.mjs
//
// A probe that manufactures round-trip samples from a KNOWN TRUTH: a true offset
// and a described path. It is the only party in the check that knows the answer,
// and every filter assertion compares the filter's output against it. It exists
// because a real network cannot be asked for a 200ms/5ms path, a step, or a
// physically impossible sample on demand (design.md D10).
//
// TEST MACHINERY — under scripts/, so it cannot reach the browser bundle.
//
// IT IS SEEDED, and the same seed produces the same samples on every run: a
// regime that fails one run in fifty teaches everyone to re-run failures away.
// The seed is reported by `describe()`.

/** mulberry32: one 32-bit word of state, deterministic across platforms. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * THE REASON THIS FILE CAN CHECK THE FILTER AT ALL: the filter derives
 * `(offset, delay)` BACKWARDS out of four timestamps, and this builds those four
 * FORWARDS out of the quantities a network actually has — two independent
 * directions through the same arithmetic. With `theta` the true offset
 * (reference clock minus client clock):
 *
 *   t1                              client writes
 *   t2 = t1 + out + theta           reference receives, in ITS timebase
 *   t3 = t2 + service               reference replies
 *   t4 = (t3 - theta) + back        client receives, in ITS timebase
 *
 * `service` cancels out of the derived delay by construction, which is what
 * makes `delay` offset-free and D6's impossibility test meaningful.
 */
function buildSample({ t1, theta, outMs, backMs, serviceMs }) {
  const t2 = t1 + outMs + theta;
  const t3 = t2 + serviceMs;
  const t4 = t3 - theta + backMs;
  return { t1, t2, t3, t4 };
}

/**
 * Each exchange is `{index, lost, sample, truth}`, where `truth` is what it was
 * built from — the true offset, the two one-way delays actually applied (jitter
 * and spikes included), and their sum.
 *
 * `trueOffsetMs`, `outMs` and `backMs` each take a constant OR A FUNCTION OF THE
 * EXCHANGE INDEX, which is how a step and a path that changes partway through
 * are one mechanism rather than two. `spikes` adds delay to ONE leg — a
 * symmetric spike is not the failure mode under study. `impossibleAt` makes the
 * reference's own interval exceed the client's, which no consistent pair of
 * monotonic timebases can produce.
 *
 * @param {{seed?: number, trueOffsetMs?: number|Function, outMs?: number|Function,
 *   backMs?: number|Function, serviceMs?: number, jitterMs?: number,
 *   lossRate?: number, startMs?: number, intervalMs?: number,
 *   gapBeforeMs?: Record<number, number>, spikes?: Record<number, object>,
 *   impossibleAt?: Record<number, boolean>}} [spec]
 */
export function createFakeProbe(spec = {}) {
  const {
    seed = 1,
    trueOffsetMs = 0,
    outMs = 10,
    backMs = 10,
    serviceMs = 1,
    jitterMs = 0,
    lossRate = 0,
    startMs = 1_000_000,
    intervalMs = 2000,
    gapBeforeMs = {},
    spikes = {},
    impossibleAt = {},
  } = spec;

  const random = mulberry32(seed);
  // A constant or a function of the index, so a step in the true offset and a
  // path that changes partway through are one mechanism — the step scenarios
  // need both at once.
  const perIndex = (v) => (typeof v === 'function' ? v : () => v);
  const offsetAt = perIndex(trueOffsetMs);
  const outAt = perIndex(outMs);
  const backAt = perIndex(backMs);

  let index = 0;
  let clock = startMs;

  function next() {
    const i = index++;
    clock += gapBeforeMs[i] ?? 0;
    const t1 = clock;
    clock += intervalMs;

    const theta = offsetAt(i);
    const spike = spikes[i] ?? {};
    // Three draws, always, used or not: the sequence a seed produces must not
    // depend on which regime is running.
    const jOut = random() * jitterMs;
    const jBack = random() * jitterMs;
    const lossDraw = random();

    const out = outAt(i) + jOut + (spike.outMs ?? 0);
    const back = backAt(i) + jBack + (spike.backMs ?? 0);
    const truth = { offsetMs: theta, outMs: out, backMs: back, delayMs: out + back };

    if (lossRate > 0 && lossDraw < lossRate) {
      return { index: i, lost: true, sample: null, truth };
    }

    const sample = buildSample({ t1, theta, outMs: out, backMs: back, serviceMs });

    if (impossibleAt[i]) {
      // The reference reports holding the message longer than the whole round
      // trip took — the fault a later change introduces by moving a timestamp
      // "somewhere more convenient". Built by moving `t3`, so the sample is
      // malformed the way a misplaced stamp malforms it rather than by writing
      // nonsense into a field.
      sample.t3 = sample.t2 + (sample.t4 - sample.t1) + 1;
    }

    return { index: i, lost: false, sample, truth };
  }

  return {
    seed,
    next,

    /** The next `n` exchanges, losses included. */
    take(n) {
      const out = [];
      for (let k = 0; k < n; k++) out.push(next());
      return out;
    },

    /**
     * Printed by any assertion that fails: a seeded generator whose seed is not
     * reported is only half reproducible.
     */
    describe() {
      const leg = (v) => (typeof v === 'function' ? 'per-index' : `${v}ms`);
      return `fake-probe(seed=${seed}, out=${leg(outMs)}, back=${leg(backMs)}, jitter=${jitterMs}ms, loss=${lossRate}, interval=${intervalMs}ms)`;
    },
  };
}
