// scripts/check/suites/presence.mjs — full-roster announcements and room reaping.

import { check, assert, assertEqual, sleep } from '../harness.mjs';
import { server } from '../fixtures.mjs';
import { TYPE_PRESENCE } from '../../../public/lib/envelope.mjs';

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
}
