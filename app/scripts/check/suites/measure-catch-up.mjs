import { assertEqual, check } from '../harness.mjs';
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

  await check('measurement catch-up: un-injected disturbance refuses', async () => {
    const fixture = evidence();
    fixture.disturbance.results.c01.injected = false;
    assertEqual(catchUp(fixture).reason, 'not-injected', 'un-injected run is named');
  });
}
