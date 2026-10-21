// scripts/check/suites/start-telemetry.mjs
//
// The start telemetry ring and the frame observer (executor-spec.md §11.1).
// Pure: the ring's `now` is scripted and the frames are manufactured by
// check/fake-frames.mjs, so nothing here costs wall-clock time or a browser.

import { check, assert, assertEqual } from '../harness.mjs';
import { createFakeFrames, createFrameBinding } from '../fake-frames.mjs';
import { createDriftLog } from '../../../public/lib/frame-drift.mjs';
import { createStartTelemetry, createFrameObserver, TELEMETRY_CAPACITY } from '../../../public/lib/start-telemetry.mjs';

const json = (value) => JSON.stringify(value);

const CONTEXT = Object.freeze({
  attemptId: 4,
  lineage: 'abc',
  version: 2,
  nowSharedMs: 5000,
  clockOffsetMs: -12,
  clockHalfWidthMs: 3,
});

/** A scripted timebase: the nth call reads 1000, 1001, … so every stamp is checkable. */
function scriptedNow() {
  let calls = 0;
  return () => 1000 + calls++;
}

const telemetryWith = (overrides = {}) => createStartTelemetry({ enabled: true, now: scriptedNow(), ...overrides });

/** One rVFC metadata object; the pair in the absent-fields case edits only what it names. */
function metadata(edit = {}) {
  const base = {
    presentationTime: 4000,
    expectedDisplayTime: 4008,
    width: 1280,
    height: 720,
    mediaTime: 60.5,
    presentedFrames: 17,
    processingDuration: 0.004,
  };
  const built = { ...base, ...edit };
  for (const key of Object.keys(edit)) if (edit[key] === undefined) delete built[key];
  return built;
}

function observerOn(telemetry, { count = 8, video = { paused: true, playbackRate: 1 } } = {}) {
  const fake = createFakeFrames({ count });
  const binding = createFrameBinding(fake);
  const observer = createFrameObserver({
    video,
    telemetry,
    context: () => CONTEXT,
    now: () => 900,
    timeOriginMs: fake.timeOriginMs,
    requestFrame: binding.requestFrame,
    cancelFrame: binding.cancelFrame,
  });
  return { fake, binding, observer };
}

