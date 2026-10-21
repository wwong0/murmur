import { assert, assertEqual, check } from '../harness.mjs';
import { playerKey } from '../../../public/lib/player-keys.mjs';

const base = { repeat: false, ctrlKey: false, altKey: false, metaKey: false, focus: 'none' };
const actions = {
  ' ': 'toggle-play', k: 'toggle-play', K: 'toggle-play', j: 'back-10', J: 'back-10',
  l: 'forward-10', L: 'forward-10', ArrowLeft: 'back-5', ArrowRight: 'forward-5',
  m: 'mute', M: 'mute', ArrowUp: 'volume-up', ArrowDown: 'volume-down',
  f: 'fullscreen', F: 'fullscreen', t: 'theatre', T: 'theatre',
};

export default async function playerKeysSuite() {
  await check('player-keys: every standard key maps to its action and prevents default', async () => {
    for (const [key, action] of Object.entries(actions)) {
      assertEqual(JSON.stringify(playerKey({ ...base, key })), JSON.stringify({ action, prevent: true }), `${key} mapping`);
    }
    assertEqual(playerKey({ ...base, key: 'Enter' }), null, 'Enter is not a player shortcut');
  });

  await check('player-keys: modifiers and text or dialog focus disable every action', async () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      for (const key of Object.keys(actions)) assertEqual(playerKey({ ...base, key, [modifier]: true }), null, `${modifier} blocks ${key}`);
    }
    for (const focus of ['text', 'dialog']) {
      for (const key of Object.keys(actions)) assertEqual(playerKey({ ...base, key, focus }), null, `${focus} blocks ${key}`);
    }
  });

  await check('player-keys: native button and range keys keep their own behavior', async () => {
    for (const key of [' ', 'Enter']) assertEqual(playerKey({ ...base, key, focus: 'button' }), null, `${key} stays with a button`);
    assertEqual(playerKey({ ...base, key: 'k', focus: 'button' }).action, 'toggle-play', 'K acts on a button');
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assertEqual(playerKey({ ...base, key, focus: 'range' }), null, `${key} stays with a range`);
    assertEqual(playerKey({ ...base, key: 'k', focus: 'range' }).action, 'toggle-play', 'K acts on a range');
  });

  await check('player-keys: held shortcuts prevent repeat operations except volume', async () => {
    for (const [key, action] of Object.entries(actions)) {
      const result = playerKey({ ...base, key, repeat: true });
      if (action === 'volume-up' || action === 'volume-down') assertEqual(result.action, action, `${key} repeats volume`);
      else assertEqual(JSON.stringify(result), JSON.stringify({ action: null, prevent: true }), `${key} does not repeat`);
    }
  });
}
