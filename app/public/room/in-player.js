import { createPortal } from 'react-dom';

// The room's overlays render inside room.html's static `#player`, so a fullscreen player keeps
// them; a page without it renders none.
export function inPlayer(children) {
  const player = document.getElementById('player');
  return player ? createPortal(children, player) : null;
}
