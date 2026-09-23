// scripts/check/suites/playback-start.mjs
//
// The scheduled-start reducer is exercised with a fake element. The fake
// records every position write with its paused flag; no browser or timer is
// involved.

import { check, assert, assertEqual } from '../harness.mjs';
import {
  createPlaybackStart,
  MISSING_CLOCK,
  MISSING_HOST_LINK,
  MISSING_STATE,
  WAITING_PAUSED,
  WAITING_PREPARING,
  WAITING_REFUSED,
} from '../../../public/lib/playback-start.mjs';
import { PRESENTATION_ADVANCE_MS } from '../../../public/lib/playback-leads.mjs';

const json = (value) => JSON.stringify(value);

const playing = (atSharedMs = 1000, mediaMs = 500, lineage = 'room', version = 1, previous = null) => ({
  lineage,
  version,
  current: { playing: true, atSharedMs, mediaMs },
  previous,
  controlMode: 'open',
});
const paused = (atSharedMs = 1000, mediaMs = 500, lineage = 'room', version = 1) => ({
  lineage,
  version,
  current: { playing: false, atSharedMs, mediaMs },
  previous: null,
  controlMode: 'open',
});

function fakeElement() {
  const element = { paused: true, writes: [], plays: [], pauses: [] };
  function apply(actions) {
    for (const action of actions) {
      if (action.kind === 'pause') {
        element.paused = true;
        element.pauses.push(action);
      } else if (action.kind === 'load' || action.kind === 'park') {
        element.writes.push({ kind: action.kind, attemptId: action.attemptId, positionMs: action.positionMs, paused: element.paused });
      } else if (action.kind === 'play') {
        element.paused = false;
        element.plays.push(action);
      }
    }
  }
  return { element, apply };
}

// `presentationAdvanceMs` is left undefined by default, so every check below
// exercises the option OMITTED — the shape all of them were written against.
function rig({ state = playing(), resolved = true, nowSharedMs = 1000, prepareLeadMs = 400, presentationAdvanceMs, linkOpen = true } = {}) {
  const fake = fakeElement();
  const start = createPlaybackStart({ prepareLeadMs, presentationAdvanceMs });
  const context = { state, resolved, nowSharedMs, linkOpen };
  function poll(overrides = {}) {
    Object.assign(context, overrides);
    const result = start.poll(context);
    fake.apply(result.actions);
    return result;
  }
  return { ...fake, start, context, poll };
}

function beginReady(r, observedSharedMs = r.context.nowSharedMs) {
  const first = r.poll();
  r.start.ready(first.attemptId, observedSharedMs);
  return first;
}

