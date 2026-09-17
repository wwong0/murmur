// scripts/check/suites/playback-start.mjs
//
// The scheduled-start reducer is exercised with a fake element. The fake
// records every position write with its paused flag; no browser or timer is
// involved.

import { check, assert, assertEqual } from '../harness.mjs';
import {
  createPlaybackStart,
  MISSING_CLOCK,
  MISSING_STATE,
  WAITING_PAUSED,
  WAITING_PREPARING,
  WAITING_REFUSED,
} from '../../../public/lib/playback-start.mjs';

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

function rig({ state = playing(), resolved = true, nowSharedMs = 1000, prepareLeadMs = 400 } = {}) {
  const fake = fakeElement();
  const start = createPlaybackStart({ prepareLeadMs });
  const context = { state, resolved, nowSharedMs };
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

  await check('playback-start: not ready at S retargets, and stale readiness cannot play the old attempt', async () => {
    const r = rig();
    const first = r.poll();
    const retarget = r.poll({ nowSharedMs: 1400 });
    assertEqual(retarget.actions.map((a) => a.kind).join(','), 'park', 'not-ready preparation retargets with a new park');
    assertEqual(retarget.nextAtSharedMs, 1800, 'the retarget computes S from its own poll');
    assertEqual(retarget.actions[0].positionMs, 1300, 'the retarget parks at mediaMsAt of the new S');
    assertEqual(retarget.attemptId !== first.attemptId, true, 'retarget has a fresh attempt id');
    assertEqual(retarget.retargets, 1, 'retarget is counted');
    r.start.ready(first.attemptId, 1000);
    const stillPreparing = r.poll({ nowSharedMs: 1400 });
    assertEqual(stillPreparing.actions.length, 0, 'stale readiness does not revive the old attempt');
    r.start.ready(retarget.attemptId, 1400);
    const due = r.poll({ nowSharedMs: 1800 });
    assertEqual(due.actions[0].kind, 'play', 'the new attempt plays when it is ready');
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
    next.poll({ nowSharedMs: 1400 });
    const replacement = next.start.state().attemptId;
    next.start.ready(replacement, 1400);
    next.poll({ nowSharedMs: 1800 });
    const beforeReplacementResult = JSON.stringify(next.start.state());
    next.start.playResolved(old.attemptId);
    next.start.playRejected(old.attemptId, { name: 'NotAllowedError' });
    assertEqual(JSON.stringify(next.start.state()), beforeReplacementResult, 'a stale id cannot alter a current dispatched attempt');

    const readiness = rig();
    const oldPark = readiness.poll();
    const replacementPark = readiness.poll({ nowSharedMs: 1400 });
    readiness.start.ready(oldPark.attemptId, 1000);
    const due = readiness.poll({ nowSharedMs: 1800 });
    assertEqual(due.actions.some((action) => action.kind === 'play'), false, 'readiness from an earlier park does not qualify the replacement');
    assertEqual(due.retargets, 2, 'the replacement retargets when it is also not ready');
    assertEqual(replacementPark.attemptId !== oldPark.attemptId, true, 'the replacement remains distinct');
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
