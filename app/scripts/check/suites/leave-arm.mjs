// The leave arm passes on three exercised runs that each show the leave.

import { assertEqual, check } from '../harness.mjs';
import { leaveArmReading } from '../../figures/roster-event.mjs';

const run = (k1, k3) => [...(k1 ? [{ row: 'K1', status: k1 }] : []), ...(k3 ? [{ row: 'K3', status: k3 }] : [])];
const shownRun = () => run('met', 'met');

export default async function leaveArmSuite() {
  await check('leave-arm: three exercised runs that show the leave pass', async () => {
    const reading = leaveArmReading({ runs: [shownRun(), shownRun(), shownRun()] });
    assertEqual(reading.status, 'pass', 'three shown runs pass');
    assertEqual(reading.shownCount, 3, 'all three show it');
    assertEqual(reading.unread, 0, 'none is unread');
  });

  await check('leave-arm: an exercised run whose K1 is unreadable is unread and does not count toward three', async () => {
    const reading = leaveArmReading({ runs: [shownRun(), shownRun(), run('unreadable', 'met')] });
    assertEqual(reading.status, 'not-established', 'two shown and one unread is not established');
    assertEqual(reading.exercisedCount, 3, 'the unread run is exercised');
    assertEqual(reading.shownCount, 2, 'two show it');
    assertEqual(reading.unread, 1, 'one is unread');
    assertEqual(reading.exercised[2].k1, 'unreadable', 'its statuses are kept');
    assertEqual(leaveArmReading({ runs: [shownRun(), shownRun(), run('met', 'evidence-failure')] }).unread, 1, 'a K3 evidence failure is unread');
    assertEqual(leaveArmReading({ runs: [shownRun(), shownRun(), run('met', null)] }).unread, 1, 'an absent K3 row is unread');
    assertEqual(leaveArmReading({ runs: [shownRun(), shownRun(), shownRun(), run('unreadable', 'met')] }).status, 'pass', 'a fourth run that shows it after three cannot undo the pass');
  });

  await check('leave-arm: a missed K1 or K3 fails the arm', async () => {
    assertEqual(leaveArmReading({ runs: [shownRun(), run('met', 'missed')] }).status, 'fail', 'a missed K3 fails');
    assertEqual(leaveArmReading({ runs: [shownRun(), run('missed', 'met')] }).status, 'fail', 'a missed K1 fails');
    assertEqual(leaveArmReading({ runs: [shownRun(), shownRun(), shownRun(), run('missed', 'met')] }).status, 'fail', 'a failure beside three shown runs still fails');
  });

  await check('leave-arm: a run whose K3 is not exercised is not counted, whatever its K1', async () => {
    const reading = leaveArmReading({ runs: [run('evidence-failure', 'not-exercised'), shownRun()] });
    assertEqual(reading.exercisedCount, 1, 'only the exercised run counts');
    assertEqual(reading.unread, 0, 'the unexercised run is not unread');
    assertEqual(reading.status, 'not-established', 'one run is not three');
  });

  await check('leave-arm: only the first five runs are read and the comparand stalls are kept', async () => {
    const reading = leaveArmReading({ runs: [run('unreadable', 'met'), run('unreadable', 'met'), run('unreadable', 'met'), run('unreadable', 'met'), run('unreadable', 'met'), run('missed', 'met')],
      comparands: [{ directory: 'drop', stalls: { c01: [{ startMs: 2000 }] } }] });
    assertEqual(reading.exercisedCount, 5, 'a sixth run is not read');
    assertEqual(reading.status, 'not-established', 'so its miss does not fail the arm');
    assertEqual(reading.comparandStalls[0].stalls.c01[0].startMs, 2000, 'the comparand\'s stall is carried');
  });
}
