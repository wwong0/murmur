// public/lib/room-timeline.mjs
//
// The reference drift is measured against: what media position the room should
// be showing at an instant on the shared clock (change 3a design.md D1, D2).
// Change 5 substitutes replicated play/pause/seek state behind `mediaMsAt`, so
// nothing above the interface may assume a roster produced the answer, or 1x.
//
// Rules that survive any edit:
//
//  - PURE. It reads no clock — the caller supplies the instant.
//  - The epoch is the MINIMUM JOIN TIME OBSERVED IN THIS ROOM INSTANCE, never
//    the minimum of the current roster: that one moves forward whenever the
//    earliest member leaves, stepping the room's timeline under everyone in it.
//  - No epoch yields `null`, NEVER 0. Zero is a media position, so a position
//    nobody agreed on would be indistinguishable from agreement (D4).
//
// Under public/lib/: no DOM, no page access.

/** @returns {number|null} the earliest usable join time in `roster`, or null. */
function earliestJoin(roster) {
  let earliest = null;
  for (const entry of roster ?? []) {
    const at = entry ? entry.joinedAt : undefined;
    if (!Number.isFinite(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

export function createRoomTimeline() {
  /** Media time zero plays at this instant on the shared clock. */
  let epochMs = null;

  /** The join time this client's own membership last carried — see `observeJoin`. */
  let ownJoinedAt = null;

  const counters = { epochRevisions: 0, freshJoins: 0 };

  /**
   * Latch the epoch to the earliest join time ever seen. A revision is a step in
   * every drift figure measured after it, so it is counted — the same reason D5
   * puts the epoch on every record.
   *
   * @param {{joinedAt?: number}[]} roster
   */
  function observeRoster(roster) {
    const earliest = earliestJoin(roster);
    if (earliest === null) return;
    if (epochMs === null) epochMs = earliest;
    else if (earliest < epochMs) {
      epochMs = earliest;
      counters.epochRevisions += 1;
    }
  }

  /**
   * A `joined` reply, the only place the room's identity can change. A page that
   * reconnects may land in a NEW room carrying the old one's epoch, which the
   * monotonic latch above could never correct — so anything but a reclaim
   * discards it. THE JOIN TIME IS THE WHOLE TEST: the server preserves a
   * reclaimed membership's and stamps a new one for every other join. FRESH IS
   * THE SAFE DIRECTION when the reply cannot be read — a needless discard
   * re-latches from the roster in hand, a needless keep is permanent and silent.
   *
   * @param {{clientId?: string, roster?: {clientId?: string, joinedAt?: number}[]}} joined
   */
  function observeJoin(joined) {
    const roster = (joined && joined.roster) ?? [];
    const mine = roster.find((entry) => entry && entry.clientId === (joined && joined.clientId));
    const joinedAt = mine && Number.isFinite(mine.joinedAt) ? mine.joinedAt : null;

    // Null on either side is not a reclaim — two unreadable replies are not
    // evidence of one membership.
    const reclaimed = joinedAt !== null && joinedAt === ownJoinedAt;
    if (!reclaimed) {
      epochMs = null;
      counters.freshJoins += 1;
    }
    ownJoinedAt = joinedAt;
    observeRoster(roster);
  }

  /** The media position the room shows at the shared-clock instant `sharedMs`. */
  function mediaMsAt(sharedMs) {
    if (epochMs === null || !Number.isFinite(sharedMs)) return null;
    return sharedMs - epochMs;
  }

  return {
    observeRoster,
    observeJoin,
    mediaMsAt,
    get epochMs() {
      return epochMs;
    },
    get counters() {
      return { ...counters };
    },
  };
}
