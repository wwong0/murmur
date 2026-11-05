import { useRef } from 'react';
import { Button, TextField } from './ui.jsx';
import { useView } from './use-view.js';

// The front page (12e design.md D1, D5, D6). The copy is the owner's, verbatim from D5; the two
// drawings are decorative HTML and CSS with no name, message, film or file name in them. The
// headline and both actions sit on the first screen at 1536x864 and 390x844 (FP1, FP2).
const LEADS = [
  ['In tight sync', 'Pause, skip or rewind, and it happens on every screen at the same moment.'],
  ['Private, peer to peer', "The video goes straight from the host's computer to the room. It is never uploaded."],
];
const SUPPORTS = [
  ['Viewers share with each other', "Each viewer passes the video on, so the host doesn't send a copy to everyone."],
  ['No account, no install', "Guests open the link in their browser and they're in. Nobody has to sign up."],
];
const CHIP_TONES = ['host', '1', '2'];
// The write-up on the public repo, where the figures sit with the setup they were measured in.
const WRITEUP_URL = 'https://github.com/wwong0/murmur/blob/main/WRITEUP.md';

function Chips({ className }) {
  return <span className={className}>{CHIP_TONES.map((tone) => <b key={tone} className={`front-chip member-chip-tone-${tone}`} />)}</span>;
}

function RoomDrawing() {
  return <div className="front-room" aria-hidden="true">
    <div className="front-room-video">
      <span className="front-room-dot" />
      <span className="front-room-track"><span /></span>
      <span className="front-room-controls"><i /><i /><i /></span>
    </div>
    <div className="front-room-column">
      <Chips className="front-room-chips" />
      <i className="front-line front-line-centre" />
      <i className="front-line front-line-short" />
      <i className="front-line front-line-mid" />
      <i className="front-line front-line-centre" />
      <i className="front-line front-line-short" />
      <i className="front-room-input" />
    </div>
  </div>;
}

const STEPS = [
  ['Pick a video file', 'An MP4 file on your computer.', <span className="front-step-file"><i className="front-step-file-icon" /><i className="front-line front-step-file-name" /></span>],
  ['Send the link', 'Friends open it in their browser.', <span className="front-step-link">Copy invite link</span>],
  ['Press play together', 'The video starts for everyone together.', <span className="front-step-play"><i className="front-step-play-button" /><Chips className="front-step-chips" /></span>],
];

function Hero({ view, actions }) {
  const input = useRef(null);
  const joinError = useView(view, (snapshot) => snapshot.joinError);
  const join = () => actions.join(input.current?.value ?? '');
  return <section className="front-hero">
    <div className="front-intro">
      <h1 className="front-headline">Watch together</h1>
      <p className="front-lede">Pick a video from your computer, send a link, and press play. Everyone watches the same moment, together.</p>
      <div className="front-actions">
        <Button id="host" variant="primary" size="xl" className="w-full" onClick={actions.host}>Host a room</Button>
        <div className="or-divider">or</div>
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
        <div id="join-error" aria-live="polite" className="min-h-5 text-sm text-warning">{joinError}</div>
      </div>
    </div>
    <RoomDrawing />
  </section>;
}

export function Front({ view, actions }) {
  return <div className="front" id="front">
    <div className="front-wrap">
      <Hero view={view} actions={actions} />
      <section className="front-leads">
        {LEADS.map(([title, text]) => <div key={title}><h2>{title}</h2><p>{text}</p></div>)}
      </section>
      <section className="front-supports">
        {SUPPORTS.map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}
      </section>
      <section className="front-steps">
        <h2 className="front-eyebrow">How it works</h2>
        <ol>
          {STEPS.map(([title, text, drawing]) => <li key={title}>
            <div className="front-step-picture" aria-hidden="true">{drawing}</div>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>)}
        </ol>
      </section>
      <footer className="front-footer"><span className="front-footer-name">Murmur</span><span>Watch parties, peer to peer · <a className="front-footer-link" href={WRITEUP_URL}>How it was built and tested</a></span></footer>
    </div>
  </div>;
}
