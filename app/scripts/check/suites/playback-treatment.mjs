// scripts/check/suites/playback-treatment.mjs
//
// The pitch treatment adapter on its own (remedy-product-integration-spec.md
// 3.2 and 4.2 item 4). The page wiring is in playback-treatment-entry.mjs.
//
// Every failure case has a passing control built from the same fixture, and a
// fallback f is asserted to BE zero with Object.is, not to be near it.

import { check, assert, assertEqual } from '../harness.mjs';
import { fakeVideo } from '../entry-harness.mjs';
import { rig } from '../controller-rig.mjs';
import { createDriftController, D8_COMMAND_THRESHOLD } from '../../../public/lib/drift-controller.mjs';
import {
  D8_TREATMENT,
  FALLBACK_TREATMENT,
  TREATMENT_FAULT_MODE,
  TreatmentFaultError,
  UNITY_RESTORE_FAILED,
  createEvidenceQueue,
  initializePlaybackTreatment,
} from '../../../public/lib/playback-treatment.mjs';

function setup(videoOptions = {}, { opened = false, evidence = false } = {}) {
  const { video, control } = fakeVideo(videoOptions);
  const notices = [];
  let nowMs = 1000;
  const treatment = initializePlaybackTreatment({
    video,
    opened,
    now: () => nowMs++,
    notify: (text, options) => notices.push({ text, ...options }),
    evidence,
  });
  return { video, control, notices, treatment };
}

const json = (value) => JSON.stringify(value);

const FALLBACKS = [
  { name: 'an extensible object with no pitch property', video: { supported: false }, reason: 'pitch-property-unsupported', writes: 0 },
  { name: 'setup after playback opened', video: {}, opened: true, reason: 'pitch-setup-late', writes: 0 },
  { name: 'an element that is already playing', video: { paused: false }, reason: 'pitch-setup-late', writes: 0 },
  { name: 'a presence check that throws', video: { throwOn: ['has'] }, reason: 'pitch-access-exception', writes: 0 },
  { name: 'a write that throws', video: { throwOn: ['write'] }, reason: 'pitch-write-exception', writes: 1 },
  { name: 'a write the element ignores', video: { rejectWrite: true }, reason: 'pitch-readback-not-false', writes: 1 },
  { name: 'a readback that is missing', video: { initial: undefined, rejectWrite: true }, reason: 'pitch-readback-not-false', writes: 1 },
  { name: 'a readback that throws', video: { throwOn: ['read-after-write'] }, reason: 'pitch-readback-exception', writes: 1 },
];

