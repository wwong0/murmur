// scripts/check/suites/settle-wait.mjs
//
// The in-sync settle path over constructed reads. Pure. The bars are
// pinned off the browser pass's values (8 records, 5000ms, RATE_EPSILON) so a
// constant in the module cannot pass.

import { check, assertEqual } from '../harness.mjs';
import { inSyncWithoutCorrection } from '../../settle-wait.mjs';

const BARS = Object.freeze({ minRecords: 6, settledForMs: 4000, rateEpsilon: 0.002 });

// Every sample agrees on these; a case overrides exactly the field it tests.
const CONTROLLER = Object.freeze({
  estimateMs: 3, windowRecords: 6, thresholdUsable: true, stoppingThresholdMs: 5,
  rate: 1.001, correctionsApplied: 0, lastDrop: null,
});
const PLAYBACK = Object.freeze({ resolved: true, playing: true });

/** One read per 250ms from 0 to `endMs`, polls advancing each read; `edit(atMs)` returns overrides. */
function reads(endMs, edit = () => ({})) {
  const out = [];
  for (let atMs = 0, polls = 1; atMs <= endMs; atMs += 250, polls++) {
    const { playback = {}, controller = {} } = edit(atMs, polls);
    out.push({ atMs, playback: { ...PLAYBACK, ...playback }, controller: { ...CONTROLLER, polls, ...controller } });
  }
  return out;
}

const run = (samples) => inSyncWithoutCorrection(samples, BARS);

export default async function settleWaitSuite() {
  await check('settle wait: an unbroken in-sync run is done at exactly the span, not one millisecond before', async () => {
    const exact = run(reads(4000));
    assertEqual(exact.done, true, 'exactly 4000ms unbroken is done');
    assertEqual(exact.since, 0, 'the run began at the first sample');
    assertEqual(exact.reason, null, 'a done run has no reason');
    const short = reads(4000);
    short.at(-1).atMs = 3999;
    assertEqual(run(short).done, false, '3999ms is not done');
    assertEqual(run(short).reason, 'short', 'and says the run is short');
  });

  await check('settle wait: a stale read does not extend the span', async () => {
    // The last four reads repeat poll 13, so the span ends at the 3000ms read.
    const stale = reads(4000, (atMs) => (atMs > 3000 ? { controller: { polls: 13 } } : {}));
    assertEqual(run(stale).done, false, 'non-advancing polls do not count as elapsed in-sync time');
    assertEqual(run(reads(4000)).done, true, 'the same reads with advancing polls are done');
  });

  await check('settle wait: each disqualifier resets the run', async () => {
    const resetAt3000 = (overrides) => run(reads(6500, (atMs) => (atMs === 3000 ? overrides : {})));
    for (const [name, overrides] of [
      ['estimate outside threshold', { controller: { estimateMs: -5.001 } }],
      ['resolved false', { playback: { resolved: false } }],
      ['not playing', { playback: { playing: false } }],
      ['too few records', { controller: { windowRecords: 5 } }],
      ['threshold unusable', { controller: { thresholdUsable: false } }],
      ['rate off base', { controller: { rate: 1.0021 } }],
    ]) {
      const result = resetAt3000(overrides);
      assertEqual(result.done, false, `${name} at 3000ms leaves 3250ms, not done`);
      assertEqual(result.since, 3250, `${name}: the run restarts after the reset`);
    }
    assertEqual(run(reads(7250, (atMs) => (atMs === 3000 ? { controller: { estimateMs: 6 } } : {}))).done, true, 'the restarted run completes 4000ms later');
    assertEqual(run(reads(6500, (atMs) => (atMs === 3000 ? { controller: { estimateMs: -5 } } : {}))).done, true, 'an estimate at the threshold does not reset');
  });

  await check('settle wait: a controller drop resets the run', async () => {
    const drop = { reason: 'seam', atMs: 3000 };
    const result = run(reads(6500, (atMs) => (atMs >= 3000 ? { controller: { lastDrop: drop } } : {})));
    assertEqual(result.done, false, 'a change in lastDrop resets');
    assertEqual(result.since, 3250, 'the run restarts after the drop');
    assertEqual(run(reads(3000, (atMs) => (atMs === 3000 ? { controller: { lastDrop: drop } } : {}))).reason, 'dropped', 'a drop on the last read is named');
    assertEqual(run(reads(4000, () => ({ controller: { lastDrop: drop } }))).done, true, 'an unchanged earlier drop does not reset');
  });

  await check('settle wait: one applied correction is never the in-sync path', async () => {
    const corrected = run(reads(20_000, (atMs) => (atMs >= 1000 ? { controller: { correctionsApplied: 1 } } : {})));
    assertEqual(corrected.done, false, 'correctionsApplied 1 is never done');
    assertEqual(corrected.reason, 'corrected', 'and says why');
  });

  await check('settle wait: a done run broken at the final sample is not done', async () => {
    const broken = run(reads(6000, (atMs) => (atMs === 6000 ? { controller: { estimateMs: 9 } } : {})));
    assertEqual(broken.done, false, 'the last sample of the wait is rechecked');
    assertEqual(broken.reason, 'outside-threshold', 'with its own reason');
    assertEqual(run([]).done, false, 'no samples is not done');
  });
}
