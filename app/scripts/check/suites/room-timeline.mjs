// scripts/check/suites/room-timeline.mjs
//
// The timeline delegates every answer to the replicated playback state. This
// suite is pure: state and shared instants are supplied by each fixture.

import { check, assertEqual } from '../harness.mjs';
import { createRoomTimeline, fixedPlayingState } from '../../../public/lib/room-timeline.mjs';

const playing = (atSharedMs, mediaMs, lineage = 'lineage', version = 1) => ({
  lineage,
  version,
  current: { playing: true, atSharedMs, mediaMs },
  previous: null,
  controlMode: 'open',
});

const paused = (atSharedMs, mediaMs, lineage = 'lineage', version = 1) => ({
  lineage,
  version,
  current: { playing: false, atSharedMs, mediaMs },
  previous: null,
  controlMode: 'open',
});

export default async function roomTimelineSuite() {
  await check('room-timeline: no state and invalid instants answer null, never media zero', async () => {
    const timeline = createRoomTimeline({ readState: () => null });
    assertEqual(timeline.mediaMsAt(12000), null, 'no state has no media position');
    assertEqual(timeline.epochMsAt(12000), null, 'no state has no epoch');
    assertEqual(timeline.mediaMsAt(NaN), null, 'a non-finite instant has no media position');
    assertEqual(timeline.epochMsAt(Infinity), null, 'a non-finite instant has no epoch');
  });

  await check('room-timeline: a playing state maps media and epoch at the display instant', async () => {
    const timeline = createRoomTimeline({ readState: () => playing(5000, 7000) });
    assertEqual(timeline.mediaMsAt(12000), 14000, 'playing 7000 at 5000 advances with shared time');
    assertEqual(timeline.epochMsAt(12000), -2000, 'the playing mapping epoch is at minus media');
    assertEqual(timeline.mediaMsAt(5000), 7000, 'the mapping includes its effective instant');
  });

  await check('room-timeline: a paused state keeps its position and has no epoch', async () => {
    const timeline = createRoomTimeline({ readState: () => paused(5000, 7000) });
    assertEqual(timeline.mediaMsAt(12000), 7000, 'paused media does not advance');
    assertEqual(timeline.epochMsAt(12000), null, 'paused media has no playing epoch');
  });

  await check('room-timeline: the retained range is state mappings, and unresolved state answers null', async () => {
    let state = {
      lineage: 'lineage',
      version: 2,
      current: playing(10000, 12000).current,
      previous: playing(5000, 7000).current,
      controlMode: 'open',
    };
    const timeline = createRoomTimeline({ readState: () => state });
    assertEqual(timeline.mediaMsAt(9000), 11000, 'an instant in the retained predecessor maps there');
    assertEqual(timeline.epochMsAt(9000), -2000, 'the predecessor epoch is used before the transition');
    assertEqual(timeline.mediaMsAt(4999), null, 'an instant before the retained range has no position');
    assertEqual(timeline.epochMsAt(4999), null, 'and no epoch');

    state = null;
    assertEqual(timeline.mediaMsAt(12000), null, 'unresolved state does not fall back to its previous answer');
    assertEqual(timeline.epochMsAt(12000), null, 'unresolved state has no epoch either');
  });

  await check('room-timeline: roster changes do not move equal acquired mappings', async () => {
    let state = playing(5000, 7000, 'adopted', 9);
    const timeline = createRoomTimeline({ readState: () => state });
    const before = [timeline.mediaMsAt(4000), timeline.epochMsAt(4000), timeline.mediaMsAt(12000), timeline.epochMsAt(12000)];
    // The acquisition-shaped state has the same identity and mappings after the
    // earliest member leaves; the timeline has no roster latch to advance.
    state = playing(5000, 7000, 'adopted', 9);
    const after = [timeline.mediaMsAt(4000), timeline.epochMsAt(4000), timeline.mediaMsAt(12000), timeline.epochMsAt(12000)];
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'equal acquired states answer identically after a roster change');
    const fixed = createRoomTimeline({ readState: () => fixedPlayingState(5000) });
    assertEqual(fixed.mediaMsAt(12000), 7000, 'the deterministic rig state uses the same interface');
  });
}
