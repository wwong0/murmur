// A playing entry page and the frames that name a difference, for the far-skip and tab-return entry suites.

import { runEntry } from './entry-harness.mjs';

export const TIME_ORIGIN_MS = 1_700_000_000_000;

export function playingPage(code, { search } = {}) {
  const page = runEntry(code, { ...(search ? { search } : {}), settings: { delivery: 'http', iceServers: [] } });
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

export function addFrames(page, driftMs, firstDisplayMs = 2000) {
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

export function settleNamed(page, driftMs, untilMs) {
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
