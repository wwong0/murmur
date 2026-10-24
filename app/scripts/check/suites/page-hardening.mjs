import { assert, assertEqual, check } from '../harness.mjs';
import { appendCapped } from '../../../public/lib/capped-list.mjs';
import { clickActs } from '../../../public/lib/player-click.mjs';
import { fileCard } from '../../../public/lib/host-file-card.mjs';
import { probeStorage } from '../../../public/lib/storage-probe.mjs';

export default async function pageHardeningSuite() {
  await check('page hardening: storage refusal is named without rejecting the probe', async () => {
    const refused = await probeStorage(async () => {
      const error = new Error('private window');
      error.name = 'SecurityError';
      throw error;
    });
    assertEqual(refused.ok, false, 'storage refusal is not okay');
    assertEqual(refused.name, 'SecurityError', 'storage refusal name');
    const available = await probeStorage(async () => undefined);
    assertEqual(available.ok, true, 'available storage is okay');
  });

  await check('page hardening: storage-refused card gives the normal-window remedy and no picker', async () => {
    const card = fileCard('storage-refused');
    assertEqual(card.title, 'Hosting needs storage this browser has turned off', 'storage title');
    assertEqual(card.note, 'Private windows turn it off. Open this room in a normal window to host.', 'storage note');
    assertEqual(card.button, null, 'storage refusal has no choose button');
    assert(!card.title.includes('could not be prepared'), 'storage refusal does not fall through to failed');
  });

  await check('page hardening: clicks act only when the selected control is explicitly enabled', async () => {
    assert(clickActs({ play: { disabled: false } }, 'play'), 'enabled play acts');
    for (const controls of [undefined, {}, { play: {} }, { play: { disabled: true } }]) {
      assert(!clickActs(controls, 'play'), 'missing or disabled play does not act');
    }
  });

  await check('page hardening: notices keep only the last capped entries in order', async () => {
    assertEqual(appendCapped([1, 2, 3], 4, 2).join(','), '3,4', 'capped list keeps the newest entries');
    assertEqual(appendCapped([], 1, 0).length, 0, 'zero cap keeps no entries');
  });
}
