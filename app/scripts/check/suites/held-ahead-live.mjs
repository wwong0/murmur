// T7 (design.md D5; tasks.md 3.3): held-ahead from the viewer's own position,
// over its own finished segments. `heldAheadMs` is pure; `peer-bytes.mjs`'s
// segment/finished-segment additions get their own cases here, since this
// change's `Files` list for T7 does not include the `peer-bytes` suite. The
// existing `scripts/figures/held-ahead.mjs` (8a's measurement) is untouched.

import { assert, assertEqual, check } from '../harness.mjs';
import { heldAheadMs } from '../../../public/lib/held-ahead.mjs';
import { createPeerBytes } from '../../../public/lib/peer-bytes.mjs';
import { offsetView } from '../../../public/lib/playback-state.mjs';
import { createRig } from '../peer-bytes-fixture.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { TYPE_AHEAD } from '../../../public/lib/envelope.mjs';

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 4 s boundaries: segment `index` covers `[index*4000, (index+1)*4000)`. */
function segment(index) {
  return { mediaStartMs: index * 4000, mediaEndMs: (index + 1) * 4000 };
}

function publisher(rig) {
  let now = 2000;
  const value = createPeerBytes({ wallNow: () => ++now });
  value.attach(rig.engine);
  return value;
}

function startPeer(rig, peerId = 'peer-a') {
  const controls = rig.request.start({ downloadSource: 'p2p', peerId }, { onAbort: () => {} });
  controls.firstBytesReceived();
  return controls;
}

