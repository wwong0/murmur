// scripts/check/suites/playback-start.mjs
//
// The load rule: when the video may open, where it opens, and the one event
// that opens it again (change 3b design.md D1). The timeline underneath it is
// change 3a's, driven by manufactured rosters.
//
// NOTHING IN HERE OPENS A SOCKET, TOUCHES A BROWSER OR WAITS FOR TIME. The
// module holds no timer and reads no clock — the caller polls it and supplies
// the instant — so a revision arriving before the first open and one arriving
// after it are both reachable synchronously. That distinction is the whole
// rule, and it costs no browser.

import { check, assert, assertEqual } from '../harness.mjs';
import { createRoomTimeline } from '../../../public/lib/room-timeline.mjs';
import { createPlaybackStart, MISSING_CLOCK, MISSING_REFERENCE } from '../../../public/lib/playback-start.mjs';

const member = (clientId, joinedAt) => ({ clientId, tabId: clientId, role: 'viewer', joinedAt });

/**
 * A shared clock under the check's control. `sharedNow` is the whole interface
 * the load rule uses; `null` is the no-estimate state, exactly as clock-sync
 * reports it before its first accepted sample.
 */
function fakeClock(sharedMs = null) {
  const state = { sharedMs };
  return { state, sharedNow: () => state.sharedMs };
}

/** The gate, plus the `open` calls it made, in order. */
function rig() {
  const timeline = createRoomTimeline();
  const clock = fakeClock();
  const opens = [];
  const start = createPlaybackStart({ timeline, clock, open: (at) => opens.push(at) });
  return { timeline, clock, opens, start };
}

