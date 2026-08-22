// public/room.entry.js
//
// Bundle entry point. The only file allowed to touch the DOM — everything
// else lives in public/lib/** as pure modules that take config as arguments.
// This file's whole job is to read the query string, wire up the room
// client and the player, and move their data into the page.
//
// Bundled by scripts/build.mjs into public/room.bundle.js, loaded by
// public/room.html.

import { createRoomClient } from './lib/room-client.mjs';
import { readBody } from './lib/envelope.mjs';
import { createPlayer } from './lib/player.mjs';
import { createClockSync, websocketProbe } from './lib/clock-sync.mjs';

console.log('[app] build', __BUILD_ID__);

// ---------------------------------------------------------------------------
// Config from the query string. The change 6 harness drives clients by URL,
// so anything that lived in a form or in storage would become harness work
// later — read it straight off location.search instead.
// ---------------------------------------------------------------------------

function randomTabId() {
  return Math.random().toString(36).slice(2, 8);
}

const params = new URLSearchParams(window.location.search);
const room = params.get('room') ?? 'demo';
const role = params.get('role') ?? 'viewer';
const tabId = params.get('tab') ?? randomTabId();

const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${wsScheme}//${window.location.host}/ws`;

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const video = document.getElementById('video');
const statusLine = document.getElementById('status-line');
const clockLine = document.getElementById('clock-line');
const rosterEl = document.getElementById('roster');
const noticesEl = document.getElementById('notices');

function addNotice(text, { warn = false } = {}) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  if (warn) li.classList.add('gap');
  noticesEl.appendChild(li);
  noticesEl.scrollTop = noticesEl.scrollHeight;
}

function renderRoster(roster) {
  rosterEl.innerHTML = '';
  for (const member of roster ?? []) {
    const li = document.createElement('li');
    li.textContent = `${member.tabId} · ${member.role} · ${member.clientId}`;
    rosterEl.appendChild(li);
  }
}

// What a person can DO about a refusal, where there is anything. Absence is the
// ordinary case and must stay readable: a code missing from here reports itself
// and the server's detail, never another code's remedy.
const REFUSAL_REMEDIES = {
  'tab-taken': `the tab name "${tabId}" is in use in room "${room}" — open this page with a different tab= value`,
  'host-taken': `the room "${room}" already has a host — open this page with role=viewer`,
};

// Some statuses are the last word: superseded, or refused for good. Both are
// followed by a socket close, whose ordinary "disconnected" status would
// otherwise land on top of the only message saying WHY the page stopped. Any
// later change adding a third reason a page stops needs this flag too.
let terminal = false;

function setStatus(text, { final = false } = {}) {
  if (terminal) return;
  statusLine.textContent = text;
  terminal = final;
}

// ---------------------------------------------------------------------------
// Room client
// ---------------------------------------------------------------------------

const client = createRoomClient({ url, room, tabId, role });

client.onEvent('status', ({ connected }) => {
  setStatus(connected ? `connected (room "${room}", tab "${tabId}", role "${role}")` : 'disconnected');
  addNotice(connected ? 'connected' : 'disconnected');
});

client.onEvent('reconnecting', ({ inMs }) => {
  setStatus(`reconnecting in ${inMs}ms…`);
  addNotice(`reconnecting in ${inMs}ms`);
});

client.onEvent('joined', ({ clientId, roster, role: heldRole }) => {
  // The role reported is the one the server gave this membership, not the one
  // the query string asked for.
  addNotice(`joined as ${clientId} (${heldRole})`);
  renderRoster(roster);
});

client.onEvent('superseded', () => {
  // Reclaimed by a newer connection presenting this membership's secret — in
  // practice this tab's own later connection.
  setStatus(`superseded — a newer connection took over as "${tabId}"; this tab will not reconnect`, { final: true });
  addNotice('superseded by a newer connection for the same membership', { warn: true });
});

client.onEvent('refused-retrying', ({ code, remainingMs }) => {
  // The server cannot tell a dying holder from a live one until its sweep has
  // run, so the page reports how long the wait is rather than guessing the
  // outcome.
  const seconds = Math.max(1, Math.ceil((remainingMs ?? 0) / 1000));
  setStatus(`join refused (${code}) — retrying for up to ${seconds}s`);
  addNotice(`join refused: ${code} — retrying for up to ${seconds}s`, { warn: true });
});

client.onEvent('refused', ({ code, detail }) => {
  // End of the line: refused, and this client will not ask again.
  //
  // NO CLOSED SET OF CODES HERE. room-client's refusal branch is terminal by
  // construction (change 2 design.md D12), so any code the server has now or
  // grows later arrives on this event — a two-branch ternary told a
  // `version-mismatch` it was a host collision. A code with a way out gets the
  // way out; everything else says what happened and stops.
  const remedy = REFUSAL_REMEDIES[code];
  setStatus(`refused (${code}): ${remedy ?? detail ?? 'this page will not reconnect'}`, { final: true });
  addNotice(`refused (${code}): ${detail ?? remedy ?? ''}`, { warn: true });
});

client.onEvent('gap', ({ expected, actual }) => {
  addNotice(`gap detected: expected seq ${expected}, got ${actual}`, { warn: true });
});

client.on('presence', (env) => {
  const body = readBody(env);
  addNotice(`presence: ${body.event} — ${body.member?.tabId ?? body.member?.clientId}`);
  renderRoster(body.roster);
});

client.connect();

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

const clockSync = createClockSync({
  probe: websocketProbe(client),
  onJoined: (fn) => client.onEvent('joined', fn),
});

// STARTED FROM `joined`, not from `connect()`. A probe sent before the join is
// answered with an error carrying no correlation id, so it resolves nothing and
// hangs until its own timeout — which is a whole steady interval of delay
// before the burst that gives this page its first estimate. Starting is itself
// a burst, and `joined` fires again on every rejoin.
client.onEvent('joined', () => clockSync.start());

function renderClock() {
  const { offsetMs, halfWidthMs, sampleCount } = clockSync.read();
  if (offsetMs === null) {
    clockLine.textContent = 'clock: no estimate yet';
    return;
  }
  const sign = offsetMs >= 0 ? '+' : '';
  clockLine.textContent = `clock: ${sign}${offsetMs.toFixed(1)}ms ± ${halfWidthMs.toFixed(1)}ms (${sampleCount} samples)`;
}

renderClock();
// The half-width widens with age even between samples, so a repaint tied only
// to new samples would freeze a number that is actually growing.
setInterval(renderClock, 1000);

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

const player = createPlayer({ video });
player.onError((detail) => {
  addNotice(`player error: ${detail.type ?? 'unknown'} ${detail.details ?? ''}`, { warn: true });
});
player.load();
