import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';

function useView(view, select) {
  return useSyncExternalStore(
    (onChange) => view.subscribe(() => onChange()),
    () => select(view.get()),
    () => select(view.get()),
  );
}

function ImperativeButton({ view, actions, id, action }) {
  const ref = useRef(null);
  const controls = useView(view, (snapshot) => snapshot.controls);
  const control = controls[id];
  useLayoutEffect(() => {
    const element = ref.current;
    element.textContent = control.text;
    element.disabled = control.disabled;
    element.hidden = control.hidden;
  }, [control]);
  useLayoutEffect(() => {
    const element = ref.current;
    const listener = actions[action];
    element.addEventListener('click', listener);
    return () => element.removeEventListener('click', listener);
  }, [actions, action]);
  return <button ref={ref} id={id} type="button" />;
}

function OverlayLine({ view, id, name }) {
  const ref = useRef(null);
  const overlay = useView(view, (snapshot) => snapshot.overlay);
  useLayoutEffect(() => {
    ref.current.textContent = overlay[name];
  }, [overlay, name]);
  return <div ref={ref} id={id} />;
}

function Notices({ view }) {
  const ref = useRef(null);
  const notices = useView(view, (snapshot) => snapshot.notices);
  useLayoutEffect(() => {
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [notices]);
  return <ul ref={ref} id="notices">{notices.map((notice) => (
    <li key={notice.seq} className={notice.warn ? 'gap' : undefined}>{notice.text}</li>
  ))}</ul>;
}

function Front({ view, actions }) {
  const input = useRef(null);
  const joinError = useView(view, (snapshot) => snapshot.joinError);
  return <div className="panel" id="front">
    <h2>watchalong</h2>
    <button id="host" type="button" onClick={actions.host}>Host</button>
    <label htmlFor="join-input">Join a room</label>
    <input ref={input} id="join-input" type="text" />
    <button id="join" type="button" onClick={() => actions.join(input.current?.value ?? '')}>Join</button>
    <div id="join-error">{joinError}</div>
  </div>;
}

function PlayerVisibility({ route }) {
  useLayoutEffect(() => {
    const player = document.getElementById('player');
    if (player) player.hidden = route === 'front';
  }, [route]);
  return null;
}

function EndedMarker({ view }) {
  const ended = useView(view, (snapshot) => snapshot.ended);
  useLayoutEffect(() => {
    const player = document.getElementById('player');
    if (!player) return;
    if (ended) player.dataset.ended = 'true';
    else delete player.dataset.ended;
  }, [ended]);
  return null;
}

function Controls({ view, actions }) {
  const invite = useView(view, (snapshot) => snapshot.invite);
  return <div className="panel">
    <h2>controls</h2>
    <div className="controls">
      <ImperativeButton view={view} actions={actions} id="control-mode" action="controlMode" />
    </div>
    <a id="invite" href={invite.href}>{invite.text}</a>
  </div>;
}

function PlayerBar({ view, actions }) {
  const ref = useRef(null);
  const seekRef = useRef(null);
  const timeRef = useRef(null);
  const dotRef = useRef(null);
  const bar = useView(view, (snapshot) => snapshot.bar);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) element.dataset.faded = bar.faded ? 'true' : 'false';
  }, [bar.faded]);
  useLayoutEffect(() => {
    const seek = seekRef.current;
    if (seek) {
      seek.disabled = bar.durationMs === null;
      seek.max = String(bar.durationMs ?? 0);
      seek.value = String(bar.positionMs);
    }
    if (timeRef.current) timeRef.current.textContent = bar.time;
    if (dotRef.current) {
      dotRef.current.dataset.state = bar.syncDot.state;
      dotRef.current.title = bar.syncDot.title;
    }
  }, [bar]);
  useLayoutEffect(() => {
    const player = document.getElementById('player');
    if (!player) return undefined;
    player.addEventListener('pointermove', actions.pointerMove);
    return () => player.removeEventListener('pointermove', actions.pointerMove);
  }, [actions]);
  const player = document.getElementById('player');
  if (!player) return null;
  return createPortal(<div ref={ref} id="control-bar" className="player-bar">
    <div className="bar-controls">
      <ImperativeButton view={view} actions={actions} id="play" action="play" />
      <ImperativeButton view={view} actions={actions} id="pause" action="pause" />
      <input ref={seekRef} id="seek" type="range" min="0" step="1" onInput={(event) => actions.seek(Number(event.currentTarget.value))} />
      <span id="time" ref={timeRef} />
      <ImperativeButton view={view} actions={actions} id="back-10" action="back10" />
      <ImperativeButton view={view} actions={actions} id="forward-10" action="forward10" />
      <ImperativeButton view={view} actions={actions} id="mute" action="mute" />
      <input id="volume" type="range" min="0" max="1" step="0.01" defaultValue="1" onInput={(event) => actions.volume(event.currentTarget.value)} />
      <button id="fullscreen" type="button" onClick={actions.fullscreen}>fullscreen</button>
      <button id="stats" type="button" onClick={actions.stats}>stats</button>
      <span ref={dotRef} id="sync-dot" data-state={bar.syncDot.state} title={bar.syncDot.title} />
    </div>
  </div>, player);
}

function Connection({ view, actions }) {
  const hostFile = useView(view, (snapshot) => snapshot.hostFile);
  const status = useView(view, (snapshot) => snapshot.status);
  const overlayVisible = useView(view, (snapshot) => snapshot.overlayVisible);
  const help = hostFile.help;
  const notice = hostFile.notice;
  return <div className="panel">
    <h2>connection</h2>
    <input type="file" id="host-file" hidden={hostFile.inputHidden} onChange={(event) => actions.chooseHostFile(event.target.files?.[0])} />
    <div id="host-file-status">{hostFile.status}</div>
    <div id="file-reason">{help?.reason ?? ''}</div>
    {help?.command ? <>
      <code id="file-command">{help.command}</code>
      <button id="file-copy" type="button" onClick={actions.copyFile}>Copy</button>
      <div id="file-note">{help.note}</div>
    </> : null}
    <div id="keyframe-notice">{notice ? `${notice.text}: ${notice.command}` : ''}</div>
    <div id="status-line">{status}</div>
    <div id="overlay" hidden={!overlayVisible}>
      <OverlayLine view={view} id="clock-line" name="clock" />
      <OverlayLine view={view} id="drift-line" name="drift" />
      <OverlayLine view={view} id="bytes-line" name="bytes" />
      <OverlayLine view={view} id="controller-line" name="controller" />
    </div>
  </div>;
}

function Roster({ view }) {
  const roster = useView(view, (snapshot) => snapshot.roster);
  return <div className="panel">
    <h2>roster</h2>
    <ul id="roster">{roster.map((member, index) => <li key={index}>{member}</li>)}</ul>
  </div>;
}

export function RoomScreens({ view, actions }) {
  const route = useView(view, (snapshot) => snapshot.route);
  if (route === 'front') {
    return <>
      <PlayerVisibility route={route} />
      <Front view={view} actions={actions} />
    </>;
  }
  return <>
    <PlayerVisibility route={route} />
    <EndedMarker view={view} />
    <Controls view={view} actions={actions} />
    <Connection view={view} actions={actions} />
    <Roster view={view} />
    <div className="panel">
      <h2>notices</h2>
      <Notices view={view} />
    </div>
    <PlayerBar view={view} actions={actions} />
  </>;
}

export function mountScreens({ view, actions }) {
  const root = createRoot(document.getElementById('screens'));
  flushSync(() => root.render(<RoomScreens view={view} actions={actions} />));
}
