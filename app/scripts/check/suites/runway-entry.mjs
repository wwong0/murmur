// The page publishes its own position and the finished media
// from it beside the figure it reports to the host. Entry level, on the fakes.

import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { edgeIndexAfter } from '../../../public/lib/held-ahead.mjs';

const drain = () => new Promise((resolve) => setTimeout(resolve, 20));
const segment = (index) => ({ mediaStartMs: index * 4000, mediaEndMs: (index + 1) * 4000, index });

// A sole viewer holding the state it created: held at 0, nothing sampled yet.
async function heldViewer(product) {
  const page = runEntry(product.code, {
    role: 'viewer',
    settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
  });
  await drain();
  page.harness.clientId = 'v1';
  page.harness.sharedNowMs = 10_000;
  page.emit('joined', { clientId: 'v1', role: 'viewer', seq: 1, roster: [{ clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 }] });
  const create = page.sent().find((entry) => entry.payload?.kind === 'create');
  page.deliver({ ...create, seq: 2, from: 'v1', ts: { recv: 10_001 } });
  page.tick();
  return page;
}

export default async function runwayEntrySuite() {
  const product = await bundleProductEntry();

  await check('runway R3: the page publishes the urgent context\'s own position, held and not held', async () => {
    const page = await heldViewer(product);
    const held = page.app.heldAhead();
    assertEqual(page.app.playbackState().held, true, 'the page is held');
    assertEqual(held.ownPositionMs, page.app.urgentContext().ownMediaMs, 'held: the two own positions agree');
    assertEqual(held.ownPositionMs, 0, 'held: at the held position');

    // The room moves to 130 000 and leaves the hold; the element is 30 s behind it.
    const state = page.app.playbackState();
    page.harness.sharedNowMs = 12_000;
    page.deliver({ v: 1, type: 'playback-operation', to: 'room', seq: 3, from: 'v1', ts: { recv: 12_001 },
      payload: { kind: 'seek', basis: { lineage: state.lineage, version: state.version }, atSharedMs: 12_300, positionMs: 130_000 } });
    page.harness.sharedNowMs = 12_350;
    page.tick();
    page.video.currentTime = 100;
    page.control.fire('timeupdate');
    page.tick();
    const playing = page.app.heldAhead();
    assertEqual(page.app.playbackState().held, false, 'the page is no longer held');
    assertEqual(playing.positionMs, 130_000, 'the figure reported to the host stays anchored on the room');
    assertEqual(playing.ownPositionMs, 100_000, 'not held: the own position is the element\'s, 30 s behind the room');
    assertEqual(playing.ownPositionMs, page.app.urgentContext().ownMediaMs, 'not held: the two own positions agree');
    // Prevention proof: the opportunity is a
    // viewer behind the room and not held, read after its timeupdate. Mutation:
    // publish `positionMs` as `ownPositionMs` in updateHeldAhead → the not-held
    // assertions are red (130000, not 100000).
  });

  await check('runway: the edge index is the engine\'s index past the contiguous run', async () => {
    const run = [segment(5), segment(6), segment(7)];
    assertEqual(edgeIndexAfter({ positionMs: 21_000, segments: run }), 8, 'three finished from the position: the next is 8');
    assertEqual(edgeIndexAfter({ positionMs: 21_000, segments: [...run, segment(9)] }), 8, 'a finished segment past a hole does not move it');
    assertEqual(edgeIndexAfter({ positionMs: 21_000, segments: [segment(7), segment(5), segment(6)] }), 8, 'whatever order they finished in');
    assertEqual(edgeIndexAfter({ positionMs: 30_000, segments: run }), 8, 'inside the last finished segment');
    assertEqual(edgeIndexAfter({ positionMs: 32_000, segments: run }), null, 'nothing finished at the position: no index, none guessed');
    assertEqual(edgeIndexAfter({ positionMs: 21_000, segments: run.map(({ index, ...times }) => times) }), null, 'an entry with no index gives none');
    assert(edgeIndexAfter({ positionMs: 0, segments: [] }) === null, 'an empty list gives none');
  });
}
