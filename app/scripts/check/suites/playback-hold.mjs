// The held mapping and the held creation.
// Pure holder-level scenarios first, then the room-level ones through the
// entry harness, then a direct rejoin against `createPlaybackAcquisition`.

import { assert, assertEqual, check } from '../harness.mjs';
import {
  createPlaybackStateHolder,
} from '../../../public/lib/playback-state.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { TYPE_AHEAD } from '../../../public/lib/envelope.mjs';

const json = (value) => JSON.stringify(value);

const BASE = {
  lineage: 'lineage-h',
  version: 10,
  current: { playing: true, atSharedMs: 50000, mediaMs: 10000 },
  previous: null,
  controlMode: 'open',
};
const ROSTER = [
  { clientId: 'A', tabId: 'a', role: 'host', joinedAt: 1 },
  { clientId: 'B', tabId: 'b', role: 'viewer', joinedAt: 2 },
];

function env(seq, from, recv, payload) {
  return { seq, from, ts: { recv }, payload };
}

function operation(seq, from, recv, kind, basis, extra = {}) {
  return env(seq, from, recv, { kind, basis, ...extra });
}

function holder(state = BASE, maxFutureMs = 10000) {
  const h = createPlaybackStateHolder({ maxFutureMs });
  h.adopt(state);
  return h;
}

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

let product;

function page(globals, role, settings) {
  return runEntry(product.code, { role, settings, globals });
}

/** A fake client/clock, for testing `createPlaybackAcquisition` directly — a
 * rejoin's proposal-copying is acquisition-level, not entry-level, and this
 * change's `Files` list for T5 does not include the `playback-acquisition`
 * suite. */
function fakeClock(nowMs) {
  return { sharedNow: () => nowMs };
}

function fakeClient(clientId) {
  const eventListeners = new Map();
  const listeners = new Map();
  const sent = [];
  return {
    clientId,
    send(envelope) { sent.push(envelope); },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
      return () => {};
    },
    onEvent(type, fn) {
      if (!eventListeners.has(type)) eventListeners.set(type, []);
      eventListeners.get(type).push(fn);
      return () => {};
    },
    request() { return new Promise(() => {}); },
    emit(type, value) { for (const fn of eventListeners.get(type) ?? []) fn(value); },
    deliver(envelope) { for (const fn of listeners.get(envelope.type) ?? []) fn(envelope); },
    sent,
  };
}

