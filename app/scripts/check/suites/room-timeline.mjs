// scripts/check/suites/room-timeline.mjs
//
// The room timeline: what media position the room shows at an instant on the
// shared clock, and how its epoch is latched, kept and discarded.
//
// NOTHING IN HERE OPENS A SOCKET, TOUCHES A BROWSER OR WAITS FOR TIME. The
// module reads no clock — the caller supplies the instant — so
// every branch is reachable synchronously from a constructed roster. If a check
// in this file ever has to wait for something, the module has grown a timer it
// must not have.
//
// The drift record built ON TOP of this timeline is checked in drift.mjs, which
// shares nothing with this file but the module under test.

import { check, assertEqual } from '../harness.mjs';
import { createRoomTimeline } from '../../../public/lib/room-timeline.mjs';

/** A roster entry as the server publishes it (`rosterEntry` in room-server). */
const member = (clientId, joinedAt) => ({ clientId, tabId: clientId, role: 'viewer', joinedAt });

export default async function roomTimelineSuite() {
  await check('room-timeline: with no roster there is no position, and neither a usable roster nor a usable instant is assumed', async () => {
    const timeline = createRoomTimeline();
    assertEqual(timeline.epochMs, null, 'no epoch before any roster');
    // The whole point of D4: 0 is a legitimate media position, so returning it
    // here would read downstream as "this client is exactly at the start".
    assertEqual(timeline.mediaMsAt(12000), null, 'and no position — specifically not media time zero');

    // An entry carrying no usable join time is SKIPPED, not latched: an epoch of
    // `undefined` makes every later position NaN, and a NaN drift is a record
    // that still looks like a measurement.
    timeline.observeRoster([{ clientId: 'a' }, { clientId: 'b', joinedAt: null }]);
    assertEqual(timeline.epochMs, null, 'a roster carrying no usable join time leaves the timeline without a reference');
    timeline.observeRoster([{ clientId: 'a' }, member('b', 5000)]);
    assertEqual(timeline.epochMs, 5000, 'and the entries beside the unusable one are still read');

    // The instant is the caller's, so the caller is where a bad one comes from.
    assertEqual(timeline.mediaMsAt(NaN), null, 'a non-finite instant has no media position either');
  });

  await check('room-timeline: the epoch is the earliest join time in the roster, and the position follows from it', async () => {
    const timeline = createRoomTimeline();
    timeline.observeRoster([member('a', 5000), member('b', 7000), member('c', 9000)]);
    assertEqual(timeline.epochMs, 5000, 'the earliest join time in the roster');
    assertEqual(timeline.mediaMsAt(12000), 7000, 'an instant 7s after the epoch is 7s into the media');
    assertEqual(timeline.mediaMsAt(5000), 0, 'the epoch itself is media time zero');
  });

  await check('room-timeline: losing the earliest member does not move the epoch, and an earlier one does and is counted', async () => {
    const timeline = createRoomTimeline();
    timeline.observeRoster([member('a', 5000), member('b', 7000)]);
    timeline.observeRoster([member('b', 7000)]);
    assertEqual(timeline.epochMs, 5000, 'the departure of the earliest member leaves the epoch where it was');
    assertEqual(timeline.counters.epochRevisions, 0, 'and is not a revision');
    assertEqual(timeline.mediaMsAt(12000), 7000, 'so the room timeline did not step');

    // The reclaim gap: a member whose entry was briefly absent reappears with
    // the join time it always had, and the client that latched a later epoch
    // while it was gone corrects itself.
    const late = createRoomTimeline();
    late.observeRoster([member('b', 7000)]);
    assertEqual(late.epochMs, 7000, 'a client that never saw the earliest member latches what it saw');
    late.observeRoster([member('a', 5000), member('b', 7000)]);
    assertEqual(late.epochMs, 5000, 'and moves earlier when the roster reveals it');
    assertEqual(late.counters.epochRevisions, 1, 'the step is counted, because every record measured before it used the old epoch');
  });

  await check('room-timeline: a fresh membership discards the latched epoch and a reclaim keeps it', async () => {
    // Both timelines latch 3000 from a member that has since left, so the epoch
    // is NOT recoverable from the roster handed to the join below. That is what
    // makes the two directions distinguishable: an implementation that always
    // discards passes the first half, one that keeps the monotonic rule
    // unconditionally passes the second, and neither passes both.
    const rosterNow = [member('c2', 5000), member('b', 7000)];

    const fresh = createRoomTimeline();
    fresh.observeJoin({ clientId: 'c1', roster: [member('c1', 3000)] });
    assertEqual(fresh.epochMs, 3000, 'latched on the first join');
    // A new membership: the server stamps a join time at the join rather than
    // restoring the one the membership held.
    fresh.observeJoin({ clientId: 'c2', roster: rosterNow });
    assertEqual(fresh.epochMs, 5000, 'a fresh membership adopts the new room’s epoch, later than the one it held');
    assertEqual(fresh.counters.epochRevisions, 0, 'a discard is not a revision');
    assertEqual(fresh.counters.freshJoins, 2, 'both joins were new memberships');

    const reclaimed = createRoomTimeline();
    reclaimed.observeJoin({ clientId: 'c1', roster: [member('c1', 3000)] });
    // A reclaim mints a NEW clientId and restores the membership's join time,
    // so the join time is the only continuity there is to read.
    reclaimed.observeJoin({ clientId: 'c2', roster: [member('c2', 3000), member('b', 7000)] });
    assertEqual(reclaimed.epochMs, 3000, 'a reclaim keeps the epoch it had, including one no roster can rebuild');
    assertEqual(reclaimed.counters.freshJoins, 1, 'and is not counted as a fresh join');
  });

  await check('room-timeline: two clients that saw the same rosters in different orders agree', async () => {
    // The property that makes two clients' logs comparable at all (D1). The
    // middle roster carries the earliest join time, so an implementation that
    // latched the FIRST roster's minimum instead of the running one answers
    // 7000 here and 9000 in the other order.
    const rosters = [
      [member('b', 7000)],
      [member('a', 5000), member('b', 7000)],
      [member('b', 7000), member('c', 9000)],
    ];
    const forwards = createRoomTimeline();
    for (const roster of rosters) forwards.observeRoster(roster);
    const backwards = createRoomTimeline();
    for (const roster of [...rosters].reverse()) backwards.observeRoster(roster);

    assertEqual(forwards.epochMs, backwards.epochMs, 'the same rosters in either order latch the same epoch');
    assertEqual(forwards.mediaMsAt(20000), backwards.mediaMsAt(20000), 'so both map an instant to the same media position');
    assertEqual(forwards.mediaMsAt(20000), 15000, 'and it is the position the earliest join time implies');
  });
}
