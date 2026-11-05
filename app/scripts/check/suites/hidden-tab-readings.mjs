// The hidden-tab probe readings on constructed runs: the validity rule, one hide's readings and D7's rule.

import { check, assert, assertEqual } from '../harness.mjs';
import { returnLanding, hideWindows, landedAtMs, readHide, validateRun } from '../../hidden-tab-readings.mjs';

const T0 = 1_000_000;
const HIDE = { start: T0 + 20_000, hidden: T0 + 20_100, back: T0 + 30_100, visible: T0 + 30_150 };

function marks() {
  return [
    { name: 'hide-start', subject: 'viewer', atWallMs: HIDE.start },
    { name: 'hidden', atWallMs: HIDE.hidden },
    { name: 'return-start', atWallMs: HIDE.back },
    { name: 'visible', atWallMs: HIDE.visible },
  ];
}

// One sample a second from T0 to T0 + 50 s. Visible: 4 ticks/s, 24 frames/s, in reach.
// Hidden: `hiddenTicks` ticks/s, no frames, element paused unless `playsHidden`.
function run({ hiddenTicks = 1, hiddenState = 'hidden', playsHidden = false, landAtMs = HIDE.visible + 6000, skipAtMs = HIDE.visible + 3000, skips = 1 } = {}) {
  const samples = [];
  let ticks = 0;
  let callbacks = 0;
  let element = 0;
  let skipped = 0;
  for (let at = T0; at <= T0 + 50_000; at += 1000) {
    const inside = at > HIDE.hidden && at < HIDE.back;
    ticks += inside ? hiddenTicks : 4;
    callbacks += inside ? 0 : 24;
    element += inside && !playsHidden ? 0 : 1000;
    if (at >= skipAtMs && skipped < skips) skipped += 1;
    const landed = !inside && (at < HIDE.start || at >= landAtMs);
    const timeline = at - T0;
    for (const page of ['viewer', 'host']) {
      const isViewer = page === 'viewer';
      samples.push({
        page, ok: true, atWallMs: at, pageMs: at + 3,
        visibility: isViewer && inside ? hiddenState : 'visible',
        ticks: isViewer ? ticks : (at - T0) / 250, callbacks: isViewer ? callbacks : (at - T0) * 0.024,
        video: { paused: isViewer && inside && !playsHidden, readyState: 4, bufferedAheadMs: 30_000 },
        elementMediaMs: isViewer ? element : timeline, timelineMediaMs: timeline,
        positionGapMs: isViewer ? element - timeline : 0,
        roomPlaying: true, skips: isViewer ? skipped : 0, lastSkipAbandonedMs: isViewer && skipped ? -10_000 : null,
        clock: { probesIssued: 0, ageMs: 100, sampleCount: 8 },
        controller: { mode: !isViewer || landed ? 'settled' : (inside ? 'stale' : 'beyond-rate-authority'), rate: 1, estimateMs: !isViewer || landed ? 5 : (inside ? null : -10_000) },
        receipts: { count: 0, bytes: 0 }, roster: 2,
      });
    }
  }
  const events = [
    { page: 'viewer', target: 'document', type: 'visibilitychange', state: 'hidden', pageMs: HIDE.start + 60 },
    { page: 'viewer', target: 'video', type: 'pause', pageMs: HIDE.start + 900 },
    { page: 'viewer', target: 'document', type: 'visibilitychange', state: 'visible', pageMs: HIDE.back + 20 },
  ];
  return { samples, events, windows: hideWindows(marks()), steadyFromMs: T0 + 5000, subject: 'viewer', other: 'host' };
}