export default async function playbackStartSuite() {
  await check('playback-start: missing clock/state are named and produce no actions', async () => {
    const noClock = rig({ resolved: false });
    let status = noClock.poll({ nowSharedMs: null });
    assertEqual(status.actions.length, 0, 'no clock has no actions');
    assertEqual(status.missing, MISSING_CLOCK, 'clock is the first missing input');

    const noState = rig({ resolved: true, state: null });
    status = noState.poll();
    assertEqual(status.actions.length, 0, 'resolved without state has no actions');
    assertEqual(status.missing, MISSING_STATE, 'state is named when clock is present');
    assertEqual(status.resolved, false, 'state without a snapshot is not resolved');
  });

  await check('playback-start: a viewer holds the first load until the host link opens', async () => {
    const r = rig({ linkOpen: false });
    for (let now = 1000; now <= 10_000; now += 1000) {
      const held = r.poll({ nowSharedMs: now, linkOpen: false });
      assertEqual(held.missing, MISSING_HOST_LINK, `poll at ${now} names the closed host link`);
      assertEqual(held.waiting, null, `poll at ${now} has no generic waiting reason`);
      assertEqual(held.actions.length, 0, `poll at ${now} does not load early`);
      assertEqual(held.nextAtSharedMs, null, `poll at ${now} schedules no retry while closed`);
    }
    const opened = r.poll({ nowSharedMs: 10_000, linkOpen: true });
    assertEqual(opened.actions.map((action) => action.kind).join(','), 'load', 'the first open poll loads exactly once');
    assertEqual(opened.missing, null, 'an open link clears the held reason');
  });

  await check('playback-start: missing host link never outranks missing clock or state', async () => {
    const noClock = rig({ resolved: false, linkOpen: false });
    assertEqual(noClock.poll({ nowSharedMs: null, linkOpen: false }).missing, MISSING_CLOCK, 'clock remains first');
    const noState = rig({ state: null, linkOpen: false });
    assertEqual(noState.poll({ linkOpen: false }).missing, MISSING_STATE, 'state remains before link');
  });

  await check('playback-start: an open loaded element survives a link drop, but a stopped one names it', async () => {
    const playingRig = rig();
    const first = beginReady(playingRig);
    const due = playingRig.poll({ nowSharedMs: 1400 });
    playingRig.start.playResolved(due.actions[0].attemptId);
    const playing = playingRig.poll({ nowSharedMs: 1500, linkOpen: false });
    assertEqual(playing.playing, true, 'a loaded playing element remains playing');
    assertEqual(playing.missing, null, 'a loaded playing element has no missing reason');

    const stopped = rig();
    const prepared = stopped.poll();
    assertEqual(prepared.actions[0].kind, 'load', 'the stopped fixture first loads');
    const held = stopped.poll({ nowSharedMs: 1200, linkOpen: false });
    assertEqual(held.playing, false, 'the stopped fixture is not presenting');
    assertEqual(held.missing, MISSING_HOST_LINK, 'a stopped loaded element names the closed link');
    assertEqual(held.waiting, null, 'the closed link is not generic preparing');
  });

  // Mutation: remove the !loaded && !linkOpen hold above; the first closed-link
  // poll emits load and this check goes red. Restore it before the green run.

  await check('playback-start: a playing target loads or parks once, then plays at S', async () => {
    const r = rig();
    const first = r.poll();
    assertEqual(first.actions.map((a) => a.kind).join(','), 'load', 'first preparation loads while paused');
    assertEqual(first.actions[0].positionMs, 900, 'the load position comes from mediaMsAt(S)');
    assertEqual(first.nextAtSharedMs, 1400, 'S is the later of now plus lead and the effective instant');
    r.start.ready(first.attemptId, 1200);
    const due = r.poll({ nowSharedMs: 1400 });
    assertEqual(due.actions.map((a) => a.kind).join(','), 'play', 'readiness before S permits play');
    assertEqual(due.actions[0].latenessMs, 0, 'timer delivery at S is on time');
    assertEqual(r.start.state().begun, 0, 'a dispatched play has not begun playback');
    r.start.playResolved(first.attemptId);
    assertEqual(r.start.state().playing, true, 'playing is published only after the promise resolves');
    assertEqual(r.start.state().begun, 1, 'a resolved play counts as begun playback');
    assertEqual(r.element.plays.length, 1, 'one play is dispatched');
  });

  await check('playback-start: timer and late tick each play exactly once and retain lateness', async () => {
    const timer = rig();
    const first = beginReady(timer, 1100);
    const atS = timer.poll({ nowSharedMs: 1400 });
    assertEqual(atS.actions.length, 1, 'timer fires one action');
    assertEqual(atS.actions[0].latenessMs, 0, 'timer lateness is zero');

    const tick = rig();
    const lateFirst = beginReady(tick, 1100);
    const late = tick.poll({ nowSharedMs: 2700 });
    assertEqual(late.actions.length, 1, 'a late tick still dispatches play');
    assertEqual(late.actions[0].latenessMs, 1300, 'lateness is measured against the original S');
    assertEqual(tick.element.plays.length, 1, 'late delivery does not retarget');
    assertEqual(tick.start.state().lastLatenessMs, 1300, 'status publishes the same lateness');
    assertEqual(lateFirst.attemptId, late.actions[0].attemptId, 'the late tick serves the same attempt');
  });

  await check('playback-start: delayed readiness keeps one parked attempt across late polls', async () => {
    const advance = 37;
    const r = rig({ prepareLeadMs: 0, presentationAdvanceMs: advance });
    const first = r.poll();
    const original = first.actions[0];
    assertEqual(first.nextAtSharedMs, 1000, 'zero preparation lead schedules the deadline at S');
    assertEqual(original.positionMs, 537, 'the one preparation position includes presentation advance');

    for (let now = 1000; now <= 1200; now += 25) {
      const waiting = r.poll({ nowSharedMs: now });
      assertEqual(waiting.actions.length, 0, `poll at ${now} does not rewrite the parked position`);
      assertEqual(waiting.nextAtSharedMs, null, `poll at ${now} schedules no expired deadline`);
      assertEqual(waiting.attemptId, first.attemptId, `poll at ${now} keeps the same attempt`);
    }
    assertEqual(r.element.writes.length, 1, 'delayed readiness has one preparation position');

    r.start.ready(first.attemptId, 1250);
    const late = r.poll({ nowSharedMs: 1300 });
    assertEqual(late.actions.length, 1, 'late readiness eventually dispatches play');
    assertEqual(late.actions[0].kind, 'play', 'the eventual action is play');
    assertEqual(late.actions[0].attemptId, first.attemptId, 'play uses the original attempt');
    assertEqual(late.actions[0].startAtSharedMs, 1000, 'play uses the original S');
    assertEqual(late.actions[0].latenessMs, 300, 'play records actual lateness from the original S');
    assertEqual(late.actions[0].positionMs, original.positionMs, 'play retains the original advanced position');
    assertEqual(late.actions[0].scheduledPositionMs, original.scheduledPositionMs, 'play retains the original scheduled position');
    assertEqual(late.actions[0].advanceMs, advance, 'play retains the original presentation advance');
    assertEqual(late.actions[0].seamEpochMs, original.seamEpochMs, 'play retains the original seam mapping');

    r.start.playResolved(first.attemptId);
    r.start.ready(first.attemptId, 1300);
    const after = r.poll({ nowSharedMs: 1350 });
    assertEqual(after.actions.length, 0, 'duplicate late polls do not dispatch play again');
    assertEqual(r.element.plays.length, 1, 'delayed readiness starts exactly once');
  });

  await check('playback-start: not ready at S retains the attempt and accepts late readiness', async () => {
    const r = rig();
    const first = r.poll();
    const deadline = r.poll({ nowSharedMs: 1400 });
    assertEqual(deadline.actions.length, 0, 'not-ready preparation does not rewrite at S');
    assertEqual(deadline.nextAtSharedMs, null, 'an unready deadline schedules no expired retry');
    assertEqual(deadline.attemptId, first.attemptId, 'the original attempt remains live');
    assertEqual(deadline.retargets, 0, 'an unready deadline is not a retarget');
    r.start.ready(first.attemptId, 1500);
    const late = r.poll({ nowSharedMs: 1600 });
    assertEqual(late.actions[0].kind, 'play', 'the original attempt plays when late readiness arrives');
    assertEqual(late.actions[0].attemptId, first.attemptId, 'late readiness plays the retained attempt');
    assertEqual(late.actions[0].latenessMs, 200, 'late play records lateness from the original S');
  });

  await check('playback-start: pause, rejoin and a second seek before S prevent the old start', async () => {
    // The rejoin re-resolves to the SAME mapping after S, so only the
    // invalidation on losing the state keeps the first attempt from playing.
    const cases = [
      ['pause', { state: paused(1200, 500) }, { state: paused(1200, 500) }],
      ['rejoin', { resolved: false }, { resolved: true }],
      ['second seek', { state: playing(1200, 900) }, { state: playing(1200, 900) }],
    ];
    for (const [label, change, after] of cases) {
      const r = rig();
      const first = r.poll();
      r.poll({ nowSharedMs: 1100, ...change });
      r.start.ready(first.attemptId, 1100);
      const later = r.poll({ nowSharedMs: 1600, ...after });
      assertEqual(later.actions.some((action) => action.kind === 'play' && action.attemptId === first.attemptId), false, `${label} invalidates the old attempt`);
    }
  });

  await check('playback-start: stale play results change no status, and readiness belongs to its attempt', async () => {
    const r = rig();
    const first = r.poll();
    r.start.ready(first.attemptId, 1000);
    const dispatched = r.poll({ nowSharedMs: 1400 });
    const replaced = r.poll({ nowSharedMs: 1500, state: playing(1200, 900) });
    assertEqual(replaced.actions.map((a) => a.kind).join(','), 'pause,park', 'a replaced unsettled play is paused before its park');
    assertEqual(r.element.writes.at(-1).paused, true, 'the replacement position write observes a paused element');
    const before = JSON.stringify(r.start.state());
    r.start.playResolved(dispatched.attemptId);
    r.start.playRejected(dispatched.attemptId, { name: 'NotAllowedError' });
    assertEqual(JSON.stringify(r.start.state()), before, 'results from a replaced dispatched attempt are ignored');

    const next = rig();
    const old = next.poll();
    const replacementPark = next.poll({ nowSharedMs: 1100, state: playing(1200, 900) });
    const replacement = replacementPark.attemptId;
    next.start.ready(replacement, 1500);
    next.poll({ nowSharedMs: 1800 });
    const beforeReplacementResult = JSON.stringify(next.start.state());
    next.start.playResolved(old.attemptId);
    next.start.playRejected(old.attemptId, { name: 'NotAllowedError' });
    assertEqual(JSON.stringify(next.start.state()), beforeReplacementResult, 'a stale id cannot alter a current dispatched attempt');

    const readiness = rig();
    const oldPark = readiness.poll();
    const replacementReadinessPark = readiness.poll({ nowSharedMs: 1100, state: playing(1200, 900) });
    readiness.start.ready(oldPark.attemptId, 1000);
    const due = readiness.poll({ nowSharedMs: 1800, state: playing(1200, 900) });
    assertEqual(due.actions.some((action) => action.kind === 'play'), false, 'readiness from an earlier park does not qualify the replacement');
    assertEqual(due.retargets, 0, 'an unready replacement remains parked without retargeting');
    assertEqual(replacementReadinessPark.attemptId !== oldPark.attemptId, true, 'the replacement remains distinct');
    readiness.start.ready(replacementReadinessPark.attemptId, 1800);
    const replacementDue = readiness.poll({ nowSharedMs: 1900, state: playing(1200, 900) });
    assertEqual(replacementDue.actions[0].kind, 'play', 'readiness for the replacement still permits play');
  });

  await check('playback-start: a paused join loads once, and a future pause waits only when the element is playing', async () => {
    const pausedJoin = rig({ state: paused(1000, 700) });
    const status = pausedJoin.poll();
    assertEqual(status.actions.map((a) => a.kind).join(','), 'load', 'paused join loads at its held position');
    assertEqual(status.actions[0].positionMs, 700, 'paused load uses current.mediaMs');
    assertEqual(status.waiting, WAITING_PAUSED, 'paused state is named');
    assertEqual(pausedJoin.element.plays.length, 0, 'paused join never plays');
    assertEqual(status.opens, 1, 'the paused join opened the media');
    assertEqual(status.begun, 0, 'but has not begun playback');

    const future = rig({ state: playing(1000, 500) });
    const first = beginReady(future);
    future.poll({ nowSharedMs: 1400 });
    future.start.playResolved(first.attemptId);
    const laterPause = future.poll({ nowSharedMs: 1500, state: paused(2000, 800) });
    assertEqual(laterPause.actions.length, 0, 'a future pause does not stop a playing element early');
    assertEqual(laterPause.nextAtSharedMs, 2000, 'the pause is scheduled at its effective instant');
    const park = future.poll({ nowSharedMs: 2000, state: paused(2000, 800) });
    assertEqual(park.actions.map((a) => a.kind).join(','), 'pause,park', 'the future pause parks after pausing');
    assertEqual(park.waiting, WAITING_PAUSED, 'the parked state is paused');
    assertEqual(park.begun, 1, 'a paused room still reads as having begun playback');
  });

  await check('playback-start: refusal recovers only by a fresh click attempt', async () => {
    const r = rig();
    const first = beginReady(r);
    const play = r.poll({ nowSharedMs: 1400 });
    r.start.playRejected(play.attemptId, { name: 'NotAllowedError' });
    assertEqual(r.start.state().waiting, WAITING_REFUSED, 'policy refusal is named');
    assertEqual(r.start.state().begun, 0, 'a refused start has not begun playback');
    const refusedId = r.start.state().attemptId;
    r.start.click();
    const retry = r.poll({ nowSharedMs: 2000 });
    assertEqual(retry.attemptId !== refusedId, true, 'click starts a fresh attempt');
    assertEqual(retry.actions[0].positionMs !== first.actions[0].positionMs, true, 'fresh attempt does not replay the old park');

    // Each click below is followed by a poll: a click only requests a retry, so
    // reading status before the next poll cannot see one taken.
    const pausedClick = rig();
    beginReady(pausedClick);
    const pausedRefusal = pausedClick.poll({ nowSharedMs: 1400 });
    pausedClick.start.playRejected(pausedRefusal.attemptId, { name: 'NotAllowedError' });
    pausedClick.poll({ nowSharedMs: 1600, state: paused(1500, 800) });
    const pausedId = pausedClick.start.state().attemptId;
    pausedClick.start.click();
    const afterPausedClick = pausedClick.poll({ nowSharedMs: 1700 });
    assertEqual(afterPausedClick.actions.length, 0, 'click while paused starts nothing');
    assertEqual(afterPausedClick.attemptId, pausedId, 'and keeps the parked attempt');

    const unresolved = rig();
    beginReady(unresolved);
    const unresolvedRefusal = unresolved.poll({ nowSharedMs: 1400 });
    unresolved.start.playRejected(unresolvedRefusal.attemptId, { name: 'NotAllowedError' });
    unresolved.poll({ nowSharedMs: 1500, resolved: false });
    unresolved.start.click();
    const afterUnresolvedClick = unresolved.poll({ nowSharedMs: 1600, resolved: true });
    assertEqual(afterUnresolvedClick.actions.length, 0, 'click while unresolved starts nothing');
    assertEqual(afterUnresolvedClick.waiting, WAITING_REFUSED, 'and the refusal still stands');

    const presenting = rig();
    const presentingFirst = beginReady(presenting);
    presenting.poll({ nowSharedMs: 1400 });
    presenting.start.playResolved(presentingFirst.attemptId);
    presenting.start.click();
    assertEqual(presenting.poll({ nowSharedMs: 1500 }).actions.length, 0, 'click while presenting starts nothing');

    const refusedThenPaused = rig();
    beginReady(refusedThenPaused);
    const refusedPlay = refusedThenPaused.poll({ nowSharedMs: 1400 });
    refusedThenPaused.start.playRejected(refusedPlay.attemptId, { name: 'NotAllowedError' });
    const held = refusedThenPaused.poll({ nowSharedMs: 1600, state: paused(1500, 800) });
    assertEqual(held.actions.map((a) => a.kind).join(','), 'park', 'a refused client still parks a paused state');
    assertEqual(held.waiting, WAITING_PAUSED, 'and names the room paused rather than refused');
  });

  await check('playback-start: becoming unresolved while presenting leaves the element and names nothing missing', async () => {
    const r = rig();
    const first = beginReady(r);
    r.poll({ nowSharedMs: 1400 });
    r.start.playResolved(first.attemptId);
    const status = r.poll({ nowSharedMs: 1500, resolved: false });
    assertEqual(status.actions.length, 0, 'unresolved touches no element');
    assertEqual(status.playing, true, 'the presented start stays presented');
    assertEqual(status.resolved, false, 'unresolved is published');
    assertEqual(status.missing, null, 'a presenting client names no missing input');
  });

  await check('playback-start: non-policy failure is preparing with an error and retargets next poll', async () => {
    const r = rig();
    const first = beginReady(r);
    const play = r.poll({ nowSharedMs: 1400 });
    r.start.playRejected(play.attemptId, { name: 'AbortError' });
    assertEqual(r.start.state().waiting, WAITING_PREPARING, 'AbortError is not reported as refusal');
    assertEqual(r.start.state().lastPlayError, 'AbortError', 'the failure name is retained');
    const retry = r.poll({ nowSharedMs: 1600 });
    assertEqual(retry.retargets, 1, 'the next poll counts a retarget');
    assertEqual(retry.actions.some((a) => a.kind === 'park'), true, 'the next poll parks a fresh target');
    assert(first.actions.length > 0, 'the initial attempt was exercised');
  });

  await check('playback-start: equal mapping ignores lineage and control-mode changes, but a 1ms difference retargets', async () => {
    const playingRig = rig();
    const first = beginReady(playingRig);
    const play = playingRig.poll({ nowSharedMs: 1400 });
    playingRig.start.playResolved(play.attemptId);
    const sameLineage = { ...playing(), lineage: 'new-lineage', version: 8 };
    assertEqual(playingRig.poll({ nowSharedMs: 1500, state: sameLineage }).actions.length, 0, 'equal playing epoch ignores a new lineage');
    assertEqual(playingRig.poll({ nowSharedMs: 1600, state: { ...sameLineage, controlMode: 'host' } }).actions.length, 0, 'control-mode-only change does not move playback');
    const different = { ...sameLineage, current: { ...sameLineage.current, mediaMs: 501 } };
    assertEqual(playingRig.poll({ nowSharedMs: 1700, state: different }).actions.some((a) => a.kind === 'park'), true, 'a one millisecond mapping change is observable');

    const pausedRig = rig({ state: paused() });
    pausedRig.poll();
    assertEqual(pausedRig.poll({ state: { ...paused(), lineage: 'other', version: 4 }, nowSharedMs: 1200 }).actions.length, 0, 'equal paused position ignores a new lineage');
    assertEqual(pausedRig.poll({ state: { ...paused(), controlMode: 'host' }, nowSharedMs: 1300 }).actions.length, 0, 'paused control-mode-only change does nothing');
  });

  // --- The presentation advance (executor-spec.md §14 items 1-3, O2 option 1') ---
  //
  // One playing mapping, exact by construction: S = max(1000, 1000 + 400) =
  // 1400, the room position at S is 500 + 400 = 900, and the room epoch is
  // 1000 - 500 = 500. Every expected number below is arithmetic on those.
  const ADVANCE = 37;
  const advanceRig = (presentationAdvanceMs) => {
    const r = rig({ presentationAdvanceMs });
    const prepared = r.poll();
    r.start.ready(prepared.attemptId, 1200);
    const due = r.poll({ nowSharedMs: 1400 });
    return { prepared, due, played: due.actions[0], r };
  };

  await check('playback-start: with no advance the physical park IS the room position, and the seam is S minus it', async () => {
    for (const [label, made] of [['omitted', advanceRig(undefined)], ['explicit zero', advanceRig(0)]]) {
      for (const action of [made.prepared.actions[0], made.played]) {
        assertEqual(action.positionMs, 900, `${label}: ${action.kind} parks at the room position at S`);
        assertEqual(action.scheduledPositionMs, 900, `${label}: and reports the same room position`);
        assertEqual(action.advanceMs, 0, `${label}: with no advance`);
        assertEqual(action.seamEpochMs, 500, `${label}: and the room mapping epoch`);
        assertEqual(action.seamEpochMs, 1400 - action.positionMs, `${label}: which S minus the park still equals here`);
      }
    }
    const held = rig({ state: paused(1000, 700) }).poll().actions[0];
    assertEqual(json([held.positionMs, held.scheduledPositionMs, held.advanceMs, held.seamEpochMs]), json([700, 700, 0, 300]), 'a paused hold parks at the state position and seams at its own mapping');
  });

  await check('playback-start: a nonzero advance moves the physical park and nothing else', async () => {
    const zero = advanceRig(0);
    const advanced = advanceRig(ADVANCE);
    // R6: the two rigs differ in the advance and in nothing else, so every
    // field that is equal below is equal for that reason.
    for (const [kind, before, after] of [['park', zero.prepared.actions[0], advanced.prepared.actions[0]], ['play', zero.played, advanced.played]]) {
      assertEqual(after.positionMs, before.positionMs + ADVANCE, `${kind}: the physical park moves by the advance`);
      assertEqual(after.positionMs, 900 + ADVANCE, `${kind}: to mediaMsAt(S + advance)`);
      assertEqual(after.scheduledPositionMs, before.scheduledPositionMs, `${kind}: the room position at S does not move`);
      assertEqual(after.seamEpochMs, before.seamEpochMs, `${kind}: nor does the room mapping epoch`);
      assertEqual(after.advanceMs, ADVANCE, `${kind}: the action carries the advance it used`);
      assertEqual(after.seamEpochMs !== 1400 - after.positionMs, true, `${kind}: S minus the advanced park is no longer the epoch`);
    }
    assertEqual(advanced.played.startAtSharedMs, zero.played.startAtSharedMs, 'S is unchanged');
    assertEqual(advanced.played.latenessMs, zero.played.latenessMs, 'and so is the lateness');
    assertEqual(advanced.prepared.nextAtSharedMs, zero.prepared.nextAtSharedMs, 'and the instant the module asks to be polled at');
    // §14 item 8: the repair adds no substitute for `begun` and removes no counter.
    advanced.r.start.playResolved(advanced.played.attemptId);
    zero.r.start.playResolved(zero.played.attemptId);
    assertEqual(json([advanced.r.start.state().opens, advanced.r.start.state().begun, advanced.r.start.state().retargets]), json([1, 1, 0]), 'an advanced start opens once, begins once and retargets never');
    assertEqual(json(advanced.r.start.state()), json(zero.r.start.state()), 'and its whole published status is the uncompensated one');
    // A paused target has no advance to apply, so its action is identical.
    const pausedAction = (presentationAdvanceMs) => rig({ state: paused(1000, 700), presentationAdvanceMs }).poll().actions[0];
    assertEqual(json(pausedAction(ADVANCE)), json(pausedAction(0)), 'a paused target parks identically whatever the advance');
  });

  await check('playback-start: the advance is validated, both sides, and is not clamped', async () => {
    for (const bad of [-1, -0.001, Number.NaN, Infinity, -Infinity, '37', null, 250.1, 1000]) {
      let threw = null;
      try {
        createPlaybackStart({ prepareLeadMs: 400, presentationAdvanceMs: bad });
      } catch (error) {
        threw = error;
      }
      assert(threw instanceof TypeError, `${json(bad)} is refused with a TypeError, got ${threw}`);
    }
    for (const good of [0, 37, 250, PRESENTATION_ADVANCE_MS]) {
      assertEqual(typeof createPlaybackStart({ prepareLeadMs: 400, presentationAdvanceMs: good }).poll, 'function', `${good} is accepted`);
    }
    assertEqual(PRESENTATION_ADVANCE_MS, 1000 / 24, 'the compiled advance is one content frame at 24fps (O2 option 1\')');
  });

  await check('playback-start: seeded random transitions never write a position while playing', async () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const r = rig();
    for (let i = 0; i < 240; i += 1) {
      const now = 1000 + i * 1000;
      const isPlaying = random() > 0.35;
      const state = isPlaying ? playing(now, 500 + i * 17, `lineage-${i}`, i + 1) : paused(now, 500 + i * 17, `lineage-${i}`, i + 1);
      const setup = r.poll({ nowSharedMs: now, resolved: true, state });
      if (!isPlaying) continue;
      let attemptId = setup.attemptId;
      if (random() > 0.2) r.start.ready(attemptId, now);
      let due = r.poll({ nowSharedMs: setup.nextAtSharedMs ?? now, resolved: true, state });
      if (due.retargets > setup.retargets) {
        attemptId = due.attemptId;
        r.start.ready(attemptId, due.nextAtSharedMs);
        due = r.poll({ nowSharedMs: due.nextAtSharedMs, resolved: true, state });
      }
      if (due.actions.some((action) => action.kind === 'play')) r.start.playResolved(attemptId);
    }
    assert(r.element.writes.length > 0, 'the random sequence exercised position writes');
    assert(r.element.plays.length > 0, 'the random sequence exercised starts');
    assert(r.element.writes.every((write) => write.paused), 'every load and park observed a paused element');
    const byAttempt = new Map();
    for (const write of r.element.writes) byAttempt.set(write.attemptId, (byAttempt.get(write.attemptId) ?? 0) + 1);
    assert([...byAttempt.values()].every((count) => count <= 1), 'at most one position write belongs to an attempt');
  });
}
