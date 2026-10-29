import { median } from '../measure/stats.mjs';

// Changing these bars changes the criteria in docs/PROPOSAL.md §6.
export const PROPOSAL_TARGETS = { multiplierAt: { 5: 1.5, 10: 2 }, medianMs: 40, p99Ms: 100, joinMs: 2000 };
// Readings step by 0.1 ms; a worst p99 within 1 ms rounds to the floor's millisecond or the next.
export const ONE_REFRESH_TOLERANCE_MS = 1;
export const driftLabel = (value, floor) => {
  return value == null ? 'no value' : value < floor ? `< ${Math.round(floor)} ms` : `${Math.round(value)} ms`;
};
export const driftShown = (value, floor) => {
  return Math.max(value, floor);
};
export const pct = (value) => {
  return `${Math.round(value * 100)}%`;
};
export const countText = (k, m, what) => {
  return `${k} of ${m} ${what}`;
};
export const armSummary = (values) => {
  return ({ n: values.length, median: median(values.filter(Number.isFinite)) });
};
export function runMark(entry, value) {
  const figures = entry.figures ?? {};
  const failed = Object.entries(figures.steadyState?.legs ?? {}).find(([, leg]) => leg?.pass === false);
  const reason = !entry.valid
    ? (entry.reasons ?? []).join(', ')
    : figures.hostUploadMultiplierRefusal?.reason ??
      (figures.steadyState?.steady === false && failed ? `not steady: ${failed[0]}` : 'no value');
  return {
    filled: Boolean(entry.valid && value != null),
    reason: entry.valid && value != null ? null : reason,
  };
}
