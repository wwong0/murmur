// The plant and the record rig, shared by the drift-controller and
// drift-convergence suites.
//
// `plant` drives the real controller against a simulated display: media time
// advances at the applied rate, and each frame is quantised onto the vsync grid,
// which is what produces the cadence sawtooth the band has to cover. `pollEvery`
// is in frames — 6 at 24fps is the 250ms interval room.entry.js actually uses.

import { createFakeClock, DEFAULT_CALLBACK_LEAD_MS, DEFAULT_TIME_ORIGIN_MS } from './fake-frames.mjs';
import { createDriftLog, deriveDriftRecord } from '../../public/lib/frame-drift.mjs';
import { createDriftController } from '../../public/lib/drift-controller.mjs';
import { createRoomTimeline } from '../../public/lib/room-timeline.mjs';

export const TIME_ORIGIN_MS = DEFAULT_TIME_ORIGIN_MS;

export function plant({
  standingError = -240,
  refreshHz = 180,
  fps = 24,
  offsetMs = 0,
  delayTermMs = 3,
  ageTermMs = 1,
  clockPresent = true,
  settings = {},
  pollEvery = 1,
} = {}) {
  const epochMs = TIME_ORIGIN_MS + 60_000;
  const intervalMs = 1000 / fps;
  const vsyncMs = 1000 / refreshHz;
  const timeline = createRoomTimeline();
  timeline.observeRoster([{ clientId: 'a', joinedAt: epochMs }]);
  const clock = createFakeClock({ offsetMs, delayTermMs, ageTermMs, present: clockPresent });
  const log = createDriftLog({ capacity: 10000 });
  const applied = [];
  const history = [];
  let simulatedNowMs = epochMs - offsetMs;
  const firstDisplayMs = Math.ceil(intervalMs / vsyncMs) * vsyncMs;
  let mediaMs = standingError + firstDisplayMs - intervalMs;
  let frameIndex = 0;
  // The applied rate IS the plant's input: media advances at whatever the
  // controller last wrote, which is what closes the loop.
  let controllerRate = 1;

  const quantisedDisplay = () => {
    const sharedElapsed = simulatedNowMs + offsetMs - epochMs;
    return epochMs + Math.ceil(sharedElapsed / vsyncMs) * vsyncMs;
  };

  const controller = createDriftController({
    log,
    clock,
    apply: (rate) => {
      applied.push(rate);
      controllerRate = rate;
    },
    settings,
    now: () => simulatedNowMs,
  });

  function deliver({ repeat = false } = {}) {
    if (!repeat) mediaMs += intervalMs;
    simulatedNowMs += intervalMs / controllerRate;
    const displaySharedMs = quantisedDisplay();
    const displayLocalMs = displaySharedMs - offsetMs;
    const metadata = {
      mediaTime: mediaMs / 1000,
      expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
      presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
      presentedFrames: repeat ? frameIndex : frameIndex + 1,
    };
    log.add(deriveDriftRecord({
      metadata,
      timeOriginMs: TIME_ORIGIN_MS,
      localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
      clock,
      timeline,
    }));
    frameIndex += 1;
    if (frameIndex % pollEvery === 0) history.push(controller.poll());
    return log.read().records.at(-1);
  }

  return {
    clock,
    log,
    applied,
    history,
    controller,
    get now() { return simulatedNowMs; },
    get rate() { return controllerRate; },
    deliver,
    advance(ms) { simulatedNowMs += ms; },
  };
}

export function recordRig({ settings = {}, offsetMs = 0, halfWidthMs = 4 } = {}) {
  const epochMs = TIME_ORIGIN_MS + 60_000;
  const timeline = createRoomTimeline();
  timeline.observeRoster([{ clientId: 'a', joinedAt: epochMs }]);
  const clock = createFakeClock({ offsetMs, delayTermMs: halfWidthMs, ageTermMs: 0 });
  const log = createDriftLog({ capacity: 10000 });
  let localNowMs = epochMs + 2000 - offsetMs;
  const applied = [];
  const controller = createDriftController({
    log,
    clock,
    apply: (rate) => applied.push(rate),
    settings,
    now: () => localNowMs,
  });

  function add(rawDriftMs, recordOffsetMs = clock.state.offsetMs) {
    const displaySharedMs = localNowMs + clock.state.offsetMs;
    const displayLocalMs = displaySharedMs - recordOffsetMs;
    clock.state.offsetMs = recordOffsetMs;
    const scheduledMediaMs = displaySharedMs - epochMs;
    const outcome = deriveDriftRecord({
      metadata: {
        mediaTime: (scheduledMediaMs + rawDriftMs) / 1000,
        expectedDisplayTime: displayLocalMs - TIME_ORIGIN_MS,
        presentationTime: displayLocalMs - TIME_ORIGIN_MS - 4,
        presentedFrames: 1,
      },
      timeOriginMs: TIME_ORIGIN_MS,
      localNowMs: displayLocalMs - DEFAULT_CALLBACK_LEAD_MS,
      clock,
      timeline,
    });
    log.add(outcome);
    localNowMs += 20;
    return outcome;
  }

  return { clock, log, controller, applied, add, advance(ms) { localNowMs += ms; } };
}

export function runUntil(thing, predicate, limitMs) {
  const start = thing.now;
  let frames = 0;
  while (!predicate(thing.controller.state()) && thing.now - start <= limitMs) {
    thing.deliver();
    frames += 1;
  }
  return { elapsedMs: thing.now - start, frames, state: thing.controller.state() };
}