export default async function playbackTreatmentSuite() {
  await check('playback-treatment: a supported pre-playback write that reads back false selects exactly the adopted f', async () => {
    const { control, notices, treatment } = setup();
    assert(Object.is(treatment.settings.MIN_COMMAND_DEVIATION, D8_COMMAND_THRESHOLD), `f is ${treatment.settings.MIN_COMMAND_DEVIATION}`);
    assertEqual(treatment.treatment, D8_TREATMENT, 'the adopted treatment is named');
    assert(Object.isFrozen(treatment.settings) && Object.isFrozen(treatment.startup), 'the settings and the startup record cannot be edited afterwards');
    assertEqual(json(control.pitchWrites().map((entry) => entry.value)), json([false]), 'exactly one write, of false');
    const { startup } = treatment;
    assert(startup.id.startsWith('pitch-setup-1000-'), `the startup id carries its local time, got ${startup.id}`);
    assertEqual(json({ ...startup, id: null }), json({
      id: null, atMs: 1000, requested: false, supported: true, beforePlayback: true, attemptedWrites: 1,
      readback: { presence: 'value', value: false }, outcome: 'treatment-established', reason: null, error: null,
    }), 'the startup record names every step it took');
    assertEqual(notices.length, 0, 'an established treatment raises no notice');
    const first = treatment.pitch();
    assertEqual(first.startup, startup, 'the seam hands back the one startup record, not a copy');
    assertEqual(json(first.current), json({ presence: 'value', value: false }), 'with a fresh current reading');
    assertEqual(first.controllerActive, true, 'and an active controller');
    assertEqual(first.fault, null, 'and no fault');
    treatment.pitch();
    assertEqual(control.pitchWrites().length, 1, 'reading the seam writes nothing');
  });

  for (const fallback of FALLBACKS) {
    await check(`playback-treatment: ${fallback.name} selects f = 0 with a named reason`, async () => {
      const { video, control, notices, treatment } = setup(fallback.video, { opened: fallback.opened ?? false });
      assert(Object.is(treatment.settings.MIN_COMMAND_DEVIATION, 0), `f must be exactly 0, got ${treatment.settings.MIN_COMMAND_DEVIATION}`);
      assertEqual(treatment.treatment, FALLBACK_TREATMENT, 'the fallback is named');
      assertEqual(treatment.startup.reason, fallback.reason, 'with the exact reason');
      assertEqual(treatment.startup.outcome, 'fallback', 'and a fallback outcome');
      assertEqual(control.pitchWrites().length, fallback.writes, `${fallback.writes} write(s) attempted, never retried`);
      assertEqual(notices.length, 1, 'one notice');
      assert(notices[0].warn === true && notices[0].text.includes(fallback.reason), `the notice warns and names the reason: ${notices[0].text}`);
      if (fallback.video.supported === false) {
        assert(!Object.hasOwn(video, 'preservesPitch') && !('preservesPitch' in video), 'no expando was created on the unsupported element');
      }
      // f = 0 carries no interlock: polls run whatever the flag does later.
      let polls = 0;
      treatment.pollController(() => { polls += 1; });
      if (fallback.video.supported !== false && !fallback.video.throwOn?.includes('has')) control.setPitch(true);
      treatment.pollController(() => { polls += 1; });
      assertEqual(polls, 2, 'the f = 0 controller keeps polling');
      assertEqual(treatment.pitch().fault, null, 'and nothing latches');
      // THE PAIRED CONTROL: the same fixture defaults, with the failure removed, establish.
      assertEqual(setup().treatment.treatment, D8_TREATMENT, 'the control element establishes the treatment');
    });
  }

  await check('playback-treatment: loss after setup suspends polling, restores unity, and does not resume on a later false read', async () => {
    for (const [lose, reason] of [[(control) => control.setPitch(true), 'pitch-lost'], [(control) => control.setPitch(undefined), 'pitch-missing'], [(control) => control.setReadThrows(true), 'pitch-unreadable']]) {
      const { control, notices, treatment } = setup();
      let polls = 0;
      const poll = () => { polls += 1; return { polls }; };
      assertEqual(json(treatment.pollController(poll)), json({ polls: 1 }), `${reason}: the control poll runs while the flag holds`);
      treatment.applyRate(1.004);
      lose(control);
      assertEqual(treatment.pollController(poll), null, `${reason}: the next poll is suspended`);
      assertEqual(polls, 1, `${reason}: and the controller was not called`);
      const { fault, controllerActive } = treatment.pitch();
      assertEqual(fault.reason, reason, `${reason}: the fault names what was read`);
      assertEqual(fault.point, 'poll', `${reason}: and where`);
      assertEqual(controllerActive, false, `${reason}: the controller is reported inactive`);
      assertEqual(fault.unity.ok, true, `${reason}: unity was restored`);
      assertEqual(control.rateWrites().at(-1), 1, `${reason}: by an exact native write of 1`);
      assertEqual(control.pitchWrites().length, 1, `${reason}: and pitch was never rewritten`);
      assert(notices.some((notice) => notice.warn && notice.text.includes('reload the page to retry')), `${reason}: the notice says to reload`);
      control.setReadThrows(false);
      control.setPitch(false);
      assertEqual(treatment.pollController(poll), null, `${reason}: a later false read does not resume`);
      assertEqual(treatment.guard('poll'), false, `${reason}: and the guard stays shut`);
      assertEqual(polls, 1, `${reason}: no poll ran after the fault`);
      let blocked = null;
      try { treatment.applyRate(1.004); } catch (error) { blocked = error; }
      assert(blocked instanceof TreatmentFaultError, `${reason}: a non-unity write after the fault is refused by name`);
      assertEqual(control.rateWrites().filter((rate) => rate !== 1).length, 1, `${reason}: and only the pre-fault correction ever reached the element`);
    }
    const reloaded = setup();
    let polls = 0;
    reloaded.treatment.pollController(() => { polls += 1; });
    assertEqual(polls, 1, 'a new initialization, which is what a reload does, polls again');
  });

  await check('playback-treatment: loss between a passing poll guard and the native write blocks the write before the kernel records it', async () => {
    for (const lose of [false, true]) {
      const { control, treatment } = setup();
      const sim = rig({ factory: createDriftController, settings: treatment.settings, options: { apply: (rate) => treatment.applyRate(rate) } });
      let error = null;
      try {
        treatment.pollController(() => {
          if (lose) control.setPitch(true);
          return sim.poll(-40);
        });
      } catch (thrown) {
        error = thrown;
      }
      const state = sim.controller.state();
      if (!lose) {
        assertEqual(error, null, 'the control poll corrects without error');
        assert(control.rateWrites().some((rate) => rate !== 1), 'and its non-unity command reaches the element');
        assert(state.rate !== 1, 'and the kernel records it');
        continue;
      }
      assert(error instanceof TreatmentFaultError, `the apply refused by name, got ${error}`);
      assertEqual(control.rateWrites().filter((rate) => rate !== 1).length, 0, 'no non-unity write reached the element');
      assertEqual(state.rate, 1, 'the kernel never recorded the refused rate as applied');
      assertEqual(state.correctionsApplied, 0, 'nor counted it');
      assertEqual(treatment.pitch().fault.point, 'write', 'the fault was caught at the write');
      assertEqual(treatment.view(state).mode, TREATMENT_FAULT_MODE, 'and the published view is the fault');
    }
  });

  await check('playback-treatment: a failed unity restore is explicit, and later ticks retry unity only', async () => {
    const { control, treatment } = setup();
    treatment.applyRate(1.005);
    control.setRateWritesFail(true);
    control.setPitch(true);
    let polls = 0;
    assertEqual(treatment.pollController(() => { polls += 1; }), null, 'the loss suspends the poll');
    const failed = treatment.view({ settings: treatment.settings, polls: 3 });
    assertEqual(failed.unity, UNITY_RESTORE_FAILED, 'the view says the restore failed');
    assertEqual(failed.rate, 1.005, 'and reports the rate the element actually has, not unity');
    assertEqual(treatment.pitch().fault.unity.ok, false, 'the fault record agrees');
    const attempts = control.rateWrites().length;
    treatment.pollController(() => { polls += 1; });
    assertEqual(control.rateWrites().length, attempts + 1, 'the next tick retries');
    assertEqual(control.rateWrites().at(-1), 1, 'and the retry is unity');
    control.setRateWritesFail(false);
    treatment.pollController(() => { polls += 1; });
    assertEqual(treatment.view({ settings: treatment.settings, polls: 3 }).unity, 'restored', 'once the element takes the write, the restore is reported');
    assertEqual(treatment.view({ settings: treatment.settings, polls: 3 }).rate, 1, 'with the rate read back');
    const settled = control.rateWrites().length;
    treatment.pollController(() => { polls += 1; });
    assertEqual(control.rateWrites().length, settled, 'a restored unity is not rewritten');
    assertEqual(polls, 0, 'and no tick ever restarted the controller');
  });

  await check('playback-treatment: an open that throws still runs the interlock after it', async () => {
    const { control, treatment } = setup();
    assertEqual(treatment.open(() => 'opened', 'load'), 'opened', 'the control open returns its value');
    assertEqual(treatment.faulted, false, 'and leaves the treatment active');
    let error = null;
    try {
      treatment.open(() => {
        control.setPitch(true);
        throw new Error('reopen failed');
      }, 'reopen');
    } catch (thrown) {
      error = thrown;
    }
    assertEqual(error?.message, 'reopen failed', "the open's own failure still reaches its caller");
    assertEqual(treatment.pitch().fault.point, 'after-reopen', 'the check after the open ran anyway');
    assertEqual(control.rateWrites().at(-1), 1, 'and restored unity');

    const before = setup();
    before.control.setPitch(true);
    before.treatment.open(() => {}, 'load');
    assertEqual(before.treatment.pitch().fault.point, 'before-load', 'a loss before the open is caught before it');
  });

  await check('playback-treatment: the faulted view replaces the kernel snapshot without editing it', async () => {
    const { control, treatment } = setup();
    const snapshot = { mode: 'settled', settlingMs: 40000, rate: 1, thresholdUsable: true, stoppingThresholdMs: 8.5, fastestCloseMs: 0, settings: treatment.settings, polls: 12, windowRecords: 8 };
    const original = json(snapshot);
    assertEqual(treatment.view(snapshot), snapshot, 'while active, consumers see the kernel snapshot itself');
    control.setPitch(true);
    treatment.guard('poll');
    const view = treatment.view(snapshot);
    assertEqual(view.mode, TREATMENT_FAULT_MODE, 'once faulted the mode is the fault, not settled');
    assertEqual(view.historical, snapshot, 'the kernel snapshot rides along as historical');
    assertEqual(json(snapshot), original, 'and is not edited');
    assertEqual(json([view.thresholdUsable, view.stoppingThresholdMs, view.fastestCloseMs, view.controllerActive]), json([false, null, null, false]), 'no threshold, close figure or active controller is claimed');
    assertEqual(view.unity, 'restored', 'the restore outcome is published');
    assertEqual(view.reason, 'pitch-lost', 'with the reason');
  });

  await check('playback-treatment: the opt-in evidence queue is off by default, contiguous when on, and counts what it drops', async () => {
    assertEqual(setup().treatment.drainEvidence(), null, 'normal playback keeps no event history');
    const { control, treatment } = setup({}, { evidence: true });
    treatment.pollController(() => ({ polls: 1 }));
    treatment.applyRate(1.002);
    control.setPitch(true);
    treatment.pollController(() => ({}));
    const drained = treatment.drainEvidence();
    assertEqual(json(drained.events.map((event) => event.kind)), json(['startup', 'poll', 'write', 'fault', 'unity-restore']), 'every step is an event, in order');
    assertEqual(json(drained.events.map((event) => event.id)), json([1, 2, 3, 4, 5]), 'with contiguous ids');
    assertEqual(json([drained.lost, drained.pending]), json([0, 0]), 'and nothing lost or left behind');
    const write = drained.events[2];
    assertEqual(json([write.requested, write.allowed, write.readback]), json([1.002, true, { presence: 'value', value: 1.002 }]), 'a write records what was asked and what the element then read');
    assertEqual(treatment.drainEvidence().events.length, 0, 'a drain empties the queue');

    const queue = createEvidenceQueue({ now: () => 0, capacity: 2 });
    for (let index = 0; index < 3; index += 1) queue.record('poll', {});
    const overflow = queue.drain();
    assertEqual(json([overflow.events.map((event) => event.id), overflow.produced, overflow.lost]), json([[1, 2], 3, 1]), 'an overflow is counted, never renumbered away');
  });

  await check('playback-treatment: a poll event carries the instant the kernel read, and never a stale one', async () => {
    const { treatment } = setup({}, { evidence: true });
    let read = null;
    treatment.pollController(() => { read = treatment.controllerNow(); return { polls: 1 }; });
    treatment.pollController(() => ({ polls: 2 }));
    const polls = treatment.drainEvidence().events.filter((event) => event.kind === 'poll');
    assert(Number.isFinite(read), 'the pass-through clock returned the adapter clock');
    assertEqual(polls[0].controllerNowMs, read, 'the value the controller used is the one recorded');
    assertEqual(polls[1].controllerNowMs, null, 'a poll that read no clock records none rather than the previous one');
  });
}
