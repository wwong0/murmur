import { assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const json = (value) => JSON.stringify(value);

function loadAction(attemptId) {
  return { kind: 'load', attemptId, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 1000 };
}

function pageAtRoomPosition(product) {
  const page = runEntry(product.code, {
    role: 'host',
    settings: { delivery: 'http', iceServers: [] },
    globals: { __waHarnessSeek: true },
  });
  page.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
  page.harness.sharedNowMs = 12_000;
  page.app.harnessSeek(128_000);
  const seek = page.sent().find((entry) => entry.payload?.kind === 'seek');
  page.deliver({ ...seek, seq: 3, from: 'host-1', ts: { recv: 12_001 } });
  page.harness.sharedNowMs = seek.payload.atSharedMs;
  page.tick();
  return page;
}

export default async function edgePositionSuite() {
  const product = await bundleProductEntry();

  await check('edge-position: the product page uses the element sample after timeupdate', async () => {
    const page = pageAtRoomPosition(product);
    const before = page.app.urgentContext();
    assertEqual(json({ ownMediaMs: before.ownMediaMs, roomMediaMs: before.roomMediaMs }), json({ ownMediaMs: 130_000, roomMediaMs: 130_000 }), 'before the first position event both positions are state-derived');
    page.video.currentTime = 100;
    page.control.fire('timeupdate');
    const after = page.app.urgentContext();
    assertEqual(json({ ownMediaMs: after.ownMediaMs, roomMediaMs: after.roomMediaMs }), json({ ownMediaMs: 100_000, roomMediaMs: 130_000 }), 'timeupdate publishes own element position and keeps room position');
    // Mutation (a) page proof, D3: the event opportunity is a viewer behind the
    // room, and the boundary is urgentContext() immediately after timeupdate.
    // Returning the state position from ownPositionMs makes this assertion red
    // (130000, not 100000); staged checkout restored the implementation and the
    // rerun was green.
  });

  await check('edge-position: a second load clears the prior element sample before its first event', async () => {
    const page = pageAtRoomPosition(product);
    page.video.currentTime = 50;
    page.control.fire('timeupdate');
    assertEqual(page.app.urgentContext().ownMediaMs, 50_000, 'the first element sample is in force');
    page.act([loadAction(2)], { startAtSharedMs: 1_000 });
    page.video.currentTime = 25;
    page.act([loadAction(3)], { startAtSharedMs: 1_000 });
    const between = page.app.urgentContext();
    assertEqual(between.ownMediaMs, 130_000, 'the second load has no own sample before its first position event');
    // Mutation (c) proof, D3: after one sampled load, a second load is an
    // opportunity to retain stale element position; the boundary is the context
    // read before the second load's first event. Removing the load reset makes
    // this assertion red (25000, not 130000). Staged checkout restored the file;
    // its result was read and the rerun was green.
  });

  await check('edge-position: a viewer page holds the room order and its own id before it has a clock', async () => {
    const page = runEntry(product.code, { role: 'viewer', settings: { delivery: 'http', iceServers: [] } });
    const roster = [
      { clientId: 'host-1', tabId: 'a', role: 'host', joinedAt: 1 },
      { clientId: 'v3', tabId: 'd', role: 'viewer', joinedAt: 2 },
      { clientId: 'v1', tabId: 'b', role: 'viewer', joinedAt: 3 },
      { clientId: 'v2', tabId: 'c', role: 'viewer', joinedAt: 4 },
    ];
    page.harness.clientId = 'v2';
    page.harness.roster = roster;
    assertEqual(page.harness.sharedNowMs, null, 'the page has no clock');
    page.emit('joined', { clientId: 'v2', role: 'viewer', seq: 1, roster });
    const joined = page.app.urgentContext();
    assertEqual(json({ viewerIds: joined.viewerIds, selfId: joined.selfId }), json({ viewerIds: ['v1', 'v2', 'v3'], selfId: 'v2' }), 'the order and the id are in force at the join');
    assertEqual(json({ roomMediaMs: joined.roomMediaMs, ownMediaMs: joined.ownMediaMs, held: joined.held }), json({ roomMediaMs: 0, ownMediaMs: 0, held: false }), 'no position is invented without a clock');
    // Proof, D2: the opportunity is a join with no clock, where the positioned
    // context cannot be written; the boundary is urgentContext() after the join.
    // Without the setUrgentOrder call in updateUrgentContext the order assertion
    // is red ([] and null). With it restored npm run check was green. E8 is the
    // browser proof.
  });

  await check('edge-position: a held state puts its instant in the context on the engine’s clock', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      settings: { delivery: 'http', iceServers: [] },
      globals: { __waHarnessSeek: true },
    });
    page.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    page.harness.sharedNowMs = 12_000;
    page.setNow(5_000);
    assertEqual(page.app.urgentContext().notBeforeMs, 0, 'no instant before a held state');
    page.app.harnessSeek(128_000);
    const seek = page.sent().find((entry) => entry.payload?.kind === 'seek');
    page.deliver({ ...seek, payload: { ...seek.payload, hold: true }, seq: 3, from: 'host-1', ts: { recv: 12_001 } });
    const leadMs = seek.payload.atSharedMs - 12_000;
    assertEqual(leadMs > 0, true, 'the seek takes effect after it is issued');
    const applied = page.app.urgentContext();
    assertEqual(json({ held: applied.held, notBeforeMs: applied.notBeforeMs }), json({ held: true, notBeforeMs: 5_000 + leadMs }), 'the instant is in force when the state is applied');
    page.harness.sharedNowMs = 12_100;
    page.setNow(5_100);
    page.tick();
    assertEqual(page.app.urgentContext().notBeforeMs, 5_000 + leadMs, 'a later tick names the same instant');
    // Proof, D4: the opportunity is a held state applied ahead of its instant,
    // and the boundary is urgentContext() before the next tick. Passing 0 from
    // updateUrgentContext makes the applied assertion red (0, not 5300). With it
    // restored npm run check was green.
  });
}
