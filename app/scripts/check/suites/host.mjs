// scripts/check/suites/host.mjs — the one-host-per-room rule and the reclaim it allows.

import { check, assert, assertEqual } from '../harness.mjs';
import { TYPE_JOINED, TYPE_PRESENCE, TYPE_ERROR, ERROR_CODES } from '../../../public/lib/envelope.mjs';

export default async function hostSuite() {
  await check('host: a claim from a different tabId is refused and the socket survives', async ({ room, peer, member }) => {
    await member('H1', 'host', { tabId: 'A' });

    const h2 = await peer('H2');
    const refused = await h2.join({ room, tabId: 'B', role: 'host' });
    assertEqual(refused.type, TYPE_ERROR, 'reply type');
    assertEqual(refused.payload.code, ERROR_CODES.HOST_TAKEN, 'error code');
    assert(!h2.closed, 'the socket must stay open so the client can rejoin as a viewer');

    // ...and it can, on the same connection.
    const asViewer = await h2.join({ room, tabId: 'B', role: 'viewer' });
    assertEqual(asViewer.type, TYPE_JOINED, 'rejoining as a viewer on the same socket');
  });

  await check('host: the reclaim secret reclaims the role, and no member ever sees a hostless roster', async ({ room, peer, member }) => {
    const h1 = await member('H1', 'host', { tabId: 'A' });
    const viewer = await member('V');
    const seenBefore = viewer.received.length;

    // An earlier version reclaimed on the `tabId` alone. It now keys on the secret;
    // everything this assertion guarantees about the reclaim itself is unchanged.
    const h2 = await peer('H2');
    const reclaimed = await h2.join({ room, tabId: 'A', role: 'host', secret: h1.secret });
    assertEqual(reclaimed.type, TYPE_JOINED, 'the returning host is admitted');

    const code = await h1.waitClosed();
    assertEqual(code, 4000, 'the superseded connection is closed with the reclaim code');

    const after = await viewer.next((e) => e.type === TYPE_PRESENCE, 2000);
    assertEqual(after.payload.roster.filter((m) => m.role === 'host').length, 1, 'exactly one host after the reclaim');
    assertEqual(after.payload.roster.length, 2, 'the roster did not grow');

    // Every presence the viewer saw across the whole reclaim, including any it
    // saw before, must hold exactly one host — never zero, never two. This is
    // the assertion the design calls out as the kind that works in testing and
    // fails once under load.
    const presences = viewer.received.slice(seenBefore).filter((e) => e.type === TYPE_PRESENCE);
    for (const env of presences) {
      const hosts = env.payload.roster.filter((m) => m.role === 'host').length;
      assertEqual(hosts, 1, `presence seq=${env.seq} reported ${hosts} hosts`);
    }
    // A reclaim is one membership change, not a departure followed by an
    // arrival. The replaced connection's close is suppressed, so no `leave` is
    // ever broadcast for it.
    assertEqual(presences.filter((e) => e.payload.event === 'leave').length, 0, 'no leave for the replaced connection');
    assertEqual(presences.length, 1, 'the room observed a single membership change');
  });
}
