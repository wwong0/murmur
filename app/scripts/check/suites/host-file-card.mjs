import { assertEqual, check } from '../harness.mjs';
import { CHOOSABLE_STATES } from '../../../public/lib/host-file-source.mjs';
import { fileCard } from '../../../public/lib/host-file-card.mjs';

const CHOOSE = 'Choose a video to watch';
const CHOOSE_NOTE = 'MP4 from your computer. It stays on your device.';
const WAITING = { kind: 'choosing', icon: 'video', title: CHOOSE, note: CHOOSE_NOTE, button: 'Getting ready…' };
const CASES = [
  ['starting', WAITING],
  ['awaiting-file', { ...WAITING, button: 'Choose file' }],
  ['refused', { kind: 'status', icon: 'warn', title: "This file can't be played in the browser", note: null, button: 'Choose another file' }],
  ['failed', { kind: 'status', icon: 'warn', title: 'This file could not be prepared', note: 'Choose it again, or pick another file. The details are in Stats.', button: 'Choose another file' }],
  ['inspecting', WAITING],
  ['ready', WAITING],
  ['off', WAITING],
  ['not-a-state', WAITING],
  [undefined, WAITING],
];

export default async function hostFileCardSuite() {
  await check('host-file-card: each state gives its kind, icon, title, note and button, and no percent', async () => {
    for (const [state, expected] of CASES) {
      const card = fileCard(state, 0.5);
      for (const field of ['kind', 'icon', 'title', 'note', 'button']) assertEqual(card[field], expected[field], `${state} ${field}`);
      assertEqual(card.percent, null, `${state} percent`);
    }
  });

  await check('host-file-card: preparing reports its percent and offers no button', async () => {
    const card = fileCard('preparing', 0.427);
    assertEqual(card.kind, 'status', 'preparing kind');
    assertEqual(card.icon, null, 'preparing has no icon');
    assertEqual(card.title, 'Preparing · 42%', 'preparing title carries the floored percent');
    assertEqual(card.percent, 42, 'preparing percent');
    assertEqual(card.note, 'Your friends will see the video when this finishes.', 'preparing note');
    assertEqual(card.button, null, 'preparing offers no button');
    assertEqual(fileCard('preparing', null).title, 'Preparing · 0%', 'no fraction reads as 0%');
    assertEqual(fileCard('preparing', 1.5).percent, 100, 'a fraction over one reads as 100%');
  });

  await check('host-file-card: every choosable state has a button to press', async () => {
    for (const state of CHOOSABLE_STATES) assertEqual(typeof fileCard(state).button, 'string', `${state} has a button`);
  });
}
