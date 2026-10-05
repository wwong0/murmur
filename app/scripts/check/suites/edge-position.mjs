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
}
