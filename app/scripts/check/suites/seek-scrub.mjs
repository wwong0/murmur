import { assert, assertEqual, check } from '../harness.mjs';
import { createSeekScrub } from '../../../public/lib/seek-scrub.mjs';

// Joint D1 F4: a drag of the seek bar seeks once, where it is released.
export default async function seekScrubSuite() {
  await check('seek-scrub: a drag of many moves issues one seek, at its release', async () => {
    const seeks = [];
    const scrub = createSeekScrub({ seek: (positionMs) => { seeks.push(positionMs); return true; } });
    assert(!scrub.holds(), 'an untouched bar is not held');
    for (const positionMs of [1_000, 2_000, 3_000, 4_000]) scrub.input(positionMs);
    assertEqual(seeks.length, 0, 'moves issue no seek');
    assert(scrub.holds(), 'a bar under the pointer is held, so the tick leaves its thumb alone');
    assertEqual(scrub.commit(4_000), true, 'the release reports the seek');
    assertEqual(JSON.stringify(seeks), '[4000]', 'one seek, to the released position');
    assert(!scrub.holds(), 'a released bar follows the room again');
  });

  await check('seek-scrub: a pointer released without a change frees the bar', async () => {
    const seeks = [];
    const scrub = createSeekScrub({ seek: (positionMs) => seeks.push(positionMs) });
    scrub.input();
    scrub.release();
    assert(!scrub.holds(), 'a cancelled drag does not hold the thumb');
    assertEqual(scrub.commit(Number.NaN), false, 'a commit with no position seeks nowhere');
    assertEqual(seeks.length, 0, 'no seek');
  });
}
