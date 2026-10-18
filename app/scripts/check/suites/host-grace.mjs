import { assertEqual, check } from '../harness.mjs';
import { createHostGrace } from '../../../public/lib/host-grace.mjs';

export default async function hostGraceSuite() {
  await check('host-grace: a finite departure reaches the grace boundary only', async () => {
    const grace = createHostGrace({ graceMs: 2_000 });
    grace.observe({ hostPresent: false, atSharedMs: 1_000 });
    assertEqual(grace.due(2_999), null, 'grace is not due before its end');
    assertEqual(grace.due(3_000), 3_000, 'grace is due at its end');
    grace.observe({ hostPresent: false, atSharedMs: 2_000 });
    assertEqual(grace.snapshot().endsAtSharedMs, 3_000, 'a second absence does not restart the grace');
    grace.observe({ hostPresent: true, atSharedMs: 3_000 });
    assertEqual(grace.due(3_000), null, 'a returning host cancels the grace');
  });

  await check('host-grace: an unsynchronised departure anchors on its first finite tick', async () => {
    const grace = createHostGrace({ graceMs: 2_000 });
    grace.observe({ hostPresent: false, atSharedMs: NaN });
    assertEqual(JSON.stringify(grace.snapshot()), JSON.stringify({
      running: true,
      pending: true,
      startedAtSharedMs: null,
      endsAtSharedMs: null,
    }), 'pending snapshot keeps absent instants null');
    assertEqual(grace.due(Infinity), null, 'an infinite clock does not anchor the grace');
    assertEqual(grace.due(5_000), null, 'the first finite tick starts but does not skip the grace');
    assertEqual(JSON.stringify(grace.snapshot()), JSON.stringify({
      running: true,
      pending: false,
      startedAtSharedMs: 5_000,
      endsAtSharedMs: 7_000,
    }), 'finite tick anchors the pending start');
    assertEqual(grace.due(6_999), null, 'pending grace remains not due before its end');
    assertEqual(grace.due(7_000), 7_000, 'pending grace is due at its anchored end');
  });
}
