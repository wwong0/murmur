// scripts/check/suites/liveness.mjs — the ws-ping sweep that buries half-open
// connections.
//
// PLAN.md's change 2 review notes the gap this suite still has: only an UPPER
// bound on the sweep's patience is asserted here. A sweep that terminated on the
// first unanswered ping would pass everything below, and 1b's "Challenged and
// left standing" rests on the sweep being patient. Change 7a owns closing that.

import { check, assert, assertEqual } from '../harness.mjs';
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
}
