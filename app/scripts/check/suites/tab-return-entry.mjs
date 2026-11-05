// The tab-return wiring through the standard vm fakes and the real controller.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry } from '../entry-harness.mjs';
import { TIME_ORIGIN_MS, playingPage as basePlayingPage, settleNamed } from '../far-skip-page.mjs';

const playingPage = (code) => basePlayingPage(code, { search: '?room=r&tab=t&startTiming=1' });

function visibility(page, state) {
  page.document.visibilityState = state;
  page.fireDocument('visibilitychange');
}

function resumeAfterSkip(page) {
  page.harness.playing = true;
  page.act([{
    kind: 'play', attemptId: 2, startAtSharedMs: TIME_ORIGIN_MS + 5000, latenessMs: 0,
    positionMs: 1234, scheduledPositionMs: 1234, advanceMs: 0, seamEpochMs: TIME_ORIGIN_MS + 5000,
  }], { resolved: true, attemptId: 2, startAtSharedMs: TIME_ORIGIN_MS + 5000 });
}

export default async function tabReturnEntrySuite() {
  const product = await bundleProductEntry();

  await check('tab-return-entry R1: a stopped viewer rejoins on return', async () => {
    const page = playingPage(product.code);
    page.harness.acceptSkip = true;
    visibility(page, 'hidden');
    page.video.pause();
    visibility(page, 'visible');
    const parks = page.events.filter((event) => event.kind === 'park');
    assertEqual(page.app.playback().skips, 1, 'return re-entry counts one skip');
    assertEqual(parks.length, 1, 'return re-entry parks once');
    assertEqual(parks[0].detail.paused, true, 'return re-entry parks while paused');
    const action = page.app.startTiming().events.filter((event) => event.kind === 'action' && event.action === 'park').at(-1);
    assert(action, 'return re-entry records a park action');
    assertEqual(action.abandonedDriftMs, null, 'return re-entry has no abandoned drift');
    assertEqual(page.app.playback().lastSkipAbandonedMs, null, 'return re-entry publishes no abandoned drift');
    assert(page.notices().some((notice) => notice.includes('re-entry on return')), 'return re-entry adds its notice');
  });

  await check('tab-return-entry R2: a playing viewer does not re-enter', async () => {
    const page = playingPage(product.code);
    page.harness.acceptSkip = true;
    visibility(page, 'hidden');
    visibility(page, 'visible');
    assertEqual(page.events.filter((event) => event.kind === 'park').length, 0, 'a playing element is not re-parked');
    assertEqual(page.app.playback().skips, 0, 'a playing element produces no return skip');
  });

  await check('tab-return-entry R3: a paused room is not started by return', async () => {
    const page = playingPage(product.code);
    page.harness.acceptSkip = true;
    // The entry's guard reads playing first and sees a paused room; the fake skip() reads it second and
    // would accept, so dropping the guard re-parks. Reordering those reads makes this unfailable.
    let playingReads = 0;
    Object.defineProperty(page.harness, 'playing', {
      configurable: true,
      get() { playingReads += 1; return playingReads === 2; },
      set() {},
    });
    page.video.pause();
    const plays = page.count('play');
    visibility(page, 'hidden');
    visibility(page, 'visible');
    assertEqual(page.events.filter((event) => event.kind === 'park').length, 0, 'a paused room is not parked');
    assertEqual(page.count('play'), plays, 'a paused room is not started');
  });

  await check('tab-return-entry R4: a visible pause is not undone', async () => {
    const page = playingPage(product.code);
    page.video.pause();
    page.tick();
    assertEqual(page.events.filter((event) => event.kind === 'park').length, 0, 'a visible pause causes no return park');
    assertEqual(page.count('play'), 1, 'a visible pause causes no start');
  });

  await check('tab-return-entry R5: return runs the playback tick once', async () => {
    const page = playingPage(product.code);
    const before = page.count('playback-start-poll');
    visibility(page, 'hidden');
    assertEqual(page.count('playback-start-poll'), before, 'hidden does not run the playback tick');
    visibility(page, 'visible');
    assertEqual(page.count('playback-start-poll'), before + 1, 'visible runs one immediate playback tick');
  });

  await check('tab-return-entry R6: a return waiver reaches the far-skip gate once', async () => {
    const returned = playingPage(product.code);
    returned.harness.acceptSkip = true;
    settleNamed(returned, -25_000, 4000);
    assertEqual(returned.app.playback().skips, 1, 'the initial dwell produces one far skip');
    resumeAfterSkip(returned);
    visibility(returned, 'hidden');
    visibility(returned, 'visible');
    settleNamed(returned, -25_000, 25_000);
    assertEqual(returned.app.playback().skips, 2, 'a return waiver permits one skip inside the interval');

    const hiddenAgain = playingPage(product.code);
    hiddenAgain.harness.acceptSkip = true;
    settleNamed(hiddenAgain, -25_000, 4000);
    resumeAfterSkip(hiddenAgain);
    visibility(hiddenAgain, 'hidden');
    hiddenAgain.document.visibilityState = 'visible';
    settleNamed(hiddenAgain, -25_000, 25_000);
    assertEqual(hiddenAgain.app.playback().skips, 1, 'without a visible event the repeat interval still holds');
  });
}
