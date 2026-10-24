import { useLayoutEffect, useRef } from 'react';
import { playerKey } from '../lib/player-keys.mjs';
import { clickActs } from '../lib/player-click.mjs';

// The player's own inputs (12e design.md D10): the keys, a click on the video and the context
// menu. Each acts through the control's own action and enabled state, as the bar's button does.

// The `focus` playerKey reads. An open popup is a dialog or menu role, not `[data-open]`: Base UI
// also marks an expanded participants list and a showing tooltip with it.
function eventFocus(target) {
  if (document.querySelector('[role="dialog"], [role="menu"]')) return 'dialog';
  const element = target?.closest?.('input, textarea, select, button, [contenteditable]') ?? target;
  const tag = element?.tagName?.toLowerCase();
  if (element?.isContentEditable || tag === 'textarea' || tag === 'select'
    || (tag === 'input' && !['range', 'button', 'checkbox'].includes(element.type))) return 'text';
  if (tag === 'input' && element.type === 'range') return 'range';
  if (tag === 'button' || element?.getAttribute?.('role') === 'button') return 'button';
  return 'none';
}

function togglePlayback(view, actions) {
  const { playSlot, controls } = view.get();
  if (clickActs(controls, playSlot)) actions[playSlot]();
}

// The four seeks share one enabled state: the entry gives back-10 and forward-10 the same rule.
const SEEK_MS = { 'back-10': -10_000, 'forward-10': 10_000, 'back-5': -5_000, 'forward-5': 5_000 };
const VOLUME_STEP = { 'volume-up': 0.05, 'volume-down': -0.05 };

function runKey(action, { view, actions, theatreShown, onTheatre, stepVolume }) {
  if (action in SEEK_MS) {
    if (view.get().controls['back-10']?.disabled === false) actions.seekBy(SEEK_MS[action]);
  } else if (action in VOLUME_STEP) {
    stepVolume(VOLUME_STEP[action]);
  } else if (action === 'toggle-play') {
    togglePlayback(view, actions);
  } else if (action === 'mute') {
    actions.mute();
  } else if (action === 'fullscreen') {
    actions.fullscreen();
  } else if (action === 'theatre' && theatreShown) {
    onTheatre();
  }
}

/** `stepVolume(delta)` moves the bar's volume range by `delta` and applies it. */
export function usePlayerInputs({ view, actions, theatreShown, onTheatre, stepVolume }) {
  // The latest props, so the listeners are added once rather than on every render of the bar.
  const latest = useRef(null);
  latest.current = { view, actions, theatreShown, onTheatre, stepVolume };

  useLayoutEffect(() => {
    const keydown = (event) => {
      const result = playerKey({
        key: event.key,
        repeat: event.repeat === true,
        ctrlKey: event.ctrlKey === true,
        altKey: event.altKey === true,
        metaKey: event.metaKey === true,
        focus: eventFocus(event.target ?? document.activeElement),
      });
      if (!result) return;
      if (result.prevent) event.preventDefault();
      if (result.action) runKey(result.action, latest.current);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);

  // A mouse click on the video toggles playback; a touch only reveals the bar.
  useLayoutEffect(() => {
    const video = document.getElementById('video');
    if (!video) return undefined;
    let pointerType = null;
    const down = (event) => { pointerType = event.pointerType; };
    const click = (event) => {
      if (event.target !== video) return;
      const { view: current, actions: currentActions } = latest.current;
      if (pointerType === 'touch') currentActions.pointerMove();
      else if (pointerType === 'mouse' || pointerType === 'pen') togglePlayback(current, currentActions);
      pointerType = null;
    };
    video.addEventListener('pointerdown', down);
    video.addEventListener('click', click);
    return () => {
      video.removeEventListener('pointerdown', down);
      video.removeEventListener('click', click);
    };
  }, []);

  // No browser menu on the player while a title is loaded.
  useLayoutEffect(() => {
    const player = document.getElementById('player');
    if (!player) return undefined;
    const contextmenu = (event) => {
      if (latest.current.view.get().bar.durationMs !== null) event.preventDefault();
    };
    player.addEventListener('contextmenu', contextmenu);
    return () => player.removeEventListener('contextmenu', contextmenu);
  }, []);
}
