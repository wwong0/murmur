// scripts/check/suites/room-client.mjs
//
// Every other suite drives the server with raw sockets. This one drives it
// through the module the browser actually uses, because three of the properties
// that matter most — correlation, where the timestamps come from, and gap
// detection — live in that module rather than on the wire.

import {
  check,
  checkGroup,
  assert,
  assertEqual,
  sleep,
  nextRoom,
  rosterOfRoom,
  recordingSocket,
  waitEvent,
  joinsIn,
  joinedIn,
} from '../harness.mjs';
import { server, WS, SLOW_WS, LIVENESS_MS, SLOW_LIVENESS_MS } from '../fixtures.mjs';
import {
  PROTOCOL_VERSION,
  ADDR_ROOM,
  ADDR_SERVER,
  ERROR_CODES,
  TYPE_ECHO,
  TYPE_ECHO_REPLY,
  TYPE_JOIN,
  TYPE_JOINED,
} from '../../../public/lib/envelope.mjs';

/**
 * The refusal under test is the server's, so it has to be provoked on the wire —
 * but the DEFECT is in room-client's handling of it, so the join has to be
 * room-client's own. `buildJoinEnvelope` stays untouched: rewriting it would
 * change what every other check sends.
 */
const staleJoin = (env) => (env.type === TYPE_JOIN ? { ...env, v: PROTOCOL_VERSION - 1 } : env);