export default async function heldAheadLiveSuite() {
  await check('held-ahead-live: contiguous run through five segments gives 18,000ms; a gap after the first gives 2,000ms', async () => {
    const contiguous = [segment(0), segment(1), segment(2), segment(3), segment(4)];
    assertEqual(heldAheadMs({ positionMs: 2000, segments: contiguous }), 18_000, 'held at 2,000ms with five finished segments and the sixth missing');
    assertEqual(heldAheadMs({ positionMs: 2000, segments: [segment(0)] }), 2_000, 'held at 2,000ms with only the first segment finished');
  });

  await check('held-ahead-live: a 60,000ms offset with 60,000-68,000 finished gives 8,000ms', async () => {
    assertEqual(heldAheadMs({ positionMs: 60_000, segments: [{ mediaStartMs: 60_000, mediaEndMs: 64_000 }, { mediaStartMs: 64_000, mediaEndMs: 68_000 }] }), 8_000, 'offset held position with two finished segments');
    // The offset itself comes from `offsetView`, not from `heldAheadMs`: a held
    // state at 0 viewed through a 60,000ms harness offset reads mediaMs 60,000.
    const held = { lineage: 'l', version: 1, current: { playing: false, atSharedMs: 0, mediaMs: 0, held: true }, previous: null, controlMode: 'open' };
    assertEqual(offsetView(held, 60_000).current.mediaMs, 60_000, 'offsetView carries the harness offset into the held position');
  });

  await check('held-ahead-live: no finished segments, and a position before the first, both give 0; a negative position throws', async () => {
    assertEqual(heldAheadMs({ positionMs: 5000, segments: [] }), 0, 'no finished segments at all');
    assertEqual(heldAheadMs({ positionMs: 2000, segments: [segment(5)] }), 0, 'a position before the first finished segment is unbracketed');
    let threw = false;
    try { heldAheadMs({ positionMs: -1, segments: [] }); } catch { threw = true; }
    assert(threw, 'a negative position throws');
    let nonFiniteThrew = false;
    try { heldAheadMs({ positionMs: NaN, segments: [] }); } catch { nonFiniteThrew = true; }
    assert(nonFiniteThrew, 'a non-finite position throws');
    // Mutation probe (against room.entry.js's `updateHeldAhead`, proven at the
    // entry level in T9/T10's suites' shared page — see held-ahead-live's own
    // entry-level positionMs case below): the offset is applied by `viewState()`
    // before `positionMs` ever reaches `heldAheadMs`, which this pure function
    // has no way to observe on its own.
  });

  await check('held-ahead-live: peer-bytes segmentLoaded carries media times, and keeps them outside the ring', async () => {
    const rig = createRig();
    const value = publisher(rig);
    const controls = startPeer(rig);
    controls.addLoadedChunk(new Uint8Array(4));
    controls.completeOnSuccess();
    const reading = value.read();
    const record = reading.records.find((entry) => entry.kind === 'segment');
    assertEqual(record.mediaStartMs, 0, 'the default fixture segment starts at 0s');
    assertEqual(record.mediaEndMs, 4000, 'the default fixture segment ends at 4s (startTime/endTime x 1000)');
    assertEqual(JSON.stringify(value.finishedSegments()), JSON.stringify([{ mediaStartMs: 0, mediaEndMs: 4000 }]), 'finishedSegments holds the same span, outside the ring');
    assertEqual(value.finishedWithoutTimes, 0, 'a segment with finite times is not counted as without them');
  });

  await check('held-ahead-live: a segment whose times are not finite is left out of the map and counted', async () => {
    const rig = createRig();
    rig.segment.startTime = NaN;
    rig.segment.endTime = NaN;
    const value = publisher(rig);
    const controls = startPeer(rig);
    controls.addLoadedChunk(new Uint8Array(4));
    controls.completeOnSuccess();
    assertEqual(value.finishedSegments().length, 0, 'a non-finite-timed segment is left out of the finished map');
    assertEqual(value.finishedWithoutTimes, 1, 'it is counted in finishedWithoutTimes instead');
    // Mutation probe: staged, then the `hasTimes` guard in peer-bytes.mjs's
    // `segmentLoaded` dropped, so every segment entered the finished map
    // unconditionally. `npm run check` turned the 'a non-finite-timed segment
    // is left out of the finished map' assertion above red (length 1 against
    // the expected 0). Reverted; check green again.
  });

  const product = await bundleProductEntry();

  await check('held-ahead-live entry: a sole viewer\'s held-ahead position carries the harness offset', async () => {
    // T7's Proof asks for this scenario "through the entry harness with
    // `__waPositionOffsetMs = 60000`". The fake player never invokes the real
    // `p2p.onEngine` callback (entry-fakes.mjs's `createPlayer().load` does not
    // call it), so `peerBytesPublisher.attach()` never runs in this harness and
    // `finishedSegments()` is always `[]` here — the three numeric scenarios
    // above are proven as pure `heldAheadMs` calls instead, which is sound
    // since the function is pure. What *is* provable through the entry harness
    // is that `updateHeldAhead` reads the position through `viewState()` (offset
    // applied), not the raw room position — checked here via `positionMs`.
    const page = runEntry(product.code, {
      role: 'viewer',
      settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
      globals: { __waPositionOffsetMs: 60_000 },
    });
    await drain();
    page.harness.clientId = 'v1';
    page.harness.sharedNowMs = 10_000;
    // A roster of one, self included, is "sole" regardless of role (T5's
    // `soleMember`/`tryCreation`) — a solo viewer creates its own held room the
    // same way a solo host would.
    page.emit('joined', { clientId: 'v1', role: 'viewer', seq: 1, roster: [{ clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 }] });
    const create = page.sent().find((entry) => entry.payload?.kind === 'create');
    assert(create, 'the sole viewer issues its own creation');
    assertEqual(create.payload.current.held, true, 'a room with peer exchange is created held');
    page.deliver({ ...create, seq: 2, from: 'v1', ts: { recv: 10_001 } });
    page.tick();
    const held = page.app.heldAhead();
    assert(held, 'heldAhead is published once a held state resolves');
    assertEqual(held.positionMs, 60_000, 'positionMs is the offset-adjusted view position, not the raw room position (0)');

    // Simulate a host also present, so `sendAheadReport` has somewhere to send:
    // `client.roster` is read live from the harness at call time.
    page.harness.roster = [
      { clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 },
      { clientId: 'host-1', tabId: 'h', role: 'host', joinedAt: 0 },
    ];
    page.tick();
    const sentAhead = page.sent().find((entry) => entry.type === TYPE_AHEAD);
    assert(sentAhead, 'a held viewer with a host present sends an ahead report');
    assertEqual(sentAhead.payload.heldAheadMs, page.app.heldAhead().heldAheadMs, 'the sent report and the published heldAhead read the same value, single source of truth');

    // Mutation probe: staged, then `updateHeldAhead`'s `const state = viewState();`
    // in room.entry.js swapped for `const state = acquisition.state;` (the
    // unoffset room state). `npm run check` turned 'positionMs is the
    // offset-adjusted view position, not the raw room position (0)' red (0
    // against the expected 60,000). Reverted; check green again.
  });
}