export default async function playbackStartSuite() {
  await check('playback-start: with an input missing it does not play, and says which one', async () => {
    const { timeline, clock, opens, start } = rig();

    let status = start.poll();
    assertEqual(status.playing, false, 'no clock estimate and no roster: nothing opens');
    assertEqual(status.missing, MISSING_CLOCK, 'and the clock is the input named first');

    // A roster with no clock is still not playable, and the answer must not
    // change to the other input just because this one arrived.
    timeline.observeRoster([member('a', 5000)]);
    assertEqual(start.poll().missing, MISSING_CLOCK, 'a reference point without a clock does not make the page playable');

    const fresh = rig();
    fresh.clock.state.sharedMs = 12000;
    status = fresh.start.poll();
    assertEqual(status.playing, false, 'a clock with no reference point does not play either');
    assertEqual(status.missing, MISSING_REFERENCE, 'and this time the reference is what is missing');

    assertEqual(opens.length, 0, 'neither state opened the media');
    assertEqual(fresh.opens.length, 0, 'neither state opened the media');

    // Both inputs present: it opens, at the timeline's answer for that instant.
    clock.state.sharedMs = 12000;
    status = start.poll();
    assertEqual(status.playing, true, 'with both inputs it plays');
    assertEqual(status.missing, null, 'and nothing is missing');
    assertEqual(opens.length, 1, 'the media was opened once');
    assertEqual(opens[0].positionMs, 7000, 'at the position the timeline gives for the instant it opened at');
    assertEqual(opens[0].reopen, false, 'as a first open, not a re-open');
    assertEqual(status.startedAtMediaMs, 7000, 'and the status reports where it began');
  });

  await check('playback-start: a reference revision BEFORE the first open is not a re-open, and one after it is', async () => {
    // THE DISTINCTION IS THE WHOLE RULE. Before the open there is nothing to
    // correct — the media was never opened against the epoch being replaced —
    // and counting it would hand change 6 a seam in a series that has no
    // records on the far side of it.
    const early = rig();
    early.timeline.observeRoster([member('b', 7000)]);
    early.timeline.observeRoster([member('a', 5000), member('b', 7000)]);
    assertEqual(early.timeline.counters.epochRevisions, 1, 'the timeline revised its reference point');
    early.clock.state.sharedMs = 12000;

    let status = early.start.poll();
    assertEqual(status.opens, 1, 'the first poll after it opens the media once');
    assertEqual(status.reopens, 0, 'and the revision it never saw is not a re-open');
    assertEqual(early.opens[0].positionMs, 7000, 'the position comes from the revised reference, not the discarded one');

    const late = rig();
    late.timeline.observeRoster([member('b', 7000)]);
    late.clock.state.sharedMs = 12000;
    status = late.start.poll();
    assertEqual(status.opens, 1, 'opened against the reference it had');
    assertEqual(late.opens[0].positionMs, 5000, 'five seconds in, from the later epoch');

    // The same revision, now arriving under an open player.
    late.timeline.observeRoster([member('a', 5000), member('b', 7000)]);
    status = late.start.poll();
    assertEqual(status.reopens, 1, 'a revision after the open re-opens the media, once');
    assertEqual(late.opens.length, 2, 'and the player was told');
    assertEqual(late.opens[1].reopen, true, 'as a re-open, which is what marks the seam');
    assertEqual(late.opens[1].positionMs, 7000, 'at the corrected position — two seconds later, the size of the revision');
    assertEqual(status.opens, 1, 'a re-open is not a second first open');
    // WHERE THE MEDIA IS OPEN NOW, not where it was first opened: a re-open
    // moved the media, and a consumer measuring how far a window has played
    // subtracts this from its current position (scripts/verify-browser.mjs).
    assertEqual(status.startedAtMediaMs, 7000, 'and the reported start position moved with it');
  });

  await check('playback-start: nothing but a revision opens the media again', async () => {
    const { timeline, clock, opens, start } = rig();
    timeline.observeRoster([member('a', 5000)]);
    clock.state.sharedMs = 12000;
    start.poll();
    assertEqual(opens.length, 1, 'open once');

    // Time passes, rosters arrive, the clock is re-read — none of it is a
    // revision. There is no drift input on this interface at all, which is the
    // structural half of D1: a page that could re-open on a drift figure would
    // hand change 4 the seek its whole job is to avoid.
    for (let i = 1; i <= 20; i++) {
      clock.state.sharedMs = 12000 + i * 1000;
      timeline.observeRoster([member('a', 5000), member(`m${i}`, 12000 + i * 1000)]);
      start.poll();
    }
    assertEqual(opens.length, 1, 'twenty polls across twenty seconds and twenty rosters opened nothing');
    assertEqual(start.state().reopens, 0, 'and counted no re-opens');
    assertEqual(start.state().startedAtMediaMs, 7000, 'the position it started at is still the one it started at');

    // A member leaving cannot move the epoch forward (change 3a D2), so a
    // departure is not a revision either.
    timeline.observeRoster([member('m20', 32000)]);
    start.poll();
    assertEqual(opens.length, 1, 'losing the earliest member does not re-open anything');
  });

  await check('playback-start: a player that throws is retried, not recorded as playing', async () => {
    // Rule 3 of the module: the state is committed after `open` returns. A gate
    // that committed first would report a page as playing that never opened —
    // the exact reading change 6 must be able to refuse a run on.
    const timeline = createRoomTimeline();
    const clock = fakeClock(12000);
    let fail = true;
    let calls = 0;
    const start = createPlaybackStart({
      timeline,
      clock,
      open: () => {
        calls += 1;
        if (fail) throw new Error('hls.js is not ready');
      },
    });
    timeline.observeRoster([member('a', 5000)]);

    let threw = false;
    try {
      start.poll();
    } catch {
      threw = true;
    }
    assert(threw, 'the failure reaches the caller rather than being swallowed');
    assertEqual(start.state().playing, false, 'and the page does not claim to be playing');
    assertEqual(start.state().opens, 0, 'nor to have opened anything');
    assertEqual(start.state().missing, null, 'and it names no missing input, because it is not missing one');

    fail = false;
    const status = start.poll();
    assertEqual(status.playing, true, 'the next poll opens it');
    assertEqual(calls, 2, 'the second attempt is a second call, not a resumed first');
  });
}
