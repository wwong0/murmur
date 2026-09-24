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
import { ADDR_SERVER, newReclaimSecret, readBody } from './lib/envelope.mjs';
import { createPlayer } from './lib/player.mjs';
import { createClockSync, websocketProbe } from './lib/clock-sync.mjs';
import { createRoomTimeline } from './lib/room-timeline.mjs';
import { createDriftLog } from './lib/frame-drift.mjs';
import { createDriftController } from './lib/drift-controller.mjs';
import { initializePlaybackTreatment } from './lib/playback-treatment.mjs';
import { createFrameSampler } from './lib/frame-sampler.mjs';
import { createPlaybackStart } from './lib/playback-start.mjs';
import { createFrameObserver, createStartTelemetry } from './lib/start-telemetry.mjs';
import { createDiagnosticsOverlay } from './lib/diagnostics-overlay.mjs';
import {
  ACQUISITION_BACKOFF_MS,
  ACQUISITION_REQUEST_TIMEOUT_MS,
  createPlaybackAcquisition,
} from './lib/playback-acquisition.mjs';
import { MAX_FUTURE_MS, PREPARE_LEAD_MS, PRESENTATION_ADVANCE_MS, TRANSITION_LEAD_MS } from './lib/playback-leads.mjs';
import { runTickSteps } from './lib/tick-steps.mjs';

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
const suppliedRoom = params.get('room');
const room = suppliedRoom ?? newReclaimSecret();
const role = suppliedRoom ? (params.get('role') ?? 'viewer') : 'host';
const tabId = suppliedRoom ? (params.get('tab') ?? randomTabId()) : randomTabId();

if (!suppliedRoom) {
  history.replaceState(null, '', `?room=${room}&role=host&tab=${tabId}`);
}

// Start-timing instrumentation (executor-spec.md §11.2), off unless asked for.
// `record` returns early when disabled, so every site below is unconditional
// and the product keeps one code path either way.
const startTiming = params.get('startTiming') === '1';
const telemetry = createStartTelemetry({ enabled: startTiming });

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
const playButton = document.getElementById('play');
const pauseButton = document.getElementById('pause');
const backButton = document.getElementById('back-10');
const forwardButton = document.getElementById('forward-10');
const modeButton = document.getElementById('control-mode');
const muteButton = document.getElementById('mute');
const invite = document.getElementById('invite');

invite.textContent = 'invite link';
invite.href = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;

function renderMute() {
  muteButton.textContent = video.muted ? 'unmute' : 'mute';
}

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

function addSubscriberFailure(label, error) {
  addNotice(`${label} failed: ${error?.message ?? error}`, { warn: true });
}

function onEnvelope(type, label, handler) {
  return client.on(type, (value) => {
    try {
      return Promise.resolve(handler(value)).catch((error) => addSubscriberFailure(label, error));
    } catch (error) {
      addSubscriberFailure(label, error);
      return undefined;
    }
  });
}

function closeHostPeer(viewerId) {
  const entry = hostPeers.get(viewerId);
  if (!entry) return;
  hostPeers.delete(viewerId);
  try { entry.detach?.(); } catch (error) { addSubscriberFailure('host link detach', error); }
  try { entry.pc.close(); } catch (error) { addSubscriberFailure('host link close', error); }
}

function closeHostPeers() {
  for (const viewerId of [...hostPeers.keys()]) closeHostPeer(viewerId);
}

function closeDepartedHostPeers(roster) {
  const present = new Set((roster ?? []).map((member) => member.clientId));
  for (const viewerId of hostPeers.keys()) {
    if (!present.has(viewerId)) closeHostPeer(viewerId);
  }
}

function rtcConfig() {
  return {
    iceServers,
    iceTransportPolicy: params.get('iceTransportPolicy') === 'relay' ? 'relay' : 'all',
  };
}

