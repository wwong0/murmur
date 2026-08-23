// scripts/check/suites/presence.mjs — full-roster announcements and room reaping.

import { check, assert, assertEqual, sleep } from '../harness.mjs';
import { server } from '../fixtures.mjs';
import { TYPE_JOINED, TYPE_PRESENCE } from '../../../public/lib/envelope.mjs';

export default async function presenceSuite() {
  await check('presence: joins and leaves are announced with the full roster, and empty rooms are reaped', async ({ room, peer, member }) => {
    const a = await member('A', 'host');
    await a.next((e) => e.type === TYPE_PRESENCE);

    const b = await peer('B');
    const bJoined = await b.join({ room, tabId: 'B', role: 'viewer' });

    const announced = await a.next((e) => e.type === TYPE_PRESENCE);
    assertEqual(announced.payload.event, 'join', 'event name');
    assertEqual(announced.payload.member.tabId, 'B', 'the member that changed');
    assertEqual(announced.payload.roster.length, 2, 'roster lists both members');

    // Both members hold identical rosters — the reason presence is a full
    // snapshot rather than a delta.
    const bPresence = await b.next((e) => e.type === TYPE_PRESENCE);
    assertEqual(JSON.stringify(bPresence.payload.roster), JSON.stringify(announced.payload.roster), 'rosters agree');
    assertEqual(bPresence.seq, announced.seq, 'both saw it at the same position in the order');
    // The joiner's own snapshot already contains the joiner: it is added to the
    // room before `joined` is built, so no member — including the newest — ever
    // holds a roster that omits someone already in the room.
    assertEqual(bJoined.payload.roster.length, 2, 'the joiner’s own snapshot includes itself');
    assertEqual(
      JSON.stringify(bJoined.payload.roster),
      JSON.stringify(announced.payload.roster),
      'the joiner’s snapshot matches what the existing member was told'
    );

    b.close();
    const left = await a.next((e) => e.type === TYPE_PRESENCE);
    assertEqual(left.payload.event, 'leave', 'event name');
    assertEqual(left.payload.roster.length, 1, 'roster shrank');
    assertEqual(left.payload.member.tabId, 'B', 'names who left');

    assert(server.rooms.has(room), 'the room survives while a member remains');
    // Closing the last member is part of the scenario here, not teardown: the
    // reap is what is being asserted.
    a.close();
    await a.waitClosed();
    await sleep(50);
    assert(!server.rooms.has(room), 'the room is reaped when the last member goes');
  });

  // The two properties of a roster entry's join time the room timeline rests on
  // (change 3a design.md D8). Both are already true of change 1's server and
  // neither was stated, which is how a later change breaks one with every
  // assertion still green.
  await check('presence: a new membership’s join time is stamped in the room timebase, and a reclaim keeps the one it had', async ({ room, peer }) => {
    // Sized against the event, not against the worst machine: `joinedAt` and
    // `ts.recv` are taken inside one synchronous join handler, so anything this
    // window admits is scheduling noise. Wide enough to catch what it is for —
    // seconds instead of milliseconds, a stamp from a previous join, a foreign
    // clock domain — and far too narrow to admit the reclaim gap below.
    const STAMP_WINDOW_MS = 25;

    const a = await peer('A');
    const joined = await a.join({ room, tabId: 'A', role: 'viewer' });
    assertEqual(joined.type, TYPE_JOINED, 'admitted');
    const mine = joined.payload.roster.find((m) => m.clientId === joined.payload.clientId);
    assert(mine !== undefined, 'the joiner’s own entry is in the roster it is given');

    // WHAT THIS PROVES: the join time is COMPARABLE with the room's own stamps,
    // which is what lets a client compare it against `sharedNow()`. WHAT IT DOES
    // NOT PROVE: which function produced it. The room timebase is
    // `performance.timeOrigin + performance.now()`, equal to `Date.now()` to
    // within a few milliseconds, so nothing observable from a client can tell
    // those two apart over a short run (D8).
    assert(Number.isFinite(mine.joinedAt), `the join time is a finite number, got ${mine.joinedAt}`);
    assert(
      Math.abs(mine.joinedAt - joined.ts.recv) <= STAMP_WINDOW_MS,
      `a new membership is stamped at the join: |joinedAt ${mine.joinedAt} - ts.recv ${joined.ts.recv}| exceeded ${STAMP_WINDOW_MS}ms`
    );
    assert(mine.joinedAt <= joined.ts.send, 'and no later than the reply that carried it');

    // A gap the stamp window cannot mistake for noise, so the comparison below
    // is about the reclaim and not about how fast this machine opened a socket.
    await sleep(60);
    const a2 = await peer('A2');
    const reclaim = await a2.join({ room, tabId: 'A', role: 'viewer', secret: joined.payload.secret });
    assertEqual(reclaim.type, TYPE_JOINED, 'the reclaim was admitted');
    const kept = reclaim.payload.roster.find((m) => m.clientId === reclaim.payload.clientId);

    assertEqual(kept.joinedAt, mine.joinedAt, 'a reclaimed membership keeps the join time it was first given');
    // The distinction room-timeline.mjs reads to tell a reclaim from a new
    // membership in a new room. Without it a page can carry a dead room's epoch
    // forever, and the monotonic rule guarantees it can never correct. Shown to
    // discriminate: stamping `joinedAt: recv` on a reclaim turns both of these
    // red, the equality on the value and this one on the gap.
    assert(
      reclaim.ts.recv - kept.joinedAt > STAMP_WINDOW_MS,
      `the kept join time is distinguishable from one stamped at this join: ts.recv ${reclaim.ts.recv} - joinedAt ${kept.joinedAt}`
    );
  });
}
