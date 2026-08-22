// scripts/check/suites/identity.mjs — the reclaim secret (change 1b).
//
// Reclaim is keyed on a per-join secret returned only in the directed `joined`
// reply, never on the `tabId` — which the server broadcasts to every member in
// the presence roster. 1b design.md D1 has the defect this closed.

import {
  check,
  assert,
  assertEqual,
  sleep,
  nextRoom,
  memberOf,
  rosterOfRoom,
} from '../harness.mjs';
import { WS, SLOW_WS, FROZEN_WS, LIVENESS_MS, SLOW_LIVENESS_MS, FROZEN_LIVENESS_MS } from '../fixtures.mjs';
import { TYPE_JOINED, TYPE_PRESENCE, TYPE_ERROR, ERROR_CODES } from '../../../public/lib/envelope.mjs';

export default async function identitySuite() {
  await check('identity: a member holding the roster cannot take the host role from it', async ({ room, peer, member }) => {
    const h = await peer('H');
    const hostJoined = await h.join({ room, tabId: 'HOST-TAB', role: 'host' });
    const v = await member('V');

    // The attacker does not guess and does not race. It reads the host's label
    // out of a roster the server broadcast to it, which is the whole defect.
    const presence = await v.next((e) => e.type === TYPE_PRESENCE);
    const published = presence.payload.roster.find((m) => m.role === 'host');
    assertEqual(published.tabId, 'HOST-TAB', 'the roster really does publish the host’s label');
    assertEqual(published.secret, undefined, 'and it does not publish the secret');

    const attacker = await peer('attacker');
    const refused = await attacker.join({ room, tabId: published.tabId, role: 'host' });
    // THE ASSERTION THAT MATTERS. It fails the moment reclaim goes back to
    // trusting a label, because then this join would be ADMITTED. The expected
    // code is `tab-taken` rather than `host-taken` because the label gate answers
    // first — it would have refused this client as a viewer too.
    assertEqual(refused.type, TYPE_ERROR, 'the roster reader is refused');
    assertEqual(refused.payload.code, ERROR_CODES.TAB_TAKEN, 'refused by the label gate');
    assert(!attacker.closed, 'the refused socket stays open so it can rejoin under a label of its own');
    assert(!h.closed, 'the real host keeps its connection');
    assertEqual(memberOf(room, hostJoined.payload.clientId).role, 'host', 'the real host keeps the role');
    assertEqual(rosterOfRoom(room).length, 2, 'the attacker was not added');

    // ...and it can join honestly, on the same socket.
    const honest = await attacker.join({ room, tabId: 'ATTACKER', role: 'viewer' });
    assertEqual(honest.type, TYPE_JOINED, 'a label of its own is fine');
  });

  await check('identity: an issued secret reaches exactly one envelope — its owner’s `joined`', async ({ room, peer }) => {
    /** @type {import('../harness.mjs').Peer[]} */
    const peers = [];
    /** @type {{secret: string, owner: string, label: string}[]} */
    const issued = [];

    async function openAndJoin(label, opts) {
      const p = await peer(label);
      peers.push(p);
      const reply = await p.join({ room, ...opts });
      if (reply.type === TYPE_JOINED) {
        issued.push({ secret: reply.payload.secret, owner: reply.payload.clientId, label });
      }
      return { peer: p, reply };
    }

    // A scene with several members joining, leaving and reclaiming while the
    // others are present and being broadcast to.
    const { peer: a } = await openAndJoin('A', { tabId: 'A', role: 'host' });
    const { peer: b } = await openAndJoin('B', { tabId: 'B', role: 'viewer' });
    const { peer: c } = await openAndJoin('C', { tabId: 'C', role: 'viewer' });

    b.close();
    await sleep(50);

    await openAndJoin('A2', { tabId: 'A', role: 'host', secret: a.secret });
    await openAndJoin('C2', { tabId: 'C', role: 'viewer', secret: c.secret });
    // A refusal, so the error path is in the capture too.
    await openAndJoin('dup', { tabId: 'C', role: 'viewer' });
    // And a stranger with an invented secret under a free label.
    await openAndJoin('D', { tabId: 'D', role: 'viewer', secret: 'not-a-real-secret' });

    await sleep(150); // let every broadcast land

    assert(issued.length >= 5, `the scene issued ${issued.length} secrets`);

    // Assert over the OUTPUT, not over a list of message types (D12). Changes 5,
    // 7a and 10 add types nobody has written yet, and this check inherits them
    // without maintenance: it fails for placements nobody has imagined.
    const everyEnvelope = peers.flatMap((p) => p.received.map((env) => ({ label: p.label, env })));
    assert(everyEnvelope.length > 10, `the capture is non-trivial (${everyEnvelope.length} envelopes)`);

    for (const { secret, owner, label } of issued) {
      const carriers = everyEnvelope.filter(({ env }) => JSON.stringify(env).includes(secret));
      assertEqual(carriers.length, 1, `${label}'s secret appeared in ${carriers.length} envelopes, expected exactly 1`);
      assertEqual(carriers[0].env.type, TYPE_JOINED, `${label}'s secret rode a "${carriers[0].env.type}", expected "joined"`);
      assertEqual(carriers[0].env.to, owner, `${label}'s secret was directed to ${carriers[0].env.to}, expected its owner`);
    }
  });

  await check('identity: the secret rotates on every join, and a stale one is refused', async ({ room, peer }) => {
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'host' });
    const s1 = j1.payload.secret;
    assert(typeof s1 === 'string' && s1.length >= 16, `a secret is a substantial opaque string, got ${s1}`);

    const a2 = await peer('A2');
    const j2 = await a2.join({ room, tabId: 'A', role: 'host', secret: s1 });
    assertEqual(j2.type, TYPE_JOINED, 'the first reclaim is admitted');
    const s2 = j2.payload.secret;
    assert(s2 !== s1, 'a reclaim issues a FRESH secret rather than reusing the presented one');

    const a3 = await peer('A3');
    const j3 = await a3.join({ room, tabId: 'A', role: 'host', secret: s2 });
    assertEqual(j3.type, TYPE_JOINED, 'reclaiming again with the newest secret is admitted');
    const s3 = j3.payload.secret;
    assert(s3 !== s2 && s3 !== s1, 'and it rotates again');

    // s1 now belongs to a member that no longer exists. This is also why no
    // server-side guard against the reclaim loop is needed: a replaced connection
    // that ignored its close code and came back would land exactly here.
    const stale = await peer('stale');
    const refused = await stale.join({ room, tabId: 'A', role: 'host', secret: s1 });
    assertEqual(refused.type, TYPE_ERROR, 'a superseded secret is not a reclaim');
    assertEqual(refused.payload.code, ERROR_CODES.TAB_TAKEN, 'it is refused like any stranger holding the label');
    assertEqual(rosterOfRoom(room).length, 1, 'the incumbent stays');
    assertEqual(rosterOfRoom(room)[0].clientId, j3.payload.clientId, 'and it is the newest connection');
  });

  await check('identity: a reclaim restores the held role, whatever the join claimed', async ({ room, peer }) => {
    const h1 = await peer('H1');
    const hj = await h1.join({ room, tabId: 'H', role: 'host' });
    const v1 = await peer('V1');
    const vj = await v1.join({ room, tabId: 'V', role: 'viewer' });

    // A host's membership reclaimed by a join that claims `viewer`.
    const h2 = await peer('H2');
    const hr = await h2.join({ room, tabId: 'H', role: 'viewer', secret: hj.payload.secret });
    assertEqual(hr.type, TYPE_JOINED, 'the reclaim is admitted, not refused — there is no error path for this');
    const hMine = hr.payload.roster.find((m) => m.clientId === hr.payload.clientId);
    assertEqual(hMine.role, 'host', 'the membership keeps the role it held');

    // ...and the other direction, which must ALSO not trip the one-host rule:
    // the host gate never sees this join, because it is a reclaim.
    const v2 = await peer('V2');
    const vr = await v2.join({ room, tabId: 'V', role: 'host', secret: vj.payload.secret });
    assertEqual(vr.type, TYPE_JOINED, 'a viewer reclaiming while claiming host is admitted');
    const vMine = vr.payload.roster.find((m) => m.clientId === vr.payload.clientId);
    assertEqual(vMine.role, 'viewer', 'and stays a viewer');
    assertEqual(vr.payload.roster.filter((m) => m.role === 'host').length, 1, 'the room still holds exactly one host');
    assertEqual(rosterOfRoom(room).length, 2, 'and exactly two members');
  });

  await check('identity: a reclaim restores the held tabId, whatever the join claimed', async ({ room, peer }) => {
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'host' });

    const a2 = await peer('A2');
    const j2 = await a2.join({ room, tabId: 'SOMETHING-ELSE', role: 'host', secret: j1.payload.secret });
    assertEqual(j2.type, TYPE_JOINED, 'admitted as a reclaim');
    const mine = j2.payload.roster.find((m) => m.clientId === j2.payload.clientId);
    assertEqual(mine.tabId, 'A', 'the reclaimed member keeps its original label');
    assertEqual(mine.joinedAt, j1.payload.roster[0].joinedAt, 'and its original join time');
    assertEqual(rosterOfRoom(room).length, 1, 'no second membership was created');
    assertEqual(rosterOfRoom(room).filter((m) => m.tabId === 'SOMETHING-ELSE').length, 0, 'the claimed label was not read');
  });

  await check('identity: a secret matching no member, under a free label, is an ordinary join', async ({ room, peer, member }) => {
    await member('sitting', 'host', { tabId: 'S' });

    // The client presents its held secret on EVERY rejoin and cannot know whether
    // its old membership still exists, so this is the common path, not an edge:
    // the membership was reaped, the client left cleanly, or the server restarted.
    const stranger = await peer('stranger');
    const joined = await stranger.join({ room, tabId: 'FREE', role: 'viewer', secret: 'a-secret-nobody-issued' });
    assertEqual(joined.type, TYPE_JOINED, 'admitted, with no refusal and no diagnostic');
    const mine = joined.payload.roster.find((m) => m.clientId === joined.payload.clientId);
    assertEqual(mine.tabId, 'FREE', 'the claimed label was honoured');
    assertEqual(mine.role, 'viewer', 'and so was the claimed role');
    assert(joined.payload.secret !== 'a-secret-nobody-issued', 'and a fresh secret replaced the presented one');
  });

  await check('identity: reclaim applies to viewers, and a duplicate label is refused for every role', async ({ room, peer, member }) => {
    await member('host', 'host', { tabId: 'HOST' });
    const v1 = await peer('V1');
    const vj = await v1.join({ room, tabId: 'V', role: 'viewer' });

    // A viewer reclaims its own membership exactly as a host does — change 1
    // gated this on the host role, and change 6's per-tab byte attribution needs
    // it not to be, because two viewers sharing a label merge into one bucket
    // with no "unknown" bucket to reveal it.
    const v2 = await peer('V2');
    const reclaimed = await v2.join({ room, tabId: 'V', role: 'viewer', secret: vj.payload.secret });
    assertEqual(reclaimed.type, TYPE_JOINED, 'the returning viewer is admitted');
    assertEqual(await v1.waitClosed(), 4000, 'and its older connection is closed as a replacement');
    assertEqual(rosterOfRoom(room).filter((m) => m.tabId === 'V').length, 1, 'exactly one member holds that label');

    // This is change 1's §2d probe, which admitted both. It must now refuse.
    for (const role of ['viewer', 'host']) {
      const dup = await peer(`dup-${role}`);
      const refused = await dup.join({ room, tabId: 'V', role });
      assertEqual(refused.type, TYPE_ERROR, `a duplicate label claiming ${role} is refused`);
      assertEqual(refused.payload.code, ERROR_CODES.TAB_TAKEN, `and the code is tab-taken, not host-taken`);
      assert(!dup.closed, 'the refused socket stays open');
      assertEqual(rosterOfRoom(room).length, 2, 'the room did not grow');
      dup.close();
    }
  });

  await check('identity: a tab-taken refusal reports how long the name could stay held', async ({ peer, member }) => {
    // D13. The figure must be derived from the configured liveness interval, not
    // be a constant that happens to be right at one setting — which is exactly
    // how the boolean this replaced went unnoticed.
    const seen = [];
    for (const [label, url, interval] of [
      ['check', WS, LIVENESS_MS],
      ['slow', SLOW_WS, SLOW_LIVENESS_MS],
      ['frozen', FROZEN_WS, FROZEN_LIVENESS_MS],
    ]) {
      const room = nextRoom();
      const holder = await member(`${label}-holder`, 'host', { url, room, tabId: 'T' });
      const probe = await peer(`${label}-probe`, url);
      const refused = await probe.join({ room, tabId: 'T', role: 'viewer' });

      assertEqual(refused.payload.code, ERROR_CODES.TAB_TAKEN, `${label}: refused`);
      assertEqual(refused.payload.holderAnswering, undefined, `${label}: the boolean D13 replaced is gone`);
      assertEqual(refused.payload.secret, undefined, `${label}: and the refusal quotes no secret back`);

      const reported = refused.payload.releaseWithinMs;
      assertEqual(typeof reported, 'number', `${label}: the refusal reports a time`);
      // It is a whole number of sweep ticks at THIS server's interval — one, two
      // or three depending where in the cycle the holder currently sits.
      const ticks = reported / interval;
      assert(
        Number.isInteger(ticks) && ticks >= 1 && ticks <= 3,
        `${label}: ${reported}ms is not 1-3 ticks of the ${interval}ms interval (got ${ticks})`
      );
      seen.push({ label, interval, reported, ticks });
      holder.close();
      probe.close();
    }

    // On a server whose sweep cannot have fired yet, the holder has not even been
    // pinged, so the figure is exactly the full three ticks. This is the one that
    // is deterministic rather than merely bounded.
    const frozen = seen.find((s) => s.label === 'frozen');
    assertEqual(frozen.reported, FROZEN_LIVENESS_MS * 3, 'an unswept holder reports the full window');

    // And the point in one line: a 500x change in the setting moves the reported
    // figure by 500x. No constant survives this.
    const fast = seen.find((s) => s.label === 'check');
    assert(
      frozen.reported > fast.reported * 100,
      `the figure tracks the interval (${fast.reported}ms at ${fast.interval}ms vs ${frozen.reported}ms at ${frozen.interval}ms)`
    );
  });

  await check('identity: a tab-taken refusal is emitted without probing the holder', async ({ room, peer, member }) => {
    // Run against the server whose sweep cannot fire during this assertion, so
    // ANY ping the holder sees had to have been sent for the refusal. On the
    // ordinary server a sweep ping would land in the same window often enough to
    // make this flaky, and a flaky assertion about a rule this load-bearing is
    // worse than none.
    //
    // SERIAL, deliberately: the `elapsed < 100` bound below is tight enough that
    // concurrent load could move it. See checkGroup's note in harness.mjs.
    const holder = await member('frozen-holder', 'host', { url: FROZEN_WS, tabId: 'T' });
    await sleep(50);
    const pingsBefore = holder.pings;

    const probe = await peer('frozen-probe', FROZEN_WS);
    const startedAt = Date.now();
    const refused = await probe.join({ room, tabId: 'T', role: 'viewer' });
    const elapsed = Date.now() - startedAt;

    assertEqual(refused.payload.code, ERROR_CODES.TAB_TAKEN, 'refused');
    assertEqual(holder.pings - pingsBefore, 0, 'no liveness ping was sent to produce the figure');
    // Nor was the refusal held back waiting for anything to come back.
    assert(elapsed < 100, `the refusal returned in ${elapsed}ms, i.e. it was not deferred`);
    await sleep(120);
    assertEqual(holder.pings - pingsBefore, 0, 'and none was sent just after, either');
  });

  await check('identity: a reclaim does not wait for the incumbent to look dead', async ({ room, peer }) => {
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'host' });

    // The incumbent is answering pings normally: several sweeps pass and it is
    // still healthy and still in the room. Change 1's D7 lockout was exactly this
    // situation resolved the other way.
    await sleep(LIVENESS_MS * 3);
    assertEqual(rosterOfRoom(room).length, 1, 'the incumbent is alive and still holds the membership');

    const a2 = await peer('A2');
    const startedAt = Date.now();
    const j2 = await a2.join({ room, tabId: 'A', role: 'host', secret: j1.payload.secret });
    const elapsed = Date.now() - startedAt;
    assertEqual(j2.type, TYPE_JOINED, 'the reclaim is admitted');
    assert(elapsed < LIVENESS_MS, `admitted in ${elapsed}ms, i.e. without waiting a liveness interval (${LIVENESS_MS}ms)`);
    assertEqual(await a1.waitClosed(), 4000, 'the incumbent was replaced rather than left in place');
  });
}
