import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { ChartNoAxesColumn, ChevronDown, FileVideo, Link, Settings, TriangleAlert } from 'lucide-react';
// The caps as `maxLength`: UTF-16 units are never fewer than code points, so never looser.
import { CHAT_MAX_CODE_POINTS, NAME_MAX_CODE_POINTS } from '../lib/envelope.mjs';
import { fileCard } from '../lib/host-file-card.mjs';
import { namePromptDue } from '../lib/name-prompt.mjs';
import { flipKeyframes } from '../lib/theatre-flip.mjs';
import { PlayerBar, PlayerTop } from './player-bar.jsx';
import { inPlayer } from './in-player.js';
import { EndedCard, ReconnectPill, ViewerWait } from './player-states.jsx';
import { Front } from './front.jsx';
import { Button, DialogPanel, IconButton, PopoverPanel, SegmentedControl, TextField } from './ui.jsx';
import { useView } from './use-view.js';

const NAME_PROMPTED_KEY = 'watchalong.name-prompted';
const THEATRE_KEY = 'watchalong.theatre';
const COPIED_MS = 2_000;
const HINT_VISIBLE_MS = 5_000;
const HINT_FADE_MS = 400;
const HEADER_CHIPS = 4;
const PINNED_SLACK_PX = 24;
const CARD_ICONS = {
  warn: { Icon: TriangleAlert, className: 'file-icon file-icon-warn' },
  video: { Icon: FileVideo, className: 'file-icon' },
};
const KEYFRAME_HINT = 'Skipping may land a little early in this file';
const CONTROL_MODES = [
  { value: 'open', label: 'Everyone', 'data-mode': 'open' },
  { value: 'host', label: 'Host only', 'data-mode': 'host' },
];

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

