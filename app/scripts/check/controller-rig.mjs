// scripts/check/controller-rig.mjs
//
// A hand-written log and clock for driving a drift controller one poll at a
// time. Shared by stopping-research.mjs and stopping-product-integration.mjs so the product
// and the research copy are driven by one rig, not two that could disagree.
//
// The rig feeds identical drift values per poll, so the window's `p95 - p5` is
// exactly 0 and the band is the clock arm alone: U is a dial, and S = U + L a
// consequence of it.

import { createStoppingResearchController } from './stopping-research-controller.mjs';

export const BAND_MS = 4;

/**
 * One second between polls, deliberately not the product's 250 ms. The estimate
 * window is ESTIMATE_WINDOW_MS = 1000, so a step of exactly that length retires
 * the previous step's records before the next poll reads: the estimate is then
 * the value this step fed and nothing is averaged across a change of fixture.
 * At 250 ms a poll after a sign flip sees both signs and medians them, which is
 * a property of the rig rather than of the controller under test.
 */
export const STEP_MS = 1000;

/** The controller reads `log.read`, `log.latestSeq` and `clock.read()` and nothing else. */
export function rig({ factory = createStoppingResearchController, settings = {}, halfWidthMs = BAND_MS, options = {} } = {}) {
  const rows = [];
  const state = { nowMs: 0, offsetMs: 0, halfWidthMs, reanchors: 0, present: true };
  const applied = [];
  const snapshots = [];
  const log = {
    get latestSeq() { return rows.length; },
    read({ afterSeq = 0 } = {}) {
      return { records: rows.filter((row) => row.seq > afterSeq), latestSeq: rows.length, missed: 0 };
    },
  };
  const controller = factory({
    log,
    clock: {
      read: () => ({
        offsetMs: state.present ? state.offsetMs : null,
        halfWidthMs: state.halfWidthMs,
        counters: { reanchors: state.reanchors },
      }),
    },
    apply: (rate) => applied.push({ atMs: state.nowMs, rate }),
    settings,
    now: () => state.nowMs,
    ...options,
  });

  function poll(driftMs, { dtMs = STEP_MS, count = 8, silent = false } = {}) {
    if (!silent) {
      for (let k = 1; k <= count; k += 1) {
        rows.push({ seq: rows.length + 1, driftMs, displaySharedMs: state.nowMs + (dtMs * k) / count, clock: { offsetMs: state.offsetMs } });
      }
    }
    state.nowMs += dtMs;
    const snapshot = controller.poll();
    snapshots.push(snapshot);
    return snapshot;
  }

  function run(driftMs, times, options) {
    let last = null;
    for (let index = 0; index < times; index += 1) last = poll(driftMs, options);
    return last;
  }

  return { controller, state, applied, snapshots, poll, run, log };
}
