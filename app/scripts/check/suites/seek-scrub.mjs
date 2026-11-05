import { assert, assertEqual, check } from '../harness.mjs';
import { createSeekScrub } from '../../../public/lib/seek-scrub.mjs';

// A drag of the seek bar seeks once, where it is released.
export default async function seekScrubSuite() {
  await check('seek-scrub: a drag of many moves issues one seek, at its release', async () => {
    const seeks = [];
    const scrub = createSeekScrub({ seek: (positionMs) => { seeks.push(positionMs); return true; } });
    assert(!scrub.holds(), 'an untouched bar is not held');
    for (const positionMs of [1_000, 2_000, 3_000, 4_000]) scrub.input(positionMs);
    assertEqual(seeks.length, 0, 'moves issue no seek');
    assert(scrub.holds(), 'a bar under the pointer is held, so the tick leaves its thumb alone');
    assertEqual(scrub.commit(4_000, 0), true, 'the release reports the seek');
    assertEqual(JSON.stringify(seeks), '[4000]', 'one seek, to the released position');
    assert(scrub.holds(14_000, 1_499), 'a committed bar holds while the room catches up');
    assert(!scrub.holds(14_000, 1_500), 'a committed bar releases at the time bound');
  });

  await check('seek-scrub: proximity releases at one second and a pointer release keeps a commit', async () => {
    const scrub = createSeekScrub({ seek: () => true });
    scrub.input();
    scrub.commit(20_000, 0);
    scrub.release();
    assert(scrub.holds(21_001, 1), 'one millisecond outside the position bound still holds');
    assert(!scrub.holds(21_000, 1), 'the inclusive position bound releases');

    scrub.input();
    scrub.commit(20_000, 0);
    scrub.release();
    assert(scrub.holds(0, 1), 'pointer release after change does not drop a commit');
    scrub.input();
    scrub.release();
    assert(!scrub.holds(0, 1), 'a new input drops the old commit');
  });

  await check('seek-scrub: a refused commit frees the bar, and an unreadable position or time keeps a commit', async () => {
    const seeks = [];
    let scrub = createSeekScrub({ seek: (positionMs) => { seeks.push(positionMs); return false; } });
    scrub.input();
    scrub.release();
    assert(!scrub.holds(), 'a cancelled drag does not hold the thumb');
    assertEqual(scrub.commit(4_000, 0), false, 'a refused seek reports no operation');
    assertEqual(seeks.length, 1, 'the finite seek was offered once');
    assert(!scrub.holds(0, 1), 'a refused seek does not hold the thumb');
    assertEqual(scrub.commit(Number.NaN, 0), false, 'a commit with no position seeks nowhere');
    scrub = createSeekScrub({ seek: () => true });
    scrub.input();
    scrub.commit(4_000, 0);
    assert(scrub.holds(Number.NaN, 1_500), 'an unreadable position keeps the commit');
    assert(scrub.holds(0, Number.NaN), 'an unreadable time keeps the commit');
  });
}
