// scripts/check/suites/liveness.mjs — the ws-ping sweep that buries half-open
// connections.
//
// The lower-bound gap in the sweep's patience is closed here: one missed pong
// followed by a pong must leave the member standing two ticks later.

import { check, assert, assertEqual, memberOf, rosterOfRoom, sleep } from '../harness.mjs';
import { LIVENESS_MS } from '../fixtures.mjs';
import { TYPE_PRESENCE } from '../../../public/lib/envelope.mjs';

export default async function livenessSuite() {
  await check('liveness: a silently dead connection is removed within three sweep ticks', async ({ member }) => {
    const watcher = await member('watcher', 'host', { tabId: 'W' });
    const ghost = await member('ghost', 'viewer', { tabId: 'G' });
    await watcher.next((e) => e.type === TYPE_PRESENCE && e.payload.event === 'join');

    // No close frame — the socket simply stops answering, which is what a
    // half-open TCP connection looks like from the server's side.
    const startedAt = Date.now();
    ghost.goSilent();

    const leave = await watcher.next((e) => e.type === TYPE_PRESENCE && e.payload.event === 'leave', 4000);
    const elapsed = Date.now() - startedAt;
    assertEqual(leave.payload.member.tabId, 'G', 'the ghost is the one removed');
    assertEqual(leave.payload.roster.length, 1, 'the roster shrank');
    // THREE ticks, not two. The sweep pings on one tick, counts the first
    // unanswered pong on the next, and only terminates on the tick after that,
    // so a connection that has just answered survives up to three intervals —
    // which is also what `msUntilNameReleased` reports, and what a `tab-taken`
    // refusal hands the client as its retry budget.
    //
    // The slack is deliberately smaller than the old 2000ms. At a 120ms interval
    // that constant was eighteen intervals wide, so it dominated the
    // interval-scaled term completely and the bound could not tell the behaviour
    // it named from any other: CONSTRAINTS.md's rule is that a check running a
    // setting away from its default must pin behaviour to the setting rather
    // than to a constant.
    assert(
      elapsed < LIVENESS_MS * 3 + 1000,
      `removed after ${elapsed}ms, expected within three ${LIVENESS_MS}ms intervals`
    );
  });

  await check('liveness: one missed ping followed by a pong leaves the member standing', async ({ member, room }) => {
    // Mutation: changing the server's missedPings >= 2 termination threshold
    // to >= 1 made this lower-bound check red while the existing upper-bound
    // check stayed green; restore the threshold before the final green run.
    const watcher = await member('watcher-lower-bound', 'host', { tabId: 'WL' });
    const ghost = await member('one-miss', 'viewer', { tabId: 'OM', wsOptions: { autoPong: false } });
    await watcher.next((e) => e.type === TYPE_PRESENCE && e.payload.event === 'join');
    assertEqual(ghost.ws._autoPong, false, 'the lower-bound peer disables automatic pongs');

    let secondPingMissed = null;
    let secondPingState = null;
    let phase = 'prime';
    let scenarioPings = 0;
    const fourth = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('one-miss: did not receive a fourth ping')), LIVENESS_MS * 8);
      ghost.ws.on('ping', () => {
        if (phase === 'prime') {
          ghost.ws.pong();
          return;
        }
        scenarioPings += 1;
        if (scenarioPings === 2) {
          const state = memberOf(room, ghost.clientId)?.ws?._connState ?? null;
          secondPingMissed = state?.missedPings ?? null;
          secondPingState = state ? { missedPings: state.missedPings, awaitingPong: state.awaitingPong } : null;
        }
        if (scenarioPings > 1) ghost.ws.pong();
        if (scenarioPings === 4) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await sleep(LIVENESS_MS * 2 + 10);
    const primingDeadline = Date.now() + LIVENESS_MS * 2;
    while (memberOf(room, ghost.clientId)?.ws?._connState?.awaitingPong && Date.now() < primingDeadline) await sleep(5);
    phase = 'scenario';
    await fourth;
    assertEqual(secondPingMissed, 1, `the second ping observes one missed pong before answering (${JSON.stringify({ scenarioPings, ghostPings: ghost.pings, state: secondPingState })})`);
    assertEqual(ghost.closed, false, 'the one-miss socket remains open');
    assert(rosterOfRoom(room).some((entry) => entry.clientId === ghost.clientId), 'the one-miss member remains in the roster');
    await watcher.none((e) => e.type === TYPE_PRESENCE && e.payload.event === 'leave' && e.payload.member?.clientId === ghost.clientId, LIVENESS_MS);
  });
}
