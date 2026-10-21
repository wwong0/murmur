// scripts/check/mechanism-driver.mjs
//
// The event driver: local elapsed time, three independent event streams, and the
// REAL unmodified drift controller wired to the modelled mechanisms next door.
//
// It exists because the old plant (`drift-plant.mjs`) advances one frame per
// step and polls every N FRAMES, so its poll schedule is a function of the very
// frame production the experiment is about. Here a poll happens every 250 ms of
// local elapsed time whether or not a frame was produced, exactly as
// `room.entry.js`'s `setInterval` does, and a record is invisible to a poll
// until the modelled callback published it.
//
// THE EVENT ORDER AT ONE INSTANT IS FIXED AND DECLARED: display step, then frame
// callback, then controller poll. Rationale, in the model's own terms: a
// compositor step selects the frame, the main thread's callback can only report
// a selection that already happened, and a poll can only read what the log
// already holds. Ties are resolved by that order and nothing else, so a case is
// reproducible from its configuration alone.
//
// A record NEVER reaches the log before its callback instant. `presentedFrames`
// increments only when the presented frame CHANGES — the compositor's own
// `ProcessNewFrame` test — so a held frame produces no callback, no record and
// no observation, which is the gap semantics the controller's staleness rule is
// written against.
//
// TEST MACHINERY — under scripts/. No randomness, no timers, no browser: a
// 240-second case costs milliseconds because every mechanism here is arithmetic.

import { createAudioTimeSource } from './mechanism-audio.mjs';
import { createRendererAlgorithm } from './mechanism-presentation.mjs';
import { createFakeClock, DEFAULT_TIME_ORIGIN_MS } from './fake-frames.mjs';
import { createDriftLog, deriveDriftRecord } from '../../public/lib/frame-drift.mjs';
import { createDriftController } from '../../public/lib/drift-controller.mjs';
import { createRoomTimeline, fixedPlayingState } from '../../public/lib/room-timeline.mjs';

export const TIME_ORIGIN_MS = DEFAULT_TIME_ORIGIN_MS;
/** `room.entry.js`'s `setInterval(tickPlayback, 250)`. */
export const POLL_INTERVAL_MS = 250;
/** The media position the model starts at, so a PTS looks like a real one. */
export const MEDIA_START_MS = 60_000;
/** Declared event precedence at one instant. Index is the priority. */
export const EVENT_ORDER = Object.freeze(['display', 'callback', 'poll']);

export const AUDIO_MECHANISMS = Object.freeze(['modelled', 'ideal']);
export const PRESENTATION_MECHANISMS = Object.freeze(['modelled', 'no-cadence', 'ideal']);

/**
 * The frozen defaults. Every one of them is a MODEL CONFIGURATION: none was
 * recovered from a browser record, and the sample rate and pitch flag in
 * particular are the declared hypothesis, not an observed device setting.
 */
export const DEFAULTS = Object.freeze({
  timeOriginMs: TIME_ORIGIN_MS,
  fps: 24,
  refreshHz: 180,
  sampleRate: 48000,
  preservesPitch: true,
  // Compositor step to the deadline it is compositing for, and to the main
  // thread callback reporting it. Their difference is the 8 ms lead
  // `fake-frames.mjs` already uses, so a record built here has the same shape as
  // one built by the existing rig.
  displayLeadMs: 8 + 1 / 3,
  callbackDelayMs: 1 / 3,
  pollPhaseMs: 0,
  displayPhaseMs: 0,
  cadenceParityOffset: 0,
  offsetMs: 0,
  clockPresent: true,
  delayTermMs: 3,
  ageTermMs: 1,
  rateLoadPpm: 0,
  decodeLookaheadMs: 250,
  maxQueuedFrames: 5,
  audioBufferMs: 200,
  logCapacity: 40_000,
});

const priorityOf = (kind) => EVENT_ORDER.indexOf(kind);

