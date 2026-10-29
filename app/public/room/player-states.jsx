import { RotateCcw } from 'lucide-react';
import { viewerLayer } from '../lib/viewer-wait-card.mjs';
import { inPlayer } from './in-player.js';
import { Button } from './ui.jsx';
import { useView } from './use-view.js';

// The viewer's card over the video while the host has nothing to play (12b design.md D16), and,
// for an absent host, only once the room is not playing (13h design.md D2). `#host-preparing`
// keeps its own texts behind Stats. The layer takes no pointer event and sits under the bar, so
// every control stays visible and disabled by the engine.
export function ViewerWait({ view }) {
  const hostStatus = useView(view, (snapshot) => snapshot.hostStatus);
  const hostSide = useView(view, (snapshot) => snapshot.hostSide);
  const ended = useView(view, (snapshot) => snapshot.ended);
  const playing = useView(view, (snapshot) => snapshot.roomPlaying);
  const card = viewerLayer({ hostStatus, hostSide, ended, playing }).card;
  if (card === null) return null;
  return inPlayer(<div className="wait-layer" data-testid="viewer-wait" data-state={card.state} role="status">
    <div className="wait-body">
      {card.state === 'choosing' ? <div className="wait-dots" aria-hidden="true"><span /><span /><span /></div> : null}
      <h2 className="wait-title tabular">{card.title}</h2>
      {card.state === 'preparing' ? <div
        className="file-progress"
        role="progressbar"
        aria-label="The host is preparing the video"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={card.percent ?? undefined}
        style={{ '--fraction': (card.percent ?? 0) / 100 }}
      ><div className="file-progress-fill" /></div> : null}
      {card.note ? <p className="wait-note">{card.note}</p> : null}
    </div>
  </div>);
}

// The countdown shares the reconnecting pill's position (design.md D1).
export function HostLeftPill({ view }) {
  const hostStatus = useView(view, (snapshot) => snapshot.hostStatus);
  const hostSide = useView(view, (snapshot) => snapshot.hostSide);
  const ended = useView(view, (snapshot) => snapshot.ended);
  const connection = useView(view, (snapshot) => snapshot.connection);
  const playing = useView(view, (snapshot) => snapshot.roomPlaying);
  const graceLeftS = useView(view, (snapshot) => snapshot.graceLeftS);
  const pill = viewerLayer({ hostStatus, hostSide, ended, connection, playing, graceLeftS }).pill;
  if (pill === null) return null;
  return inPlayer(<div className="reconnect-pill" data-testid="host-left" role="status">
    <span className="reconnect-dot" aria-hidden="true" />
    <span>{pill}</span>
  </div>);
}

// Only while a lost connection is being retried (the entry's `connection`). It takes no pointer
// event, so the strip under it still hovers.
export function ReconnectPill({ view }) {
  const connection = useView(view, (snapshot) => snapshot.connection);
  if (connection !== 'reconnecting') return null;
  return inPlayer(<div className="reconnect-pill" data-testid="reconnecting" role="status">
    <span className="reconnect-dot" aria-hidden="true" />
    <span>Reconnecting…</span>
  </div>);
}

// The centred button is a second element calling the action `#play` calls, and it follows
// `#play`'s own disabled flag: a room the engine has blocked takes no second way in
// (design.md D16). The veil sits under the strip and the bar.
export function EndedCard({ view, actions }) {
  const ended = useView(view, (snapshot) => snapshot.ended);
  const disabled = useView(view, (snapshot) => snapshot.controls.play.disabled);
  if (!ended) return null;
  return inPlayer(<div className="ended-layer" data-testid="ended">
    <div className="ended-body">
      <h2 className="ended-title">Ended</h2>
      <Button variant="primary" size="xl" className="ended-button" data-testid="watch-again" disabled={disabled} onClick={actions.play}>
        <RotateCcw size={24} strokeWidth={2} aria-hidden="true" />
        <span>Watch again</span>
      </Button>
    </div>
  </div>);
}
