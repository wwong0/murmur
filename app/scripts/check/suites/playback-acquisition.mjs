import {
  assert,
  assertEqual,
  check,
  checkGroup,
  memberOf,
  Peer,
  rosterOfRoom,
  waitEvent,
  sleep,
} from '../harness.mjs';
import { FROZEN_WS, WS } from '../fixtures.mjs';
import {
  PROTOCOL_VERSION,
  TYPE_PLAYBACK_OPERATION,
  TYPE_PLAYBACK_STATE_ANSWER,
  TYPE_PLAYBACK_STATE_REQUEST,
} from '../../../public/lib/envelope.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { mediaMsAt } from '../../../public/lib/playback-state.mjs';

const SETTINGS = Object.freeze({
  transitionLeadMs: 150,
  maxFutureMs: 1150,
  requestTimeoutMs: 200,
  backoffMs: 100,
  autoStart: () => true,
});

const clock = { sharedNow: () => performance.timeOrigin + performance.now() };

function waitFor(test, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (test()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${label}`));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

function lineageFactory(prefix) {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

function makeDriver(client, options = {}) {
  return createPlaybackAcquisition({
    client,
    clock: options.clock ?? clock,
    settings: options.settings ?? SETTINGS,
    mintLineage: options.mintLineage ?? lineageFactory(client.tabId ?? 'state'),
    onOutcome: options.onOutcome,
    report: options.report,
  });
}

async function connect(client) {
  const joined = waitEvent(client, 'joined');
  client.connect();
  return joined;
}

async function ready(driver) {
  await waitFor(() => driver.snapshot.resolved, 'acquisition to resolve');
  assert(driver.state !== null, 'resolved acquisition has a state');
}

function assertSameState(left, right, label) {
  assertEqual(JSON.stringify(left.state), JSON.stringify(right.state), `${label}: state`);
  assertEqual(JSON.stringify(left.snapshot.identity), JSON.stringify(right.snapshot.identity), `${label}: identity`);
}

function delayedClient(actual, delayOrFn) {
  const timers = new Set();
  return {
    on: actual.on.bind(actual),
    onEvent: actual.onEvent.bind(actual),
    request: actual.request.bind(actual),
    get clientId() { return actual.clientId; },
    get role() { return actual.role; },
    send(env) {
      if (env.type !== TYPE_PLAYBACK_STATE_ANSWER) return actual.send(env);
      const delay = typeof delayOrFn === 'function' ? delayOrFn(env) : delayOrFn;
      const handle = setTimeout(() => {
        timers.delete(handle);
        actual.send(env);
      }, delay);
      timers.add(handle);
      return env;
    },
    clear() {
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };
}

function heldClient(actual, holds) {
  const held = [];
  return {
    on: actual.on.bind(actual),
    onEvent: actual.onEvent.bind(actual),
    request: actual.request.bind(actual),
    get clientId() { return actual.clientId; },
    get role() { return actual.role; },
    held,
    send(env) {
      if (env.type !== TYPE_PLAYBACK_STATE_ANSWER || !holds(env)) return actual.send(env);
      held.push(env);
      return env;
    },
    release() {
      for (const env of held.splice(0)) actual.send(env);
    },
  };
}

export default async function playbackAcquisitionSuite() {
  await check('playback acquisition: late join adopts the survivor after earliest leaves', async ({ room, client }) => {
    const drivers = [];
    try {
      const a = client('A', 'host', { url: WS });
      const ad = makeDriver(a);
      drivers.push(ad);
      await connect(a);
      await ready(ad);

      const b = client('B', 'viewer', { url: WS });
      const bd = makeDriver(b);
      drivers.push(bd);
      await connect(b);
      await ready(bd);
      assertSameState(ad, bd, 'incumbents agree');

      const survivor = bd.state;
      const earliestId = a.clientId;
      a.close();
      await waitFor(() => !memberOf(room, earliestId), 'earliest member to leave');

      const c = client('C', 'viewer', { url: WS });
      const cd = makeDriver(c);
      drivers.push(cd);
      await connect(c);
      await ready(cd);
      assertEqual(cd.snapshot.identity.lineage, survivor.lineage, 'late join reaches survivor lineage');
      assertEqual(cd.snapshot.identity.version, survivor.version, 'late join reaches survivor version');
      const at = survivor.current.atSharedMs;
      for (const instant of [at - 1000, at, at + 1000]) {
        assertEqual(mediaMsAt(cd.state, instant), mediaMsAt(bd.state, instant), `timeline agrees at ${instant}`);
      }
    } finally {
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: operation buffered during delayed adoption is folded', async ({ client }) => {
    const drivers = [];
    let delayed;
    try {
      const b = client('B', 'host', { url: FROZEN_WS });
      delayed = delayedClient(b, 150);
      const bd = makeDriver(delayed);
      drivers.push(bd);
      await connect(b);
      await ready(bd);

      const a = client('A', 'viewer', { url: FROZEN_WS });
      const ad = makeDriver(a);
      drivers.push(ad);
      await connect(a);
      await ready(ad);

      const c = client('C', 'viewer', { url: FROZEN_WS });
      const cd = makeDriver(c);
      drivers.push(cd);
      await connect(c);
      await waitFor(() => cd.snapshot.requests >= 1, 'C to request B');
      assertEqual(cd.snapshot.resolved, false, 'C remains unresolved while B answer is delayed');
      assertEqual(ad.issue('pause'), true, 'A issues during acquisition');
      await waitFor(() => cd.snapshot.bufferedOperations > 0, 'C to buffer A operation');
      assertEqual(cd.snapshot.resolved, false, 'buffered operation is observed before adoption');
      await ready(cd);
      await waitFor(() => bd.snapshot.playing === false, 'B to apply pause');
      assertSameState(ad, cd, 'adopter folds the buffered operation');
      assertSameState(bd, cd, 'all members agree after fold');
    } finally {
      delayed?.clear();
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: pending transition mappings survive adoption', async ({ client }) => {
    const drivers = [];
    const longSettings = { ...SETTINGS, transitionLeadMs: 3000, maxFutureMs: 4000 };
    try {
      const a = client('A', 'host', { url: FROZEN_WS });
      const ad = makeDriver(a, { settings: longSettings });
      drivers.push(ad);
      await connect(a);
      await ready(ad);
      await waitFor(() => performance.timeOrigin + performance.now() >= ad.state.current.atSharedMs, 'initial transition');
      assertEqual(ad.issue('seek', { positionMs: 1234 }), true, 'A issues a long-lead seek');
      await waitFor(() => ad.state.current.mediaMs === 1234, 'seek to apply');

      const b = client('B', 'viewer', { url: FROZEN_WS });
      const bd = makeDriver(b, { settings: longSettings });
      drivers.push(bd);
      await connect(b);
      await ready(bd);
      const c = client('C', 'viewer', { url: FROZEN_WS });
      const cd = makeDriver(c, { settings: longSettings });
      drivers.push(cd);
      await connect(c);
      await ready(cd);
      const at = ad.state.current.atSharedMs;
      for (const instant of [at - 1000, at + 1000]) {
        assertEqual(mediaMsAt(cd.state, instant), mediaMsAt(ad.state, instant), `pending mapping at ${instant}`);
      }
      assertSameState(ad, cd, 'pending transition identity');
    } finally {
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: sole creator answers none before its creation echo', async ({ room, client, peer }) => {
    const drivers = [];
    let released = false;
    try {
      const creator = client('CREATOR', 'host', { url: FROZEN_WS });
      const creatorIdClock = { sharedNow: () => (released ? clock.sharedNow() : null) };
      const cd = makeDriver(creator, { clock: creatorIdClock });
      drivers.push(cd);
      const joined = await connect(creator);
      await waitFor(() => cd.snapshot.resolved === false, 'creator to become unresolved');
      assertEqual(cd.snapshot.created, 0, 'creation waits for its clock');

      const requester = await peer('REQUESTER', FROZEN_WS);
      const requesterJoined = await requester.join({ room, tabId: 'REQUESTER', role: 'viewer' });
      assertEqual(requesterJoined.type, 'joined', 'requester joined');
      requester.send({
        v: PROTOCOL_VERSION,
        type: TYPE_PLAYBACK_STATE_REQUEST,
        to: joined.clientId,
        id: 'before-create',
        payload: {},
      });
      const answer = await requester.next((env) => env.type === TYPE_PLAYBACK_STATE_ANSWER);
      assertEqual(answer.payload.state, null, 'request before creation gets none');
      assertEqual(cd.snapshot.created, 0, 'creation echo was not observed yet');

      released = true;
      cd.poll();
      await waitFor(() => cd.snapshot.created === 1, 'creator echo');
      await ready(cd);

      const later = client('LATER', 'viewer', { url: FROZEN_WS });
      const ld = makeDriver(later);
      drivers.push(ld);
      await connect(later);
      await ready(ld);
      assertEqual(ld.snapshot.identity.lineage, cd.snapshot.identity.lineage, 'later join adopts creator lineage');
    } finally {
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: terminated member re-acquires its own identity', async ({ room, client }) => {
    const drivers = [];
    try {
      const a = client('A', 'host', { url: WS });
      const ad = makeDriver(a);
      drivers.push(ad);
      await connect(a);
      await ready(ad);
      const b = client('B', 'viewer', { url: WS });
      const bd = makeDriver(b);
      drivers.push(bd);
      await connect(b);
      await ready(bd);
      const oldId = b.clientId;
      const before = JSON.stringify(bd.snapshot.identity);
      memberOf(room, oldId).ws.terminate();
      await waitFor(() => b.clientId !== oldId && bd.snapshot.resolved, 'B to rejoin and resolve', 5000);
      assertEqual(JSON.stringify(bd.snapshot.identity), before, 'rejoin preserves its identity');
    } finally {
      for (const driver of drivers) driver.dispose();
    }
  });

  await checkGroup([
    ['playback acquisition: silent member blocks creation until it leaves', async ({ room, client, peer }) => {
      const drivers = [];
      try {
        const silent = await peer('SILENT', FROZEN_WS);
        const first = await silent.join({ room, tabId: 'SILENT', role: 'viewer' });
        assertEqual(first.type, 'joined', 'silent member joined');
        const c = client('C', 'viewer', { url: FROZEN_WS });
        const cd = makeDriver(c);
        drivers.push(cd);
        await connect(c);
        await waitFor(() => cd.snapshot.requests >= 1, 'C first request');
        await sleep(4 * (SETTINGS.requestTimeoutMs + SETTINGS.backoffMs));
        assertEqual(cd.snapshot.created, 0, 'silent member prevents creation');
        assertEqual(cd.snapshot.resolved, false, 'C remains unresolved while silent member remains');
        assert(cd.snapshot.requests >= 2, `C retried the silent member (${cd.snapshot.requests})`);
        silent.close();
        await waitFor(() => cd.snapshot.created === 1, 'C to create after silent member leaves');
      } finally {
        for (const driver of drivers) driver.dispose();
      }
    }],
  ]);

  await check('playback acquisition: host permission follows the roster at operation seq', async ({ room, client }) => {
    // C's answer from V is held while V pauses hostless, H2 joins and V's play
    // is refused, so all three reach C only from its buffer, after a
    // `throughSeq` that precedes them. C holds H2 in its roster before it adopts,
    // so only replaying the buffered presences in order applies the pause.
    const drivers = [];
    let heldViewer;
    const cOutcomes = [];
    try {
      const h = client('H', 'host', { url: WS });
      const hd = makeDriver(h);
      drivers.push(hd);
      await connect(h);
      await ready(hd);
      const v = client('V', 'viewer', { url: WS });
      let c = null;
      heldViewer = heldClient(v, (env) => c !== null && env.to === c.clientId);
      const vd = makeDriver(heldViewer);
      drivers.push(vd);
      await connect(v);
      await ready(vd);
      await waitFor(() => clock.sharedNow() >= hd.state.current.atSharedMs, 'initial start before control mode');
      assertEqual(hd.issue('control-mode', { controlMode: 'host' }), true, 'host enables host mode');
      await waitFor(() => vd.snapshot.controlMode === 'host', 'viewer to adopt host mode');

      const hostId = h.clientId;
      h.close();
      await waitFor(() => !rosterOfRoom(room).some((member) => member.clientId === hostId), 'host to leave');
      await waitFor(() => vd.permitted('pause') === true, 'viewer to observe hostless roster');

      c = client('C', 'viewer', { url: WS });
      const cd = makeDriver(c, {
        settings: { ...SETTINGS, requestTimeoutMs: 5000 },
        onOutcome: ({ env, outcome }) => cOutcomes.push([env.payload?.kind, outcome]),
      });
      drivers.push(cd);
      await connect(c);
      await waitFor(() => heldViewer.held.length === 1, 'V to answer C');

      assertEqual(vd.issue('pause'), true, 'viewer can pause while hostless');
      await waitFor(() => vd.snapshot.playing === false, 'hostless pause');
      const h2 = client('H2', 'host', { url: WS });
      const h2d = makeDriver(h2);
      drivers.push(h2d);
      await connect(h2);
      await ready(h2d);
      await waitFor(() => clock.sharedNow() >= vd.state.current.atSharedMs, 'hostless pause to become due');
      assertEqual(vd.issue('play'), true, 'viewer play reaches the room for rejection');
      await waitFor(() => vd.snapshot.rejected.notPermitted === 1 && h2d.snapshot.rejected.notPermitted === 1, 'V and H2 to reject viewer play');
      await waitFor(() => cd.snapshot.bufferedOperations === 2, 'C to buffer both viewer operations');
      assertEqual(cd.snapshot.resolved, false, 'C is still unresolved');

      heldViewer.release();
      await ready(cd);
      assertEqual(cd.snapshot.adopted, 1, 'C adopted V\'s held answer');
      assertEqual(JSON.stringify(cOutcomes), JSON.stringify([['pause', 'applied'], ['play', 'notPermitted']]), 'C judges each buffered operation by the roster at its seq');
      assertSameState(cd, vd, 'C folds to V');
      assertSameState(h2d, vd, 'H2 holds V\'s state');
      assertEqual(cd.permitted('pause'), false, 'adopter sees H2 as controlling host');

      assertEqual(h2d.issue('play'), true, 'H2 resumes playback');
      await waitFor(() => vd.snapshot.playing === true && cd.snapshot.playing === true, 'all live clients to play');
      await waitFor(() => clock.sharedNow() >= h2d.state.current.atSharedMs, 'resume transition to become due');
      const before = [vd.snapshot.rejected.notPermitted, cd.snapshot.rejected.notPermitted, h2d.snapshot.rejected.notPermitted];
      assertEqual(vd.issue('pause'), true, 'viewer operation reaches the room for rejection');
      await waitFor(() => vd.snapshot.rejected.notPermitted > before[0]
        && cd.snapshot.rejected.notPermitted > before[1]
        && h2d.snapshot.rejected.notPermitted > before[2], 'all clients to reject viewer pause');
      assertEqual(vd.snapshot.playing, true, 'viewer state remains playing');
      assertEqual(cd.snapshot.playing, true, 'adopter state remains playing');
      assertEqual(h2d.snapshot.playing, true, 'host state remains playing');
    } finally {
      heldViewer?.release();
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: concurrent operations converge with one stale rejection', async ({ client }) => {
    const drivers = [];
    const outcomes = new Map();
    try {
      const a = client('A', 'host', { url: WS });
      const ad = makeDriver(a, { onOutcome: (event) => outcomes.get('A').push(event) });
      outcomes.set('A', []);
      drivers.push(ad);
      await connect(a);
      await ready(ad);
      const b = client('B', 'viewer', { url: WS });
      const bd = makeDriver(b, { onOutcome: (event) => outcomes.get('B').push(event) });
      outcomes.set('B', []);
      drivers.push(bd);
      await connect(b);
      await ready(bd);
      const c = client('C', 'viewer', { url: WS });
      const cd = makeDriver(c, { onOutcome: (event) => outcomes.get('C').push(event) });
      outcomes.set('C', []);
      drivers.push(cd);
      await connect(c);
      await ready(cd);
      for (const list of outcomes.values()) list.length = 0;
      const before = [ad.snapshot, bd.snapshot, cd.snapshot];
      await waitFor(() => clock.sharedNow() >= ad.state.current.atSharedMs, 'race basis to become due');
      assertEqual(ad.issue('pause'), true, 'A sends first operation');
      assertEqual(bd.issue('pause'), true, 'B sends second operation in the same turn');
      for (const list of outcomes.values()) assertEqual(list.length, 0, 'both sends precede operation echoes');
      await waitFor(() => [...outcomes.values()].every((list) => list.length >= 2), 'all operation outcomes');
      const after = [ad.snapshot, bd.snapshot, cd.snapshot];
      for (let i = 0; i < after.length; i++) {
        assertEqual(after[i].rejected.stale - before[i].rejected.stale, 1, `client ${i} rejects one stale operation`);
        assertEqual(after[i].rejected.notApplicable - before[i].rejected.notApplicable, 0, `client ${i} has no applicability rejection`);
        assertEqual(after[i].rejected.malformed - before[i].rejected.malformed, 0, `client ${i} has no malformed rejection`);
        assertEqual(after[i].rejected.notPermitted - before[i].rejected.notPermitted, 0, `client ${i} has no permission rejection`);
        assertEqual(after[i].rejected.stale + after[i].rejected.notApplicable, before[i].rejected.stale + before[i].rejected.notApplicable + 1, `client ${i} saw one rejected race operation`);
      }
      assertSameState(ad, bd, 'race A/B');
      assertSameState(ad, cd, 'race A/C');
    } finally {
      for (const driver of drivers) driver.dispose();
    }
  });

  await check('playback acquisition: departed request target is abandoned promptly', async ({ room, client }) => {
    const drivers = [];
    let delayedA;
    let answerCount = 0;
    let leftAt = null;
    let nextRequestAt = null;
    try {
      const a = client('A', 'host', { url: WS });
      delayedA = delayedClient(a, () => (answerCount++ === 0 ? 0 : 300));
      const ad = makeDriver(delayedA);
      drivers.push(ad);
      await connect(a);
      await ready(ad);
      const b = client('B', 'viewer', { url: WS });
      const bd = makeDriver(b);
      drivers.push(bd);
      await connect(b);
      await ready(bd);
      b.on(TYPE_PLAYBACK_STATE_REQUEST, () => { nextRequestAt = performance.now(); });
      const c = client('C', 'viewer', { url: WS });
      const cd = makeDriver(c);
      drivers.push(cd);
      const departedId = a.clientId;
      const off = c.on('presence', (env) => {
        if (env.payload?.event === 'leave' && env.payload.member?.clientId === departedId) leftAt = performance.now();
      });
      drivers.push({ dispose: off });
      await connect(c);
      await waitFor(() => cd.snapshot.requests >= 1, 'C request to A');
      a.close();
      await waitFor(() => cd.snapshot.abandoned >= 1, 'C to abandon departed A');
      await waitFor(() => nextRequestAt !== null, 'C request to B');
      assert(leftAt !== null, 'leave ordering was observed');
      assert(nextRequestAt >= leftAt && nextRequestAt - leftAt <= SETTINGS.requestTimeoutMs / 2,
        `next request followed the leave promptly (${nextRequestAt - leftAt}ms)`);
      assert(!rosterOfRoom(room).some((member) => member.clientId === departedId), 'departed target stayed absent');
      await ready(cd);
      assertEqual(cd.snapshot.identity.lineage, bd.snapshot.identity.lineage, 'next member supplied the state');
    } finally {
      delayedA?.clear();
      for (const driver of drivers) driver.dispose();
    }
  });

}
