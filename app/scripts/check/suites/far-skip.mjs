// Pure D4 dwell and repeat checks. The gate reads no clock or timer.

import { check, assert, assertEqual } from '../harness.mjs';
import { createFarSkip } from '../../../public/lib/far-skip.mjs';

function gate() {
  return createFarSkip({ dwellMs: 2000, repeatIntervalMs: 60_000 });
}

function run(g, nowMs, options = {}) {
  return g.evaluate({ nowMs, named: true, eligible: true, estimateMs: -25_000, ...options });
}

export default async function farSkipSuite() {
  await check('far-skip F1: the named dwell is two seconds', async () => {
    const g = gate();
    assertEqual(run(g, 0).skip, false, 'the first named evaluation only starts the dwell');
    assertEqual(run(g, 1999).skip, false, '1999 ms has not completed the dwell');
    const skipped = run(g, 2000);
    assertEqual(skipped.skip, true, '2000 ms completes the dwell');
    assertEqual(skipped.abandonedDriftMs, -25_000, 'the skip carries the estimate at its decision');
  });

  await check('far-skip F2: an unnamed evaluation restarts the dwell', async () => {
    const g = gate();
    run(g, 0);
    run(g, 1500);
    assertEqual(run(g, 1501, { named: false }).skip, false, 'the brief excursion clears the first dwell');
    run(g, 1502);
    assertEqual(run(g, 3501).skip, false, '1999 ms into the second naming is still short');
    assertEqual(run(g, 3502).skip, true, 'the second naming reaches two seconds');
  });

  await check('far-skip F3: the repeat interval gates a second skip', async () => {
    const g = gate();
    run(g, 0);
    assertEqual(run(g, 2000).skip, true, 'the first skip fires at the dwell boundary');
    run(g, 2001);
    assertEqual(run(g, 4001).skip, false, 'the second dwell cannot bypass the repeat interval');
    assertEqual(run(g, 61_999).skip, false, '59999 ms after the first skip is still barred');
    assertEqual(run(g, 62_000).skip, true, '60000 ms after the first skip permits another');
  });

  await check('far-skip F4: an ineligible named viewer is never skipped', async () => {
    const g = gate();
    assertEqual(run(g, 0, { eligible: false }).skip, false, 'an ineligible viewer does not start a dwell');
    assertEqual(run(g, 10_000, { eligible: false }).skip, false, 'ten seconds ineligible still has no skip');
    assertEqual(g.state().namedSince, null, 'ineligible evaluations leave no named dwell');
  });

  await check('far-skip F5: a viewer back from a hidden page skips inside the interval', async () => {
    const g = gate();
    assertEqual(run(g, 0).skip, false, 'the first naming starts the dwell');
    assertEqual(run(g, 2000).skip, true, 'the initial skip fires at 2000 ms');
    g.returned();
    assertEqual(g.state().waived, true, 'return grants a waiver');
    assertEqual(run(g, 20_001).skip, false, 'the return starts a fresh dwell');
    assertEqual(run(g, 22_000).skip, false, '2000 ms from the return is still short');
    const skipped = run(g, 22_001);
    assertEqual(skipped.skip, true, 'the waiver permits a skip inside the interval');
    assertEqual(skipped.abandonedDriftMs, -25_000, 'the skip carries the estimate at its decision');
  });

  await check('far-skip F6: a return grants one skip, not one per poll', async () => {
    const g = gate();
    run(g, 0);
    assertEqual(run(g, 2000).skip, true, 'the first skip fires at 2000 ms');
    g.returned();
    run(g, 20_001);
    assertEqual(run(g, 22_000).skip, false, 'the return dwell is still short at 22000 ms');
    assertEqual(run(g, 22_001).skip, true, 'the return waiver permits the second skip');
    assertEqual(g.state().waived, false, 'the skip spends the waiver');
    run(g, 22_002);
    assertEqual(run(g, 30_000).skip, false, 'the spent waiver cannot fire another skip');
    assertEqual(run(g, 82_000).skip, false, '59999 ms after the second naming is still barred');
    assertEqual(run(g, 82_001).skip, true, 'the repeat interval permits the next skip');
  });

  await check('far-skip F7: a return still needs the dwell', async () => {
    const g = gate();
    run(g, 0);
    assertEqual(run(g, 2000).skip, true, 'the initial skip fires at 2000 ms');
    run(g, 20_000);
    g.returned();
    assertEqual(run(g, 22_100).skip, false, 'pre-return naming does not count toward the dwell');
    assertEqual(run(g, 24_099).skip, false, '1999 ms of post-return naming is still short');
    assertEqual(run(g, 24_100).skip, true, '2000 ms of post-return naming permits the skip');
  });

  await check('far-skip F8: an unspent waiver lapses when hidden', async () => {
    const g = gate();
    run(g, 0);
    assertEqual(run(g, 2000).skip, true, 'the initial skip fires at 2000 ms');
    g.returned();
    assertEqual(g.state().waived, true, 'return grants a waiver');
    g.hidden();
    assertEqual(g.state().waived, false, 'hiding lapses the unspent waiver');
    assertEqual(run(g, 12_000).skip, false, 'the second naming starts a dwell');
    assertEqual(run(g, 14_001).skip, false, 'the interval still bars the skip');
    assertEqual(run(g, 62_000).skip, true, 'the repeat interval permits the next skip');
  });
}
