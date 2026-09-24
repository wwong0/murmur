import { check, assert, assertEqual } from '../harness.mjs';
import { offsetView } from '../../../public/lib/playback-state.mjs';
import { createPlaybackStart } from '../../../public/lib/playback-start.mjs';
import { createRoomTimeline } from '../../../public/lib/room-timeline.mjs';
import { deriveDriftRecord } from '../../../public/lib/frame-drift.mjs';
import { createFakeClock, createFakeFrames } from '../fake-frames.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const json = (value) => JSON.stringify(value);

const playing = ({ atSharedMs = 10_000, mediaMs = 0, previous = null } = {}) => ({
  lineage: 'offset-test',
  version: 1,
  current: { playing: true, atSharedMs, mediaMs },
  previous,
  controlMode: 'open',
});

const paused = ({ atSharedMs = 10_000, mediaMs = 5000 } = {}) => ({
  lineage: 'offset-test',
  version: 1,
  current: { playing: false, atSharedMs, mediaMs },
  previous: null,
  controlMode: 'open',
});

const timeline = (state) => createRoomTimeline({ readState: () => state });

function throws(fn) {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
}

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export default async function positionOffsetSuite() {
  await check('position-offset (a): null, zero identity and invalid offsets', async () => {
    const state = playing();
    assertEqual(offsetView(null, 5000), null, 'null state remains null');
    assert(offsetView(state, 0) === state, 'zero offset preserves state identity');
    assert(throws(() => offsetView(state, Number.NaN)), 'NaN offset is rejected');
    assert(throws(() => offsetView(state, 1.5)), 'fractional offset is rejected');
    assert(throws(() => offsetView(state, '5')), 'string offset is rejected');
  });

  await check('position-offset (b): view timeline shifts position and epoch only', async () => {
    const state = playing();
    const view = timeline(offsetView(state, 30_000));
    const unbiased = timeline(state);
    assertEqual(view.mediaMsAt(12_000), 32_000, 'view media position includes the offset');
    assertEqual(view.epochMsAt(12_000), -20_000, 'view epoch removes the offset');
    assertEqual(unbiased.mediaMsAt(12_000), 2000, 'unbiased media position remains the room value');
    assertEqual(unbiased.epochMsAt(12_000), 10_000, 'unbiased epoch remains the room value');
  });

  await check('position-offset (c): scheduled start carries the biased position but keeps S', async () => {
    const state = playing();
    const offset = 30_000;
    const unbiasedStart = createPlaybackStart({ prepareLeadMs: 0 });
    const viewStart = createPlaybackStart({ prepareLeadMs: 0 });
    const unbiased = unbiasedStart.poll({ nowSharedMs: 12_000, resolved: true, state });
    const view = viewStart.poll({ nowSharedMs: 12_000, resolved: true, state: offsetView(state, offset) });
    const roomAction = unbiased.actions[0];
    const viewAction = view.actions[0];
    assertEqual(viewAction.positionMs, roomAction.positionMs + offset, 'positionMs is room position plus offset');
    assertEqual(viewAction.scheduledPositionMs, roomAction.scheduledPositionMs + offset, 'scheduledPositionMs is room position plus offset');
    assertEqual(viewAction.seamEpochMs, roomAction.seamEpochMs - offset, 'seamEpochMs removes the offset');
    assertEqual(view.nextAtSharedMs, unbiased.nextAtSharedMs, 'S is identical for both timelines');
  });

  await check('position-offset (d): paused target parks at room position plus offset with no advance', async () => {
    const state = paused();
    const result = createPlaybackStart({ prepareLeadMs: 0 }).poll({
      nowSharedMs: 12_000,
      resolved: true,
      state: offsetView(state, 30_000),
    });
    const action = result.actions[0];
    assertEqual(action.kind, 'load', 'the initial paused preparation is a load');
    assertEqual(action.positionMs, 35_000, 'paused position includes offset');
    assertEqual(action.scheduledPositionMs, 35_000, 'paused scheduled position includes offset');
    assertEqual(action.advanceMs, 0, 'paused target has no advance');
  });

  await check('position-offset (e): drift is zero against the view and positive against the room', async () => {
    const fake = createFakeFrames({ count: 1 });
    const frame = fake.frames[0];
    const state = playing({ atSharedMs: fake.epochMs, mediaMs: 0 });
    const view = offsetView(state, 30_000);
    const viewTimeline = timeline(view);
    const roomTimeline = timeline(state);
    const viewMediaMs = viewTimeline.mediaMsAt(frame.displaySharedMs);
    const metadata = { ...frame.metadata, mediaTime: viewMediaMs / 1000 };
    const input = {
      metadata,
      timeOriginMs: fake.timeOriginMs,
      localNowMs: frame.nowLocalMs,
      clock: createFakeClock(),
    };
    const viewRecord = deriveDriftRecord({ ...input, timeline: viewTimeline });
    const roomRecord = deriveDriftRecord({ ...input, timeline: roomTimeline });
    assertEqual(viewRecord.record.driftMs, 0, 'a frame at the view position has zero drift');
    assertEqual(roomRecord.record.driftMs, 30_000, 'the same frame is ahead by the offset on the room timeline');
  });

  await check('position-offset (f): previous mapping is shifted too', async () => {
    const state = playing({
      atSharedMs: 20_000,
      mediaMs: 10_000,
      previous: { playing: true, atSharedMs: 10_000, mediaMs: 0 },
    });
    const view = timeline(offsetView(state, 30_000));
    const room = timeline(state);
    assertEqual(view.mediaMsAt(15_000), room.mediaMsAt(15_000) + 30_000, 'previous media mapping includes offset');
  });

  const product = await bundleProductEntry();
  await check('position-offset (g): entry publishes, refuses invalid input, and seeks on room position', async () => {
    const plain = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] } });
    const shifted = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] }, globals: { __waPositionOffsetMs: 30_000 } });
    const negative = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] }, globals: { __waPositionOffsetMs: -1 } });
    const text = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] }, globals: { __waPositionOffsetMs: 'x' } });
    await drain();

    assertEqual(json(plain.app.positionOffset()), json({ ms: 0, error: null }), 'absent offset publishes zero');
    assertEqual(shifted.app.positionOffset().ms, 30_000, 'valid offset is published');
    assert(negative.app.positionOffset().ms === null && typeof negative.app.positionOffset().error === 'string', 'negative offset publishes an error');
    assert(text.app.positionOffset().ms === null && typeof text.app.positionOffset().error === 'string', 'string offset publishes an error');
    assertEqual(negative.events.filter((event) => event.kind === 'playback-start-poll').length, 0, 'negative offset never calls start.poll');
    assertEqual(text.events.filter((event) => event.kind === 'playback-start-poll').length, 0, 'string offset never calls start.poll');
    assertEqual(negative.events.filter((event) => event.kind === 'load').length, 0, 'negative offset never loads the player');
    assertEqual(text.events.filter((event) => event.kind === 'load').length, 0, 'string offset never loads the player');

    shifted.resolveSole({ nowMs: 10_000 });
    shifted.harness.sharedNowMs = 13_000;
    shifted.tick();
    shifted.click('forward-10');
    const seek = shifted.sent().findLast((env) => env.payload?.kind === 'seek');
    assert(seek, 'offset seek reaches the room action boundary');
    assertEqual(seek.payload.positionMs, 13_000, 'seek sends the unbiased room position plus ten seconds');
  });

  await check('position-offset telemetry: load, park and play records publish the offset', async () => {
    const page = runEntry(product.code, {
      search: '?room=r&tab=t&startTiming=1',
      settings: { delivery: 'http', iceServers: [] },
      globals: { __waPositionOffsetMs: 30_000 },
    });
    await drain();
    page.open({ positionMs: 30_000, scheduledPositionMs: 30_000, seamEpochMs: -29_000 });
    page.act([{ kind: 'park', attemptId: 2, positionMs: 31_000, scheduledPositionMs: 31_000, advanceMs: 0, seamEpochMs: -30_000 }]);
    page.act([{ kind: 'play', attemptId: 3, positionMs: 32_000, scheduledPositionMs: 32_000, advanceMs: 0, seamEpochMs: -31_000, startAtSharedMs: 1000, latenessMs: 0 }]);
    const actions = page.app.startTiming().events.filter((event) => event.kind === 'action');
    for (const kind of ['load', 'park', 'play']) {
      const event = actions.find((candidate) => candidate.action === kind);
      assert(event, `${kind} telemetry record exists`);
      assertEqual(event.positionOffsetMs, 30_000, `${kind} telemetry record publishes offset`);
    }
  });
}
