// T3 (design.md D2; tasks.md 2.3): the shared token bucket, over constructed
// instants. Pure module — no server, no clock, no channel.

import { assert, assertEqual, check } from '../harness.mjs';
import { createSendPace, HEADROOM_DEFAULT, validateHeadroomFraction } from '../../../public/lib/send-pace.mjs';

export default async function sendPaceSuite() {
  await check('send-pace: HEADROOM_DEFAULT is 0.85, and validateHeadroomFraction accepts (0,1] or unpaced only', async () => {
    assertEqual(HEADROOM_DEFAULT, 0.85, 'the product default is 0.85');
    for (const value of [0.7, 1, 'unpaced']) {
      assertEqual(JSON.stringify(validateHeadroomFraction(value)), JSON.stringify({ fraction: value, error: null }), `${value} is valid`);
    }
    for (const value of [0, 1.01, NaN, '0.7', null, undefined, -1, Infinity]) {
      const result = validateHeadroomFraction(value);
      assertEqual(result.fraction, null, `${String(value)} yields no fraction`);
      assertEqual(result.error, 'headroom-fraction-must-be-in-(0,1]-or-unpaced', `${String(value)} names the error`);
    }
  });

  await check('send-pace: no bucket exists before any rate is set, whatever is taken', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    assertEqual(JSON.stringify(pace.available(0)), JSON.stringify({ ok: true }), 'no bucket: always ok');
    pace.take(1_000_000, 0);
    assertEqual(JSON.stringify(pace.available(100)), JSON.stringify({ ok: true }), 'still ok: no rate was ever set');
    assertEqual(pace.closeInterval(200), 0, 'no bucket means no pace-bound time, however much was taken');
  });

  await check('send-pace: the first non-null rate starts the level at capBytes, discarding earlier debt', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.take(5000, 0); // debt while unbucketed — must not carry over
    pace.setRate(10, 100);
    assertEqual(pace.available(100).ok, true, 'the level starts full, not at the earlier debt');
    pace.take(1000, 100); // empties the bucket to exactly zero
    const atZero = pace.available(100);
    assertEqual(atZero.ok, false, 'a level at exactly zero is not admitting (strictly above zero is required)');
    assertEqual(atZero.waitMs, 1, 'an exactly empty bucket waits the 1ms floor');
  });

  await check('send-pace: available refills continuously and its waitMs is the ceiling of the deficit over the rate', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(10, 0);
    pace.take(1500, 0); // level -500
    const blocked = pace.available(0);
    assertEqual(blocked.ok, false, 'a negative level blocks admission');
    assertEqual(blocked.waitMs, 50, '500 / 10 = 50ms to refill to zero');
    assertEqual(pace.available(49).ok, false, 'one ms short of the crossing, still blocked');
    assertEqual(pace.available(50).ok, false, 'the level reaches exactly zero at the crossing, still not admitting');
    assertEqual(pace.available(51).ok, true, 'one ms past the crossing the level is positive');
  });

  await check('send-pace: take lowers the level and it may go negative; the level is capped, never above capBytes', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(1, 0);
    pace.take(1500, 0);
    assertEqual(pace.available(0).waitMs, 500, 'take moved the level to -500, whatever the level had been');
    // Refill for far longer than needed to reach the cap; it must not run past it.
    assertEqual(pace.available(10_000).ok, true, 'the level is at or above zero long before 10,000ms');
    pace.take(1, 10_000); // one byte below the cap
    const almostFull = pace.available(10_000);
    assertEqual(almostFull.ok, true, 'one byte below a full cap is still positive');
  });

  await check('send-pace: a change of rate accrues to nowMs at the old rate first', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(10, 0);
    pace.take(1000, 0); // level exactly 0 at t=0
    assertEqual(pace.available(20).ok, true, 'refilled at the OLD rate (10 B/ms) by t=20: level=200');
    pace.setRate(1, 20); // switch to the NEW rate exactly at t=20
    pace.take(400, 20); // level = 200 - 400 = -200, from the level the old rate left behind
    assertEqual(pace.available(39).ok, false, 'far too soon for the new, slower rate to close a 200-byte deficit');
    assertEqual(pace.available(219).ok, false, '199ms of the new rate has not yet closed the deficit');
    assertEqual(pace.available(220).ok, false, 'the deficit reaches exactly zero at t=220 under the new rate, still not admitting');
    assertEqual(pace.available(221).ok, true, 'one ms past the new rate’s crossing the level is positive');
  });

  await check('send-pace: pace-bound time integrates exactly between calls, split at the zero-crossing and at each setWaiting change', async () => {
    // The bucket is empty (deeply negative, so the zero-crossing sits well past this
    // window) from t=100 to t=500, with one channel waiting throughout; waiting
    // stops at 500. Expected pace-bound time: 500 - 100 = 400ms.
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(1, 0);
    pace.setWaiting(1, 0);
    pace.take(2000, 100); // level -1000 at t=100; refilling at 1 B/ms crosses zero only at t=1100
    pace.setWaiting(0, 500);
    assertEqual(pace.closeInterval(600), 400, 'pace-bound time is exactly the constructed 400ms span');

    // The pair: the same bucket-empty span, differing only in the waiting count.
    const zero = createSendPace({ capBytes: 1000 });
    zero.setRate(1, 0);
    zero.setWaiting(0, 0);
    zero.take(2000, 100);
    zero.setWaiting(0, 500);
    assertEqual(zero.closeInterval(600), 0, 'with no channel ever waiting, the same empty span accrues no pace-bound time');
    // Mutation probe: staged, then the `waitingCount > 0 &&` clause dropped from
    // `advance`'s pace-bound guard in send-pace.mjs. `npm run check` turned both the
    // zero case above and the next check's assertions red (each read a positive
    // pace-bound time where zero or a bounded value was expected). Reverted; check
    // green again.
  });

  await check('send-pace: closeInterval resets its accumulator, and a second interval starts from zero', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(1, 0);
    pace.setWaiting(1, 0);
    pace.take(2000, 0); // level -2000 at t=0; the deficit is not closed for a long time
    assertEqual(pace.closeInterval(300), 300, 'the whole 300ms interval is pace-bound');
    assertEqual(pace.closeInterval(600), 300, 'the next 300ms interval, freshly measured, is pace-bound too');
    pace.setWaiting(0, 600);
    assertEqual(pace.closeInterval(900), 0, 'once nothing is waiting, a fresh interval accrues nothing, whatever came before');
  });

  await check('send-pace: setWaiting takes the channel count, not a boolean', async () => {
    const pace = createSendPace({ capBytes: 1000 });
    pace.setRate(1, 0);
    pace.take(2000, 0);
    pace.setWaiting(2, 0);
    pace.setWaiting(1, 100); // still >0 throughout — pace-bound continues to accrue
    assertEqual(pace.closeInterval(200), 200, 'the waiting count stayed above zero across the change, so the whole span is pace-bound');
  });
}