/**
 * Run one case to `durationMs` of local elapsed time.
 *
 * `command` is either `{ kind: 'closed-loop' }` — the controller's rate reaches
 * the player — or `{ kind: 'open-loop', rateAt(elapsedMs) }`, which is D7's rig:
 * the controller still polls and still publishes, and its writes are recorded
 * and discarded, so the loop is open at the actuator and nowhere else.
 *
 * `createController` is a SECOND PARAMETER and not a config field, so it cannot
 * reach `spec` and cannot be serialised into a result: a recorded case says what
 * was configured, and which controller ran it is stated by the caller that chose
 * it. It defaults to the real controller, so every existing call site — and
 * every existing check — keeps the product loop it already had.
 */
export function runMechanismCase(config, { createController = createDriftController } = {}) {
  const {
    caseId = 'unnamed',
    durationMs,
    standingErrorMs = 0,
    command = { kind: 'closed-loop' },
    mechanisms = { audio: 'modelled', presentation: 'modelled' },
    settings = {},
    traceEvents = false,
    traceRecords = false,
    ...rest
  } = config;
  const spec = { ...DEFAULTS, ...rest };
  if (!AUDIO_MECHANISMS.includes(mechanisms.audio)) throw new RangeError(`mechanism-driver: unknown audio mechanism ${mechanisms.audio}`);
  if (!PRESENTATION_MECHANISMS.includes(mechanisms.presentation)) throw new RangeError(`mechanism-driver: unknown presentation mechanism ${mechanisms.presentation}`);
  if (!(durationMs > 0)) throw new RangeError(`mechanism-driver: durationMs must be positive, got ${durationMs}`);

  const frameIntervalMs = 1000 / spec.fps;
  const renderIntervalMs = 1000 / spec.refreshHz;
  const loadMultiplier = 1 + spec.rateLoadPpm / 1e6;
  // Chosen so an ideally presented frame at elapsed 0 carries exactly
  // `standingErrorMs` of drift; the display lead cancels between the frame's
  // mapped media time and the schedule read at the same deadline.
  const epochMs = spec.timeOriginMs + spec.offsetMs - MEDIA_START_MS + standingErrorMs;

  const audio = createAudioTimeSource({
    sampleRate: spec.sampleRate,
    preservesPitch: spec.preservesPitch,
    startMediaMs: MEDIA_START_MS,
    startWallMs: 0,
    bufferFrames: Math.round((spec.audioBufferMs / 1000) * spec.sampleRate),
    idealAdvance: mechanisms.audio === 'ideal',
  });
  const renderer = mechanisms.presentation === 'ideal' ? null : createRendererAlgorithm({
    wallClockTimeCb: (mediaTimestamps) => ({
      wallTimes: mediaTimestamps.map((ms) => audio.wallClockTimeForMediaMs(ms).wallMs),
      isTimeMoving: true,
    }),
    cadenceParityOffset: spec.cadenceParityOffset,
    cadenceEnabled: mechanisms.presentation === 'modelled',
  });

  const clock = createFakeClock({ offsetMs: spec.offsetMs, delayTermMs: spec.delayTermMs, ageTermMs: spec.ageTermMs, present: spec.clockPresent });
  const log = createDriftLog({ capacity: spec.logCapacity });
  const timeline = createRoomTimeline({ readState: () => fixedPlayingState(epochMs) });

  let elapsedMs = 0;
  let requestedRate = 1;
  const applied = [];
  const controller = createController({
    log,
    clock,
    apply: (rate) => {
      applied.push({ atMs: elapsedMs, rate });
      if (command.kind === 'closed-loop') requestedRate = rate;
    },
    settings,
    now: () => spec.timeOriginMs + elapsedMs,
  });

  const scheduledMediaAt = (localElapsedMs) => localElapsedMs + MEDIA_START_MS - standingErrorMs;
  /** The PHYSICAL error: the media clock against the room, with no observation stage in it. */
  const trueDriftAt = () => audio.currentMediaMs - scheduledMediaAt(elapsedMs);

  const history = [];
  const events = [];
  const records = [];
  const counters = {
    displaySteps: 0, callbacks: 0, polls: 0, presentedFrames: 0, heldSteps: 0,
    recordsRefused: 0, framesDecoded: 0, framesDropped: 0,
  };
  const audioModeCounts = { passthrough: 0, wsola: 0, resampler: 0, ideal: 0 };

  let nextStepIndex = 0;
  let nextPollIndex = 0;
  let nextFrameIndex = 0;
  let currentFrameId = null;
  let presentedFrames = 0;
  /** @type {{atMs: number, ptsMs: number, deadlineMinMs: number, presentedFrames: number}[]} */
  const pendingCallbacks = [];

  const stepTime = (index) => spec.displayPhaseMs + index * renderIntervalMs;
  const pollTime = (index) => spec.pollPhaseMs + index * POLL_INTERVAL_MS;

  function advanceTo(atMs) {
    const dtMs = atMs - elapsedMs;
    if (dtMs < 0) throw new RangeError(`mechanism-driver: ${caseId} tried to run time backwards to ${atMs}`);
    if (dtMs > 0) {
      const { mode } = audio.advanceWall(dtMs, requestedRate, loadMultiplier);
      audioModeCounts[mode] += 1;
    }
    elapsedMs = atMs;
  }

  function decodeInto() {
    while (renderer.queueLength < spec.maxQueuedFrames) {
      const ptsMs = MEDIA_START_MS + nextFrameIndex * frameIntervalMs;
      if (ptsMs > audio.currentMediaMs + spec.decodeLookaheadMs) break;
      renderer.enqueueFrame({ ptsMs, metadataDurationMs: frameIntervalMs });
      nextFrameIndex += 1;
      counters.framesDecoded += 1;
    }
  }

  function onDisplayStep() {
    counters.displaySteps += 1;
    const deadlineMinMs = elapsedMs + spec.displayLeadMs;
    const deadlineMaxMs = deadlineMinMs + renderIntervalMs;
    let ptsMs = null;
    let isNew = false;
    if (renderer === null) {
      // Ideal presentation: the observation channel carries the media clock with
      // no frame quantisation at all. NOT a physical player — no player presents
      // 180 distinct frames a second from 24 fps content — it is the control that
      // isolates the audio branch, and it is labelled as one everywhere.
      const { effectiveRate } = audio.peekEffectiveRate(requestedRate, loadMultiplier);
      ptsMs = audio.currentMediaMs + spec.displayLeadMs * effectiveRate;
      isNew = true;
    } else {
      decodeInto();
      const rendered = renderer.render(deadlineMinMs, deadlineMaxMs);
      if (rendered === null) return;
      counters.framesDropped += rendered.framesDropped;
      ptsMs = rendered.frame.ptsMs;
      isNew = rendered.frame.id !== currentFrameId;
      if (isNew) currentFrameId = rendered.frame.id;
      else counters.heldSteps += 1;
    }
    if (!isNew) return;
    presentedFrames += 1;
    counters.presentedFrames += 1;
    pendingCallbacks.push({ atMs: elapsedMs + spec.callbackDelayMs, ptsMs, deadlineMinMs, presentedFrames });
  }

  function onCallback(pending) {
    counters.callbacks += 1;
    const outcome = deriveDriftRecord({
      metadata: {
        mediaTime: pending.ptsMs / 1000,
        expectedDisplayTime: pending.deadlineMinMs,
        presentationTime: pending.deadlineMinMs - spec.displayLeadMs,
        presentedFrames: pending.presentedFrames,
      },
      timeOriginMs: spec.timeOriginMs,
      localNowMs: spec.timeOriginMs + elapsedMs,
      clock,
      timeline,
      placementMs: 0,
    });
    if (!outcome.ok) counters.recordsRefused += 1;
    const record = log.add(outcome);
    // TWO INSTANTS, AND THEY ARE NOT THE SAME ONE. `atMs` is when the callback
    // ran, which is what decides whether a poll can see this record. `displayMs`
    // is the deadline the frame was scheduled for, which is the timebase the
    // browser diagnostic regresses PTS against. They differ by
    // `displayLeadMs - callbackDelayMs`, 8 ms under the declared configuration,
    // and a slope taken against the wrong one puts different records inside a
    // window (see `mechanism-model-report.md`, "Corrections after review").
    if (traceRecords && record) records.push({ atMs: elapsedMs, displayMs: pending.deadlineMinMs, seq: record.seq, ptsMs: pending.ptsMs, driftMs: record.driftMs });
    return record;
  }

  function onPoll() {
    counters.polls += 1;
    const state = controller.poll();
    history.push({
      atMs: elapsedMs,
      polls: state.polls,
      mode: state.mode,
      reason: state.reason,
      estimateMs: state.estimateMs,
      bandMs: state.bandMs,
      spreadMs: state.spreadMs,
      stoppingThresholdMs: state.stoppingThresholdMs,
      windowRecords: state.windowRecords,
      rate: state.rate,
      settlingMs: state.settlingMs,
      requestedRate,
      trueDriftMs: trueDriftAt(),
      audioMode: audio.peekEffectiveRate(requestedRate, loadMultiplier).mode,
      effectiveRate: audio.peekEffectiveRate(requestedRate, loadMultiplier).effectiveRate,
      cadenceInUse: renderer ? renderer.cadenceInUse.join(':') : null,
      presentedFrames,
    });
  }

  while (true) {
    const candidates = [];
    const nextStepMs = stepTime(nextStepIndex);
    if (nextStepMs <= durationMs) candidates.push({ kind: 'display', atMs: nextStepMs });
    if (pendingCallbacks.length > 0 && pendingCallbacks[0].atMs <= durationMs) {
      candidates.push({ kind: 'callback', atMs: pendingCallbacks[0].atMs });
    }
    const nextPollMs = pollTime(nextPollIndex);
    if (nextPollMs <= durationMs) candidates.push({ kind: 'poll', atMs: nextPollMs });
    if (candidates.length === 0) break;
    candidates.sort((a, b) => (a.atMs - b.atMs) || (priorityOf(a.kind) - priorityOf(b.kind)));
    const event = candidates[0];
    advanceTo(event.atMs);
    if (command.kind === 'open-loop') requestedRate = command.rateAt(elapsedMs);
    if (traceEvents) events.push({ kind: event.kind, atMs: event.atMs, requestedRate });
    if (event.kind === 'display') { nextStepIndex += 1; onDisplayStep(); }
    else if (event.kind === 'callback') { onCallback(pendingCallbacks.shift()); }
    else { nextPollIndex += 1; onPoll(); }
  }
  advanceTo(durationMs);

  return {
    caseId,
    spec: { ...spec, durationMs, standingErrorMs, mechanisms: { ...mechanisms }, commandKind: command.kind, settings },
    epochMs,
    history,
    applied,
    // `missed` from seq 0 IS the eviction count: a ring shorter than the run
    // loses evidence silently otherwise (`CONSTRAINTS.md` → *Measurement*).
    counters: { ...counters, ...log.counters, logEvictions: log.read({ afterSeq: 0 }).missed },
    audioModeCounts,
    events: traceEvents ? events : null,
    records: traceRecords ? records : null,
    finalTrueDriftMs: trueDriftAt(),
    finalRequestedRate: requestedRate,
    cadenceInUse: renderer ? renderer.cadenceInUse.join(':') : null,
    cadenceEstimated: renderer ? renderer.cadenceEstimated.join(':') : null,
    presentationCounters: renderer ? renderer.counters : null,
    maxAcceptableDriftMs: renderer ? renderer.maxAcceptableDriftMs : null,
    timeUntilMaxDriftMs: renderer ? renderer.timeUntilMaxDriftMs : null,
  };
}