export default async function roomClientSuite() {
  await check('room-client: request resolves on its own reply and not on another of the same type', async ({ client }) => {
    const c = client('RC1', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    // A second echo-reply is in flight for a different id at the same time.
    const [first, second] = await Promise.all([c.echo(), c.echo()]);
    assert(first.replyTo !== second.replyTo, 'the two calls used different ids');
    assertEqual(first.type, TYPE_ECHO_REPLY, 'first resolved with an echo-reply');
    assertEqual(second.type, TYPE_ECHO_REPLY, 'second resolved with an echo-reply');

    const pending = c.request({ type: TYPE_ECHO, to: ADDR_SERVER, timeoutMs: 2500 });
    const resolved = await pending;
    assert(resolved.replyTo !== first.replyTo, 'each call resolved with its own reply');
  });

  // The assertion the check above USED to claim to make and did not. It issued
  // a third ordinary request and watched it get its own reply, which no forgery
  // is involved in. Written honestly here (design.md D11): the envelope comes
  // from a second member, carries the outstanding correlation id, and must not
  // resolve the call.
  await check('room-client: a reply from a party the request was not addressed to does not resolve it', async ({ member, client }) => {
    const c = client('RC-FORGE', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    const forger = await member('forger', 'viewer', { tabId: 'FORGER' });

    // `probe` addressed to the server has no handler, so the server refuses it
    // with an error carrying no `replyTo`. The call therefore stays outstanding
    // and the forged reply is the ONLY envelope that could resolve it — no race
    // with a genuine one, and nothing here depends on arrival order.
    const pending = c.request({ type: 'probe', to: ADDR_SERVER, timeoutMs: 700 });
    const dispatched = [];
    c.on('probe-reply', (env) => dispatched.push(env));
    const uncorrelated = [];
    c.onEvent('uncorrelated-reply', (d) => uncorrelated.push(d));

    // `m-0` is this client's first request id. They are sequential and
    // therefore guessable, which is the point: the id is not a secret and the
    // fix must not rest on it being one.
    forger.send({
      v: PROTOCOL_VERSION,
      type: 'probe-reply',
      to: c.clientId,
      replyTo: 'm-0',
      payload: { forged: true },
    });

    let resolvedWith = null;
    let rejection = null;
    await pending.then(
      (env) => (resolvedWith = env),
      (err) => (rejection = err)
    );

    assertEqual(
      resolvedWith,
      null,
      `the forged reply must not resolve the pending call (it resolved with ${JSON.stringify(resolvedWith)})`
    );
    assert(rejection !== null && /timed out/.test(rejection.message), 'the call stayed outstanding and timed out');
    // Not dropped: it is still an envelope of a type somebody may be listening
    // for, and swallowing it would hide the forgery from the page as well.
    assertEqual(dispatched.length, 1, 'the forged envelope still reached subscribers by type');
    assertEqual(dispatched[0].from, forger.clientId, 'and it carries the forger’s identity, filled in by the server');
    assertEqual(dispatched[0].local.t1, null, 'no send time is attached to an envelope that answers nothing');
    // Reported, so a page can say a member is sending replies to exchanges that
    // never happened rather than silently dropping them.
    assertEqual(uncorrelated.length, 1, 'the uncorrelated reply was reported exactly once');
    assertEqual(uncorrelated[0].from, forger.clientId, 'naming who sent it');
    assertEqual(uncorrelated[0].expectedFrom, ADDR_SERVER, 'and who the call was addressed to');

    // The check that the `from` gate did not simply break correlation: an
    // ordinary exchange with the server still resolves, after the forgery.
    const genuine = await c.echo();
    assertEqual(genuine.from, ADDR_SERVER, 'a genuine reply from the addressed party still resolves the call');
    assertEqual(uncorrelated.length, 1, 'and does not report itself as uncorrelated');
  });

  await check('room-client: a request addressed to a member resolves on that member’s reply', async ({ member, client }) => {
    const c = client('RC-DIRECT', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    const responder = await member('responder', 'viewer', { tabId: 'RESPONDER' });

    // The case the `from` check must not break. Change 1's *one member can
    // request another and match the reply by id* covers this on the raw wire
    // only; the address is half the correlation key in THIS module, so it is
    // this module that has to be shown still able to talk to a member.
    const pending = c.request({ type: 'ping', to: responder.clientId, timeoutMs: 2000 });
    const asked = await responder.next((e) => e.type === 'ping');
    responder.send({ v: PROTOCOL_VERSION, type: 'pong', to: asked.from, replyTo: asked.id, payload: {} });

    const reply = await pending;
    assertEqual(reply.type, 'pong', 'the call resolved with the member’s answer');
    assertEqual(reply.from, responder.clientId, 'from the member it was addressed to');
    assertEqual(typeof reply.local.t1, 'number', 'and it carries the round-trip stamps, so a probe could ride on it');
  });

  await check('room-client: a complete round-trip sample is attached, and t1 <= ts.recv <= ts.send <= t4', async ({ room, peer, client }) => {
    const c = client('RC2', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    for (let i = 0; i < 5; i++) {
      const reply = await c.echo();
      assert(reply.local, 'the delivered envelope carries local timestamps');
      assertEqual(typeof reply.local.t1, 'number', 't1 is a number');
      assertEqual(typeof reply.local.t4, 'number', 't4 is a number');
      assert(reply.local.t1 <= reply.local.t4, `t1 (${reply.local.t1}) must not exceed t4 (${reply.local.t4})`);
      // Same process, same timeOrigin, so the client's stamps must bracket the
      // server's exactly. A stamp taken in the wrong place breaks this.
      assert(reply.local.t1 <= reply.ts.recv, 'client send precedes server receive');
      assert(reply.ts.send <= reply.local.t4, 'server send precedes client receive');
    }

    // `local` is local: it must never have been on the wire.
    const raw = await peer('raw');
    await raw.join({ room, tabId: 'raw', role: 'viewer' });
    raw.send({ v: PROTOCOL_VERSION, type: TYPE_ECHO, to: ADDR_SERVER, id: 'q', payload: {} });
    const onWire = await raw.next((e) => e.type === TYPE_ECHO_REPLY);
    assertEqual(onWire.local, undefined, 'the local timestamps are never transmitted');
  });

  // SERIAL, deliberately: this one measures a 40ms burn against the gap between
  // t4 and resolution. Concurrency would make the bound meaningless.
  await check('room-client: a slow subscriber for the reply type cannot move the recorded t4', async ({ client }) => {
    const c = client('RC3', 'host');
    const joined = waitEvent(c, 'joined');
    c.connect();
    await joined;

    // This is the change-3-subscriber-logs-drift scenario, exaggerated. If t4
    // were taken where a caller would naturally take it — after the request
    // resolves — this 40ms of unrelated work would land inside every offset
    // estimate, always in the same direction.
    const BURN_MS = 40;
    c.on(TYPE_ECHO_REPLY, () => {
      const until = performance.now() + BURN_MS;
      while (performance.now() < until) {
        /* deliberately blocking */
      }
    });

    const reply = await c.echo();
    const afterResolve = performance.timeOrigin + performance.now();
    const bias = afterResolve - reply.local.t4;
    assert(bias >= BURN_MS * 0.8, `the subscriber should have run between t4 and resolution, gap was ${bias.toFixed(1)}ms`);
    assert(reply.ts.send <= reply.local.t4, 't4 still brackets the server send, so the sample stayed clean');
    assert(reply.local.t4 - reply.ts.send < BURN_MS, 'the subscriber’s work did not enter the sample');
  });

  await check('room-client: the retained secret is replaced on every joined and presented on the next rejoin', async ({ room, peer, member, client }) => {
    await member('anchor', 'host', { tabId: 'ANCHOR' });

    const { Impl, wire } = recordingSocket();
    const c = client('RC-SECRET', 'viewer', { WebSocketImpl: Impl });
    const first = waitEvent(c, 'joined');
    c.connect();
    const firstJoin = await first;

    assertEqual(joinsIn(wire).length, 1, 'one join so far');
    assertEqual(joinsIn(wire)[0].payload.secret, undefined, 'a FIRST join presents no secret');
    const s1 = joinedIn(wire)[0].payload.secret;
    assertEqual(typeof s1, 'string', 'the joined reply carried a secret');
    // D8's client half: the role reported is the one the server gave, read back
    // from the roster entry for this very clientId.
    assertEqual(firstJoin.role, 'viewer', 'the joined event reports the role the server assigned');
    assertEqual(c.role, 'viewer', 'and the client reports the same');
    assertEqual(c.secret, undefined, 'the secret is not exposed to callers');

    // Drop the socket without a close frame, so the client reconnects by itself.
    for (let i = 0; i < 2; i++) {
      const rejoined = waitEvent(c, 'joined', 5000);
      wire.socket.terminate();
      await rejoined;
    }

    const joins = joinsIn(wire);
    const replies = joinedIn(wire);
    assertEqual(joins.length, 3, 'three joins were made');
    assertEqual(replies.length, 3, 'and three were answered');
    // The heart of D2's client half: each rejoin presents the secret from the
    // MOST RECENT reply, never the first. A client that kept its original secret
    // would be presenting a credential for a member that no longer exists.
    assertEqual(joins[1].payload.secret, replies[0].payload.secret, 'the second join presented the first reply’s secret');
    assertEqual(joins[2].payload.secret, replies[1].payload.secret, 'the third join presented the second reply’s secret');
    assert(joins[2].payload.secret !== joins[1].payload.secret, 'the held secret was replaced, not accumulated');
    assert(replies[1].payload.secret !== replies[0].payload.secret, 'and the server rotated it on every join');

    // ...and the secret the client holds right now is genuinely the live one: a
    // connection presenting it performs a real reclaim.
    const superseded = waitEvent(c, 'superseded', 3000);
    const taker = await peer('taker');
    const reclaimed = await taker.join({
      room,
      tabId: 'RC-SECRET',
      role: 'viewer',
      secret: replies[2].payload.secret,
    });
    assertEqual(reclaimed.type, TYPE_JOINED, 'the secret the client currently holds performs a reclaim');
    await superseded;
  });

  await check('room-client: a reconnect across missed room traffic reports the gap', async ({ member, client }) => {
    const other = await member('other', 'host', { tabId: 'other' });

    const c = client('RC4', 'viewer');
    const firstJoin = waitEvent(c, 'joined');
    c.connect();
    await firstJoin;

    // Some traffic it does see, so lastSeq is meaningful.
    other.send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: { n: 1 } });
    await new Promise((resolve) => c.on('shout', resolve));
    const before = c.lastSeq;
    assertEqual(typeof before, 'number', 'the client tracked a room-scoped seq');

    const gap = waitEvent(c, 'gap', 5000);
    const rejoined = waitEvent(c, 'joined', 5000);
    let gapCount = 0;
    c.onEvent('gap', () => gapCount++);

    // Drop the connection without warning, then emit room traffic it cannot
    // possibly see. This is the four-seconds-of-wifi scenario from design.md D5.
    c.close();
    for (let i = 0; i < 3; i++) other.send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: { n: i } });
    await sleep(30);
    c.connect();

    const [gapEvent, joinEvent] = await Promise.all([gap, rejoined]);
    assertEqual(gapEvent.expected, before + 1, 'the gap names the value the client was expecting');
    assertEqual(gapEvent.actual, joinEvent.seq, 'the gap names the value the rejoin reported');
    assert(gapEvent.actual > gapEvent.expected, 'and that value is genuinely ahead of it');
    assertEqual(gapCount, 1, 'exactly one gap is reported, not one per missed message');
    // lastSeq has already moved past the rejoin's value, because the rejoin's
    // own presence broadcast follows it immediately — the client resynchronises
    // to the room's order rather than stalling on the hole.
    assert(c.lastSeq >= joinEvent.seq, `client resynchronised (lastSeq ${c.lastSeq} >= ${joinEvent.seq})`);

    // Report, do not repair: nothing was replayed or refetched, and the order is
    // consecutive again from here on.
    const shoutsAfter = [];
    c.on('shout', (e) => shoutsAfter.push(e));
    for (let i = 0; i < 3; i++) other.send({ v: PROTOCOL_VERSION, type: 'shout', to: ADDR_ROOM, payload: { n: `after-${i}` } });
    await sleep(300);
    assertEqual(shoutsAfter.length, 3, 'only new traffic arrives; the missed messages are not recovered');
    assertEqual(gapCount, 1, 'no further gap is reported once the client has resynchronised');
  });

  // -------------------------------------------------------------------------
  // The refusal-policy checks, run CONCURRENTLY.
  //
  // These were 61% of the whole check's wall time and none of it was work: they
  // sit in sleeps proving negatives, or wait out a liveness sweep or a
  // reconnect backoff. Each takes a room of its own, every assertion in them is
  // room-scoped, and their time bounds are either lower bounds or carry six
  // seconds of slack — so concurrency cannot move any of them.
  // -------------------------------------------------------------------------
  await checkGroup([
    ['room-client: a join refusal it carries no policy for stops it and is reported', async ({ room, client }) => {
      // A page running an older bundle than the server, which is what a bumped
      // PROTOCOL_VERSION produces and what CONSTRAINTS.md → *Reachable is not
      // fresh* already names as reachable. Driven through room-client rather
      // than a raw peer: the server's refusal was never in doubt, the module's
      // handling of it was.
      const { Impl, wire } = recordingSocket({ rewrite: staleJoin });
      const c = client('STALE-BUNDLE', 'viewer', { WebSocketImpl: Impl });
      const refused = waitEvent(c, 'refused', 3000);
      let retried = 0;
      c.onEvent('refused-retrying', () => retried++);

      c.connect();
      const info = await refused;

      assertEqual(info.code, ERROR_CODES.VERSION_MISMATCH, 'the refusal is reported, naming its code');
      assertEqual(retried, 0, 'a refusal nothing can be done about is not retried');
      await sleep(900); // several reconnect backoff intervals
      assertEqual(joinsIn(wire).length, 1, 'exactly one join attempt was ever made');
      assertEqual(c.isConnected, false, 'the client stops reporting itself as connected');
      assertEqual(c.isJoined, false, 'and it never joined');
      assertEqual(rosterOfRoom(room).length, 0, 'the server admitted nobody');
    }],

    ['room-client: a name held by a dying connection is retried until the server frees it', async ({ member, client }) => {
      // THIS ASSERTION USED TO PASS FOR THE WRONG REASON. Under D11's fixed ~1s
      // budget it only worked because this check runs the interval at 120ms, where
      // the name frees inside that second; at the default 5000ms it would have been
      // red. So it now runs at two intervals, and the second one is chosen so that
      // a fixed one-second budget fails it.
      for (const [label, url, interval] of [
        ['check interval', WS, LIVENESS_MS],
        ['longer interval', SLOW_WS, SLOW_LIVENESS_MS],
      ]) {
        const room = nextRoom();
        await member(`${label}/anchor`, 'host', { url, room, tabId: 'ANCHOR' });
        const ghost = await member(`${label}/ghost`, 'viewer', { url, room, tabId: 'CONTESTED' });

        // Half-open, so the sweep will bury the ghost. This is the shape of the
        // case the retry exists for: the label the client wants is held by its OWN
        // dying connection.
        ghost.goSilent();

        const c = client('CONTESTED', 'viewer', { url, room });
        const joined = waitEvent(c, 'joined', 20000);
        let retried = 0;
        let gaveUp = 0;
        c.onEvent('refused-retrying', () => retried++);
        c.onEvent('refused', () => gaveUp++);

        const startedAt = Date.now();
        c.connect();
        await joined;
        const elapsed = Date.now() - startedAt;

        assert(retried >= 1, `${label}: refused at least once on the way in`);
        assertEqual(gaveUp, 0, `${label}: never reported a final refusal`);
        assertEqual(c.isJoined, true, `${label}: got in by itself, with no caller intervention`);
        // It cannot have got in before the sweep ran, and must have got in without
        // sitting out anything beyond the window the server reported.
        assert(elapsed >= interval, `${label}: waited for the sweep (${elapsed}ms >= ${interval}ms)`);
        assert(elapsed < interval * 3 + 6000, `${label}: got in within the reported window, took ${elapsed}ms`);
      }
    }],

    ['room-client: a superseded connection does not reconnect and take the role back', async ({ room, peer, member, client }) => {
      await member('viewer', 'viewer', { tabId: 'V' });

      const { Impl, wire } = recordingSocket();
      const first = client('SAME-TAB', 'host', { WebSocketImpl: Impl });
      const firstJoined = waitEvent(first, 'joined');
      first.connect();
      await firstJoined;

      let supersededEvents = 0;
      first.onEvent('superseded', () => supersededEvents++);

      // Under change 1 a second room-client with the same tabId reclaimed the role.
      // It no longer can — it has no secret — so the replacement is driven by a
      // connection that holds the first client's secret, read off the wire.
      const second = await peer('second');
      const secondJoined = await second.join({
        room,
        tabId: 'SAME-TAB',
        role: 'host',
        secret: joinedIn(wire)[0].payload.secret,
      });
      assertEqual(secondJoined.type, TYPE_JOINED, 'the reclaim is admitted');

      // The dangerous outcome is not that the first connection closes — that is
      // the design. It is that it reconnects, reclaims the role straight back, and
      // the two trade it forever, broadcasting presence to the room on every swap.
      // Rotation now makes that impossible rather than merely discouraged, and the
      // assertion is on the loop either way.
      await sleep(400);
      const seqAfterFirstSwap = server.rooms.get(room).seq;
      await sleep(1200); // several reconnect backoff intervals
      assertEqual(
        server.rooms.get(room).seq,
        seqAfterFirstSwap,
        'the room order stopped advancing, i.e. the two connections are not trading the host role'
      );
      assertEqual(first.isConnected, false, 'the superseded connection stays down');
      assertEqual(supersededEvents, 1, 'the superseded connection was told why, exactly once');
      assertEqual(joinsIn(wire).length, 1, 'and it never made a second join attempt');
      assertEqual(server.rooms.get(room).members.size, 2, 'the room holds the viewer and exactly one host');
    }],

    ['room-client: a name held by a live member is retried, reported, then given up on', async ({ room, member, client }) => {
      const holder = await member('holder', 'host', { tabId: 'TAKEN' });

      const c = client('TAKEN', 'viewer');
      const refused = waitEvent(c, 'refused', 10000);
      const retries = [];
      c.onEvent('refused-retrying', (d) => retries.push(d));
      let joins = 0;
      c.onEvent('joined', () => joins++);

      const startedAt = Date.now();
      c.connect();
      const info = await refused;
      const elapsed = Date.now() - startedAt;

      assertEqual(info.code, ERROR_CODES.TAB_TAKEN, 'the code it reported');
      assertEqual(typeof info.budgetMs, 'number', 'and the budget it had been working to');
      // Every attempt on the way is reported, so a page can say it is retrying
      // rather than going silent until the budget expires. That is what makes the
      // longer give-up affordable (D13).
      assert(retries.length >= 1, `each refused attempt was reported (${retries.length} of them)`);
      for (const r of retries) {
        assertEqual(typeof r.releaseWithinMs, 'number', 'each retry carries the server’s figure');
      }
      // It waited out the window the server reported, and stopped once it had.
      assert(elapsed >= info.budgetMs, `waited the reported window (${elapsed}ms >= ${info.budgetMs}ms)`);
      assert(elapsed < info.budgetMs + 6000, `and stopped once it had, at ${elapsed}ms`);
      assertEqual(joins, 0, 'it never got in');
      assert(!holder.closed, 'the incumbent was untouched throughout');
      assertEqual(rosterOfRoom(room).length, 1, 'and the room still holds only the incumbent');

      await sleep(700);
      assertEqual(c.isConnected, false, 'and it stays down rather than quietly retrying');
    }],

    ['room-client: a held host role is reported and never retried', async ({ room, member, client }) => {
      await member('host', 'host', { tabId: 'H' });

      const { Impl, wire } = recordingSocket();
      const c = client('OTHER', 'host', { WebSocketImpl: Impl });
      const refused = waitEvent(c, 'refused', 3000);
      c.connect();
      const info = await refused;

      // A held host role does not free itself, so waiting cannot help and the
      // response is a person choosing to join as a viewer instead.
      assertEqual(info.code, ERROR_CODES.HOST_TAKEN, 'the code it reported');
      await sleep(900); // several backoff intervals
      assertEqual(joinsIn(wire).length, 1, 'exactly one join attempt was ever made');
      assertEqual(c.isConnected, false, 'it did not come back');
      assertEqual(rosterOfRoom(room).length, 1, 'and the incumbent host is alone and untouched');
    }],
  ]);
}
