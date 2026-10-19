import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { ChartNoAxesColumn, ChevronDown, Link, Settings } from 'lucide-react';
import { createSeekScrub } from '../lib/seek-scrub.mjs';
import { namePromptDue } from '../lib/name-prompt.mjs';
import { joinTarget } from '../lib/route.mjs';
import { Button, DialogPanel, IconButton, PopoverPanel, SegmentedControl, TextField } from './ui.jsx';

const NAME_PROMPTED_KEY = 'watchalong.name-prompted';
const COPIED_MS = 2_000;
const HEADER_CHIPS = 4;
const PINNED_SLACK_PX = 24;
const CONTROL_MODES = [
  { value: 'open', label: 'Everyone', 'data-mode': 'open' },
  { value: 'host', label: 'Host only', 'data-mode': 'host' },
];

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

// The join keeps the tab, so this flag outlives the navigation and the invite page skips
// its name prompt (design.md D19). Joining must not depend on storage being writable.
function markNamePrompted() {
  try {
    sessionStorage.setItem(NAME_PROMPTED_KEY, '1');
  } catch {
    // The prompt shows later; the join goes ahead.
  }
}

// Writes the flag before it answers, so a reload shows nothing. Storage that throws is "not
// due": a prompt that could not record itself would come back on every reload.
function takeNamePrompt() {
  try {
    if (!namePromptDue(location.search, sessionStorage.getItem(NAME_PROMPTED_KEY))) return false;
    sessionStorage.setItem(NAME_PROMPTED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

// Calls no action and holds nothing up: the engine has joined behind it (design.md D19). Its
// field keeps nothing. Focus is left alone on close, so a driver's next click lands as it
// would have with no prompt.
function NamePrompt() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (takeNamePrompt()) setOpen(true);
  }, []);
  const close = (event) => {
    event.preventDefault();
    setOpen(false);
  };
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <DialogPanel id="name-prompt" finalFocus={false}>
      <Dialog.Title className="dialog-title">Choose a name</Dialog.Title>
      <form onSubmit={close}>
        <TextField id="name-prompt-field" label="Your name" placeholder="Your name" size="lg" autoComplete="off" />
        <Button type="submit" variant="primary" size="lg" className="mt-3 w-full">Join</Button>
      </form>
    </DialogPanel>
  </Dialog.Root>;
}