async function readHostSource(path) {
  if (!nativeFetch) throw new Error('native fetch is unavailable');
  const response = await nativeFetch(new URL(path, location.href), { headers: { 'x-app-tab': tabId }, cache: 'no-store' });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function answerHostOffer(env) {
  if (delivery !== 'host' || client.role !== 'host') return;
  const viewerId = env.from;
  const payload = env.payload ?? {};
  if (typeof viewerId !== 'string' || typeof payload.linkId !== 'string' || typeof payload.sdp !== 'string') {
    throw new TypeError('host-link-offer is malformed');
  }
  closeHostPeer(viewerId);
  const pc = new RTCPeerConnection(rtcConfig());
  const viewerTag = client.roster.find((member) => member.clientId === viewerId)?.tabId ?? null;
  const entry = { pc, linkId: payload.linkId, viewerTag, detach: null };
  hostPeers.set(viewerId, entry);
  pc.addEventListener('icecandidate', (event) => {
    if (!event.candidate || hostPeers.get(viewerId) !== entry) return;
    const candidate = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
    client.send({ type: 'host-link-ice', to: viewerId, payload: { linkId: entry.linkId, candidate } });
  });
  pc.addEventListener('datachannel', (event) => {
    if (hostPeers.get(viewerId) !== entry || !hostOrigin) return;
    entry.detach?.();
    entry.detach = hostOrigin.attach(event.channel, { viewerTag: entry.viewerTag });
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  client.send({ type: 'host-link-answer', to: viewerId, payload: { linkId: entry.linkId, sdp: answer.sdp ?? answer } });
}

async function routeHostIce(env) {
  if (delivery !== 'host' || client.role !== 'host') return;
  const entry = hostPeers.get(env.from);
  if (!entry || env.payload?.linkId !== entry.linkId) return;
  await entry.pc.addIceCandidate(env.payload.candidate);
}

async function installHostSide() {
  if (hostSideInstalled) return;
  await loadHostTransport();
  hostOrigin = createHostOrigin({
    readSource: readHostSource,
    clock: {
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });
  onEnvelope('host-link-offer', 'host-link offer', answerHostOffer);
  onEnvelope('host-link-ice', 'host-link ICE', routeHostIce);
  hostSideInstalled = true;
}

function installViewerLink() {
  if (typeof RTCPeerConnection !== 'function') throw new Error('RTCPeerConnection is unavailable');
  let lastState = null;
  link = createHostLink({
    client,
    RTCPeerConnection,
    rtcConfig: rtcConfig(),
    onChange: (snapshot) => {
      if (snapshot.state !== lastState) {
        lastState = snapshot.state;
        addNotice(`host link: ${snapshot.state}`);
      }
      schedulePollStart(0);
    },
  });
  window.fetch = link.createShimFetch({ realFetch: nativeFetch, baseUrl: location.href });
  window.XMLHttpRequest = link.createShimXhr({ RealXHR: window.XMLHttpRequest, baseUrl: location.href });
}

// ---------------------------------------------------------------------------
// Room client
// ---------------------------------------------------------------------------

const client = createRoomClient({ url, room, tabId, role });
let delivery = 'host';
let iceServers = [];
let link = null;
let hostOrigin = null;
const hostPeers = new Map();
const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
let createHostLink = null;
let createHostOrigin = null;
let hostSideInstalled = false;

async function loadHostTransport() {
  if (createHostLink && createHostOrigin) return;
  const [linkModule, originModule] = await Promise.all([
    import('./lib/host-link.mjs'),
    import('./lib/host-origin.mjs'),
  ]);
  createHostLink = linkModule.createHostLink;
  createHostOrigin = originModule.createHostOrigin;
}

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
  if (delivery === 'host' && joined.role === 'host') {
    closeHostPeers();
    if (nativeFetch) installHostSide().catch((error) => addSubscriberFailure('host transport', error));
  }
  addNotice(`joined as ${joined.clientId} (${joined.role})`);
  renderRoster(joined.roster);
  schedulePollStart(0);
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
  // A member can relay an envelope typed `presence`; only the server's closes peers (7a d1-findings D1-1).
  if (env.from === ADDR_SERVER && delivery === 'host' && client.role === 'host') closeDepartedHostPeers(body.roster);
  addNotice(`presence: ${body.event} — ${body.member?.tabId ?? body.member?.clientId}`);
  renderRoster(body.roster);
  schedulePollStart(0);
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

const player = createPlayer({ video, clientTag: tabId });
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

// The replicated playback state (change 5 design.md D4). Built before connect
// so its `joined` subscriber sees the first join.
const acquisition = createPlaybackAcquisition({
  client,
  clock: clockSync,
  settings: {
    transitionLeadMs: TRANSITION_LEAD_MS,
    maxFutureMs: MAX_FUTURE_MS,
    requestTimeoutMs: ACQUISITION_REQUEST_TIMEOUT_MS,
    backoffMs: ACQUISITION_BACKOFF_MS,
  },
  mintLineage: newReclaimSecret,
  onOutcome: ({ env, outcome }) => {
    if (outcome !== 'applied' && env.from === client.clientId) {
      addNotice(`your ${env.payload?.kind ?? 'operation'} was rejected: ${outcome}`, { warn: true });
    }
    renderControls();
    if (outcome === 'applied') schedulePollStart(0);
  },
  report: (where, error) => addNotice(`playback state ${where} failed: ${error?.message ?? error}`, { warn: true }),
});

const timeline = createRoomTimeline({ readState: () => acquisition.state });

function controlsReady(kind) {
  const state = acquisition.state;
  const now = clockSync.sharedNow();
  return acquisition.snapshot.resolved
    && state !== null
    && Number.isFinite(now)
    && Number.isFinite(state.current?.atSharedMs)
    && now >= state.current.atSharedMs
    && acquisition.permitted(kind);
}

function renderControls() {
  const state = acquisition.state;
  const ready = (kind) => controlsReady(kind);
  playButton.disabled = !(ready('play') && !state?.current.playing);
  pauseButton.disabled = !(ready('pause') && state?.current.playing);
  backButton.disabled = !ready('seek');
  forwardButton.disabled = !ready('seek');
  modeButton.hidden = client.role !== 'host';
  modeButton.disabled = !ready('control-mode');
  modeButton.textContent = `mode: ${state?.controlMode === 'host' ? 'open' : 'host'}`;
}

function issue(kind, args) {
  acquisition.issue(kind, args);
  renderControls();
}

function seekBy(deltaMs) {
  const now = clockSync.sharedNow();
  if (!Number.isFinite(now)) return;
  const positionMs = timeline.mediaMsAt(now + TRANSITION_LEAD_MS);
  if (Number.isFinite(positionMs)) issue('seek', { positionMs: positionMs + deltaMs });
}

playButton.addEventListener('click', () => issue('play'));
pauseButton.addEventListener('click', () => issue('pause'));
backButton.addEventListener('click', () => seekBy(-10_000));
forwardButton.addEventListener('click', () => seekBy(10_000));
modeButton.addEventListener('click', () => {
  const state = acquisition.state;
  if (state) issue('control-mode', { controlMode: state.controlMode === 'host' ? 'open' : 'host' });
});
muteButton.addEventListener('click', () => {
  video.muted = !video.muted;
  renderMute();
});
renderMute();

const driftLog = createDriftLog();
// The video element carries its own `requestVideoFrameCallback`; the sampler's
// default binding calls it on the element it was handed.
const sampler = createFrameSampler({ video, timeline, clock: clockSync, log: driftLog });

// A second observer on the same frames, never stopped, so the frame the park
// presented is identifiable too. It holds no log and no timeline: the product
// sampler above is untouched, and the two streams join offline on
// `presentedFrames` (executor-spec.md §11.1).
const frameObserver = startTiming
  ? createFrameObserver({ video, telemetry, context: telemetryContext, now: pageNow })
  : null;
frameObserver?.start();

const controller = createDriftController({
  log: driftLog,
  clock: clockSync,
  // `applyRate` returns nothing — it throws on a refusal and on a failed write —
  // so there is no applied flag to retain, and `appliedOk` is named absent.
  // ONE PATH, not a startTiming pair: `record` is the early return when the
  // instrument is off, which is what keeps this call identical either way.
  apply: (rate) => {
    const applied = treatment.applyRate(rate);
    telemetry.record('rate-write', { commandedRate: rate, readbackRate: video.playbackRate, appliedOk: applied ?? null }, telemetryContext());
    return applied;
  },
  settings: treatment.settings,
  now: treatment.controllerNow,
});
// What every consumer reads: the kernel snapshot, or once the treatment has
// faulted, a view that says so and carries the kernel's as historical.
const controllerView = () => treatment.view(controller.state());

// ---------------------------------------------------------------------------
// The scheduled start (D6) and the window drop at every start and park (D7)
// ---------------------------------------------------------------------------

const start = createPlaybackStart({ prepareLeadMs: PREPARE_LEAD_MS, presentationAdvanceMs: PRESENTATION_ADVANCE_MS });
const STARTS_KEPT = 32;
const starts = [];
let startTimer = null;
// Readiness per executor-spec.md C1-7: an event after this attempt's load or
// park, and for a park only from its `seeked` on; the tick re-checks readyState.
let readiness = null;

function reportStep(name, error) {
  addNotice(`${name} failed: ${error?.message ?? error}`, { warn: true });
}

// The identity and the clock as this page holds them at this instant, read from
// the same sources the product reads. Every value may be null, and a null is
// named in the event rather than defaulted (executor-spec.md R17).
//
// THE ONE PLACE THE INSTRUMENT COSTS ANYTHING IS GUARDED, so every call site
// below stays unconditional and the product keeps one code path: `record`'s own
// early return does not stop its third argument being built, and these four
// reads would otherwise run four times a second on the shipped path with
// nothing recorded (D1 R7, `docs/constraints/measurement.md`).
function telemetryContext() {
  if (!startTiming) return null;
  const estimate = clockSync.read();
  const identity = acquisition.snapshot.identity;
  return {
    attemptId: start.state().attemptId,
    lineage: identity?.lineage ?? null,
    version: identity?.version ?? null,
    nowSharedMs: clockSync.sharedNow(),
    clockOffsetMs: estimate?.offsetMs ?? null,
    clockHalfWidthMs: estimate?.halfWidthMs ?? null,
  };
}

function markSeam(epochMs, positionMs) {
  controller.markSeam({ afterSeq: driftLog.latestSeq, epochMs, positionMs });
}

/** The shared instant offered as readiness, or null when nothing was offered. */
function checkReady() {
  if (!readiness?.prerequisiteSeen || video.seeking || !(video.readyState >= 3)) return null;
  const observedSharedMs = clockSync.sharedNow();
  start.ready(readiness.attemptId, observedSharedMs);
  return observedSharedMs;
}

function observeElement(type) {
  const readyState = video.readyState;
  const paused = video.paused;
  const elementCurrentTimeMs = video.currentTime * 1000;
  // Native events carry no attempt ID. A queued event from an earlier park
  // must not qualify a replacement whose current seek is still unfinished.
  const blocked = !readiness || video.seeking
    || (readiness.needsSeeked && !readiness.prerequisiteSeen && type !== 'seeked');
  let observedSharedMs = null;
  if (!blocked) {
    readiness.prerequisiteSeen = true;
    observedSharedMs = checkReady();
  }
  telemetry.record('element-event', {
    type,
    readyState,
    paused,
    elementCurrentTimeMs,
    prerequisiteSeen: readiness?.prerequisiteSeen ?? false,
    offeredReadiness: observedSharedMs !== null,
    observedSharedMs,
  }, telemetryContext());
}

for (const type of ['canplay', 'canplaythrough', 'seeked']) {
  video.addEventListener(type, () => runTickSteps([['readiness', () => observeElement(type)]], reportStep));
}

/**
 * One `action` event per action, with `dispatchedAtLocalMs`/`returnedAtLocalMs`
 * bracketing the element or player call itself — not the step around it, which
 * is the measurement the repair brief names first.
 */
function recordAction(action, fields, dispatch) {
  const elementPausedBefore = video.paused;
  const elementCurrentTimeMs = video.currentTime * 1000;
  const dispatchedAtLocalMs = pageNow();
  let threw = null;
  try {
    // A dispatch that handles its own failure names it by returning the name; one
    // that throws is named here and keeps throwing, exactly as it did before.
    threw = dispatch() ?? null;
  } catch (error) {
    threw = error?.name ?? String(error?.message ?? error);
    throw error;
  } finally {
    telemetry.record('action', {
      action: action.kind,
      // A `pause` carries no position, and says so rather than inventing one.
      positionMs: action.positionMs ?? null,
      scheduledPositionMs: action.scheduledPositionMs ?? null,
      advanceMs: action.advanceMs ?? null,
      startAtSharedMs: null,
      latenessMs: null,
      seamEpochMs: null,
      ...fields,
      elementPausedBefore,
      elementCurrentTimeMs,
      dispatchedAtLocalMs,
      returnedAtLocalMs: pageNow(),
      threw,
    }, telemetryContext());
  }
}

function play(action) {
  // The room's own mapping, as the reducer computed it — never S minus the
  // physical park, which differs from it by the advance (§12, C1-10).
  const seamEpochMs = action.seamEpochMs;
  markSeam(seamEpochMs, action.scheduledPositionMs);
  starts.push({
    attemptId: action.attemptId,
    afterSeq: driftLog.latestSeq,
    startAtSharedMs: action.startAtSharedMs,
    playAtSharedMs: action.startAtSharedMs + action.latenessMs,
    latenessMs: action.latenessMs,
    positionMs: action.positionMs,
    scheduledPositionMs: action.scheduledPositionMs,
    advanceMs: action.advanceMs,
    // The seam's own epoch, so acceptance can check it against the room's
    // (§15 item 4) without re-deriving it from the advanced park.
    epochMs: seamEpochMs,
  });
  if (starts.length > STARTS_KEPT) starts.shift();
  sampler.start();
  let pending;
  recordAction(action, { startAtSharedMs: action.startAtSharedMs, latenessMs: action.latenessMs, seamEpochMs }, () => {
    try {
      pending = video.play();
    } catch (error) {
      pending = Promise.reject(error);
      return error?.name ?? String(error?.message ?? error);
    }
    return null;
  });
  const settled = (outcome, errorName) => {
    // Stamped before the reducer reacts, so the settlement instant is not the
    // instant of the reaction to it.
    const settledAtLocalMs = pageNow();
    const settledSharedMs = clockSync.sharedNow();
    return ['play-settled', () => telemetry.record('play-settled', { outcome, errorName, settledAtLocalMs, settledSharedMs }, telemetryContext())];
  };
  Promise.resolve(pending).then(
    () => runTickSteps([settled('resolved', null), ['play', () => {
      start.playResolved(action.attemptId);
      pollStart();
    }]], reportStep),
    (error) => runTickSteps([settled('rejected', error?.name ?? null), ['play', () => {
      if (start.state().attemptId === action.attemptId) sampler.stop();
      start.playRejected(action.attemptId, { name: error?.name });
      addNotice(`play() failed: ${error?.name ?? error}`, { warn: true });
      pollStart();
    }]], reportStep),
  );
}

function execute(result) {
  for (const action of result.actions) {
    if (action.kind === 'pause') {
      sampler.stop();
      recordAction(action, {}, () => video.pause());
    } else if (action.kind === 'load' || action.kind === 'park') {
      // C1-10: the reducer carries the mapping each action serves, playing or
      // paused, so nothing here derives an epoch from the physical park.
      const epochMs = action.seamEpochMs;
      readiness = { attemptId: action.attemptId, needsSeeked: action.kind === 'park', prerequisiteSeen: false };
      recordAction(action, { startAtSharedMs: result.startAtSharedMs, seamEpochMs: epochMs }, () => {
        if (action.kind === 'load') treatment.open(() => player.load({ startPositionMs: action.positionMs }), 'load');
        else player.park(action.positionMs);
      });
      if (action.kind === 'load') addNotice(`playback opened at ${(action.positionMs / 1000).toFixed(2)}s`);
      markSeam(epochMs, action.scheduledPositionMs);
    } else if (action.kind === 'play') {
      play(action);
    }
  }
}

function schedulePollStart(delayMs) {
  if (startTimer !== null) clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    startTimer = null;
    runTickSteps([['playback-start', pollStart]], reportStep);
  }, Math.max(0, delayMs));
}

function pollStart() {
  checkReady();
  const state = acquisition.state;
  const nowSharedMs = clockSync.sharedNow();
  const result = start.poll({
    nowSharedMs,
    resolved: acquisition.snapshot.resolved,
    state,
    linkOpen: link ? link.snapshot().state === 'open' : true,
  });
  telemetry.record('poll', {
    nowSharedMs,
    resolved: result.resolved,
    waiting: result.waiting,
    missing: result.missing,
    actions: result.actions.map((action) => action.kind),
    nextAtSharedMs: result.nextAtSharedMs,
    opens: result.opens,
    begun: result.begun,
    retargets: result.retargets,
  }, telemetryContext());
  execute(result);
  if (result.nextAtSharedMs === null) {
    if (startTimer !== null) clearTimeout(startTimer);
    startTimer = null;
  } else {
    schedulePollStart(result.nextAtSharedMs - (clockSync.sharedNow() ?? result.nextAtSharedMs));
  }
}

document.addEventListener('click', () => {
  start.click();
  pollStart();
});

// ---------------------------------------------------------------------------
// The diagnostics overlay
// ---------------------------------------------------------------------------

const overlay = createDiagnosticsOverlay({ clock: clockSync, controller: { state: controllerView }, log: driftLog, playback: start });

// ON THE TICK, NOT ON A CLOCK EVENT: the half-width widens with age between
// samples, so a repaint tied to new samples alone freezes a growing number.
function paintOverlay() {
  const lines = overlay.lines();
  clockLine.textContent = lines.clock;
  driftLine.textContent = lines.drift;
  controllerLine.textContent = lines.controller;
}

// Each step in its own try (D10): the controller's stale rule is what returns
// the rate to 1.0 when frames stop, so a failing start must not skip it.
function tickPlayback() {
  runTickSteps([
    ['acquisition', () => acquisition.poll()],
    ['playback-start', pollStart],
    ['controller', () => treatment.pollController(() => controller.poll())],
    ['overlay', paintOverlay],
    ['controls', renderControls],
  ], reportStep);
}

renderControls();
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
  // `start.state()`, so a key of the same name there would be silently
  // overwritten by this one rather than colliding visibly.
  controller: controllerView,
  // Measurement instrumentation, inert without `startTiming=1` (§11.2).
  startTiming: (afterSeq = 0) => telemetry.read(afterSeq),
  pitch: () => treatment.pitch(),
  treatmentEvidence: (maxEvents) => treatment.drainEvidence(maxEvents),
  delivery: () => delivery,
  hostLink: () => (link ? link.snapshot() : null),
  hostCounters: () => (hostOrigin ? hostOrigin.snapshot() : null),
  hostReceipts: (afterSeq = 0) => (link ? link.receipts(afterSeq) : null),
  playback: () => ({
    ...start.state(),
    callbacks: sampler.callbacks,
    sampling: sampler.running,
    seams: controller.seams,
    starts: starts.map((entry) => ({ ...entry })),
  }),
  timeline: () => acquisition.snapshot,
};

async function startApp() {
  try {
    // No fetch means no settings: the page does not guess a delivery (7a d1-findings D1-4).
    if (typeof window.fetch !== 'function') throw new Error('fetch is unavailable');
    const settingsResponse = await window.fetch('/app-settings', { cache: 'no-store' });
    if (!settingsResponse.ok) throw new Error(`HTTP ${settingsResponse.status}`);
    const settings = await settingsResponse.json();
    if (!settings || (settings.delivery !== 'host' && settings.delivery !== 'http') || !Array.isArray(settings.iceServers)) {
      throw new TypeError('invalid application settings');
    }
    delivery = settings.delivery;
    iceServers = settings.iceServers;
    if (delivery === 'host') {
      await loadHostTransport();
      if (role === 'viewer') installViewerLink();
    }
    client.connect();
  } catch (error) {
    setStatus(`settings unavailable: ${error?.message ?? error}`, { final: true });
    addNotice(`settings unavailable: ${error?.message ?? error}`, { warn: true });
  }
}

void startApp();
