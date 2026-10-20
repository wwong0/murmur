// The sync dot's tooltip lines (design.md D10), from `sync-dot.mjs`'s state and the controller's
// estimate. Positive is ahead of the room (`drift-readout.mjs`, `frame-drift.mjs`).

const HEADLINE = { 'in-sync': 'In sync', correcting: 'Catching up' };

/** One line for a state with no figure, two with one, none while idle. */
export function syncWords({ state, estimateMs } = {}) {
  const headline = HEADLINE[state];
  if (headline === undefined) return [];
  if (!Number.isFinite(estimateMs)) return [headline];
  // The side follows the rounded figure: -0.4 rounds to zero, and zero is never "behind".
  const rounded = Math.round(estimateMs);
  return [headline, `${Math.abs(rounded)} ms ${rounded < 0 ? 'behind' : 'ahead of'} the room`];
}