export default async function playbackHoldSuite() {
  product = await bundleProductEntry();

  await check('playback-hold: a held seek pauses at the landing whatever the prior playing flag', async () => {
    const h = holder();
    const basis = { lineage: 'lineage-h', version: 10 };
    const outcome = h.apply(operation(11, 'A', 52000, 'seek', basis, { atSharedMs: 53000, positionMs: 16000, hold: true }), ROSTER);
    assertEqual(outcome.outcome, 'applied', 'a held seek applies');
    assertEqual(json(h.state.current), json({ playing: false, atSharedMs: 53000, mediaMs: 16000, held: true }), 'held seek lands paused and held');
  });

  await check('playback-hold: play ends a hold, yielding a non-held playing mapping', async () => {
    const h = holder();
    const basis = { lineage: 'lineage-h', version: 10 };
    h.apply(operation(11, 'A', 52000, 'seek', basis, { atSharedMs: 53000, positionMs: 16000, hold: true }), ROSTER);
    const played = h.apply(operation(12, 'A', 53500, 'play', { lineage: 'lineage-h', version: 11 }, { atSharedMs: 54000 }), ROSTER);
    assertEqual(played.outcome, 'applied', 'play against a held state applies');
    assertEqual(json(h.state.current), json({ playing: true, atSharedMs: 54000, mediaMs: 16000 }), 'play clears held and carries the landing position forward');
  });

  await check('playback-hold: pause ends a hold without playing, at mediaMsAt(held, effective)', async () => {
    const h = holder();
    const basis = { lineage: 'lineage-h', version: 10 };
    h.apply(operation(11, 'A', 52000, 'seek', basis, { atSharedMs: 53000, positionMs: 16000, hold: true }), ROSTER);
    const paused = h.apply(operation(12, 'A', 53500, 'pause', { lineage: 'lineage-h', version: 11 }, { atSharedMs: 54000 }), ROSTER);
    assertEqual(paused.outcome, 'applied', 'pause against a held state applies');
    assertEqual(json(h.state.current), json({ playing: false, atSharedMs: 54000, mediaMs: 16000 }), 'pause on a held state ends the hold without moving position or playing');
  });

  await check('playback-hold: a room without peer exchange seeks as today, no hold field', async () => {
    const h = holder();
    const basis = { lineage: 'lineage-h', version: 10 };
    const outcome = h.apply(operation(11, 'A', 52000, 'seek', basis, { atSharedMs: 53000, positionMs: 16000 }), ROSTER);
    assertEqual(outcome.outcome, 'applied', 'an unheld seek applies');
    assertEqual(json(h.state.current), json({ playing: true, atSharedMs: 53000, mediaMs: 16000 }), 'a seek without hold carries the prior playing flag forward, unchanged');
  });

  await check('playback-hold prevention claim: a pause on a paused, non-held state is still rejected', async () => {
    const h = holder({ ...BASE, current: { playing: false, atSharedMs: 50000, mediaMs: 10000 } });
    const basis = { lineage: 'lineage-h', version: 10 };
    const outcome = h.apply(operation(11, 'A', 52000, 'pause', basis, { atSharedMs: 53000 }), ROSTER);
    assertEqual(outcome.outcome, 'notApplicable', 'pause on an already-paused, non-held state is not applicable');
    assertEqual(h.state.version, 10, 'the rejected pause does not advance version');
    // Mutation probe: staged, then the whole `(payload.kind === 'pause' && ...)`
    // disjunct dropped from `apply`'s notApplicable guard in playback-state.mjs,
    // so pause was applicable whenever not playing (held or not). `npm run
    // check` turned this check red — 'playback-hold prevention claim: a pause
    // on a paused, non-held state is still rejected' ('applied' against the
    // expected 'notApplicable'). Reverted; check green again.
  });

  await check('playback-hold entry: a host page with a tracker issues hold on seek; one without does not', async () => {
    const withTracker = page({ __waHarnessSeek: true }, 'host', { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] });
    await drain();
    withTracker.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    withTracker.harness.sharedNowMs = 20_000;
    withTracker.app.harnessSeek(600);
    const heldSeek = withTracker.sent().find((entry) => entry.payload?.kind === 'seek');
    assertEqual(heldSeek.payload.hold, true, 'a room with peer exchange seeks with hold: true');

    const withoutTracker = page({ __waHarnessSeek: true }, 'host', { delivery: 'host', trackerUrl: null, iceServers: [] });
    await drain();
    withoutTracker.resolveSole({ clientId: 'host-2', nowMs: 10_000 });
    withoutTracker.harness.sharedNowMs = 20_000;
    withoutTracker.app.harnessSeek(600);
    const unheldSeek = withoutTracker.sent().find((entry) => entry.payload?.kind === 'seek');
    assert(!Object.hasOwn(unheldSeek.payload, 'hold'), 'a room without peer exchange seeks with no hold field at all');
  });

  await check('playback-hold entry: a room with peer exchange is created held; without a tracker, or over http, it plays', async () => {
    const withTracker = page({}, 'host', { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] });
    await drain();
    const heldSnapshot = withTracker.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    assertEqual(heldSnapshot.held, true, 'a sole host with host delivery and a tracker is created held');
    assertEqual(json(withTracker.app.playbackState()).includes('"playing":false'), true, 'the held creation is paused');
    assertEqual(json(withTracker.app.playbackState()).includes('"positionMs":0'), true, 'the held creation lands at position zero');

    const withoutTracker = page({}, 'host', { delivery: 'host', trackerUrl: null, iceServers: [] });
    await drain();
    const playingSnapshot = withoutTracker.resolveSole({ clientId: 'host-2', nowMs: 10_000 });
    assertEqual(playingSnapshot.held, false, 'the same page without a tracker creates playing');

    const overHttp = page({}, 'host', { delivery: 'http', trackerUrl: null, iceServers: [] });
    await drain();
    const httpSnapshot = overHttp.resolveSole({ clientId: 'host-3', nowMs: 10_000 });
    assertEqual(httpSnapshot.held, false, 'a page with http delivery creates playing');
  });

  await check('playback-hold entry: the last ready report resumes the settled host before the next tick', async () => {
    const hostPage = page({}, 'host', { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] });
    await drain();
    hostPage.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    const created = hostPage.app.playbackState();
    assertEqual(created.held, true, 'the host starts held');
    hostPage.harness.roster = [
      { clientId: 'host-1', tabId: 'h', role: 'host', joinedAt: 1 },
      { clientId: 'v1', tabId: 'v', role: 'viewer', joinedAt: 2 },
    ];
    hostPage.harness.sharedNowMs = 10_000;
    hostPage.tick();
    hostPage.harness.sharedNowMs = 12_000;
    hostPage.deliver({ type: TYPE_AHEAD, from: 'v1', payload: { lineage: created.lineage, version: created.version, heldAheadMs: 4_000 } });
    const plays = hostPage.sent().filter((entry) => entry.payload?.kind === 'play');
    assertEqual(plays.length, 1, 'the last ready report issues play immediately, before another tick');
    // Mutation (b): the report is delivered after the roster has settled, so
    // removing driveHoldResume() from the TYPE_AHEAD handler leaves the named
    // immediate-play assertion at 0 and turns it red. Restored; check is green.
  });

  await check('playback-hold: a rejoin creation copies a held proposal\'s held flag', async () => {
    const clock = fakeClock(10_000);
    const client = fakeClient('c1');
    const acquisition = createPlaybackAcquisition({
      client,
      clock,
      settings: { transitionLeadMs: 300, maxFutureMs: 60_000, holds: () => true, autoStart: () => true },
      mintLineage: () => 'lineage-rejoin',
      report: () => {},
    });
    client.emit('joined', { clientId: 'c1', roster: [{ clientId: 'c1', tabId: 't', role: 'host', joinedAt: 1 }], seq: 1 });
    const firstCreate = client.sent.find((entry) => entry.payload?.kind === 'create');
    assert(firstCreate, 'the sole member issues a first creation');
    assertEqual(firstCreate.payload.current.held, true, 'the first creation, with no proposal, is held');
    client.deliver({ ...firstCreate, seq: 2, from: 'c1', ts: { recv: 10_001 } });

    // Simulate a rejoin: a fresh `joined`, still sole, with the prior state as
    // acquisition's own proposal (handleJoined sets `proposal = holder.state`).
    client.emit('joined', { clientId: 'c1', roster: [{ clientId: 'c1', tabId: 't', role: 'host', joinedAt: 1 }], seq: 3 });
    const rejoinCreate = client.sent.filter((entry) => entry.payload?.kind === 'create').at(-1);
    assert(rejoinCreate !== firstCreate, 'the rejoin issues a second creation');
    assertEqual(rejoinCreate.payload.current.held, true, 'a rejoin creation copies the held proposal\'s held flag');
    assertEqual(rejoinCreate.payload.current.mediaMs, 0, 'the rejoin creation copies the held proposal\'s position too');
    acquisition.dispose();
  });
}
