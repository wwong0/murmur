// scripts/check/suites/routing.mjs — directed vs room-scoped delivery, the
// non-interpretation invariant, and anti-spoofing.

import { check, assert, assertEqual } from '../harness.mjs';
import { PROTOCOL_VERSION, ADDR_ROOM, TYPE_ERROR, ERROR_CODES } from '../../../public/lib/envelope.mjs';

export default async function routingSuite() {
  await check('routing: a directed envelope reaches only its target, with seq null', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    const c = await member('C');

    a.send({ v: PROTOCOL_VERSION, type: 'whisper', to: b.clientId, payload: { n: 1 } });
    const got = await b.next((e) => e.type === 'whisper');
    assertEqual(got.seq, null, 'directed envelopes are outside the room order');
    assertEqual(got.from, a.clientId, 'from is the true sender');
    assertEqual(got.to, b.clientId, 'to is preserved');
    await c.none((e) => e.type === 'whisper');
  });

  await check('routing: an unknown recipient errors to the sender and reaches no one', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');

    a.send({ v: PROTOCOL_VERSION, type: 'whisper', to: 'c-deadbeef', payload: {} });
    const err = await a.next((e) => e.type === TYPE_ERROR);
    assertEqual(err.payload.code, ERROR_CODES.UNKNOWN_RECIPIENT, 'error code');
    assert(!a.closed, 'the sender survives');
    await b.none((e) => e.type === 'whisper');

    // ...and the connection still works afterwards.
    a.send({ v: PROTOCOL_VERSION, type: 'whisper', to: b.clientId, payload: { ok: true } });
    await b.next((e) => e.type === 'whisper');
  });

  await check('routing: a room-scoped envelope reaches every member including the sender, gaplessly', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    const c = await member('C');

    const senders = [a, b, c];
    for (let i = 0; i < 9; i++) senders[i % 3].send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: { i } });

    for (const peer of senders) {
      const seen = [];
      for (let i = 0; i < 9; i++) seen.push(await peer.next((e) => e.type === 'shout'));
      assertEqual(seen.length, 9, `${peer.label} received every shout, its own included`);
      // Within one connection the room stream is 1, 2, 3, ... with no holes.
      const scoped = peer.roomScoped();
      for (let i = 1; i < scoped.length; i++) {
        assertEqual(scoped[i].seq, scoped[i - 1].seq + 1, `${peer.label} seq stream is consecutive`);
      }
    }

    // ...and every member saw the same order.
    const orderOf = (p) => p.received.filter((e) => e.type === 'shout').map((e) => `${e.seq}:${e.payload.i}`).join(',');
    assertEqual(orderOf(b), orderOf(a), 'B observed the same total order as A');
    assertEqual(orderOf(c), orderOf(a), 'C observed the same total order as A');
  });

  await check('D3 invariant: an unregistered type with an arbitrary body is relayed byte-identically', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');

    // A type the server has never heard of, carrying a body with nesting, an
    // array, a null, a number the server might be tempted to touch, unicode, and
    // a key that collides with a routing field name.
    const body = {
      ice: [{ candidate: 'a=candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host', sdpMLineIndex: 0 }],
      nested: { deep: { deeper: [1, 2, { three: null }] } },
      seq: 'not the routing seq',
      from: 'not the routing from',
      unicode: 'héllo ✓ 🎬',
      zero: 0,
      negative: -1.5,
    };
    const sent = JSON.stringify(body);
    a.send({ v: PROTOCOL_VERSION, type: 'offer-ish-thing-from-change-7a', to: b.clientId, id: 'x-1', payload: body });

    const got = await b.next((e) => e.type === 'offer-ish-thing-from-change-7a');
    assertEqual(JSON.stringify(got.payload), sent, 'message body must arrive byte-identical');
    assertEqual(got.id, 'x-1', 'correlation id survives');
    // The routing fields the client tried to smuggle inside the body stayed
    // inside it, and the real routing fields are the server's.
    assertEqual(got.from, a.clientId, 'routing from is the true sender');
    assertEqual(got.seq, null, 'routing seq is the server’s, not the one in the body');
  });

  await check('D2 anti-spoofing: a forged `from` is replaced with the true sender', async ({ room, member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    const c = await member('C');

    // A claims to be B, and invents a room, a seq and a timebase while it is at it.
    a.send({
      v: PROTOCOL_VERSION,
      type: 'shout',
      to: ADDR_ROOM,
      from: b.clientId,
      room: 'some-other-room',
      seq: 99999,
      ts: { recv: 0, send: 0 },
      payload: {},
    });

    const seenByC = await c.next((e) => e.type === 'shout');
    assertEqual(seenByC.from, a.clientId, 'from is the true sender, not the claimed one');
    assertEqual(seenByC.room, room, 'room comes from connection state');
    assert(seenByC.seq !== 99999, 'seq comes from the room counter');
    assert(seenByC.ts.recv > 0 && seenByC.ts.send > 0, 'ts comes from the server clock');
  });

  await check('OQ1 insurance: one member can request another and match the reply by id', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');

    // This is change 2's fallback shape: if the room's time reference moves from
    // the server to the host tab, the probe becomes exactly this exchange — and
    // the server needs no change to carry it.
    a.send({ v: PROTOCOL_VERSION, type: 'peer-probe', to: b.clientId, id: 'probe-7', payload: { t1: 1 } });
    const atB = await b.next((e) => e.type === 'peer-probe');
    assertEqual(atB.id, 'probe-7', 'the id the sender chose arrives unchanged');

    b.send({ v: PROTOCOL_VERSION, type: 'peer-probe-reply', to: atB.from, replyTo: atB.id, payload: { t2: 2 } });
    const atA = await a.next((e) => e.type === 'peer-probe-reply');
    assertEqual(atA.replyTo, 'probe-7', 'the reply correlates to the original id');
    assertEqual(atA.from, b.clientId, 'the answer names the true answerer');
  });
}