export default async function hiddenTabReadingsSuite() {
  await check('13a probe R1: a run whose hidden ticks slow and whose log brackets the hide is valid', async () => {
    const result = validateRun(run());
    assertEqual(result.valid, true, `valid: ${result.reasons.join('; ')}`);
    assert(Math.abs(result.visibleTickRate - 4) < 0.01, `visible rate ${result.visibleTickRate}`);
    assert(Math.abs(result.hiddenTickRates[0] - 1) < 0.01, `hidden rate ${result.hiddenTickRates[0]}`);
  });

  await check('13a probe R2: ticks at the visible rate while hidden make the run invalid', async () => {
    const result = validateRun(run({ hiddenTicks: 4 }));
    assertEqual(result.valid, false, 'full-rate ticks while hidden are invalid');
    assert(result.reasons.some((r) => r.startsWith('hide 1: ticks')), result.reasons.join('; '));
    assertEqual(validateRun(run({ hiddenTicks: 2 })).valid, true, 'half the visible rate is the bound, inclusive');
    assertEqual(validateRun(run({ hiddenTicks: 3 })).valid, false, 'three quarters is over it');
  });

  await check('13a probe R2a: an audible page is valid on stopped frames, and invalid on frames', async () => {
    assertEqual(validateRun({ ...run({ hiddenTicks: 4 }), audible: true }).valid, true, 'full-rate ticks with no hidden frame are valid when audible');
    const framed = run({ hiddenTicks: 4 });
    for (const s of framed.samples) if (s.page === 'viewer' && s.atWallMs > HIDE.hidden + 3000 && s.atWallMs < HIDE.back) s.callbacks += 24;
    const result = validateRun({ ...framed, audible: true });
    assertEqual(result.valid, false, 'a frame callback while hidden is invalid when audible');
    assert(result.reasons.some((r) => r.includes('frame callbacks while hidden')), result.reasons.join('; '));
  });

  await check('13a probe R3: a hide the page never saw, or a change on the other page, is invalid', async () => {
    const unseen = validateRun(run({ hiddenState: 'visible' }));
    assertEqual(unseen.valid, false, 'a page sampled visible inside the hide is invalid');
    assert(unseen.reasons.some((r) => r.includes('sampled visible inside hide 1')), unseen.reasons.join('; '));
    const input = run();
    input.events.push({ page: 'host', target: 'document', type: 'visibilitychange', state: 'hidden', pageMs: T0 + 40_000 });
    assertEqual(validateRun(input).valid, false, 'the other page changing visibility is invalid');
    const missing = run();
    missing.events = missing.events.filter((e) => e.state !== 'visible');
    assertEqual(validateRun(missing).valid, false, 'a hide with no visible event is invalid');
  });

  await check('13a probe R4: one hide reads the paused element, the stopped frames and the skip after it', async () => {
    const input = run();
    const reading = readHide({ ...input, window: input.windows[0], untilMs: T0 + 50_001 });
    assertEqual(reading.playback.pausedSamples, reading.samples, 'every hidden sample is paused');
    assertEqual(reading.playback.elementAdvanceMs, 0, 'the paused element did not advance');
    assertEqual(reading.playback.events.pause, 1, 'the pause event inside the hide is counted');
    assertEqual(reading.frames.callbacks, 0, 'no frame callbacks while hidden');
    assertEqual(reading.afterReturn.skips, 1, 'one skip after the return');
    assertEqual(reading.afterReturn.abandonedMs, -10_000, 'the skip carries its abandoned difference');
    assertEqual(reading.afterReturn.landedAfterVisibleMs, 6850, 'landed at the first of three in-reach samples after visible');
    const played = run({ playsHidden: true });
    const playedReading = readHide({ ...played, window: played.windows[0], untilMs: T0 + 50_001 });
    assert(playedReading.playback.elementAdvanceRatio > 0.99 && playedReading.playback.elementAdvanceRatio < 1.01, `advance ratio ${playedReading.playback.elementAdvanceRatio}`);
  });

  await check('13a probe R5: D7 passes a landing inside 10 s with one skip, and fails the rest', async () => {
    const read = (options) => {
      const input = run(options);
      return readHide({ ...input, window: input.windows[0], untilMs: T0 + 50_001 });
    };
    assertEqual(returnLanding(read({ landAtMs: HIDE.visible + 9850 })).pass, true, 'landed 9850 ms after visible passes');
    assertEqual(returnLanding(read({ landAtMs: HIDE.visible + 10_850 })).pass, false, 'landed 10850 ms after visible fails');
    assertEqual(returnLanding(read({ skips: 2 })).pass, false, 'two skips after one return fail');
    assertEqual(returnLanding(read({ skips: 0 }), { mustSkip: true }).pass, false, 'a required skip that never came fails');
    assertEqual(returnLanding(read({ skips: 0 })).pass, true, 'no skip, landed, passes where none is required');
  });

  await check('13a probe R6: in-reach samples without new frames never land', async () => {
    const list = [0, 1, 2, 3, 4].map((i) => ({ atWallMs: i * 1000, callbacks: 10, controller: { mode: 'settled', estimateMs: 1 } }));
    assertEqual(landedAtMs(list, 0), null, 'a settled mode on stopped frames is not a landing');
    list.forEach((s, i) => { s.callbacks = 10 + i * 24; });
    assertEqual(landedAtMs(list, 0), 1000, 'the same samples with advancing frames land');
  });
}
