// Held-ahead and ready-at-once reports.

import { assert, assertEqual, check } from '../harness.mjs';
import { aheadReportDue, heldAheadMs } from '../../../public/lib/held-ahead.mjs';
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
  await check('held-ahead-live: ready crossing bypasses the interval once per key, while interval remains exact', async () => {
    const crossing = {
      nowMs: 4_000,
      lastSentMs: 3_600,
      lastSentKey: 'lineage:1',
      lastSentReady: false,
      key: 'lineage:1',
      heldAheadMs: 4_000,
      readyMs: 4_000,
      intervalMs: 1_000,
    };
    assertEqual(aheadReportDue(crossing), true, '400ms after a 2,000ms report, reaching 4,000ms is due');
    assertEqual(aheadReportDue({ ...crossing, lastSentReady: true }), false, 'the same ready report for the same key is not due again before the interval');
    assertEqual(aheadReportDue({ ...crossing, key: 'lineage:2' }), true, 'a new held-state key re-arms the ready crossing');
    assertEqual(aheadReportDue({ ...crossing, heldAheadMs: 2_000, nowMs: 3_400 }), false, '400ms after a report still below ready is not due');
    assertEqual(aheadReportDue({ ...crossing, heldAheadMs: 2_000, nowMs: 4_600 }), true, '1,000ms after a report is due');
    assertEqual(aheadReportDue({ ...crossing, lastSentMs: null }), true, 'a key with no prior report is due at once');
  });

  await check('held-ahead-live: contiguous run through five segments gives 18,000ms; a gap after the first gives 2,000ms', async () => {
    const contiguous = [segment(0), segment(1), segment(2), segment(3), segment(4)];
    assertEqual(heldAheadMs({ positionMs: 2000, segments: contiguous }), 18_000, 'held at 2,000ms with five finished segments and the sixth missing');
    assertEqual(heldAheadMs({ positionMs: 2000, segments: [segment(0)] }), 2_000, 'held at 2,000ms with only the first segment finished');
  });

  await check('held-ahead-live: a 60,000ms offset with 60,000-68,000 finished gives 8,000ms', async () => {
    assertEqual(heldAheadMs({ positionMs: 60_000, segments: [{ mediaStartMs: 60_000, mediaEndMs: 64_000 }, { mediaStartMs: 64_000, mediaEndMs: 68_000 }] }), 8_000, 'offset held position with two finished segments');
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
    assertEqual(JSON.stringify(value.finishedSegments()), JSON.stringify([{ mediaStartMs: 0, mediaEndMs: 4000, index: rig.segment.externalId }]), 'finishedSegments holds the same span and the engine index, outside the ring');
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
    // Mutation probe: opportunity is segmentLoaded with non-finite times;
    // dropping `hasTimes` made the named map-length assertion red (1 vs 0).
    // `git checkout -- peer-bytes.mjs` restored it; npm run check was green.
  });

  const product = await bundleProductEntry();

  await check('held-ahead-live entry: a viewer reports immediately, then at the ready crossing on segment load', async () => {
    const page = runEntry(product.code, {
      role: 'viewer',
      settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
    });
    await drain();
    page.harness.clientId = 'v1';
    page.harness.sharedNowMs = 10_000;
    page.emit('joined', { clientId: 'v1', role: 'viewer', seq: 1, roster: [{ clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 }] });
    const create = page.sent().find((entry) => entry.payload?.kind === 'create');
    assert(create, 'the sole viewer issues its own creation');
    assertEqual(create.payload.current.held, true, 'a room with peer exchange is created held');
    page.deliver({ ...create, seq: 2, from: 'v1', ts: { recv: 10_001 } });
    page.harness.roster = [
      { clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 },
      { clientId: 'host-1', tabId: 'h', role: 'host', joinedAt: 0 },
    ];
    page.setNow(1_000);
    page.open();
    const reportsAfterTick = page.sent().filter((entry) => entry.type === TYPE_AHEAD);
    assertEqual(reportsAfterTick.length, 1, 'the first tick sends the first ahead report');
    assertEqual(reportsAfterTick[0].payload.heldAheadMs, 0, 'the first report has zero held-ahead before any segment finishes');

    const load = page.events.find((event) => event.kind === 'load');
    assert(load?.detail?.p2p?.onEngine, 'the viewer load exposes its engine callback to the harness');
    const rig = createRig();
    load.detail.p2p.onEngine(rig.engine);
    const controls = startPeer(rig);
    controls.addLoadedChunk(new Uint8Array(4));
    page.setNow(1_300);
    controls.completeOnSuccess();
    const reportsAfterLoad = page.sent().filter((entry) => entry.type === TYPE_AHEAD);
    assertEqual(reportsAfterLoad.length, 2, 'the segment-loaded turn sends a second ahead report before the interval');
    assert(reportsAfterLoad[1].payload.heldAheadMs >= 4_000, 'the second report carries at least 4,000ms held-ahead');

    // Mutation (a): opportunity is the segment-loaded turn 300ms after report 1;
    // removing aheadReportDue's ready rule made this named assertion red (1 vs 2).
    // `git checkout -- held-ahead.mjs` restored it; npm run check was green.
    // Mutation (c): opportunity is the same event boundary; moving this listener
    // before attach made this assertion red (1 vs 2). The fake EventTarget does
    // preserve listener order. `git checkout -- room.entry.js` restored it; npm
    // run check was green. E6 remains the browser proof.
  });

  await check('held-ahead-live entry: a sole viewer\'s held-ahead position carries the harness offset', async () => {
    const page = runEntry(product.code, {
      role: 'viewer',
      settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
      globals: { __waPositionOffsetMs: 60_000 },
    });
    await drain();
    page.harness.clientId = 'v1';
    page.harness.sharedNowMs = 10_000;
    page.emit('joined', { clientId: 'v1', role: 'viewer', seq: 1, roster: [{ clientId: 'v1', tabId: 't', role: 'viewer', joinedAt: 1 }] });
    const create = page.sent().find((entry) => entry.payload?.kind === 'create');
    assert(create, 'the sole viewer issues its own creation');
    page.deliver({ ...create, seq: 2, from: 'v1', ts: { recv: 10_001 } });
    page.tick();
    const held = page.app.heldAhead();
    assert(held, 'heldAhead is published once a held state resolves');
    // An older case, kept: `updateHeldAhead` reads through `viewState()`.
    assertEqual(held.positionMs, 60_000, 'positionMs is the offset-adjusted view position, not the raw room position (0)');
  });
}
