// The sync dot's tooltip lines (design.md D10), as a table.

import { assertEqual, check } from '../harness.mjs';
import { syncWords } from '../../../public/lib/sync-words.mjs';

const json = (value) => JSON.stringify(value);

export default async function syncWordsSuite() {
  await check('sync-words: a positive figure is ahead of the room and a negative one behind it', async () => {
    assertEqual(json(syncWords({ state: 'in-sync', estimateMs: 3 })), json(['In sync', '3 ms ahead of the room']), '+3');
    assertEqual(json(syncWords({ state: 'correcting', estimateMs: -52 })), json(['Catching up', '52 ms behind the room']), '-52');
  });

  await check('sync-words: zero and a figure that rounds to zero read ahead, never behind', async () => {
    assertEqual(syncWords({ state: 'in-sync', estimateMs: 0 })[1], '0 ms ahead of the room', 'zero');
    assertEqual(syncWords({ state: 'in-sync', estimateMs: -0.4 })[1], '0 ms ahead of the room', '-0.4 rounds to zero');
    assertEqual(syncWords({ state: 'in-sync', estimateMs: -0.6 })[1], '1 ms behind the room', '-0.6 rounds to one');
  });

  await check('sync-words: no figure gives the first line alone, and every state gives its own words', async () => {
    assertEqual(json(syncWords({ state: 'in-sync', estimateMs: null })), json(['In sync']), 'null estimate, in sync');
    assertEqual(json(syncWords({ state: 'correcting', estimateMs: Number.NaN })), json(['Catching up']), 'NaN estimate, correcting');
    assertEqual(syncWords({ state: 'in-sync', estimateMs: 1 })[0], 'In sync', 'in-sync');
    assertEqual(syncWords({ state: 'correcting', estimateMs: 1 })[0], 'Catching up', 'correcting');
  });

  await check('sync-words: idle and an unknown state give no lines, whatever the figure', async () => {
    assertEqual(json(syncWords({ state: 'idle', estimateMs: 12 })), '[]', 'idle with a figure');
    assertEqual(json(syncWords({ state: 'idle', estimateMs: null })), '[]', 'idle without one');
    assertEqual(json(syncWords({ state: 'later', estimateMs: 12 })), '[]', 'a state this module does not know');
    assertEqual(json(syncWords()), '[]', 'no argument');
  });
}
