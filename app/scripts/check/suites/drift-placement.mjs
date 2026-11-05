// scripts/check/suites/drift-placement.mjs
//
// A frame's reported media time is its element time less the load's placement.
// Pure: the frame is hand-built and the callback binding is an argument.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { createFakeClock, DEFAULT_CALLBACK_LEAD_MS, DEFAULT_TIME_ORIGIN_MS } from '../fake-frames.mjs';
import { createRoomTimeline, fixedPlayingState } from '../../../public/lib/room-timeline.mjs';
import { createDriftLog, deriveDriftRecord, REFUSAL_REASONS } from '../../../public/lib/frame-drift.mjs';
import { createFrameSampler } from '../../../public/lib/frame-sampler.mjs';
import { createFrameObserver, createStartTelemetry } from '../../../public/lib/start-telemetry.mjs';

const TIME_ORIGIN_MS = DEFAULT_TIME_ORIGIN_MS;
const EPOCH_MS = TIME_ORIGIN_MS + 60_000;
const ELEMENT_SECONDS = 5.229667;
const PLACEMENT_MS = 21.333;

const displayLocalMs = EPOCH_MS + 5000;
const metadata = () => ({
  mediaTime: ELEMENT_SECONDS,
  expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
  presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
  presentedFrames: 7,
});

function derive(placementMs) {
  return deriveDriftRecord({
    metadata: metadata(),
    timeOriginMs: TIME_ORIGIN_MS,
    localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
    clock: createFakeClock(),
    timeline: createRoomTimeline({ readState: () => fixedPlayingState(EPOCH_MS) }),
    placementMs,
  });
}

/** A one-shot rVFC binding the test fires by hand. */
function manualBinding() {
  const binding = { fire: null };
  binding.requestFrame = (callback) => {
    binding.fire = () => callback(0, metadata());
    return 1;
  };
  binding.cancelFrame = () => {};
  return binding;
}

export default async function driftPlacementSuite() {
  await check('drift placement: a record reports element time less the placement', async () => {
    const outcome = derive(PLACEMENT_MS);
    assert(outcome.ok, 'a frame with a known placement is a record');
    assertNear(outcome.record.mediaMs, 5208.333, 0.002, 'element 5229.667 ms less 21.333 ms');
    assertEqual(outcome.record.placementMs, PLACEMENT_MS, 'the placement sits beside it');
    assert(Math.abs(outcome.record.mediaMs - ELEMENT_SECONDS * 1000) > 20, 'the unmapped element time is outside the answer');
  });

  await check('drift placement: a pending placement is refused by name and counted', async () => {
    const log = createDriftLog();
    const outcome = derive(null);
    assertEqual(outcome.ok, false, 'no record while the placement is unknown');
    assertEqual(outcome.reason, 'placementPending', 'and the reason is its own');
    assertEqual(REFUSAL_REASONS.at(-1), 'placementPending', 'listed last');
    assertEqual(log.add(outcome), null, 'the log keeps nothing');
    assertEqual(log.counters.placementPending, 1, 'and counts one');
    assertEqual(log.counters.framesOffered, 1, 'as an offered frame');
    assertEqual(derive(undefined).reason, 'placementPending', 'an omitted placement is also pending');
  });

  await check('drift placement: a placement of 0 leaves the element time as it was', async () => {
    const outcome = derive(0);
    assertEqual(outcome.record.mediaMs, ELEMENT_SECONDS * 1000, 'media time equals element time');
    assertEqual(outcome.record.placementMs, 0, 'and says why');
  });

  await check('drift placement: the sampler reads the placement at the callback, the telemetry frame maps the same way', async () => {
    let placementMs = null;
    const binding = manualBinding();
    const log = createDriftLog();
    const sampler = createFrameSampler({
      timeline: createRoomTimeline({ readState: () => fixedPlayingState(EPOCH_MS) }),
      clock: createFakeClock(),
      log,
      requestFrame: binding.requestFrame,
      cancelFrame: binding.cancelFrame,
      now: () => displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
      timeOriginMs: TIME_ORIGIN_MS,
      placement: () => placementMs,
    });
    sampler.start();
    binding.fire();
    assertEqual(log.counters.placementPending, 1, 'a frame before the placement is known is counted, not recorded');
    placementMs = PLACEMENT_MS;
    binding.fire();
    assertNear(log.read().records.at(-1).mediaMs, 5208.333, 0.002, 'the next frame maps by the placement read at its callback');

    const telemetry = createStartTelemetry({ enabled: true, now: () => 1000 });
    const observerBinding = manualBinding();
    const observer = createFrameObserver({
      video: { paused: true, playbackRate: 1 },
      telemetry,
      requestFrame: observerBinding.requestFrame,
      cancelFrame: observerBinding.cancelFrame,
      now: () => 900,
      timeOriginMs: TIME_ORIGIN_MS,
      placement: () => placementMs,
    });
    observer.start();
    observerBinding.fire();
    placementMs = null;
    observerBinding.fire();
    const [mapped, pending] = telemetry.read(0).events;
    assertNear(mapped.mediaTimeMs, 5208.333, 0.002, 'the telemetry frame is media time');
    assertEqual(mapped.placementMs, PLACEMENT_MS, 'with the placement beside it');
    assertEqual(pending.mediaTimeMs, null, 'a pending placement is null, not element time');
    assert(pending.absentFields.includes('placementMs'), 'and is named absent');
  });
}
