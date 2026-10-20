import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '@base-ui/react/tooltip';
import { Maximize, Pause, Play, RectangleHorizontal, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react';
import { createSeekScrub } from '../lib/seek-scrub.mjs';
import { syncWords } from '../lib/sync-words.mjs';
import { swallowTouch } from '../lib/touch-reveal.mjs';
import { inPlayer } from './in-player.js';
import { IconButton } from './ui.jsx';
import { useView } from './use-view.js';

// An engine button's icon, chosen from its own text: the title's end puts a replay arrow in the
// play slot, and a muted page shows the muted speaker. `skip-10` is the class whose generated
// content draws the "10" (room.css).
const LOOKS = {
  play: (control) => (control.text === 'Watch again' ? { icon: RotateCcw } : { icon: Play, filled: true }),
  pause: () => ({ icon: Pause, filled: true }),
  'back-10': () => ({ icon: RotateCcw, iconClassName: 'skip-10' }),
  'forward-10': () => ({ icon: RotateCw, iconClassName: 'skip-10' }),
  mute: (control) => ({ icon: control.text === 'unmute' ? VolumeX : Volume2 }),
};

// The engine's text goes in the label span, never the button: the icon is its sibling, and the
// button's textContent must stay the engine's text alone (survey 1.2). `slot` names the one of
// `#play`/`#pause` the bar shows; the other keeps its text, `disabled` and handler under `hidden`
// (design.md D8), and carries no display class that would override it.
function BarButton({ view, actions, id, action, slot }) {
  const ref = useRef(null);
  const labelRef = useRef(null);
  const control = useView(view, (snapshot) => snapshot.controls[id]);
  const playSlot = useView(view, (snapshot) => snapshot.playSlot);
  useLayoutEffect(() => {
    labelRef.current.textContent = control.text;
    ref.current.disabled = control.disabled;
    ref.current.hidden = control.hidden || (slot !== undefined && slot !== playSlot);
  }, [control, slot, playSlot]);
  useLayoutEffect(() => {
    const element = ref.current;
    const listener = actions[action];
    element.addEventListener('click', listener);
    return () => element.removeEventListener('click', listener);
  }, [actions, action]);
  return <IconButton ref={ref} labelRef={labelRef} id={id} size="bar" {...LOOKS[id](control)} />;
}

// A native range paints no played part, so the stylesheet reads it from `--fraction`.
function paintRange(range) {
  const max = Number(range.max);
  const fraction = max > 0 ? Math.min(1, Math.max(0, Number(range.value) / max)) : 0;
  range.style.setProperty('--fraction', String(fraction));
}

// Focusable, so keyboard focus opens the tooltip as hover does. It carries `hidden` only while no
// title is loaded, and no display of its own. The `title` stays: drivers read it (sync-dot.mjs).
function SyncDot({ view, container }) {
  const bar = useView(view, (snapshot) => snapshot.bar);
  const { state, title } = bar.syncDot;
  const lines = syncWords({ state, estimateMs: bar.syncEstimateMs, playing: bar.syncPlaying });
  return <Tooltip.Root disabled={lines.length === 0}>
    <Tooltip.Trigger render={<span id="sync-dot" role="img" aria-label="Sync status" tabIndex={0} data-state={state} title={title} hidden={!bar.syncShown} />} />
    <Tooltip.Portal container={container}>
      <Tooltip.Positioner className="popover-positioner" side="bottom" align="end" sideOffset={8}>
        <Tooltip.Popup className="tooltip">
          {lines.map((line, index) => <div key={index} className={index === 0 ? 'tooltip-head' : 'tooltip-sub'}>{line}</div>)}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}

// The tooltip portals into the player, not body: a body popup is hidden behind a fullscreen
// player. `#title-name`'s text is exactly the name or nothing: N1 reads it. `chips` are
// theatre's; the dot stays the last item, top-right.
export function PlayerTop({ view, chips }) {
  const title = useView(view, (snapshot) => snapshot.title);
  const player = document.getElementById('player');
  if (!player) return null;
  return createPortal(<div className="player-top">
    <div id="title-name">{title.name ?? ''}</div>
    <div className="player-top-end">
      {chips}
      <SyncDot view={view} container={player} />
    </div>
  </div>, player);
}

export function PlayerBar({ view, actions, theatre, onTheatre }) {
  const ref = useRef(null);
  const seekRef = useRef(null);
  const volumeRef = useRef(null);
  const timeRef = useRef(null);
  const scrub = useRef(null);
  if (!scrub.current) scrub.current = createSeekScrub({ seek: (positionMs) => actions.seek(positionMs) });
  const bar = useView(view, (snapshot) => snapshot.bar);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) element.dataset.faded = bar.faded ? 'true' : 'false';
  }, [bar.faded]);
  useLayoutEffect(() => {
    const seek = seekRef.current;
    if (seek) {
      seek.disabled = bar.durationMs === null || bar.preparing;
      seek.max = String(bar.durationMs ?? 0);
      if (!scrub.current.holds()) seek.value = String(bar.positionMs);
      paintRange(seek);
    }
    if (timeRef.current) timeRef.current.textContent = bar.time;
  }, [bar]);
  useLayoutEffect(() => {
    if (volumeRef.current) paintRange(volumeRef.current);
  }, []);
  useLayoutEffect(() => {
    const seek = seekRef.current;
    if (!seek) return undefined;
    const commit = () => scrub.current.commit(Number(seek.value));
    const release = () => scrub.current.release();
    seek.addEventListener('change', commit);
    seek.addEventListener('pointerup', release);
    seek.addEventListener('pointercancel', release);
    return () => {
      seek.removeEventListener('change', commit);
      seek.removeEventListener('pointerup', release);
      seek.removeEventListener('pointercancel', release);
    };
  }, []);
  useLayoutEffect(() => {
    const player = document.getElementById('player');
    if (!player) return undefined;
    player.addEventListener('pointermove', actions.pointerMove);
    return () => player.removeEventListener('pointermove', actions.pointerMove);
  }, [actions]);
  // Capture phase, on the bar, so the swallowed tap's click never reaches the control under it.
  // The flag is rewritten by every pointerdown: a tap that never produced a click cannot make a
  // later mouse click vanish.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let swallowed = false;
    const down = (event) => {
      swallowed = swallowTouch({ pointerType: event.pointerType, faded: view.get().bar.faded });
      if (swallowed) actions.pointerMove();
    };
    const click = (event) => {
      if (!swallowed) return;
      swallowed = false;
      event.stopPropagation();
      event.preventDefault();
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('click', click, true);
    };
  }, [view, actions]);
  return inPlayer(<div ref={ref} id="control-bar" className="player-bar">
    <input ref={seekRef} id="seek" className="range" type="range" min="0" step="1" onInput={(event) => {
      scrub.current.input();
      paintRange(event.currentTarget);
    }} />
    <div className="bar-row">
      <div className="bar-group">
        <BarButton view={view} actions={actions} id="play" action="play" slot="play" />
        <BarButton view={view} actions={actions} id="pause" action="pause" slot="pause" />
        <BarButton view={view} actions={actions} id="back-10" action="back10" />
        <BarButton view={view} actions={actions} id="forward-10" action="forward10" />
        <BarButton view={view} actions={actions} id="mute" action="mute" />
        <input ref={volumeRef} id="volume" className="range" type="range" min="0" max="1" step="0.01" defaultValue="1" onInput={(event) => {
          actions.volume(event.currentTarget.value);
          paintRange(event.currentTarget);
        }} />
        <span id="time" ref={timeRef} />
      </div>
      <div className="bar-group">
        <IconButton id="theatre" icon={RectangleHorizontal} size="bar" label="theatre" aria-pressed={theatre} onClick={onTheatre} />
        <IconButton id="fullscreen" icon={Maximize} size="bar" label="fullscreen" onClick={actions.fullscreen} />
      </div>
    </div>
  </div>);
}
