// scripts/check/drift-reporting-fixtures.mjs
//
// The simulated rig `suites/drift-reporting.mjs` and `suites/drift-settling.mjs`
// both drive, and the client that settles on it.

import { recordRig } from './drift-plant.mjs';

/**
 * `recordRig` with the simulated instant of every poll. `add` advances the rig's
 * clock by 20 ms and `advance` by its argument, so this mirror is exact; a
 * boundary assertion in the settling suite fails loudly if it ever stops being.
 */
export function timed(options = {}) {
  const rig = recordRig(options);
  let nowMs = 0;
  return {
    ...rig,
    get nowMs() { return nowMs; },
    add(driftMs) { rig.add(driftMs); nowMs += 20; },
    advance(ms) { rig.advance(ms); nowMs += ms; },
    poll(driftMs) {
      if (driftMs !== undefined) { rig.add(driftMs); nowMs += 20; }
      return rig.controller.poll();
    },
  };
}

/**
 * A client that corrects once, comes inside the threshold and holds there for
 * the dwell. It polls on every record, so every instant it reports is a
 * multiple of 20 ms and the 5000 ms dwell and 1000 ms excursion horizon both
 * land exactly on a poll.
 */
export function settle(rig) {
  for (let i = 0; i < 8; i++) rig.add(-200);
  const corrected = rig.poll();
  const correctedAt = rig.nowMs;
  let insideAt = null;
  let state = corrected;
  for (let i = 0; i < 400 && state.mode !== 'settled'; i++) {
    state = rig.poll(0);
    if (insideAt === null && (state.mode === 'declining' || state.mode === 'settled')) insideAt = rig.nowMs;
  }
  return { corrected, correctedAt, insideAt, settledAt: rig.nowMs, state };
}