// Writes the flag before it answers, so a reload shows nothing. Storage that throws is "not
// due": a prompt that could not record itself would come back on every reload.
function takeNamePrompt(fromFront) {
  try {
    if (!namePromptDue(location.search, sessionStorage.getItem(NAME_PROMPTED_KEY), fromFront)) return false;
    sessionStorage.setItem(NAME_PROMPTED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

// Holds nothing up: the engine has joined behind it (design.md D19), and closing it unanswered
// leaves the member unnamed. Submitting hands the field to `setName`; the page keeps only the
// name the roster returns. Focus is left alone on close, so a driver's next click lands as it
// would have with no prompt. `fromFront` is read once, on mount: a host who pressed Host kept
// this document, and its rig-style URL says nothing about how they got here. The member's own
// participants entry asks for it again.
function NamePrompt({ view, actions, fromFront }) {
  const [open, setOpen] = useState(false);
  const field = useRef(null);
  const request = useView(view, (snapshot) => snapshot.namePromptRequest);
  const ownName = useView(view, (snapshot) => snapshot.ownName);
  useEffect(() => {
    if (takeNamePrompt(fromFront)) setOpen(true);
  }, []);
  useEffect(() => {
    if (request > 0) setOpen(true);
  }, [request]);
  const submit = (event) => {
    event.preventDefault();
    actions.setName(field.current?.value ?? '');
    setOpen(false);
  };
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <DialogPanel id="name-prompt" finalFocus={false}>
      <Dialog.Title className="dialog-title">Choose a name</Dialog.Title>
      <form onSubmit={submit}>
        <TextField ref={field} id="name-prompt-field" label="Your name" placeholder="Your name" size="lg" autoComplete="off" maxLength={NAME_MAX_CODE_POINTS} defaultValue={ownName} />
        <Button type="submit" variant="primary" size="lg" className="mt-3 w-full">Join</Button>
      </form>
    </DialogPanel>
  </Dialog.Root>;
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

// Theatre does not display the header (room.css) and shows no settings button anywhere: settings
// is reached by leaving theatre (owner, 8.5, design.md D9).
function RoomHeader({ view, actions, theatre }) {
  return <header className="room-header">
    <a href="/" className="wordmark" data-testid="wordmark">Murmur</a>
    {theatre ? null : <SettingsMenu view={view} actions={actions} />}
  </header>;
}

// Storage that throws is "off": theatre is a convenience, and a tab that cannot keep it still
// toggles (design.md D9).
function readTheatre() {
  try {
    return sessionStorage.getItem(THEATRE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTheatre(on) {
  try {
    if (on) sessionStorage.setItem(THEATRE_KEY, '1');
    else sessionStorage.removeItem(THEATRE_KEY);
  } catch {
    // Nothing to do: the toggle already took effect on the page.
  }
}

// Theatre's layout applies from this width (room.css); below it the header keeps the settings
// button, so the button follows the same width, not the stored flag alone.
const THEATRE_WIDTH = '(min-width: 768px)';

function useWide() {
  const [wide, setWide] = useState(() => matchMedia(THEATRE_WIDTH).matches);
  useEffect(() => {
    const query = matchMedia(THEATRE_WIDTH);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

// The static .layout carries the flag for the stylesheet, as EndedMarker does for #player.
// Theatre moves no element: the media element is the same one it was. A change after mount
// plays #player from its old box to its new one; a remembered theatre does not animate in on
// load (12e design.md D11).
function TheatreMarker({ theatre }) {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const layout = document.querySelector('.layout');
    if (!layout) return undefined;
    const player = document.getElementById('player');
    const before = mounted.current && player ? player.getBoundingClientRect() : null;
    if (theatre) layout.dataset.theatre = 'true';
    else delete layout.dataset.theatre;
    mounted.current = true;
    const keyframes = before ? flipKeyframes(before, player.getBoundingClientRect()) : null;
    if (keyframes && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      player.animate(keyframes, { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
    return undefined;
  }, [theatre]);
  useLayoutEffect(() => () => { delete document.querySelector('.layout')?.dataset.theatre; }, []);
  return null;
}

function TheatreChips({ view }) {
  const people = useView(view, (snapshot) => snapshot.people);
  return <ParticipantsChips people={people} />;
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
      <ChartNoAxesColumn size={22} strokeWidth={4} aria-hidden="true" />
      <span>Stats</span>
    </Button>
    <a id="invite" href={invite.href} className="btn btn-primary" onClick={copy}>
      <Link size={20} strokeWidth={2} aria-hidden="true" />
      <span aria-live="polite">{copied ? 'Copied' : 'Copy invite link'}</span>
    </a>
  </div>;
}

// Shown for a title's first seconds and then gone: the timers start when `shown` turns true, a
// repaint with it still true leaves them alone, and a title that loads again starts them again.
// The fade is the stylesheet's, so reduced motion drops it there; this only unmounts after it.
function KeyframeHint({ shown }) {
  const [phase, setPhase] = useState(shown ? 'visible' : 'gone');
  useEffect(() => {
    if (!shown) {
      setPhase('gone');
      return undefined;
    }
    setPhase('visible');
    const fade = setTimeout(() => setPhase('fading'), HINT_VISIBLE_MS);
    const gone = setTimeout(() => setPhase('gone'), HINT_VISIBLE_MS + HINT_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [shown]);
  return shown && phase !== 'gone' ? <div className="file-hint" data-phase={phase}>{KEYFRAME_HINT}</div> : null;
}

// The host's card over the video while there is nothing to play (design.md D15). #host-file is
// the input drivers set files on, so it stays mounted and visually hidden, never `hidden`, and
// carries the disabled flag itself: a CDP pick bypasses the button. The refusal's command keeps
// its ids and texts, and `hidden` closes the card with no display class on `.file-state`.
function HostFileControls({ view, actions }) {
  const hostFile = useView(view, (snapshot) => snapshot.hostFile);
  const hostStatus = useView(view, (snapshot) => snapshot.hostStatus);
  const input = useRef(null);
  const help = hostFile.help;
  const card = fileCard(hostFile.state, hostStatus.fraction);
  const icon = CARD_ICONS[card.icon];
  return inPlayer(<>
    <div className="file-state" data-kind={card.kind} hidden={hostFile.inputHidden && !help}>
      <div className="file-card">
        {hostFile.state === 'storage-refused' ? null : <input
            ref={input}
            type="file"
            id="host-file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            disabled={!hostFile.choosable}
            onChange={(event) => actions.chooseHostFile(event.target.files?.[0])}
          />}
        <div className="file-body">
          {icon ? <icon.Icon className={icon.className} size={72} strokeWidth={1.5} aria-hidden="true" /> : null}
          <h2 className="file-title tabular">{card.title}</h2>
          {card.percent === null ? null : <div
            className="file-progress"
            role="progressbar"
            aria-label="Preparing"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={card.percent}
            style={{ '--fraction': card.percent / 100 }}
          ><div className="file-progress-fill" /></div>}
          <div id="file-reason">{help?.reason ?? ''}</div>
          {card.note ? <p className="file-note">{card.note}</p> : null}
          {help?.command ? <>
            <div className="file-codebox">
              <code id="file-command">{help.command}</code>
              <Button id="file-copy" onClick={actions.copyFile}>Copy</Button>
            </div>
            <div id="file-note">{help.note}</div>
          </> : null}
          {card.button === null ? null : <Button
            variant="primary"
            size="lg"
            className="file-button"
            data-testid="host-file-button"
            disabled={!hostFile.choosable}
            onClick={() => input.current?.click()}
          >{card.button}</Button>}
        </div>
      </div>
    </div>
    <KeyframeHint shown={Boolean(hostFile.notice)} />
  </>);
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
        <OverlayLine view={view} id="start-wait-line" name="startWait" />
        <OverlayLine view={view} id="links-line" name="links" />
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

// Class names are whole literals so the stylesheet's tone rules are findable by search.
const TONE_CLASS = {
  host: 'member-chip-tone-host',
  1: 'member-chip-tone-1',
  2: 'member-chip-tone-2',
  3: 'member-chip-tone-3',
  4: 'member-chip-tone-4',
  5: 'member-chip-tone-5',
};

const CHAT_TONE_CLASS = {
  host: 'chat-sender-tone-host',
  1: 'chat-sender-tone-1',
  2: 'chat-sender-tone-2',
  3: 'chat-sender-tone-3',
  4: 'chat-sender-tone-4',
  5: 'chat-sender-tone-5',
};

// Initials only: the chip is a picture of the member, and the label beside it (or the header's
// own text) is what a screen reader gets. The fill is the member's tone; the host's chip
// also carries an ink ring.
function MemberChip({ person, size }) {
  return <span className={clsx('member-chip', TONE_CLASS[person.tone], size === 'sm' && 'member-chip-sm', person.host && 'member-chip-host')} aria-hidden="true">{person.initial}</span>;
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

// The member's own entry is a button that reopens the name prompt.
function ParticipantsList({ people, selfClientId, onOwnEntry }) {
  return <ul className="participants-list">
    {people.map((person) => {
      const body = <>
        <MemberChip person={person} />
        <span className="participant-label">{person.label}</span>
      </>;
      return <li key={person.clientId} className="participant">
        {person.clientId === selfClientId
          ? <button type="button" className="participant-self" onClick={onOwnEntry}>{body}</button>
          : body}
        {person.host ? <span className="host-tag">host</span> : null}
      </li>;
    })}
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
    {activity.map((entry) => (entry.kind === 'chat'
      ? <p key={entry.id} className="activity-line activity-chat">
        <span className={clsx('chat-sender', CHAT_TONE_CLASS[entry.tone])}>{entry.label}</span>{' '}{entry.text}
      </p>
      : <p key={entry.id} className={clsx('activity-line', entry.warn && 'activity-warn')}>{entry.text}</p>))}
  </div>;
}

// Enter sends. The field clears when its own message comes back relayed and still holds what
// was sent; a refusal leaves the text where it was typed.
function MessageInput({ view, actions }) {
  const field = useRef(null);
  const sent = useRef(null);
  const outcome = useView(view, (snapshot) => snapshot.chatOutcome);
  useEffect(() => {
    const own = sent.current;
    if (own === null || outcome.id !== own.id) return;
    sent.current = null;
    if (outcome.result === 'relayed' && field.current?.value === own.raw) field.current.value = '';
  }, [outcome]);
  const onKeyDown = (event) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const raw = event.currentTarget.value;
    const id = actions.sendChat(raw);
    sent.current = id === null ? null : { id, raw };
  };
  return <TextField ref={field} id="message-input" label="Message the room" placeholder="Message the room" autoComplete="off" maxLength={CHAT_MAX_CODE_POINTS} onKeyDown={onKeyDown} />;
}

// The right column: the participants' disclosure, the activity region, then the message
// input. The column's height and the activity region's scrolling are in room.css.
function RoomColumn({ view, actions }) {
  const people = useView(view, (snapshot) => snapshot.people);
  const selfClientId = useView(view, (snapshot) => snapshot.selfClientId);
  return <aside className="room-column" aria-label="Room">
    <Collapsible.Root className="participants">
      <Collapsible.Trigger className="participants-trigger">
        <span className="participants-title">Participants · {people.length}</span>
        <ParticipantsChips people={people} />
        <ChevronDown className="participants-chevron" size={20} strokeWidth={2} aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="participants-panel">
        <ParticipantsList people={people} selfClientId={selfClientId} onOwnEntry={actions.openNamePrompt} />
      </Collapsible.Panel>
    </Collapsible.Root>
    <ActivityLog view={view} />
    <div className="room-compose"><MessageInput view={view} actions={actions} /></div>
  </aside>;
}

export function RoomScreens({ view, actions }) {
  const route = useView(view, (snapshot) => snapshot.route);
  // Pressing Host swaps the route in this document, and the room's URL then reads like a rig
  // URL: the prompt needs this to know the host came from the front page (design.md D19).
  const sawFront = useRef(false);
  useLayoutEffect(() => {
    if (route === 'front') sawFront.current = true;
  }, [route]);
  const [theatre, setTheatre] = useState(readTheatre);
  const wide = useWide();
  const inTheatre = wide && theatre;
  const toggleTheatre = () => {
    writeTheatre(!theatre);
    setTheatre(!theatre);
  };
  if (route === 'front') {
    return <>
      <PlayerVisibility route={route} />
      <Front view={view} actions={actions} />
    </>;
  }
  return <>
    <PlayerVisibility route={route} />
    <EndedMarker view={view} />
    <TheatreMarker theatre={theatre} />
    <RoomHeader view={view} actions={actions} theatre={inTheatre} />
    <NamePrompt view={view} actions={actions} fromFront={sawFront.current} />
    <PlayerTop view={view} chips={inTheatre ? <TheatreChips view={view} /> : null} />
    <HostFileControls view={view} actions={actions} />
    <ViewerWait view={view} />
    <EndedCard view={view} actions={actions} />
    <ReconnectPill view={view} />
    <PlayerBar view={view} actions={actions} theatre={theatre} theatreShown={wide} onTheatre={toggleTheatre} />
    <RoomActions view={view} actions={actions} />
    <StatsPanel view={view} />
    <RoomColumn view={view} actions={actions} />
  </>;
}

export function mountScreens({ view, actions }) {
  const root = createRoot(document.getElementById('screens'));
  flushSync(() => root.render(<RoomScreens view={view} actions={actions} />));
}
