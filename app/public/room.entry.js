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
import { createRoomTimeline } from './lib/room-timeline.mjs';
import { createDriftLog } from './lib/frame-drift.mjs';
import { createDriftController } from './lib/drift-controller.mjs';
import { initializePlaybackTreatment } from './lib/playback-treatment.mjs';
import { createFrameSampler } from './lib/frame-sampler.mjs';
import { createPlaybackStart } from './lib/playback-start.mjs';
import { createDiagnosticsOverlay } from './lib/diagnostics-overlay.mjs';

const BUILD_ID = __BUILD_ID__;

console.log('[app] build', BUILD_ID);

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
const driftLine = document.getElementById('drift-line');
const controllerLine = document.getElementById('controller-line');
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

client.onEvent('joined', (joined) => {
  // The role reported is the one the server gave this membership, not the one
  // the query string asked for.
  addNotice(`joined as ${joined.clientId} (${joined.role})`);
  renderRoster(joined.roster);
  // THE WHOLE REPLY, not the roster: the join time in it is the only thing that
  // tells a reclaimed membership from a new one, and a new one lands in a room
  // whose epoch this page must not carry over (change 3a design.md D2).
  timeline.observeJoin(joined);
  tickPlayback();
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
  timeline.observeRoster(body.roster);
  tickPlayback();
});

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

// ---------------------------------------------------------------------------
// Player, the room timeline, and the drift instrument
// ---------------------------------------------------------------------------

const player = createPlayer({ video });
player.onError((detail) => {
  addNotice(`player error: ${detail.type ?? 'unknown'} ${detail.details ?? ''}`, { warn: true });
});

// THE PITCH TREATMENT, BEFORE THE SAMPLER, THE CONTROLLER AND ANY OPEN: the
// adopted floor is only licensed by a pre-playback `preservesPitch = false`
// that read back false, and this is the one place that write happens. The
// verifier opts in to the treatment's event history with treatmentEvidence=1.
const pageNow = () => performance.timeOrigin + performance.now();
const treatment = initializePlaybackTreatment({
  video,
  opened: false,
  now: pageNow,
  notify: addNotice,
  evidence: params.get('treatmentEvidence') === '1',
});

const timeline = createRoomTimeline();
const driftLog = createDriftLog();
// The video element carries its own `requestVideoFrameCallback`; the sampler's
// default binding calls it on the element it was handed.
const sampler = createFrameSampler({ video, timeline, clock: clockSync, log: driftLog });

const controller = createDriftController({
  log: driftLog,
  clock: clockSync,
  apply: (rate) => treatment.applyRate(rate),
  settings: treatment.settings,
  now: treatment.controllerNow,
});
// What every consumer reads: the kernel snapshot, or once the treatment has
// faulted, a view that says so and carries the kernel's as historical.
const controllerView = () => treatment.view(controller.state());

const playback = createPlaybackStart({
  timeline,
  clock: clockSync,
  open({ positionMs, epochMs, reopen }) {
    const seconds = (positionMs / 1000).toFixed(2);
    if (reopen) {
      sampler.stop();
      treatment.open(() => player.reopen({ startPositionMs: positionMs }), 'reopen');
      controller.markSeam({ afterSeq: driftLog.latestSeq, epochMs, positionMs });
      addNotice(`timeline reference revised — re-opened at ${seconds}s`, { warn: true });
    } else {
      treatment.open(() => player.load({ startPositionMs: positionMs }), 'load');
      addNotice(`playback opened at ${seconds}s`);
    }
    sampler.start();
  },
});

// ---------------------------------------------------------------------------
// The diagnostics overlay
// ---------------------------------------------------------------------------

const overlay = createDiagnosticsOverlay({ clock: clockSync, controller: { state: controllerView }, log: driftLog, playback });

// ON THE TICK, NOT ON A CLOCK EVENT: the half-width widens with age between
// samples, so a repaint tied to new samples alone freezes a growing number.
function paintOverlay() {
  const lines = overlay.lines();
  clockLine.textContent = lines.clock;
  driftLine.textContent = lines.drift;
  controllerLine.textContent = lines.controller;
}

/**
 * Poll the load rule, then repaint the lines WHETHER OR NOT THE POLL GOT THERE.
 * The playback and drift polls deliberately let their errors reach this caller
 * so the next tick can retry (playback-start.mjs rule 3), and this is the last place
 * that failure can be reported from: room-client hands a throwing subscriber to a
 * `subscriber-error` event nothing here listens to (CONSTRAINTS.md →
 * *Verification*). An unpainted drift line goes on naming an input the page
 * stopped missing seconds ago.
 *
 * Also called from the roster handlers, because a reference point arriving is
 * not worth a tick's wait.
 */
function tickPlayback() {
  // SEPARATE TRIES, because the controller's stale rule is what returns the
  // rate to 1.0 when frames stop. A re-open that throws has already stopped the
  // sampler, so sharing one try left the last correction applied open-loop for
  // as long as the open kept failing — the one condition the stale rule exists
  // to end.
  try {
    playback.poll();
  } catch (err) {
    addNotice(`the player did not open: ${err?.message ?? err}`, { warn: true });
  }
  try {
    treatment.pollController(() => controller.poll());
  } catch (err) {
    addNotice(`the drift controller did not poll: ${err?.message ?? err}`, { warn: true });
  }
  try {
    paintOverlay();
  } catch (err) {
    addNotice(`the overlay did not paint: ${err?.message ?? err}`, { warn: true });
  }
}

tickPlayback();
setInterval(tickPlayback, 250);

// ---------------------------------------------------------------------------
// The harness seam (D2)
//
// Change 6 reads these as values over CDP, `playing` above all: a client that
// never played downloads nothing, which makes the host upload multiplier of
// criteria 2 and 3 look BETTER (CONSTRAINTS.md → *Measurement*).
//
// Functions, not values — a consumer evaluating this expression twice must get
// two readings, not one frozen at load.
// ---------------------------------------------------------------------------

window.__app = {
  buildId: BUILD_ID,
  room,
  tabId,
  clock: () => clockSync.read(),
  drift: (afterSeq = 0) => driftLog.read({ afterSeq }),
  // THE CANONICAL ROLLING WINDOW. Published so no consumer has to re-derive a
  // median from `drift().records` and get a second one — the browser pass did,
  // and its two figures did not share a definition of the middle of an even set.
  summary: () => driftLog.summary(),
  // BESIDE `clock` AND `drift`, not inside `playback()`. The seam below spreads
  // `playback.state()`, so a key of the same name there would be silently
  // overwritten by this one rather than colliding visibly.
  controller: controllerView,
  pitch: () => treatment.pitch(),
  treatmentEvidence: (maxEvents) => treatment.drainEvidence(maxEvents),
  playback: () => ({ ...playback.state(), callbacks: sampler.callbacks, sampling: sampler.running, seams: controller.seams }),
  timeline: () => ({ epochMs: timeline.epochMs, ...timeline.counters }),
};

client.connect();
