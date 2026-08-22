// scripts/check/suites/join.mjs — what a `joined` reply carries, and the version gate.

import { check, assert, assertEqual } from '../harness.mjs';
import { server } from '../fixtures.mjs';
import { PROTOCOL_VERSION, ADDR_SERVER, TYPE_JOINED, TYPE_PRESENCE, TYPE_ERROR, ERROR_CODES } from '../../../public/lib/envelope.mjs';

export default async function joinSuite() {
  await check('join: `joined` carries clientId, roster, room seq and server time', async ({ room, peer }) => {
    const a = await peer('A');
    const joined = await a.join({ room, tabId: 'A', role: 'host' });
    assertEqual(joined.type, TYPE_JOINED, 'reply type');
    assertEqual(joined.from, ADDR_SERVER, 'joined.from');
    assertEqual(joined.seq, null, 'joined is directed, so it is outside the room order');
    assert(/^c-[0-9a-f]{8}$/.test(joined.payload.clientId), `clientId shape: ${joined.payload.clientId}`);
    assertEqual(joined.payload.roster.length, 1, 'roster length');
    assertEqual(joined.payload.roster[0].tabId, 'A', 'roster tabId');
    assertEqual(joined.payload.roster[0].role, 'host', 'roster role');
    assertEqual(typeof joined.payload.seq, 'number', 'room seq is a number');
    assertEqual(typeof joined.payload.serverTime, 'number', 'serverTime is a number');

    // The first room-scoped envelope after joining carries the next value.
    const presence = await a.next((e) => e.type === TYPE_PRESENCE);
    assertEqual(presence.seq, joined.payload.seq + 1, 'first room-scoped seq follows the reported one');
  });

  await check('join: a wrong protocol version is refused and the client is not added', async ({ room, peer }) => {
    const a = await peer('A');
    const reply = await a.join({ room, tabId: 'A', role: 'viewer', v: PROTOCOL_VERSION + 99 });
    assertEqual(reply.type, TYPE_ERROR, 'reply type');
    assertEqual(reply.payload.code, ERROR_CODES.VERSION_MISMATCH, 'error code');
    assertEqual(reply.payload.expected, PROTOCOL_VERSION, 'error names the expected version');
    assertEqual(reply.payload.got, PROTOCOL_VERSION + 99, 'error names the received version');
    assert(!server.rooms.has(room), 'a refused join must not create or populate a room');
  });
}
