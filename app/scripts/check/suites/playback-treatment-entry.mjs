// scripts/check/suites/playback-treatment-entry.mjs
//
// The treatment through the real bundled page (remedy-product-integration-spec.md
// 4.2 items 4 and 5): room.entry.js runs in a vm against a scripted element,
// with only the network and hls.js faked. Then the composed research arms, the
// product bundle's inputs, and the one-assignment rule on the source.
//
// Each esbuild build costs a fraction of a second; there is no browser here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { check, assert, assertEqual } from '../harness.mjs';
import { FAKED_SPECIFIERS, bundleProductEntry, researchEsbuild, runEntry, withTempDir } from '../entry-harness.mjs';
import { commandThresholdFor } from '../d8-research-controller.mjs';
import { buildResearchBundle } from '../../remedy-browser-build.mjs';
import { buildOptions } from '../../build.mjs';
import { D8_COMMAND_THRESHOLD } from '../../../public/lib/drift-controller.mjs';
import { seamEpochAgreement } from '../../start-residual.mjs';
import { PRESENTATION_ADVANCE_MS } from '../../../public/lib/playback-leads.mjs';
import { CONTROLLER_LINE_TREATMENT_FAULT_RE } from '../../../public/lib/diagnostics-overlay.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = (value) => JSON.stringify(value);

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (/\.(m?js|jsx)$/.test(entry.name) && !entry.name.includes('.bundle.')) found.push(full);
  }
  return found;
}

// One scripted frame sequence, and the drift records it must produce whatever
// the instrument is doing (executor-spec.md §11.2). Every number is arithmetic
// on the fixture: displayShared = timeOrigin + expectedDisplayTime + offset,
// scheduled = displayShared − epoch, drift = media − scheduled. The epoch is the
// sole creation's, `sharedNow + TRANSITION_LEAD_MS` at mediaMs 0.
const TIME_ORIGIN_MS = 1_700_000_000_000;
const FIXTURE = Object.freeze({
  sharedNowMs: 1_700_000_000_400,
  epochMs: 1_700_000_000_700,
  clock: Object.freeze({ offsetMs: 500, halfWidthMs: 7, delayTermMs: 4, ageTermMs: 3, sampleCount: 8, counters: Object.freeze({ reanchors: 0 }) }),
  frames: Object.freeze([
    { expectedDisplayTime: 900, mediaTime: 0.5, presentedFrames: 101 },
    { expectedDisplayTime: 1000, mediaTime: 0.625, presentedFrames: 102 },
    { expectedDisplayTime: 1100, mediaTime: 0.75, presentedFrames: 103 },
    { expectedDisplayTime: 1200, mediaTime: 0.875, presentedFrames: 104 },
  ]),
});
const RECORD_CLOCK = { offsetMs: 500, halfWidthMs: 7, delayTermMs: 4, ageTermMs: 3, sampleCount: 8 };
const EXPECTED_RECORDS = [
  { seq: 1, epochMs: 1_700_000_000_700, mediaMs: 500, placementMs: 0, displaySharedMs: 1_700_000_001_400, scheduledMediaMs: 700, driftMs: -200, presentedFrames: 101, clock: RECORD_CLOCK },
  { seq: 2, epochMs: 1_700_000_000_700, mediaMs: 625, placementMs: 0, displaySharedMs: 1_700_000_001_500, scheduledMediaMs: 800, driftMs: -175, presentedFrames: 102 },
  { seq: 3, epochMs: 1_700_000_000_700, mediaMs: 750, placementMs: 0, displaySharedMs: 1_700_000_001_600, scheduledMediaMs: 900, driftMs: -150, presentedFrames: 103 },
  { seq: 4, epochMs: 1_700_000_000_700, mediaMs: 875, placementMs: 0, displaySharedMs: 1_700_000_001_700, scheduledMediaMs: 1000, driftMs: -125, presentedFrames: 104 },
].map((record) => ({ ...record, clock: RECORD_CLOCK }));

