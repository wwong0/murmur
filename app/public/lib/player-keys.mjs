const ACTIONS = {
  ' ': 'toggle-play',
  k: 'toggle-play',
  K: 'toggle-play',
  j: 'back-10',
  J: 'back-10',
  l: 'forward-10',
  L: 'forward-10',
  ArrowLeft: 'back-5',
  ArrowRight: 'forward-5',
  m: 'mute',
  M: 'mute',
  ArrowUp: 'volume-up',
  ArrowDown: 'volume-down',
  f: 'fullscreen',
  F: 'fullscreen',
  t: 'theatre',
  T: 'theatre',
};

const VOLUME_ACTIONS = new Set(['volume-up', 'volume-down']);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export function playerKey({ key, repeat, ctrlKey, altKey, metaKey, focus }) {
  if (ctrlKey || altKey || metaKey || focus === 'text' || focus === 'dialog') return null;
  if (focus === 'button' && (key === ' ' || key === 'Enter')) return null;
  if (focus === 'range' && ARROWS.has(key)) return null;
  const action = ACTIONS[key];
  if (action === undefined) return null;
  if (repeat && !VOLUME_ACTIONS.has(action)) return { action: null, prevent: true };
  return { action, prevent: true };
}
