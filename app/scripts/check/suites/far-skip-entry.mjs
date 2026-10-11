// D4 entry wiring through the standard vm fakes and the real controller.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const TIME_ORIGIN_MS = 1_700_000_000_000;

function playingPage(code) {
  const page = runEntry(code, { settings: { delivery: 'http', iceServers: [] } });
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

export default async function farSkipEntrySuite() {
  const product = await bundleProductEntry();

  await check('far-skip-entry F6: a closable difference never moves the position', async () => {
    const page = playingPage(product.code);
    settleNamed(page, -400, 12_000);
    assertEqual(page.app.playback().skips, 0, '400 ms behind for ten seconds never skips');
    assertEqual(page.events.filter((event) => event.kind === 'park').length, 0, 'the closable difference causes no position write');
  });

  await check('far-skip-entry F6: an unclosable difference skips without an envelope', async () => {
    const page = playingPage(product.code);
    page.harness.acceptSkip = true;
    const before = page.sent().length;
    settleNamed(page, -25_000, 4000);
    const afterSkip = page.sent().length;
    assertEqual(page.app.playback().skips, 1, '25000 ms behind produces one skip');
    const parks = page.events.filter((event) => event.kind === 'park');
    assertEqual(parks.length, 1, 'the skip produces one position write');
    assertEqual(parks[0].detail.paused, true, 'the skip writes the position while paused');
    assertEqual(afterSkip, before, 'the skip sends zero envelopes');
    page.click('forward-10');
    assertEqual(page.sent().length, before + 1, 'an ordinary operation can move the send count in this check');
  });
}
