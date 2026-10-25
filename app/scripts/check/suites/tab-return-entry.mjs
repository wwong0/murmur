// D2-D4 return wiring through the standard vm fakes and the real controller.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const TIME_ORIGIN_MS = 1_700_000_000_000;

function playingPage(code) {
  const page = runEntry(code, {
    search: '?room=r&tab=t&startTiming=1',
    settings: { delivery: 'http', iceServers: [] },
  });
  page.harness.clock = {
    offsetMs: 0, halfWidthMs: 1, delayTermMs: 1, ageTermMs: 1, sampleCount: 8, counters: { reanchors: 0 },
  };
  page.resolveSole({ clientId: 'host-1', nowMs: TIME_ORIGIN_MS + 1000 });
  page.act([{
    kind: 'play', attemptId: 1, startAtSharedMs: TIME_ORIGIN_MS + 1400, latenessMs: 0,
    positionMs: 100, scheduledPositionMs: 100, advanceMs: 0, seamEpochMs: TIME_ORIGIN_MS + 1300,
  }], { resolved: true, attemptId: 1, startAtSharedMs: TIME_ORIGIN_MS + 1400 });
  page.harness.playing = true;
  return page;
}

function addFrames(page, driftMs, firstDisplayMs = 2000) {
  for (let index = 0; index < 8; index += 1) {
    const displayMs = firstDisplayMs + index;
    page.setNow(displayMs);
    page.control.deliverFrame({
      expectedDisplayTime: displayMs,
      mediaTime: (700 + index + driftMs) / 1000,
      presentedFrames: index + 1,
    });
  }
}

function settleNamed(page, driftMs, untilMs) {
  addFrames(page, driftMs, 1993);
  page.setNow(2000);
  page.tick();
  addFrames(page, driftMs, untilMs - 8);
  page.setNow(untilMs - 1);
  page.harness.sharedNowMs = TIME_ORIGIN_MS + untilMs - 1;
  page.tick();
  addFrames(page, driftMs, untilMs - 7);
  page.setNow(untilMs);
  page.harness.sharedNowMs = TIME_ORIGIN_MS + untilMs;
  page.tick();
}

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
