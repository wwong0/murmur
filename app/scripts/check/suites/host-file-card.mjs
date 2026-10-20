import { assertEqual, check } from '../harness.mjs';
import { CHOOSABLE_STATES } from '../../../public/lib/host-file-source.mjs';
import { fileCard } from '../../../public/lib/host-file-card.mjs';

const CHOOSE = 'Choose a video to watch';
const WAITING = { title: CHOOSE, button: 'Getting ready…' };
const CASES = [
  ['starting', WAITING],
  ['awaiting-file', { title: CHOOSE, button: 'Choose file' }],
  ['preparing', { title: 'Preparing', button: null }],
  ['refused', { title: "This file can't be played in the browser", button: 'Choose another file' }],
  ['failed', { title: 'This file could not be prepared', button: 'Choose another file' }],
  ['inspecting', WAITING],
  ['ready', WAITING],
  ['off', WAITING],
  ['not-a-state', WAITING],
  [undefined, WAITING],
];

export default async function hostFileCardSuite() {
  await check('host-file-card: each state gives its title and button, and enabled follows the source guard', async () => {
    for (const [state, expected] of CASES) {
      const card = fileCard(state);
      assertEqual(card.title, expected.title, `${state} title`);
      assertEqual(card.button, expected.button, `${state} button`);
      assertEqual(card.enabled, CHOOSABLE_STATES.includes(state), `${state} enabled`);
    }
  });

  await check('host-file-card: only a button that can be pressed is enabled, and preparing has none', async () => {
    for (const [state] of CASES) {
      const card = fileCard(state);
      if (card.enabled) assertEqual(typeof card.button, 'string', `${state} enabled card has a button`);
    }
    assertEqual(fileCard('preparing').button, null, 'preparing offers no button');
    assertEqual(fileCard('preparing').enabled, false, 'preparing is not choosable');
  });
}
