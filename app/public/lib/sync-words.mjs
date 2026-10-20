// The sync dot's tooltip lines (design.md D10), from `sync-dot.mjs`'s state and the controller's
// estimate. Positive is ahead of the room (`drift-readout.mjs`, `frame-drift.mjs`).

const HEADLINE = { 'in-sync': 'In sync', correcting: 'Catching up' };

// Idle has no figure to give, so its words say why: nothing plays, or nothing is measured yet.
const IDLE_WORDS = {
  paused: ['Paused', 'Measured while the video plays'],
  measuring: ['Measuring', 'No figure yet'],
};

/** One line for a state with no figure, two with one, two for idle, none for a state not known. */
export function syncWords({ state, estimateMs, playing } = {}) {
  if (state === 'idle') return [...IDLE_WORDS[playing === true ? 'measuring' : 'paused']];
  const headline = HEADLINE[state];
  if (headline === undefined) return [];
  if (!Number.isFinite(estimateMs)) return [headline];
  // The side follows the rounded figure: -0.4 rounds to zero, and zero is never "behind".
  const rounded = Math.round(estimateMs);
  return [headline, `${Math.abs(rounded)} ms ${rounded < 0 ? 'behind' : 'ahead of'} the room`];
}
