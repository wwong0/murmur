// What a run's polls cover: the gap test a recovery span is read against, the
// largest gap each page's polls left, and the brackets the timebase join rests on.

import { median } from '../../public/lib/frame-drift.mjs';

const finite = (value) => Number.isFinite(value);
const instantOf = (poll) => poll?.harnessAfterMs ?? poll?.harnessBeforeMs;

/** The largest stretch of `window` with no poll in it, its two edges included. */
export function coverageGap(polls, window) {
  const values = (polls ?? []).map(instantOf)
    .filter(finite).filter((at) => at >= window.startMs && at <= window.endMs).sort((a, b) => a - b);
  if (values.length < 2) return Infinity;
  return Math.max(values[0] - window.startMs, ...values.slice(1).map((at, index) => at - values[index]), window.endMs - values.at(-1));
}

/** The largest gap between two consecutive polls, and where it sits. No value under two polls. */
export function largestPollGap(polls) {
  const values = (polls ?? []).map(instantOf).filter(finite).sort((a, b) => a - b);
  if (values.length < 2) return null;
  let largest = { maxGapMs: -Infinity, fromMs: null, toMs: null };
  for (let index = 1; index < values.length; index += 1) {
    const gap = values[index] - values[index - 1];
    if (gap > largest.maxGapMs) largest = { maxGapMs: gap, fromMs: values[index - 1], toMs: values[index] };
  }
  return largest;
}

export function pollGaps({ hostPoll, viewerPolls = {} } = {}) {
  return {
    host: largestPollGap(hostPoll),
    viewers: Object.fromEntries(Object.entries(viewerPolls).map(([tag, polls]) => [tag, largestPollGap(polls)])),
  };
}

/** Half of the median and of the widest poll bracket. A bracket that ends before it begins cannot exist. */
export function bracketHalfWidths(polls) {
  const brackets = polls.map((poll) => poll.harnessAfterMs - poll.harnessBeforeMs);
  if (brackets.some((bracket) => !finite(bracket) || bracket < 0)) throw new RangeError('poll bracket is negative or missing');
  return {
    medianMs: median(brackets.slice().sort((a, b) => a - b)) / 2,
    maxMs: Math.max(...brackets) / 2,
  };
}

/**
 * A viewer's runway at one poll. The page publishes its held-ahead from the
 * playback mapping's anchor, which is the playhead only while the room is held
 * or paused; while playing the runway is that figure less the time played since
 * the anchor, floored at zero. A poll with no state, or no instant, has no value.
 */
export function runwayMs(poll, tag = 'a viewer') {
  const published = poll?.heldAhead?.heldAheadMs;
  if (!finite(published)) return null;
  if (published < 0) throw new RangeError(`${tag} published a held-ahead below zero: ${published}`);
  const state = poll.state;
  if (!state || typeof state !== 'object') return null;
  if (state.playing !== true || state.held === true) return published;
  const playedMs = poll.heldAhead.atPageMs + poll.clock?.offsetMs - state.atSharedMs;
  return finite(playedMs) ? Math.max(0, published - Math.max(0, playedMs)) : null;
}

/**
 * Each viewer's runway at `atMs`, from its last poll at or before the instant,
 * when that poll is no more than 1 000 ms before it. Otherwise no value.
 */
export function heldAheadAt(viewerPolls, tags, atMs, freshMs = 1_000) {
  return Object.fromEntries(tags.map((tag) => {
    const before = (viewerPolls?.[tag] ?? []).filter((poll) => finite(instantOf(poll)) && instantOf(poll) <= atMs);
    const poll = before.length ? before.reduce((last, entry) => (instantOf(entry) >= instantOf(last) ? entry : last)) : null;
    return [tag, poll && atMs - instantOf(poll) <= freshMs ? runwayMs(poll, tag) : null];
  }));
}