function runScriptedFrames(product, { startTiming }) {
  const page = runEntry(product.code, { search: startTiming ? '?room=r&tab=t&startTiming=1' : '?room=r&tab=t' });
  page.harness.clock = { ...FIXTURE.clock };
  page.resolveSole({ nowMs: FIXTURE.sharedNowMs });
  // A fixed `performance.now()`: the display-window guard compares it against
  // each frame's display instant, and nothing in a record is derived from it.
  page.setNow(1000);
  const armedBeforePlay = page.control.armedFrames();
  page.act([{ kind: 'play', attemptId: 1, startAtSharedMs: FIXTURE.epochMs, latenessMs: 0, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: FIXTURE.epochMs }], { startAtSharedMs: FIXTURE.epochMs });
  const armedAfterPlay = page.control.armedFrames();
  for (const frame of FIXTURE.frames) {
    page.control.deliverFrame({ width: 1280, height: 720, presentationTime: frame.expectedDisplayTime - 4, processingDuration: 0.004, ...frame });
  }
  return { page, armedBeforePlay, armedAfterPlay, records: page.app.drift().records };
}

export default async function playbackTreatmentEntrySuite() {
  const product = await bundleProductEntry();

  await check('playback-treatment-entry: the page writes pitch once, after the player and before the sampler, controller and open', async () => {
    for (const specifier of [...FAKED_SPECIFIERS, './lib/drift-controller.mjs', './lib/frame-sampler.mjs']) {
      assert(product.hits.includes(specifier), `the harness substitution for ${specifier} fired`);
    }
    const page = runEntry(product.code);
    const kinds = page.kinds();
    const at = (kind) => kinds.indexOf(kind);
    const order = ['player-created', 'pitch-write', 'sampler-created', 'controller-created', 'playback-start-created'];
    for (let index = 1; index < order.length; index += 1) {
      assert(at(order[index - 1]) >= 0 && at(order[index - 1]) < at(order[index]), `${order[index - 1]} precedes ${order[index]}: ${kinds.join(', ')}`);
    }
    const constructed = page.events.find((event) => event.kind === 'controller-created');
    assert(Object.is(constructed.detail.f, D8_COMMAND_THRESHOLD), `the controller was constructed at exactly the adopted f, got ${constructed.detail.f}`);
    page.open({});
    assert(at('pitch-write') < page.kinds().indexOf('load'), 'the write precedes the load');
    assertEqual(page.count('pitch-write'), 1, 'one pitch write in the page lifetime');
    const pitch = page.app.pitch();
    assertEqual(json([pitch.treatment, pitch.controllerActive, pitch.fault]), json(['d8-pitch-disabled', true, null]), 'the seam reports the adopted treatment, active');
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'each tick polls the controller once');
    assertEqual(page.app.treatmentEvidence(), null, 'without the opt-in the page keeps no event history');
  });

  await check('playback-treatment-entry: the page constructs the start with the compiled presentation advance', async () => {
    const page = runEntry(product.code);
    const constructed = page.events.find((event) => event.kind === 'playback-start-created');
    assert(constructed !== undefined, 'the page constructed the scheduled start');
    const { presentationAdvanceMs } = constructed.detail ?? {};
    // Two-sided: the exact compiled constant, and positive. A zero would leave
    // every EPOCH label agreeing by coincidence and every residual untreated,
    // with nothing else in this suite able to tell (d1-findings.md R2).
    assert(Object.is(presentationAdvanceMs, PRESENTATION_ADVANCE_MS),
      `the page passed the compiled advance, got ${presentationAdvanceMs}`);
    assert(presentationAdvanceMs > 0, `the advance the page passed is positive, got ${presentationAdvanceMs}`);
  });

  await check('playback-treatment-entry: a throwing playback-start step still polls the controller and is reported by name', async () => {
    const page = runEntry(product.code);
    page.harness.pollThrows = true;
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'the controller step ran after the throwing start step');
    assert(page.notices().some((text) => text.includes('playback-start failed')), 'the failure is reported under its step name');
  });

  await check('playback-treatment-entry: every load, park and play marks one seam, and the sampler follows pause and play', async () => {
    const page = runEntry(product.code);
    const identity = page.resolveSole({ nowMs: 10_000 });
    assert(identity.resolved === true && identity.playing === true, `the real acquisition resolved from its own creation: ${json(identity)}`);
    const { lineage } = identity.identity;
    // Pause the room at 10400: paused at media 100 (the creation plays from 0 at 10300).
    page.deliver({ type: 'playback-operation', seq: 3, from: 'c1', ts: { recv: 10_350 }, payload: { kind: 'pause', basis: { lineage, version: 2 }, atSharedMs: 10_400 } });
    assertEqual(page.app.timeline().playing, false, 'the pause was applied');
    const latestSeq = page.app.drift().latestSeq;

    page.act([{ kind: 'load', attemptId: 1, positionMs: 100, scheduledPositionMs: 100, advanceMs: 0, seamEpochMs: 10_300 }], { startAtSharedMs: null });
    page.act([{ kind: 'park', attemptId: 2, positionMs: 250, scheduledPositionMs: 250, advanceMs: 0, seamEpochMs: 10_750 }], { startAtSharedMs: 11_000 });
    page.act([{ kind: 'pause', attemptId: 3 }]);
    assertEqual(page.count('sampler-stop'), 1, 'a pause action stops the sampler');
    assertEqual(page.count('sampler-start'), 0, 'and nothing started it');
    page.act([{ kind: 'play', attemptId: 2, startAtSharedMs: 11_000, latenessMs: 20, positionMs: 250, scheduledPositionMs: 250, advanceMs: 0, seamEpochMs: 10_750 }]);
    assertEqual(page.count('sampler-start'), 1, 'a play action starts the sampler');
    assertEqual(page.count('play'), 1, 'and calls play() on the element');

    const { seams, starts } = page.app.playback();
    assertEqual(json(seams), json([
      { afterSeq: latestSeq, epochMs: 10_300, positionMs: 100 },
      { afterSeq: latestSeq, epochMs: 10_750, positionMs: 250 },
      { afterSeq: latestSeq, epochMs: 10_750, positionMs: 250 },
    ]), 'a paused hold seams at its mapping, a playing park and its play at S minus the park');
    assertEqual(json(starts), json([{ attemptId: 2, afterSeq: latestSeq, startAtSharedMs: 11_000, playAtSharedMs: 11_020, latenessMs: 20, positionMs: 250, scheduledPositionMs: 250, advanceMs: 0, epochMs: 11_000 - 250 }]), 'the play appended one start');

    page.control.settlePlay(0);
    await new Promise((resolve) => setImmediate(resolve));
    assertEqual(json(page.events.filter((event) => event.kind === 'play-resolved').map((event) => event.detail)), json([2]), 'the resolution reached its attempt');
  });

  // The defect §12 exists to prevent, and the one that would evade every
  // controller assertion: with a nonzero advance, `S − physical park` is the
  // true room epoch MINUS the advance, and the controller drops its own window
  // by `afterSeq`, so nothing downstream would contradict it.
  await check('playback-treatment-entry: the seam publishes the room mapping epoch, not S minus the advanced park', async () => {
    const A = PRESENTATION_ADVANCE_MS;
    assert(A > 0, `this check is only a check with a nonzero advance, got ${A}`);
    const page = runEntry(product.code, { search: '?room=r&tab=t' });
    page.harness.clock = { ...FIXTURE.clock };
    const identity = page.resolveSole({ nowMs: FIXTURE.sharedNowMs });
    // The sole creation plays from mediaMs 0 at sharedNow + TRANSITION_LEAD_MS.
    const roomEpochMs = FIXTURE.epochMs;
    assert(identity.playing === true, 'the room this start serves is playing');
    const latestSeq = page.app.drift().latestSeq;
    // One mapping, three actions: the room position at S, and the park an
    // advance beyond it. Nothing but the advance separates the two.
    const serving = (S) => ({ scheduledPositionMs: S - roomEpochMs, positionMs: S - roomEpochMs + A, advanceMs: A, seamEpochMs: roomEpochMs });
    const S1 = roomEpochMs + 700;
    const S2 = roomEpochMs + 1_700;
    page.act([{ kind: 'load', attemptId: 1, ...serving(S1) }], { startAtSharedMs: S1 });
    page.act([{ kind: 'park', attemptId: 2, ...serving(S2) }], { startAtSharedMs: S2 });
    page.act([{ kind: 'play', attemptId: 2, startAtSharedMs: S2, latenessMs: 0, ...serving(S2) }], { startAtSharedMs: S2 });

    const { seams, starts } = page.app.playback();
    assertEqual(seams.length, 3, 'the load, the park and the play each marked exactly one seam');
    assertEqual(json(seams), json([
      { afterSeq: latestSeq, epochMs: roomEpochMs, positionMs: 700 },
      { afterSeq: latestSeq, epochMs: roomEpochMs, positionMs: 1_700 },
      { afterSeq: latestSeq, epochMs: roomEpochMs, positionMs: 1_700 },
    ]), 'every seam publishes the room mapping epoch and the room position at S');
    // Two-sided: the derived expression is a different, reachable number, so the
    // assertion above is not satisfied by the two happening to agree.
    assertEqual(S2 - serving(S2).positionMs, roomEpochMs - A, 'S minus the advanced park is the room epoch minus the advance');
    assert(seams.every((seam) => seam.epochMs !== S2 - serving(S2).positionMs), 'and no seam published that');
    const wrote = page.events.filter((event) => event.kind === 'load' || event.kind === 'park');
    assertEqual(json(wrote.map((event) => event.detail.startPositionMs ?? event.detail.positionMs)), json([700 + A, 1_700 + A]), 'the player was written the advanced park, not the room position');
    assertEqual(json([starts[0].positionMs, starts[0].scheduledPositionMs, starts[0].advanceMs]), json([1_700 + A, 1_700, A]), 'the start entry keeps the park, the room position and the advance apart');
    assertEqual(starts[0].epochMs, roomEpochMs, 'and publishes the seam epoch acceptance reads (§15 item 4)');

    // The records come from the timeline, so seam and record must agree.
    page.setNow(1000);
    page.control.deliverFrame({ width: 1280, height: 720, presentationTime: 896, processingDuration: 0.004, ...FIXTURE.frames[0] });
    const records = page.app.drift().records;
    assertEqual(records.length, 1, 'the delivered frame produced one record');
    assertEqual(records[0].epochMs, seams[0].epochMs, 'the record carries the same epoch the seam published');
    assert(Number.isFinite(records[0].epochMs) && Number.isFinite(seams[0].epochMs), 'both are finite');

    // The acceptance label, over the page's OWN published figures rather than a
    // fixture: this is the path `verify:browser` takes (§15 items 1 and 4).
    const accepted = records.map((record, index) => ({ ...record, seq: starts[0].afterSeq + 1 + index }));
    assertEqual(seamEpochAgreement({ start: starts[0], records: accepted }).status, 'agrees', 'EPOCH agrees over the entry point\'s own start and records');
    assertEqual(seamEpochAgreement({ start: { ...starts[0], epochMs: S2 - starts[0].positionMs }, records: accepted }).status, 'derived',
      'and the same start with the derived epoch is caught, so the label can fail');
  });

  await check('playback-treatment-entry: readiness waits for a park\'s seeked, and the tick re-checks readyState', async () => {
    const page = runEntry(product.code);
    page.harness.sharedNowMs = 5_000;
    const readies = () => page.events.filter((event) => event.kind === 'ready').map((event) => event.detail);
    page.act([{ kind: 'park', attemptId: 7, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 6_000 }], { startAtSharedMs: 6_000 });
    page.video.readyState = 4;
    page.control.fire('canplay');
    assertEqual(readies().length, 0, 'canplay before the park\'s seeked is not readiness');
    page.video.readyState = 2;
    page.control.fire('seeked');
    assertEqual(readies().length, 0, 'seeked below HAVE_FUTURE_DATA is not readiness yet');
    page.video.readyState = 3;
    page.tick();
    assertEqual(json(readies()[0]), json({ attemptId: 7, observedSharedMs: 5_000 }), 'the tick reports readiness for the parked attempt');

    const load = runEntry(product.code);
    load.harness.sharedNowMs = 5_000;
    load.act([{ kind: 'load', attemptId: 1, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 6_000 }], { startAtSharedMs: 6_000 });
    load.video.readyState = 4;
    load.control.fire('canplay');
    assertEqual(load.events.filter((event) => event.kind === 'ready').length, 1, 'a load needs no seeked');
  });

  await check('playback-treatment-entry: queued readiness cannot qualify an unfinished replacement seek', async () => {
    const page = runEntry(product.code);
    page.harness.sharedNowMs = 5_000;
    const park = (id, positionMs) => page.act([{ kind: 'park', attemptId: id,
      positionMs, scheduledPositionMs: positionMs, advanceMs: 0, seamEpochMs: 4_000,
    }], { startAtSharedMs: 6_000 });
    const readies = () => page.events.filter((event) => event.kind === 'ready');
    park(7, 1000);
    park(8, 2000);
    // The native event has no attempt ID. A queued event from the old seek
    // arrives while the replacement's currentTime write is still seeking.
    page.video.seeking = true;
    page.video.readyState = 4;
    page.control.fire('seeked');
    page.tick();
    assertEqual(readies().length, 0, 'an unfinished replacement cannot receive readiness from the queued old event');
    page.video.seeking = false;
    page.tick();
    assertEqual(readies().length, 0, 'the ignored event cannot latch a prerequisite that revives on a later tick');
    page.control.fire('seeked');
    assertEqual(json(readies().map((event) => event.detail)), json([{ attemptId: 8, observedSharedMs: 5_000 }]), 'the completed replacement seek still qualifies');

    const tick = runEntry(product.code);
    tick.harness.sharedNowMs = 5_000;
    tick.act([{ kind: 'park', attemptId: 9, positionMs: 0, scheduledPositionMs: 0,
      advanceMs: 0, seamEpochMs: 6_000 }], { startAtSharedMs: 6_000 });
    tick.video.seeking = false;
    tick.video.readyState = 2;
    tick.control.fire('seeked');
    tick.video.seeking = true;
    tick.video.readyState = 4;
    tick.tick();
    assertEqual(tick.events.filter((event) => event.kind === 'ready').length, 0, 'the polling path also waits while the element is seeking');
    tick.video.seeking = false;
    tick.tick();
    assertEqual(tick.events.filter((event) => event.kind === 'ready').length, 1, 'polling recovers when the live seek is complete');
  });

  await check('playback-treatment-entry: pitch lost across the load latches the fault, and the page shows it', async () => {
    for (const point of ['load']) {
      const page = runEntry(product.code, { onLoad: (control) => control.setPitch(true) });
      page.open({});
      assertEqual(page.app.pitch().fault?.point, `after-${point}`, `${point}: the check after the ${point} latched`);
      const polls = page.count('controller-poll');
      page.tick();
      assertEqual(page.count('controller-poll'), polls, `${point}: no poll after the fault`);
      const view = page.app.controller();
      assertEqual(view.mode, 'treatment-fault', `${point}: the public controller view is the fault`);
      assert(view.historical && view.historical.mode !== 'treatment-fault', `${point}: with the kernel snapshot kept as historical`);
      assert(CONTROLLER_LINE_TREATMENT_FAULT_RE.test(page.controllerLine()), `${point}: the overlay paints the fault line: ${page.controllerLine()}`);
      assert(page.notices().some((text) => text.includes('reload the page to retry')), `${point}: the notice says to reload`);
      assertEqual(page.control.rateWrites().at(-1), 1, `${point}: unity was written`);
      assertEqual(page.count('pitch-write'), 1, `${point}: pitch was not rewritten`);
      page.control.setPitch(false);
      page.tick();
      assertEqual(page.count('controller-poll'), polls, `${point}: a later false read does not resume`);
    }
  });

  await check('playback-treatment-entry: a throwing load still runs the interlock, and without a loss it faults nothing', async () => {
    for (const lose of [true, false]) {
      const page = runEntry(product.code, {
        onLoad: (control) => {
          if (lose) control.setPitch(true);
          throw new Error('load failed');
        },
      });
      page.open({});
      assert(page.notices().some((text) => text.includes('playback-start failed: load failed')), `${lose}: the entry reported the failed open`);
      const polls = page.count('controller-poll');
      page.tick();
      if (lose) {
        assertEqual(page.app.pitch().fault?.point, 'after-load', 'the loss was caught after the throwing load');
        assertEqual(page.count('controller-poll'), polls, 'and the controller stays suspended');
        assertEqual(page.control.rateWrites().at(-1), 1, 'at unity');
      } else {
        assertEqual(page.app.pitch().fault, null, 'the control: a throwing load alone is not a treatment fault');
        assertEqual(page.count('controller-poll'), polls + 1, 'and the controller keeps polling');
      }
    }
  });

  await check('playback-treatment-entry: an unsupported element runs the page at exactly f = 0 with a notice and no expando', async () => {
    const page = runEntry(product.code, { videoOptions: { supported: false } });
    const constructed = page.events.find((event) => event.kind === 'controller-created');
    assert(Object.is(constructed.detail.f, 0), `f must be exactly 0, got ${constructed.detail.f}`);
    assertEqual(page.app.pitch().treatment, 'fallback-f0', 'the fallback is published');
    assert(page.notices().some((text) => text.includes('pitch-property-unsupported')), 'with its reason in a notice');
    assert(!Object.hasOwn(page.video, 'preservesPitch'), 'and no pitch property was created');
    const polls = page.count('controller-poll');
    page.tick();
    assertEqual(page.count('controller-poll'), polls + 1, 'the f = 0 controller polls');
  });

  await check('playback-treatment-entry: the verifier opt-in turns on the event history through the URL', async () => {
    const page = runEntry(product.code, { search: '?room=r&tab=t&treatmentEvidence=1' });
    page.open({});
    const drained = page.app.treatmentEvidence();
    assertEqual(drained.events[0].kind, 'startup', 'the first event is the startup record');
    assertEqual(drained.events[0].startup.outcome, 'treatment-established', 'carrying the outcome');
    assert(drained.events.some((event) => event.kind === 'open' && event.point === 'load'), 'the load is recorded');
    assert(drained.events.some((event) => event.kind === 'poll'), 'and the polls');
    assertEqual(drained.lost, 0, 'with nothing lost');
  });

  await check('playback-treatment-entry: without startTiming the instrument is off, nothing extra is armed, and the records are the constructed ones', async () => {
    const off = runScriptedFrames(product, { startTiming: false });
    assertEqual(off.page.app.startTiming().enabled, false, 'the seam reports the instrument off');
    assertEqual(json(off.page.app.startTiming()), json({ enabled: false, events: [], missed: 0, dropped: 0, latestSeq: 0, capacity: 0 }), 'and reads the disabled shape');
    assertEqual(off.armedBeforePlay, 0, 'no frame observer is armed before the start');
    assertEqual(off.armedAfterPlay, 1, 'exactly one rVFC consumer, the product sampler');
    assertEqual(json(off.records), json(EXPECTED_RECORDS), 'the scripted frames produce the constructed records');
  });

  await check('playback-treatment-entry: the instrument moves no drift record — on and off are byte-identical', async () => {
    const off = runScriptedFrames(product, { startTiming: false });
    const on = runScriptedFrames(product, { startTiming: true });
    assertEqual(on.page.app.startTiming().enabled, true, 'the instrument is on');
    assertEqual(on.armedBeforePlay, 1, 'the observer is armed before the start');
    assertEqual(on.armedAfterPlay, 2, 'and the sampler joins it, two consumers on the same frames');
    assertEqual(json(on.records), json(off.records), 'the same frames produce byte-identical drift records');
    assertEqual(json(on.records), json(EXPECTED_RECORDS), 'and they are still the constructed ones');
    const frames = on.page.app.startTiming().events.filter((event) => event.kind === 'frame');
    assertEqual(frames.length, FIXTURE.frames.length, 'the observer saw every frame');
    assertEqual(json(frames.map((frame) => frame.presentedFrames)), json(FIXTURE.frames.map((frame) => frame.presentedFrames)), 'and retains the join key the records carry');
  });

  await check('playback-treatment-entry: a scripted load, readiness, play and resolution record one event each, in order', async () => {
    const page = runEntry(product.code, { search: '?room=r&tab=t&startTiming=1' });
    page.harness.sharedNowMs = 6_000;
    // From a cursor: the page's own load tick and the poll the resolution drives
    // are real events, and this sequence is the window between them.
    const cursor = page.app.startTiming().latestSeq;
    page.act([
      { kind: 'load', attemptId: 1, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 7_000 },
      { kind: 'play', attemptId: 1, startAtSharedMs: 7_000, latenessMs: 3, positionMs: 0, scheduledPositionMs: 0, advanceMs: 0, seamEpochMs: 7_000 },
    ], { startAtSharedMs: 7_000 });
    page.video.readyState = 4;
    page.control.fire('canplay');
    page.control.settlePlay(0);
    await new Promise((resolve) => setImmediate(resolve));
    const events = page.app.startTiming().events;
    const window = events.filter((event) => event.seq > cursor && event.kind !== 'rate-write');
    const of = (kind) => window.filter((event) => event.kind === kind);
    assertEqual(json(window.map((event) => event.kind).slice(0, 5)), json(['poll', 'action', 'action', 'element-event', 'play-settled']), 'one poll, two actions, one element event, then the settlement');
    assertEqual(json(['action', 'element-event', 'play-settled'].map((kind) => of(kind).length)), json([2, 1, 1]), 'and one of each, with nothing repeated');
    assertEqual(json(window.map((event) => event.seq).sort((a, b) => a - b)), json(window.map((event) => event.seq)), 'seq runs forward');
    assert(window.at(-1).kind === 'poll' && window.at(-1).seq > of('play-settled')[0].seq, 'the poll the resolution drives comes after the settlement it is reacting to');
    assertEqual(json(of('poll')[0].actions), json(['load', 'play']), 'the poll names the actions it returned');
    const [load, play] = of('action');
    assertEqual(json([load.action, load.startAtSharedMs, load.advanceMs, load.scheduledPositionMs, load.elementPausedBefore]), json(['load', 7_000, 0, 0, true]), 'the load carries an uncompensated park');
    assertEqual(json([play.action, play.startAtSharedMs, play.latenessMs, play.seamEpochMs, play.threw]), json(['play', 7_000, 3, 7_000, null]), 'and the play its scheduled start and seam');
    // The header comes from `telemetryContext`, which the entry guards so the
    // shipped build does not read the clock, the identity and the start state
    // four times a second with nothing recorded. A guard that stopped answering
    // WITH the instrument on would null every header field and leave every
    // assertion above green, so this is the one that fails on it.
    assertEqual(json([play.atSharedMs, play.absentFields.includes('atSharedMs')]), json([6_000, false]), 'the event carries the live shared instant, not an absent header');
    assert(play.dispatchedAtLocalMs <= play.returnedAtLocalMs, `the play call is bracketed: ${play.dispatchedAtLocalMs} then ${play.returnedAtLocalMs}`);
    assert(play.dispatchedAtLocalMs < play.returnedAtLocalMs, 'and the two instants are distinct, so the bracket is around the call and not around nothing');
    const settled = of('play-settled')[0];
    assertEqual(json([settled.outcome, settled.errorName]), json(['resolved', null]), 'the settlement is reported with no error');
    assert(settled.settledAtLocalMs >= play.returnedAtLocalMs, `the settlement follows the return: ${settled.settledAtLocalMs} against ${play.returnedAtLocalMs}`);
    const ready = of('element-event')[0];
    assertEqual(json([ready.type, ready.readyState, ready.offeredReadiness, ready.observedSharedMs]), json(['canplay', 4, true, 6_000]), 'the element event says what readiness it offered');
  });

  await check('playback-treatment-entry: composed research arms keep their own treatment behind the stand-in', async () => {
    const f = commandThresholdFor();
    await withTempDir(async (root) => {
      for (const arm of [
        { arm: 'B', treatment: 'pitch-disabled', writes: [], f: 0 },
        { arm: 'C', treatment: 'pitch-disabled', writes: [false], f },
        { arm: 'C', treatment: 'refusal-split', writes: [], f },
      ]) {
        const label = `${arm.arm}/${arm.treatment}`;
        const built = await buildResearchBundle({
          arm: arm.arm,
          root: path.join(root, `${arm.arm}-${arm.treatment}`),
          buildId: 'entry-harness',
          collectorId: 'entry-harness',
          threshold: f,
          treatment: arm.treatment,
          esbuildImpl: researchEsbuild(),
        });
        assertEqual(json(built.resolver.redirected.map((hit) => hit.role).sort()), json(['controller', 'log', 'sampler', 'treatment']), `${label}: the four named substitutions fired`);
        const inputs = Object.keys(built.metafile.inputs).map((input) => path.basename(input));
        assert(inputs.includes('research-treatment.mjs') && !inputs.includes('playback-treatment.mjs'), `${label}: the stand-in replaced the product adapter`);
        const page = runEntry(await fs.readFile(built.outfile, 'utf8'));
        assertEqual(json(page.control.pitchWrites().map((entry) => entry.value)), json(arm.writes), `${label}: the arm's own pitch writes and no other`);
        const { settings } = page.app.controller();
        assert(Object.is(settings.MIN_COMMAND_DEVIATION, arm.f), `${label}: f is ${arm.f}, got ${settings.MIN_COMMAND_DEVIATION}`);
        assertEqual(page.app.pitch(), null, `${label}: the product treatment seam is absent`);
        if (arm.arm === 'B') assertEqual(page.video.preservesPitch, true, 'B runs with the native default, true');
        // No interlock: with pitch preserved the research controller still polls.
        page.open({});
        const before = page.app.controller().polls;
        page.tick();
        assert(page.app.controller().polls > before, `${label}: the controller keeps polling`);
        assert(page.app.controller().mode !== 'treatment-fault', `${label}: and nothing latched`);
      }
    });
  });

  await check('playback-treatment-entry: the product bundle takes the real adapter and no research or test module', async () => {
    const result = await esbuild.build({ ...buildOptions('entry-harness-audit'), sourcemap: false, write: false, metafile: true });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.split(path.sep).join('/'));
    assert(inputs.includes('public/lib/playback-treatment.mjs'), 'the product adapter is an input');
    const foreign = inputs.filter((input) => input.startsWith('scripts/') || input.includes('/scripts/'));
    assertEqual(foreign.length, 0, `nothing from scripts/ reaches the product bundle: ${foreign.join(', ')}`);
  });

  await check('playback-treatment-entry: product source has one pitch assignment, in the adapter, and the player has none', async () => {
    const sites = [];
    for (const file of await sourceFiles(path.join(APP_DIR, 'public'))) {
      const count = ((await fs.readFile(file, 'utf8')).match(/\.preservesPitch\s*=(?!=)/g) ?? []).length;
      if (count > 0) sites.push({ file: path.relative(APP_DIR, file).split(path.sep).join('/'), count });
    }
    assertEqual(json(sites), json([{ file: 'public/lib/playback-treatment.mjs', count: 1 }]), 'exactly one assignment site');
    const player = await fs.readFile(path.join(APP_DIR, 'public', 'lib', 'player.mjs'), 'utf8');
    assert(!player.includes('preservesPitch'), 'the player does not touch the flag');
  });
}
