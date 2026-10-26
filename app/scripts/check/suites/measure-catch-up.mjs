import { assertEqual, assertNear, check } from '../harness.mjs';
import { catchUp } from '../../measure/catch-up.mjs';

function record(L, mediaMs) { return { displaySharedMs: L, mediaMs, driftMs: mediaMs - L, clock: { offsetMs: 0 } }; }
function evidence() {
  const drift = Array.from({ length: 31 }, (_, index) => record(index * 1_000, index < 20 ? index * 1_000 - 500 : index * 1_000));
  const aligned = Array.from({ length: 31 }, (_, index) => record(index * 1_000, index * 1_000));
  const polls = [0, 10_000, 20_000, 30_000].map((atMs, index) => ({ atMs,
    controller: { rate: index === 1 ? 1.01 : 1 }, playback: { skips: index > 1 ? 1 : 0 }, stalls: { count: 0 } }));
  return { run: 'catch-up', tags: ['c01', 'c02'], manifest: { content: { frameRate: 1 }, window: { startMs: 0, endMs: 30_000 } },
    condition: {}, disturbance: { clients: ['c01'], observationMs: 30_000, results: { c01: { injected: true, pauseCallLocalMs: 0, playResolvedLocalMs: 0 } } },
    clients: { c01: { drift, polls }, c02: { drift: aligned, polls: [] } } };
}

export default async function measureCatchUpSuite() {
  await check('measurement catch-up: hold timing and far skip resolution', async () => {
    const result = catchUp(evidence());
    assertEqual(result.measuredPauseMs, 0, 'pause is measured from page timestamps');
    assertEqual(result.timeInto40Ms, 20_000, '40 ms hold starts after the 20 second gap');
    assertEqual(result.resolvedBy, 'far-skip', 'a far skip takes precedence over rate');
    assertEqual(result.skipsDelta, 1, 'skip delta is read over the observation');
  });

  // 24 fps, three viewers. c01 pauses at 10 000 for 500 ms, resumes 500 behind and closes at 1%:
  // g = −500 + 0.01·(L − 10 500), inside 40 from L = 56 500. `shape(k)` sets its frame at k·step.
  const step = 1000 / 24;
  const at24 = (shape, toMs = 70_000) => Array.from({ length: Math.floor(toMs / step) }, (_, k) => shape(k)).filter(Boolean);
  const frame = (L, mediaMs) => ({ displaySharedMs: L, mediaMs, driftMs: mediaMs - L, clock: { offsetMs: 0 } });
  const aligned = at24((k) => frame(k * step, k * step));
  function behind(disturbed, { others = [aligned, aligned], polls = [] } = {}) {
    return { run: 'behind', tags: ['c01', 'c02', 'c03'], manifest: { content: { frameRate: 24 }, window: { startMs: 0, endMs: 70_000 } },
      condition: {}, disturbance: { clients: ['c01'], observationMs: 59_000,
        results: { c01: { injected: true, pauseCallLocalMs: 10_000, playResolvedLocalMs: 10_500 } } },
      clients: { c01: { drift: disturbed, polls }, c02: { drift: others[0], polls: [] }, c03: { drift: others[1], polls: [] } } };
  }
  const closing = at24((k) => {
    const L = k * step;
    if (L > 10_000 && L < 10_500) return null;
    return frame(L, L < 10_500 ? L : L + Math.min(0, -500 + 0.01 * (L - 10_500)));
  });

  await check('measurement catch-up: a 500 ms pause at 24 fps is measured, closed and timed', async () => {
    const result = catchUp(behind(closing, { polls: [
      { atMs: 10_500, controller: { rate: 1.01 }, playback: { skips: 0 }, stalls: { count: 0 } },
      { atMs: 69_000, controller: { rate: 1 }, playback: { skips: 0 }, stalls: { count: 0 } }] }));
    assertEqual(result.measuredPauseMs, 500, 'measured pause');
    assertNear(result.gapBeforeMs, 0, 1e-6, 'in sync before the pause');
    assertNear(result.gapAfterMs, -500, 1e-6, 'largest gap after the pause');
    assertNear(result.timeInto40Ms, 46_000, step, 'holds from the instant it is inside 40');
    assertEqual(result.resolvedBy, 'rate', 'closed by rate, no skip');
    assertNear(result.othersMovedMs.differenceMs, 0, 1e-6, 'the others did not move');
  });

  await check('measurement catch-up: two frames off, a frozen viewer and moving others', async () => {
    // Two frames behind at 24 fps (83.3 ms) never holds, whatever the vsync phase.
    const twoFrames = at24((k) => (k * step > 10_000 && k * step < 10_500 ? null : frame(k * step, (k - 2) * step)));
    assertEqual(catchUp(behind(twoFrames)).timeInto40Ms, null, 'two frames off never holds 40 ms');
    // Frozen after resuming: its last frame goes stale and the rows drop out; it never reads in sync.
    const frozen = closing.filter((record) => record.displaySharedMs < 10_600);
    const stuck = catchUp(behind(frozen));
    assertEqual(stuck.timeInto40Ms, null, 'a viewer that stops presenting never holds');
    assertEqual(stuck.resolvedBy, 'unresolved', 'and is unresolved');
    // c03 drifts 20 ms after t0: the undisturbed pair moved by 20.
    const drifting = at24((k) => frame(k * step, k * step < 10_500 ? k * step : k * step + 20));
    const moved = catchUp(behind(closing, { others: [aligned, drifting] }));
    assertNear(moved.othersMovedMs.differenceMs, 20, 1e-6, 'others moved is after minus before');
  });

  await check('measurement catch-up: un-injected disturbance refuses', async () => {
    const fixture = evidence();
    fixture.disturbance.results.c01.injected = false;
    assertEqual(catchUp(fixture).reason, 'not-injected', 'un-injected run is named');
  });
}
