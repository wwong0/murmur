// public/lib/playback-start.mjs
//
// When the video may open, where it opens, and the one event that re-opens it
// (change 3b design.md D1). It holds no timer and reads no clock: the caller
// polls it, and it calls back when the player must act.
//
// Rules that survive any edit:
//
//  1. NOTHING HERE TAKES A DRIFT FIGURE — nor may it be given one. That is the
//     seek change 4's whole job is to avoid.
//  2. A MISSING INPUT IS NAMED, NEVER SUBSTITUTED.
//  3. The state is committed AFTER `open` returns, so a player that threw is
//     retried rather than recorded as playing.
//
// Under public/lib/: no DOM, no page access.

/** The two inputs a client cannot begin aligned without, as a consumer reads them. */
export const MISSING_CLOCK = 'clock-estimate';
export const MISSING_REFERENCE = 'timeline-reference';

/**
 * @param {{timeline: {mediaMsAt: Function, epochMs: number|null},
 *   clock: {sharedNow: () => number|null},
 *   open: (at: {positionMs: number, epochMs: number, reopen: boolean}) => void}} config
 */
export function createPlaybackStart({ timeline, clock, open }) {
  /** The epoch the media was last opened against — null until it has been opened at all. */
  let openedEpochMs = null;
  /** Where the media is open now. A re-open moves it, because it moved the media. */
  let startedAtMediaMs = null;
  /** What the last poll was waiting for. Read by the seam, which does not poll. */
  let missing = MISSING_CLOCK;
  const counters = { opens: 0, reopens: 0 };

  /** A PURE READ. `poll` owns every field below; nothing on this path writes one. */
  function snapshot() {
    return {
      playing: openedEpochMs !== null,
      missing,
      epochMs: openedEpochMs,
      startedAtMediaMs,
      ...counters,
    };
  }

  /** Open, re-open, or do neither. Called on every roster and every render tick. */
  function poll() {
    const sharedMs = clock.sharedNow();
    if (sharedMs === null) {
      missing = MISSING_CLOCK;
      return snapshot();
    }
    const positionMs = timeline.mediaMsAt(sharedMs);
    if (positionMs === null) {
      missing = MISSING_REFERENCE;
      return snapshot();
    }
    // Past here nothing is a missing input, so a page still not playing is one
    // whose player did not open — naming an input it holds sends change 6 after
    // the wrong fault.
    missing = null;

    const epochMs = timeline.epochMs;
    const first = openedEpochMs === null;
    // The one way to stay put: already open, against this same epoch. A revision
    // arriving before the first open replaced an epoch nothing was ever opened
    // against, so it is not a re-open — it is where the first open goes.
    if (!first && epochMs === openedEpochMs) return snapshot();

    open({ positionMs, epochMs, reopen: !first });
    // Rule 3: `open` throwing leaves every field below untouched, so the next
    // poll retries the same open.
    openedEpochMs = epochMs;
    startedAtMediaMs = positionMs;
    if (first) counters.opens += 1;
    else counters.reopens += 1;
    return snapshot();
  }

  /** The seam and the read-out line read `state`; only the page polls. */
  return { poll, state: snapshot };
}