function Front({ view, actions }) {
  const input = useRef(null);
  const joinError = useView(view, (snapshot) => snapshot.joinError);
  const join = () => {
    const text = input.current?.value ?? '';
    if (joinTarget(text) !== null) markNamePrompted();
    actions.join(text);
  };
  return <div className="front" id="front">
    <div className="mx-auto flex w-full max-w-[34rem] flex-col">
      <h1 className="m-0 text-center text-[4.5rem] font-bold leading-none tracking-[-0.03em] text-ink">Uni<span className="text-accent">sono</span></h1>
      <p className="mb-10 mt-4 text-center text-[1.75rem] text-secondary">Watch together, in sync.</p>
      <TextField id="front-name" label="Your name" placeholder="Your name" size="xl" autoComplete="off" />
      <Button id="host" variant="primary" size="xl" className="mt-3 w-full" onClick={actions.host}>Host a room</Button>
      <div className="or-divider my-6">or</div>
      <div className="flex gap-3">
        <TextField
          ref={input}
          id="join-input"
          label="Invite link"
          placeholder="Paste an invite link"
          size="xl"
          autoComplete="off"
          className="min-w-0 flex-1"
          aria-invalid={joinError ? 'true' : undefined}
          aria-describedby="join-error"
        />
        <Button id="join" size="xl" className="shrink-0" onClick={join}>Join</Button>
      </div>
      <div id="join-error" aria-live="polite" className="mt-3 min-h-5 text-sm text-warning">{joinError}</div>
    </div>
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

// The popup mounts only while open. The group is the engine's `control-mode` entry: a viewer
// sees it disabled with the current mode pressed (design.md D11).
function SettingsMenu({ view, actions }) {
  const mode = useView(view, (snapshot) => snapshot.controlMode);
  const disabled = useView(view, (snapshot) => snapshot.controls['control-mode'].disabled);
  return <Popover.Root>
    <Popover.Trigger id="settings" render={<IconButton icon={Settings} label="Settings" aria-label="Settings" className="icon-btn-chip" />} />
    <PopoverPanel align="end">
      <div id="control-mode-label" className="popover-label">Who can control</div>
      <SegmentedControl
        id="control-mode"
        aria-labelledby="control-mode-label"
        options={CONTROL_MODES}
        value={mode}
        disabled={disabled}
        onChange={actions.controlMode}
      />
    </PopoverPanel>
  </Popover.Root>;
}

function RoomHeader({ view, actions }) {
  return <header className="room-header">
    <span className="text-[1.75rem] font-bold leading-none tracking-[-0.03em]" data-testid="wordmark">Uni<span className="text-accent">sono</span></span>
    <SettingsMenu view={view} actions={actions} />
  </header>;
}

// Portalled into the static #player, over the video. Its text is exactly the name or
// nothing: N1 reads it.
function TitleName({ view }) {
  const title = useView(view, (snapshot) => snapshot.title);
  const player = document.getElementById('player');
  if (!player) return null;
  return createPortal(<div id="title-name">{title.name ?? ''}</div>, player);
}

function RoomActions({ view, actions }) {
  const invite = useView(view, (snapshot) => snapshot.invite);
  const overlayVisible = useView(view, (snapshot) => snapshot.overlayVisible);
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // `preventDefault` first: the anchor's href is what a driver reads, and following it would
  // reload the room.
  const copy = async (event) => {
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(invite.href);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return <div className="room-actions">
    <Button id="stats" onClick={actions.stats} aria-expanded={overlayVisible} aria-controls="stats-panel">
      <ChartNoAxesColumn size={20} strokeWidth={2} aria-hidden="true" />
      <span>Stats</span>
    </Button>
    <a id="invite" href={invite.href} className="btn btn-primary" onClick={copy}>
      <Link size={20} strokeWidth={2} aria-hidden="true" />
      <span aria-live="polite">{copied ? 'Copied' : 'Copy invite link'}</span>
    </a>
  </div>;
}

// The file chooser and a refusal's command keep their ids, texts and `hidden` rule: drivers
// set #host-file's files and click #file-copy by id.
function HostFileControls({ view, actions }) {
  const hostFile = useView(view, (snapshot) => snapshot.hostFile);
  const help = hostFile.help;
  const player = document.getElementById('player');
  if (!player) return null;
  return createPortal(<div className="file-state" hidden={hostFile.inputHidden && !help}>
    <div className="file-card">
      <input type="file" id="host-file" hidden={hostFile.inputHidden} onChange={(event) => actions.chooseHostFile(event.target.files?.[0])} />
      <div id="file-reason">{help?.reason ?? ''}</div>
      {help?.command ? <>
        <code id="file-command">{help.command}</code>
        <Button id="file-copy" onClick={actions.copyFile}>Copy</Button>
        <div id="file-note">{help.note}</div>
      </> : null}
    </div>
  </div>, player);
}

// Mounted always: closed it is `hidden` and every readout stays current by `textContent`
// (diagnostics → The overlay is shown on request and always readable). `#overlay` follows
// the panel through the same value.
function StatsPanel({ view }) {
  const hostFile = useView(view, (snapshot) => snapshot.hostFile);
  const status = useView(view, (snapshot) => snapshot.status);
  const hostStatus = useView(view, (snapshot) => snapshot.hostStatus);
  const roster = useView(view, (snapshot) => snapshot.roster);
  const overlayVisible = useView(view, (snapshot) => snapshot.overlayVisible);
  const notice = hostFile.notice;
  return <section id="stats-panel" className="stats-panel" aria-label="Stats" hidden={!overlayVisible}>
    <div className="stats-body">
      <div id="overlay" hidden={!overlayVisible}>
        <OverlayLine view={view} id="clock-line" name="clock" />
        <OverlayLine view={view} id="drift-line" name="drift" />
        <OverlayLine view={view} id="bytes-line" name="bytes" />
        <OverlayLine view={view} id="controller-line" name="controller" />
      </div>
      <div id="status-line">{status}</div>
      <div id="host-file-status">{hostFile.status}</div>
      <div id="keyframe-notice">{notice ? `${notice.text}: ${notice.command}` : ''}</div>
      <div
        id="host-preparing"
        data-state={hostStatus.state}
        data-fraction={hostStatus.fraction ?? ''}
        data-received={hostStatus.received}
        data-last-at={hostStatus.lastAtMs ?? ''}
        data-disbelieved={hostStatus.disbelieved}
      >
        {hostStatus.state === 'preparing'
          ? `the host is preparing the video · ${Math.floor(hostStatus.fraction * 100)} %`
          : hostStatus.state === 'choosing' ? 'the host is choosing a video'
            : hostStatus.state === 'absent' ? 'the host has left' : ''}
      </div>
      <h3 className="stats-caption">roster</h3>
      <ul id="roster">{roster.map((member, index) => <li key={index}>{member}</li>)}</ul>
      <h3 className="stats-caption">notices</h3>
      <Notices view={view} />
    </div>
  </section>;
}

// Initials only: the chip is a picture of the member, and the label beside it (or the header's
// own text) is what a screen reader gets. The host's chip carries the accent ring.
function MemberChip({ person, size }) {
  return <span className={clsx('member-chip', size === 'sm' && 'member-chip-sm', person.host && 'member-chip-host')} aria-hidden="true">{person.initial}</span>;
}

function ParticipantsChips({ people }) {
  const shown = people.slice(0, HEADER_CHIPS);
  const more = people.length - shown.length;
  return <span className="participants-chips" aria-hidden="true">
    {shown.map((person, index) => (
      <span key={person.clientId} className="participants-chip-slot" style={{ zIndex: HEADER_CHIPS - index }}>
        <MemberChip person={person} size="sm" />
      </span>
    ))}
    {more > 0 ? <span className="member-chip member-chip-sm member-chip-more">+{more}</span> : null}
  </span>;
}

function ParticipantsList({ people }) {
  return <ul className="participants-list">
    {people.map((person) => (
      <li key={person.clientId} className="participant">
        <MemberChip person={person} />
        <span className="participant-label">{person.label}</span>
        {person.host ? <span className="host-tag">host</span> : null}
      </li>
    ))}
  </ul>;
}

// Newest line last. A reader who scrolled up to older lines keeps their place; one at the
// bottom stays there as lines arrive, and as the region resizes when the participants open.
function ActivityLog({ view }) {
  const activity = useView(view, (snapshot) => snapshot.activity);
  const ref = useRef(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (pinned.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [activity]);
  useLayoutEffect(() => {
    const element = ref.current;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const track = (event) => {
    const element = event.currentTarget;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_SLACK_PX;
  };
  return <div ref={ref} className="room-activity" role="log" aria-label="Activity" onScroll={track}>
    {activity.map((entry) => <p key={entry.id} className={clsx('activity-line', entry.warn && 'activity-warn')}>{entry.text}</p>)}
  </div>;
}

// In no form and with no handler: Enter does nothing, and the text stays where it was typed
// (design.md D19).
function MessageInput() {
  return <TextField id="message-input" label="Message the room" placeholder="Message the room" autoComplete="off" />;
}

// The right column: the participants' disclosure, the activity region, then the message
// input. The column's height and the activity region's scrolling are in room.css.
function RoomColumn({ view }) {
  const people = useView(view, (snapshot) => snapshot.people);
  return <aside className="room-column" aria-label="Room">
    <Collapsible.Root className="participants">
      <Collapsible.Trigger className="participants-trigger">
        <span className="participants-title">Participants · {people.length}</span>
        <ParticipantsChips people={people} />
        <ChevronDown className="participants-chevron" size={20} strokeWidth={2} aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="participants-panel">
        <ParticipantsList people={people} />
      </Collapsible.Panel>
    </Collapsible.Root>
    <ActivityLog view={view} />
    <div className="room-compose"><MessageInput /></div>
  </aside>;
}

function PlayerBar({ view, actions }) {
  const ref = useRef(null);
  const seekRef = useRef(null);
  const timeRef = useRef(null);
  const dotRef = useRef(null);
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
    }
    if (timeRef.current) timeRef.current.textContent = bar.time;
    if (dotRef.current) {
      dotRef.current.dataset.state = bar.syncDot.state;
      dotRef.current.title = bar.syncDot.title;
    }
  }, [bar]);
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
  const player = document.getElementById('player');
  if (!player) return null;
  return createPortal(<div ref={ref} id="control-bar" className="player-bar">
    <div className="bar-controls">
      <ImperativeButton view={view} actions={actions} id="play" action="play" />
      <ImperativeButton view={view} actions={actions} id="pause" action="pause" />
      <input ref={seekRef} id="seek" type="range" min="0" step="1" onInput={() => scrub.current.input()} />
      <span id="time" ref={timeRef} />
      <ImperativeButton view={view} actions={actions} id="back-10" action="back10" />
      <ImperativeButton view={view} actions={actions} id="forward-10" action="forward10" />
      <ImperativeButton view={view} actions={actions} id="mute" action="mute" />
      <input id="volume" type="range" min="0" max="1" step="0.01" defaultValue="1" onInput={(event) => actions.volume(event.currentTarget.value)} />
      <button id="fullscreen" type="button" onClick={actions.fullscreen}>fullscreen</button>
      <span ref={dotRef} id="sync-dot" data-state={bar.syncDot.state} title={bar.syncDot.title} />
    </div>
  </div>, player);
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
    <RoomHeader view={view} actions={actions} />
    <NamePrompt />
    <TitleName view={view} />
    <HostFileControls view={view} actions={actions} />
    <PlayerBar view={view} actions={actions} />
    <RoomActions view={view} actions={actions} />
    <StatsPanel view={view} />
    <RoomColumn view={view} />
  </>;
}

export function mountScreens({ view, actions }) {
  const root = createRoot(document.getElementById('screens'));
  flushSync(() => root.render(<RoomScreens view={view} actions={actions} />));
}