export default async function startTelemetrySuite() {
  await check('start telemetry: disabled records nothing and reads a shape distinguishable from enabled-and-empty', async () => {
    const off = createStartTelemetry({});
    assertEqual(off.enabled, false, 'the default is off');
    for (let i = 0; i < 10; i += 1) assertEqual(off.record('poll', { opens: 1 }, CONTEXT), null, `record ${i} returns null`);
    assertEqual(json(off.read(0)), json({ enabled: false, events: [], missed: 0, dropped: 0, latestSeq: 0, capacity: 0 }), 'the disabled reading');
    assertEqual(off.dropped, 0, 'and nothing was evicted');
    const on = telemetryWith();
    const empty = on.read(0);
    assertEqual(json(empty), json({ enabled: true, events: [], missed: 0, dropped: 0, latestSeq: 0, capacity: TELEMETRY_CAPACITY }), 'enabled and empty');
    // The pair differs in exactly the two keys that tell "off" from "on and silent".
    const differing = Object.keys(empty).filter((key) => json(empty[key]) !== json(off.read(0)[key]));
    assertEqual(json(differing), json(['enabled', 'capacity']), 'and in nothing else');
  });

  await check('start telemetry: sequence, key order, the context header and what read(afterSeq) returns', async () => {
    const telemetry = telemetryWith();
    const first = telemetry.record('poll', { nowSharedMs: 5000, resolved: true, waiting: null, missing: null, actions: ['load'], nextAtSharedMs: 5300, opens: 1, begun: 0, retargets: 0 }, CONTEXT);
    assertEqual(json(Object.keys(first)), json([
      'seq', 'kind', 'atLocalMs', 'atSharedMs', 'clockOffsetMs', 'clockHalfWidthMs', 'attemptId', 'lineage', 'version',
      'absentFields', 'nowSharedMs', 'resolved', 'waiting', 'missing', 'actions', 'nextAtSharedMs', 'opens', 'begun', 'retargets',
    ]), 'the declared key order');
    assertEqual(json([first.seq, first.atLocalMs, first.atSharedMs, first.clockOffsetMs, first.clockHalfWidthMs, first.attemptId, first.lineage, first.version]),
      json([1, 1000, 5000, -12, 3, 4, 'abc', 2]), 'seq 1, the scripted stamp and the context header');
    assertEqual(json(first.absentFields), json([]), 'a complete event names nothing absent');
    assert(Object.isFrozen(first) && Object.isFrozen(first.absentFields) && Object.isFrozen(first.actions), 'the event, its absent list and its array field are frozen');
    for (let i = 2; i <= 6; i += 1) {
      const event = telemetry.record('rate-write', { commandedRate: 1.01, readbackRate: 1, appliedOk: true }, CONTEXT);
      assertEqual(event.seq, i, `seq runs to ${i}`);
    }
    const reading = telemetry.read(4);
    assertEqual(json(reading.events.map((event) => event.seq)), json([5, 6]), 'read(4) is exactly what follows seq 4');
    assertEqual(reading.latestSeq, 6, 'latestSeq is the last seq issued');
    assertEqual(reading.missed, 0, 'with nothing missed');
    assertEqual(json(telemetry.read(0).events.map((event) => event.seq)), json([1, 2, 3, 4, 5, 6]), 'read(0) is everything');
    assertEqual(json(telemetry.read(6).events), json([]), 'read at the head is empty, not a repeat');
  });

  await check('start telemetry: the ring evicts by capacity and reports missed against the reader\'s cursor', async () => {
    const telemetry = telemetryWith({ capacity: 4 });
    for (let i = 0; i < 8; i += 1) telemetry.record('poll', { opens: i }, CONTEXT);
    const all = telemetry.read(0);
    assertEqual(all.events.length, 4, 'four events survive a capacity of four');
    assertEqual(json(all.events.map((event) => event.seq)), json([5, 6, 7, 8]), 'the newest four');
    assertEqual(all.dropped, 4, 'four were evicted');
    assertEqual(telemetry.dropped, 4, 'and the getter agrees');
    assertEqual(all.missed, 4, 'a reader at 0 missed four');
    assertEqual(telemetry.read(6).missed, 0, 'a reader at 6 missed none');
    assertEqual(json(telemetry.read(6).events.map((event) => event.seq)), json([7, 8]), 'and sees what follows it');
    assertEqual(all.capacity, 4, 'the capacity is reported');
  });

  await check('start telemetry: an absent metadata key and a NaN are named and nulled, and nothing else moves', async () => {
    const telemetry = telemetryWith();
    const complete = metadata();
    const broken = metadata({ processingDuration: undefined, presentationTime: Number.NaN });
    // R6: the pair differs in exactly the two fields under test.
    assertEqual(json(Object.keys(complete).filter((key) => json(complete[key]) !== json(broken[key]))), json(['presentationTime', 'processingDuration']), 'the fixture pair differs in two keys');
    const fields = (source) => ({
      paused: false, callbackNowMs: 4000, localNowMs: 4001, timeOriginMs: 1_756_000_000_000, commandedRate: 1, placementMs: 0,
      mediaTimeMs: Number.isFinite(source.mediaTime) ? source.mediaTime * 1000 : source.mediaTime,
      presentedFrames: source.presentedFrames, presentationTimeMs: source.presentationTime,
      expectedDisplayTimeMs: source.expectedDisplayTime,
      processingDurationMs: Number.isFinite(source.processingDuration) ? source.processingDuration * 1000 : source.processingDuration,
      width: source.width, height: source.height,
    });
    const good = telemetry.record('frame', fields(complete), CONTEXT);
    const bad = telemetry.record('frame', fields(broken), CONTEXT);
    assertEqual(json(good.absentFields), json([]), 'the complete frame names nothing');
    assertEqual(json(bad.absentFields), json(['presentationTime', 'processingDuration']), 'both keys are named under their metadata names');
    assertEqual(bad.presentationTimeMs, null, 'the NaN is stored as null');
    assertEqual(bad.processingDurationMs, null, 'and so is the missing optional');
    const untouched = Object.keys(good).filter((key) => !['seq', 'atLocalMs', 'absentFields', 'presentationTimeMs', 'processingDurationMs'].includes(key));
    for (const key of untouched) assertEqual(json(bad[key]), json(good[key]), `${key} is intact`);
    assertEqual(good.mediaTimeMs, 60_500, 'mediaTime is converted to milliseconds once, in the observer');
    // A null context is named, not defaulted to zero.
    const blind = telemetry.record('poll', { opens: 0 }, null);
    assertEqual(json([blind.atSharedMs, blind.clockOffsetMs, blind.clockHalfWidthMs]), json([null, null, null]), 'no clock reads as null');
    for (const key of ['atSharedMs', 'clockOffsetMs', 'clockHalfWidthMs', 'attemptId', 'version']) {
      assert(blind.absentFields.includes(key), `${key} is named absent`);
    }
  });

  await check('start telemetry: a callback from a previous generation records nothing', async () => {
    const telemetry = telemetryWith();
    const { binding, observer } = observerOn(telemetry, { count: 8 });
    observer.start();
    const stale = binding.hold();
    // Stopped and started again: `running` is true when the old callback lands,
    // so the running guard cannot absorb it and only the generation can.
    observer.stop();
    observer.start();
    assertEqual(observer.running, true, 'the observer is running when the stale callback is delivered');
    const before = telemetry.read(0).latestSeq;
    binding.deliverStale(stale);
    assertEqual(telemetry.read(0).latestSeq, before, 'a callback from a previous generation records nothing');
    assertEqual(observer.callbacks, 0, 'and is not counted');
    binding.deliver(1);
    assertEqual(telemetry.read(0).latestSeq, before + 1, 'a callback of the current generation records');
    assertEqual(observer.callbacks, 1, 'and is counted');
    binding.deliver(1);
    assertEqual(telemetry.read(0).latestSeq, before + 2, 'and the current generation re-armed');
  });

  await check('start telemetry: the observer holds no drift log, and its frames carry the raw metadata', async () => {
    const telemetry = telemetryWith();
    const log = createDriftLog();
    const { fake, binding, observer } = observerOn(telemetry, { count: 60, video: { paused: false, playbackRate: 1.005 } });
    observer.start();
    binding.deliver(50);
    assertEqual(observer.callbacks, 50, 'fifty frames were observed');
    assertEqual(log.read().counters.framesOffered, 0, 'the drift log received zero calls');
    assertEqual(log.latestSeq, 0, 'and holds no record');
    const events = telemetry.read(0).events;
    assertEqual(events.length, 50, 'one event per frame');
    const first = events[0];
    const source = fake.frames[0].metadata;
    assertEqual(json([first.kind, first.paused, first.commandedRate, first.timeOriginMs, first.localNowMs]),
      json(['frame', false, 1.005, fake.timeOriginMs, 900]), 'the element and timebase readings taken at callback entry');
    assertEqual(json([first.callbackNowMs, first.expectedDisplayTimeMs, first.presentationTimeMs, first.presentedFrames, first.width, first.height]),
      json([source.expectedDisplayTime, source.expectedDisplayTime, source.presentationTime, source.presentedFrames, source.width, source.height]),
      'the rVFC `now` argument and the metadata are retained raw');
    assertEqual(first.mediaTimeMs, source.mediaTime * 1000, 'media time in milliseconds');
    assertEqual(first.processingDurationMs, source.processingDuration * 1000, 'processing duration in milliseconds');
    observer.stop();
    assertEqual(observer.running, false, 'stop clears the running flag');
  });
}
