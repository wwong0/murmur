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
import {
  ADDR_SERVER, CHAT_MAX_CODE_POINTS, ERROR_CODES, NAME_MAX_CODE_POINTS, TYPE_AHEAD, TYPE_HOST_STATUS,
  buildAheadEnvelope, buildHostStatusEnvelope, newReclaimSecret, readAheadReport, readBody,
  readHostStatus, readMemberText, readTrimmedText,
} from './lib/envelope.mjs';
import { createPlayer } from './lib/player.mjs';
import { createPeerBytes } from './lib/peer-bytes.mjs';
import { aheadReportDue, edgeIndexAfter, heldAheadMs } from './lib/held-ahead.mjs';
import { createHoldResume, createResumeRing, READY_HELD_AHEAD_MS } from './lib/hold-resume.mjs';
import { peerEngineConfig } from './lib/peer-engine-config.mjs';
import { PRODUCT_ENGINE_WINDOWS, validateEngineWindows } from './lib/engine-windows.mjs';
import { HEADROOM_DEFAULT, validateHeadroomFraction } from './lib/send-pace.mjs';
import { createClockSync, websocketProbe } from './lib/clock-sync.mjs';
import { createRoomTimeline } from './lib/room-timeline.mjs';
import { offsetView, stateIdentity } from './lib/playback-state.mjs';
import { createHostGrace } from './lib/host-grace.mjs';
import { createEndLatch, endInstant, endPauseMs, isEnded } from './lib/title-end.mjs';
import { createDriftLog } from './lib/frame-drift.mjs';
import { createDriftController } from './lib/drift-controller.mjs';
import { initializePlaybackTreatment } from './lib/playback-treatment.mjs';
import { createFrameSampler } from './lib/frame-sampler.mjs';
import { createPlaybackStart } from './lib/playback-start.mjs';
import { createFarSkip } from './lib/far-skip.mjs';
import { createFrameObserver, createStartTelemetry } from './lib/start-telemetry.mjs';
import { createDiagnosticsOverlay } from './lib/diagnostics-overlay.mjs';
import {
  ACQUISITION_BACKOFF_MS,
  ACQUISITION_REQUEST_TIMEOUT_MS,
  createPlaybackAcquisition,
} from './lib/playback-acquisition.mjs';
import {
  LATE_START_REPARK_MS, MAX_FUTURE_MS, MAX_LATE_REPARKS, PREPARE_LEAD_MS, PRESENTATION_ADVANCE_MS, START_COVER_MARGIN_MS,
  SKIP_DWELL_MS, SKIP_REPEAT_INTERVAL_MS, START_PROJECTION_MAX_MS, START_PROJECTION_MS, TRANSITION_LEAD_MS,
} from './lib/playback-leads.mjs';
import { runTickSteps } from './lib/tick-steps.mjs';
import { readHostAsks, setUrgentContext, setUrgentOrder, urgentContext, urgentDelay } from './lib/urgent-source.mjs';
import { viewerOrder } from './lib/edge-assignment.mjs';
import { ownPositionMs, requestClass } from './lib/urgent-request.mjs';
import { createWireMeter } from './lib/wire-meter.mjs';
import { controlInForce } from './lib/edge-control.mjs';
import { createOpfsBackend, createWebLocks } from './lib/prepared-store-opfs.mjs';
import { createPreparedStore } from './lib/prepared-store.mjs';
import { createPrepareClient } from './lib/prepare-client.mjs';
import { CHOOSABLE_STATES, createHostFileSource, hostFileSnapshot } from './lib/host-file-source.mjs';
import { keyframeNotice, refusalHelp } from './lib/file-help.mjs';
import { createPageView } from './lib/page-view.mjs';
import { syncDot } from './lib/sync-dot.mjs';
import { leaveWarns } from './lib/leave-warning.mjs';
import { joinTarget, readRoute } from './lib/route.mjs';
import { formatMediaTime } from './lib/media-time.mjs';
import { activityText, chatLine, labelMap, memberLabels } from './lib/room-people.mjs';
import { appendCapped } from './lib/capped-list.mjs';
import { clickActs } from './lib/player-click.mjs';
import { createStartWait, startWaitText } from './lib/start-wait.mjs';
import { createLinkKinds } from './lib/link-kinds.mjs';
import { probeStorage } from './lib/storage-probe.mjs';
import { createHostAnswer } from './lib/host-answer.mjs';
import { createHostStatusBook, ownHostStatus, statusDue, titleDue } from './lib/host-status.mjs';
import { isValidHostName } from './lib/title-fields.mjs';
import { mountScreens } from './room/screens.jsx';

const BUILD_ID = __BUILD_ID__;

const POSITION_OFFSET_MAX_MS = 600_000;
const suppliedPositionOffsetMs = globalThis.__waPositionOffsetMs;
const positionOffset = suppliedPositionOffsetMs === undefined
  ? { ms: 0, error: null }
  : !Number.isSafeInteger(suppliedPositionOffsetMs)
    ? { ms: null, error: 'position-offset-must-be-a-safe-integer' }
    : suppliedPositionOffsetMs < 0
      ? { ms: null, error: 'position-offset-must-be-non-negative' }
      : suppliedPositionOffsetMs > POSITION_OFFSET_MAX_MS
        ? { ms: null, error: `position-offset-must-be-at-most-${POSITION_OFFSET_MAX_MS}` }
        : { ms: suppliedPositionOffsetMs, error: null };
const offsetMs = positionOffset.ms ?? 0;
const suppliedHarnessSeek = globalThis.__waHarnessSeek;
const harnessSeekConfig = suppliedHarnessSeek === undefined
  ? { enabled: false, error: null }
  : suppliedHarnessSeek === true
    ? { enabled: true, error: null }
    : { enabled: false, error: 'harness-seek-flag-must-be-true' };
const suppliedEngineWindows = globalThis.__waEngineWindows;
const engineWindows = suppliedEngineWindows === undefined
  ? { windows: null, error: null }
  : validateEngineWindows(suppliedEngineWindows);
// T4 (design.md D2): read before load, as engineWindows is above. Absent gives
// the product default, unsupplied; an invalid supply falls back to the same
// default but is still marked supplied, and carries the error the harness reads
// to refuse the run — the host still serves at the default (an invalid supply
// must not break a room).
const suppliedHeadroomFraction = globalThis.__waHeadroomFraction;
const headroomFraction = (() => {
  if (suppliedHeadroomFraction === undefined) return { fraction: HEADROOM_DEFAULT, supplied: false, error: null };
  const { fraction, error } = validateHeadroomFraction(suppliedHeadroomFraction);
  return error ? { fraction: HEADROOM_DEFAULT, supplied: true, error } : { fraction, supplied: true, error: null };
})();

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
const initialRoute = readRoute(window.location.search);
let route = initialRoute.room ? 'room' : 'front';
let room = initialRoute.room;
let role = initialRoute.role;
let tabId = initialRoute.room ? (initialRoute.tab ?? randomTabId()) : null;
let activeClient = null;
let appStarted = false;

// One session-storage key whose failures are swallowed; undefined without storage.
function sessionKey(key) {
  let storage;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    return undefined;
  }
  if (!storage) return undefined;
  return {
    get() {
      try { return storage.getItem(key); } catch { return null; }
    },
    set(value) {
      try { storage.setItem(key, value); } catch {}
    },
    clear() {
      try { storage.removeItem(key); } catch {}
    },
  };
}

const PREPARED_NAME_KEY = 'watchalong.prepared-name';
const playbackStore = sessionKey('watchalong.playback-state');
const preparedName = sessionKey(PREPARED_NAME_KEY);
const nameStore = sessionKey('watchalong.name');
if (route !== 'room') playbackStore?.clear();

// The name the server last accepted for this tab, or undefined; an invalid stored value is none.
function storedName() {
  const stored = nameStore?.get();
  return readMemberText(stored, NAME_MAX_CODE_POINTS) ?? undefined;
}

// Start-timing instrumentation (executor-spec.md §11.2), off unless asked for.
// `record` returns early when disabled, so every site below is unconditional
// and the product keeps one code path either way.
const startTiming = params.get('startTiming') === '1';
const telemetry = createStartTelemetry({ enabled: startTiming });

// The telemetry schema drops fields it does not declare, so the offset is added
// where the ring is published. It is fixed for the page's life.
function startTimingWithOffset(afterSeq) {
  const reading = telemetry.read(afterSeq);
  if (!reading.enabled) return reading;
  return {
    ...reading,
    events: reading.events.map((event) => event.kind === 'action'
      && ['load', 'park', 'play'].includes(event.action)
      ? { ...event, positionOffsetMs: offsetMs }
      : event),
  };
}

const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${wsScheme}//${window.location.host}/ws`;

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const video = document.getElementById('video');
let elementMediaMs = null;

const INITIAL_VIEW = {
  status: 'unknown',
  ended: false,
  hostFile: { status: 'off', inputHidden: true, help: null, notice: null, state: 'off', choosable: false },
  hostStatus: { state: 'unknown', fraction: null, received: 0, lastAtMs: null, disbelieved: 0 },
  // Whether this page's own source reports `hostStatus`: the host's file card shows it, and the
  // viewer's waiting card must not.
  hostSide: false,
  // 'reconnecting' only while a lost connection is being retried (design.md D13, D16).
  connection: 'connecting',
  title: { name: null },
  overlay: { clock: '', drift: '', bytes: '', controller: '', startWait: '', links: '' },
  overlayVisible: false,
  fullscreen: false,
  bar: {
    faded: false,
    positionMs: 0,
    durationMs: null,
    preparing: false,
    time: '0:00 / 0:00',
    syncDot: { state: 'idle', title: 'no figure' },
    syncEstimateMs: null,
    syncShown: false,
    syncPlaying: false,
  },
  // Which of `#play`/`#pause` the bar shows (design.md D8); both stay mounted either way.
  playSlot: 'play',
  roster: [],
  people: [],
  selfClientId: null,
  ownName: '',
  namePromptRequest: 0,
  chatOutcome: { id: null, result: null },
  notices: [],
  activity: [],
  controlMode: 'open',
  route,
  joinError: '',
  invite: { href: room ? `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}` : '', text: 'invite link' },
  controls: {
    play: { text: 'play', disabled: false, hidden: false },
    pause: { text: 'pause', disabled: false, hidden: false },
    'back-10': { text: 'back 10s', disabled: false, hidden: false },
    'forward-10': { text: 'forward 10s', disabled: false, hidden: false },
    'control-mode': { text: 'mode: host', disabled: false, hidden: false },
    mute: { text: 'unmute', disabled: false, hidden: false },
  },
};
const view = createPageView(INITIAL_VIEW, {
  onError: (error, key) => console.error('[app] view subscriber failed', key, error),
});
document.addEventListener('fullscreenchange', () => {
  view.set('fullscreen', document.fullscreenElement != null);
});
let noticeSeq = 0;
const NOTICE_CAP = 100;
const startWait = createStartWait();
let reportStats = null;
const linkKinds = createLinkKinds({
  links: openHostLinks,
  readStats: () => reportStats,
  onChange: (links) => view.set('overlay', { ...view.get().overlay, links }),
});

function renderMute() {
  const controls = view.get().controls;
  view.set('controls', { ...controls, mute: { ...controls.mute, text: video.muted ? 'unmute' : 'mute' } });
}

function addNotice(text, { warn = false } = {}) {
  view.set('notices', appendCapped(view.get().notices, {
    seq: noticeSeq++,
    text: `[${new Date().toLocaleTimeString()}] ${text}`,
    warn,
  }, NOTICE_CAP));
}

function renderRoster(roster) {
  view.set('roster', (roster ?? []).map((member) => `${member.tabId} · ${member.role} · ${member.clientId}`));
  try {
    view.set('people', memberLabels(roster));
  } catch (error) {
    addSubscriberFailure('participants', error);
  }
}

// The activity list is a view for a person, so a failure in it reports itself and never
// reaches the handlers around it (a throw in a room-client subscriber reaches nobody).
const ACTIVITY_CAP = 100;
let activitySeq = 0;

function addActivity(event, labels) {
  try {
    const text = activityText(event, labels ?? labelMap(view.get().people));
    if (text === null) return;
    const entry = { id: activitySeq++, text, warn: event.kind === 'refused' || event.kind === 'rate' };
    view.set('activity', [...view.get().activity, entry].slice(-ACTIVITY_CAP));
  } catch (error) {
    addSubscriberFailure('activity', error);
  }
}

function addChatLine(env) {
  try {
    const line = chatLine(env, view.get().people);
    if (line === null) return;
    view.set('activity', [...view.get().activity, { id: activitySeq++, ...line, warn: false }].slice(-ACTIVITY_CAP));
  } catch (error) {
    addSubscriberFailure('activity', error);
  }
}

// This member's own name and chat sends, by id, so a refusal or a relay can be told from anyone's.
const OWN_SENDS_KEPT = 32;
const ownSends = new Map();

// Sends only text the rule accepts, trimmed; the server still decides. Returns the id, or null.
function sendOwn(kind, text, maxCodePoints, send) {
  const value = readTrimmedText(text, maxCodePoints);
  if (value === null) return null;
  const id = send(value);
  if (id === null || id === undefined) return id;
  ownSends.set(id, kind);
  if (ownSends.size > OWN_SENDS_KEPT) ownSends.delete(ownSends.keys().next().value);
  return id;
}

// The own entry in the server's latest roster decides what the page shows and keeps as its name.
function syncOwnMember(roster) {
  const mine = (roster ?? []).find((member) => member?.clientId === client.clientId);
  if (!mine) return;
  view.set('selfClientId', mine.clientId);
  view.set('ownName', typeof mine.name === 'string' ? mine.name : '');
  if (typeof mine.name === 'string') nameStore?.set(mine.name);
  else nameStore?.clear();
}

// What a person can DO about a refusal, where there is anything. Absence is the
// ordinary case and must stay readable: a code missing from here reports itself
// and the server's detail, never another code's remedy.
const REFUSAL_REMEDIES = {
  'tab-taken': () => `the tab name "${tabId}" is in use in room "${room}" — open this page with a different tab= value`,
  'host-taken': () => `the room "${room}" already has a host — open this page with role=viewer`,
};

// Some statuses are the last word: superseded, or refused for good. Both are
// followed by a socket close, whose ordinary "disconnected" status would
// otherwise land on top of the only message saying WHY the page stopped. Any
// later change adding a third reason a page stops needs this flag too.
let terminal = false;

function setStatus(text, { final = false } = {}) {
  if (terminal) return;
  view.set('status', text);
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

function rtcConfig() {
  return {
    iceServers,
    iceTransportPolicy: params.get('iceTransportPolicy') === 'relay' ? 'relay' : 'all',
  };
}

async function readHostSource(path) {
  if (hostFile) return hostFile.read(path);
  if (!nativeFetch) throw new Error('native fetch is unavailable');
  const response = await nativeFetch(new URL(path, location.href), { headers: { 'x-app-tab': tabId }, cache: 'no-store' });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
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
    pace: { fraction: headroomFraction.fraction },
    // T14 (design.md D2, reversed): the estimate reads the wire, not the channels' drain.
    wire: createWireMeter({ peers: () => hostAnswer.peerConnections() }),
  });
  hostAnswer = createHostAnswer({
    client,
    RTCPeerConnection,
    rtcConfig,
    origin: () => hostOrigin,
    isActive: isHostSide,
    report: addSubscriberFailure,
  });
  onEnvelope('host-link-offer', 'host-link offer', async (env) => {
    await hostAnswer.answerOffer(env);
    void linkKinds.refresh();
  });
  onEnvelope('host-link-ice', 'host-link ICE', async (env) => {
    await hostAnswer.routeIce(env);
    void linkKinds.refresh();
  });
  hostSideInstalled = true;
}

// T13 (design.md D2): the viewer's own start or resume segments, and the playlist,
// go to the host marked urgent; the middle class follows the engine window.
function urgentRequestFor(path) {
  try {
    const nowSharedMs = clockSync.sharedNow();
    const positionMs = ownPositionMs({
      control: controlInForce().control,
      state: viewState(),
      sharedMs: nowSharedMs,
      elementMs: elementMediaMs,
    });
    const nearMs = (engineWindows.windows?.highDemandTimeWindow
      ?? PRODUCT_ENGINE_WINDOWS.highDemandTimeWindow) * 1000;
    return requestClass({
      control: controlInForce().control,
      path,
      positionMs,
      segments: link?.segmentTimes() ?? null,
      runwayMs: READY_HELD_AHEAD_MS,
      nearMs,
    });
  } catch (error) {
    addNotice(`urgent request: ${error?.message ?? String(error)}`);
    return null;
  }
}

function installViewerLink() {
  if (typeof RTCPeerConnection !== 'function') throw new Error('RTCPeerConnection is unavailable');
  let lastState = null;
  link = createHostLink({
    client,
    RTCPeerConnection,
    rtcConfig: rtcConfig(),
    urgency: urgentRequestFor,
    hostPreparing: () => hostWithholds(),
    onChange: (snapshot) => {
      if (snapshot.state !== lastState) {
        lastState = snapshot.state;
        addNotice(`host link: ${snapshot.state}`);
        void linkKinds.refresh();
      }
      schedulePollStart(0);
    },
  });
  window.fetch = link.createShimFetch({ realFetch: nativeFetch, baseUrl: location.href });
  window.XMLHttpRequest = link.createShimXhr({ RealXHR: window.XMLHttpRequest, baseUrl: location.href });
  void linkKinds.refresh();
}

// 11-2 D6: the host's own player reads the store. Imported here, as the host transport is.
async function installHostFileLink() {
  const { createPreparedMediaLink } = await import('./lib/prepared-media-link.mjs');
  const { createShimFetch, createShimXhr } = await import('./lib/host-link-shim.mjs');
  const link = createPreparedMediaLink({ read: (path) => hostFile.read(path) });
  window.fetch = createShimFetch({ link, realFetch: nativeFetch, baseUrl: location.href });
  window.XMLHttpRequest = createShimXhr({ link, RealXHR: window.XMLHttpRequest, baseUrl: location.href });
}

function openHostLinks() {
  if (client.role === 'host') return hostAnswer?.peerConnections?.() ?? [];
  if (link?.snapshot?.().state !== 'open') return [];
  const peerConnection = link.peerConnection?.();
  return peerConnection ? [peerConnection] : [];
}

// ---------------------------------------------------------------------------
// Room client
// ---------------------------------------------------------------------------

const eventSubscribers = new Map();
const envelopeSubscribers = new Map();

// D4: the front page has no room, so the client is made at Host or load; a
// subscription made before it is replayed onto it, and its unsubscribe still detaches.
function subscribe(map, method, type, listener) {
  const entry = { listener, off: activeClient?.[method](type, listener) };
  if (!map.has(type)) map.set(type, new Set());
  map.get(type).add(entry);
  return () => {
    map.get(type)?.delete(entry);
    entry.off?.();
  };
}

function activateClient() {
  if (activeClient) return;
  activeClient = createRoomClient({ url, room, tabId, role: role ?? 'viewer', name: storedName() });
  for (const [type, entries] of eventSubscribers) {
    for (const entry of entries) entry.off = activeClient.onEvent(type, entry.listener);
  }
  for (const [type, entries] of envelopeSubscribers) {
    for (const entry of entries) entry.off = activeClient.on(type, entry.listener);
  }
}

const client = {
  get clientId() { return activeClient?.clientId ?? null; },
  get role() { return activeClient?.role ?? role; },
  get roster() { return activeClient?.roster ?? []; },
  get lastSeq() { return activeClient?.lastSeq ?? null; },
  get isConnected() { return activeClient?.isConnected ?? false; },
  get isJoined() { return activeClient?.isJoined ?? false; },
  get name() { return activeClient?.name ?? null; },
  setName(name) { return activeClient ? activeClient.setName(name) : null; },
  sendChat(text) { return activeClient ? activeClient.sendChat(text) : null; },
  onEvent(type, listener) { return subscribe(eventSubscribers, 'onEvent', type, listener); },
  on(type, listener) { return subscribe(envelopeSubscribers, 'on', type, listener); },
  send(envelope) {
    return activeClient ? activeClient.send(envelope) : null;
  },
  request(options) {
    return activeClient ? activeClient.request(options) : Promise.reject(new Error('room is not active'));
  },
  // The clock probe's only route to the server: without it no page ever has an estimate.
  echo(timeoutMs) {
    return activeClient ? activeClient.echo(timeoutMs) : Promise.reject(new Error('room is not active'));
  },
  connect() { activeClient?.connect(); },
  close() { activeClient?.close(); },
};

if (route === 'room') activateClient();
let delivery = 'host';
let iceServers = [];
let trackerUrl = null;
// D8: on the page no creation precedes /app-settings (both connects follow it), so
// only entry suites that create first read this; true keeps their start as it was.
let autoStart = true;
let peerExchange = null;
// T10 (design.md D7): every reader of "does this room have peer exchange" reads
// this one value, derived once in startApp — not the delivery/trackerUrl pair
// each reader used to re-check for itself.
let roomHasPeerExchange = false;
const peerBytesPublisher = createPeerBytes();
// A viewer publishes this stub until its engine is attached, so no reading
// before load says attribution is unavailable.
let peerBytesRead = () => ({ attribution: null, peerExchange: peerExchange ?? 'off', peerId: null, peerIds: [] });
let peerEngine = null;
let link = null;
let hostOrigin = null;
let hostAnswer = null;
const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
let createHostLink = null;
let createHostOrigin = null;
let hostSideInstalled = false;
let hostFile = null;
let hostFileChooserOpen = false;
let mediaSource = null;
let targetSegmentSeconds = null;
let hostGraceMs = 10_000;
let hostGrace = null;
let gracePauses = 0;
const hostStatusBook = createHostStatusBook();
let lastStatusSent = null;
let statusSends = 0;
// Design D10: the bar fades after this long without a pointer move over #player.
const FADE_AFTER_MS = 3000;
let lastPointerMoveAt = null;
const PREPARED_KEY_NAME = 'watchalong.prepared-key';
const endLatch = createEndLatch();
const graceLatch = createEndLatch();
const titleLatch = createEndLatch();
let lastEndPauseInstant = null;
let lastGracePauseInstant = null;
let loadedTitle;

function isHostSide() {
  return delivery === 'host' && client.role === 'host';
}

function ownStatus() {
  const name = mediaSource === 'file' ? preparedName?.get() ?? null : null;
  return ownHostStatus({ mediaSource, hostFile: hostFile?.snapshot() ?? null, name });
}

function rosterHasHost() {
  return client.roster.some((member) => member?.role === 'host');
}

// The host status this page acts on: its own as the host, the believed report
// otherwise, and `absent` under host delivery while the roster has no host.
function hostStatusNow() {
  if (isHostSide()) return ownStatus();
  const status = hostStatusBook.current(client.roster);
  return delivery === 'host' && !rosterHasHost()
    ? { ...status, state: 'absent', fraction: null, hostId: null, atMs: null }
    : status;
}

function observeHostGrace() {
  if (!hostGrace || delivery !== 'host' || isHostSide()) return;
  hostGrace.observe({ hostPresent: rosterHasHost(), atSharedMs: clockSync.sharedNow() });
}

// 11-2 D5: under `file` this is the host's only route into the room.
function paintHostFile(snapshot) {
  const detail = snapshot.refusal?.message ?? snapshot.failure;
  const help = snapshot.refusal ? refusalHelp(snapshot.refusal) : null;
  const notice = snapshot.state === 'ready' ? keyframeNotice(snapshot.manifest) : null;
  view.set('hostFile', {
    status: detail ? `${snapshot.state}: ${detail}` : snapshot.state,
    inputHidden: snapshot.state === 'ready',
    help,
    notice,
    state: snapshot.state,
    choosable: CHOOSABLE_STATES.includes(snapshot.state),
  });
  sendHostStatus(false);
  paintHostStatus();
  maybeIssueTitle();
}

function sendHostStatus(force) {
  if (!isHostSide() || !client.isJoined) return;
  const next = ownStatus();
  const nowMs = pageNow();
  if (force || statusDue({ nowMs, last: lastStatusSent, next })) {
    client.send(buildHostStatusEnvelope(next));
    lastStatusSent = { ...next, atMs: pageNow() };
    statusSends += 1;
  }
}

function paintHostStatus() {
  const own = isHostSide();
  const status = hostStatusNow();
  const counts = hostStatusBook.counts();
  // Before `hostStatus`: a host's first `choosing` must never render as a viewer's card.
  view.set('hostSide', own);
  view.set('hostStatus', {
    state: status.state,
    fraction: status.fraction,
    received: own ? statusSends : counts.received,
    lastAtMs: own ? lastStatusSent?.atMs ?? null : status.atMs,
    disbelieved: own ? 0 : counts.disbelieved,
  });
  view.set('title', { name: status.state === 'ready' ? status.name ?? null : null });
}

let malformedHostStatus = 0;

onEnvelope(TYPE_HOST_STATUS, 'host status', (env) => {
  if (client.role === 'host') return;
  const report = readHostStatus(env);
  if (!report) {
    malformedHostStatus += 1;
    return;
  }
  hostStatusBook.accept(report, client.roster, pageNow());
  paintHostStatus();
  renderControls();
  schedulePollStart(0);
});

async function loadHostTransport() {
  if (createHostLink && createHostOrigin) return;
  const [linkModule, originModule] = await Promise.all([
    import('./lib/host-link.mjs'),
    import('./lib/host-origin.mjs'),
  ]);
  createHostLink = linkModule.createHostLink;
  reportStats = linkModule.reportStats;
  createHostOrigin = originModule.createHostOrigin;
}

// The first connect is not a reconnect, a second disconnect before any connect adds nothing
// to a line already saying the connection is down, and a page that will not reconnect never
// says it is trying.
let everConnected = false;
let connectionLost = false;

client.onEvent('status', ({ connected, superseded }) => {
  setStatus(connected ? `connected (room "${room}", tab "${tabId}", role "${client.role}")` : 'disconnected');
  addNotice(connected ? 'connected' : 'disconnected');
  if (connected && connectionLost) addActivity({ kind: 'reconnected' });
  const retrying = !connected && everConnected && !superseded && !terminal;
  if (retrying && !connectionLost) addActivity({ kind: 'reconnecting' });
  // A close that will not be retried leaves the value alone, so a dead page never says it is trying.
  if (connected || retrying) view.set('connection', connected ? 'connected' : 'reconnecting');
  connectionLost = everConnected && !connected;
  everConnected = everConnected || connected;
});

client.onEvent('reconnecting', ({ inMs }) => {
  setStatus(`reconnecting in ${inMs}ms…`);
  addNotice(`reconnecting in ${inMs}ms`);
});

client.onEvent('joined', (joined) => {
  // The role reported is the one the server gave this membership, not the one
  // the query string asked for.
  setStatus(`connected (room "${room}", tab "${tabId}", role "${client.role}")`);
  if (delivery === 'host' && joined.role === 'host') {
    sendHostStatus(true);
    hostAnswer?.closeAll();
    if (nativeFetch) installHostSide().catch((error) => addSubscriberFailure('host transport', error));
  }
  addNotice(`joined as ${joined.clientId} (${joined.role})`);
  renderRoster(joined.roster);
  syncOwnMember(joined.roster);
  observeHostGrace();
  paintHostStatus();
  runTickSteps([['urgent-context', updateUrgentContext]], reportStep);
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
  const remedy = REFUSAL_REMEDIES[code]?.();
  setStatus(`refused (${code}): ${remedy ?? detail ?? 'this page will not reconnect'}`, { final: true });
  addNotice(`refused (${code}): ${detail ?? remedy ?? ''}`, { warn: true });
});

client.onEvent('gap', ({ expected, actual }) => {
  addNotice(`gap detected: expected seq ${expected}, got ${actual}`, { warn: true });
});

// A leaver is gone from the roster that just arrived, so the label comes from the one held
// before it; a joiner is only in the new one. Own join says nothing.
function notePresence(body, labelsBefore) {
  const clientId = body.member?.clientId;
  if (body.event === 'leave') addActivity({ kind: 'leave', clientId }, labelsBefore);
  if (body.event === 'join' && clientId !== client.clientId) addActivity({ kind: 'join', clientId });
  if (body.event === 'name') {
    const labelsAfter = labelMap(view.get().people);
    addActivity({ kind: 'rename', before: labelsBefore.get(clientId), after: labelsAfter.get(clientId) });
  }
}

client.on('presence', (env) => {
  const body = readBody(env);
  // A member can relay an envelope typed `presence`; only the server's closes peers (7a d1-findings D1-1).
  if (env.from === ADDR_SERVER && isHostSide()) hostAnswer?.closeDeparted(body.roster);
  if (env.from === ADDR_SERVER && isHostSide()) void linkKinds.refresh();
  if (env.from === ADDR_SERVER && body.event === 'join' && body.member?.clientId !== client.clientId) sendHostStatus(true);
  addNotice(`presence: ${body.event} — ${body.member?.tabId ?? body.member?.clientId}`);
  const labelsBefore = labelMap(view.get().people);
  renderRoster(body.roster);
  if (env.from === ADDR_SERVER) syncOwnMember(body.roster);
  if (env.from === ADDR_SERVER) notePresence(body, labelsBefore);
  if (env.from === ADDR_SERVER) observeHostGrace();
  paintHostStatus();
  runTickSteps([['urgent-context', updateUrgentContext]], reportStep);
  schedulePollStart(0);
});

// A relayed chat message is a line in the activity list and never a notice. A body the reader
// refuses is dropped: the server cannot send one, but the page does not rely on that.
onEnvelope('chat', 'chat', (env) => {
  addChatLine(env);
  if (env.from === client.clientId && ownSends.get(env.id) === 'chat') {
    view.set('chatOutcome', { id: env.id, result: 'relayed' });
  }
});

// A refusal of this member's own send, told by the id it names. A rate refusal shows the
// warning line; a refused chat tells the input to keep its text.
onEnvelope('error', 'send refusal', (env) => {
  if (env.from !== ADDR_SERVER || !ownSends.has(env.replyTo)) return;
  const kind = ownSends.get(env.replyTo);
  ownSends.delete(env.replyTo);
  if (kind === 'chat') view.set('chatOutcome', { id: env.replyTo, result: 'refused' });
  if (readBody(env)?.code === ERROR_CODES.RATE_LIMITED) addActivity({ kind: 'rate' });
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
player.onFinished(() => runTickSteps([['finished-fragment', () => schedulePollStart(0)]], reportStep));

// THE PITCH TREATMENT, BEFORE THE SAMPLER, THE CONTROLLER AND ANY OPEN: the
// adopted floor is only licensed by a pre-playback `preservesPitch = false`
// that read back false, and this is the one place that write happens. The
// verifier opts in to the treatment's event history with treatmentEvidence=1.
const pageNow = () => performance.timeOrigin + performance.now();

function maybeAskStartWait() {
  if (acquisition.state?.current.playing !== true) return;
  startWait.asked(pageNow());
}

function captureStartWaitFrame() {
  const afterSeq = startWait.awaitedAfterSeq();
  if (afterSeq === null) return;
  const record = driftLog.read({ afterSeq }).records[0];
  if (!record) return;
  startWait.framePresented(record.displaySharedMs - record.clock.offsetMs);
}

const treatment = initializePlaybackTreatment({
  video,
  opened: false,
  now: pageNow,
  notify: addNotice,
  evidence: params.get('treatmentEvidence') === '1',
});

// Applied play, pause and seek, and this member's own refusal, as activity lines (design.md
// D13). The title's end is "The film ended", not a member's pause; a pause with no host in the
// roster is the grace pause, which "Host left" already says.
function noteOutcome(env, outcome, ownSystemPause) {
  const kind = env.payload?.kind;
  if (outcome === 'notPermitted' && env.from === client.clientId && !ownSystemPause) {
    addActivity({ kind: 'refused', op: kind ?? 'operation' });
  }
  if (outcome !== 'applied') return;
  if (kind === 'play') addActivity({ kind: 'play', from: env.from });
  if (kind === 'seek') addActivity({ kind: 'seek', from: env.from, positionMs: env.payload.positionMs });
  if (kind !== 'pause') return;
  if (titleEnded()) addActivity({ kind: 'ended' });
  // A pause carries no position, so the line takes the replicated state's.
  else if (rosterHasHost()) addActivity({ kind: 'pause', from: env.from, positionMs: acquisition.state?.current.mediaMs });
}

// The replicated playback state (change 5 design.md D4). Built before connect
// so its `joined` subscriber sees the first join.
const acquisition = createPlaybackAcquisition({
  client,
  clock: clockSync,
  store: playbackStore,
  room: () => room,
  settings: {
    transitionLeadMs: TRANSITION_LEAD_MS,
    maxFutureMs: MAX_FUTURE_MS,
    requestTimeoutMs: ACQUISITION_REQUEST_TIMEOUT_MS,
    backoffMs: ACQUISITION_BACKOFF_MS,
    holds: () => roomHasPeerExchange,
    autoStart: () => autoStart,
  },
  mintLineage: newReclaimSecret,
  onOutcome: ({ env, outcome }) => {
    // D7: this member's end pause may be rejected as stale or by the control mode; no notice.
    // The same holds for its grace pause.
    const ownSystemPause = env.payload?.kind === 'pause'
      && [lastEndPauseInstant, lastGracePauseInstant].includes(env.payload?.atSharedMs);
    if (outcome !== 'applied' && env.from === client.clientId && !ownSystemPause) {
      addNotice(`your ${env.payload?.kind ?? 'operation'} was rejected: ${outcome}`, { warn: true });
    }
    renderControls();
    if (outcome === 'applied') {
      discardStaleTitle();
      maybeIssueTitle();
      updateUrgentContext();
      schedulePollStart(0);
    }
    noteOutcome(env, outcome, ownSystemPause);
  },
  report: (where, error) => addNotice(`playback state ${where} failed: ${error?.message ?? error}`, { warn: true }),
});

window.addEventListener('beforeunload', (event) => {
  if (leaveWarns({ role: client.role, playing: acquisition.state?.current.playing === true })) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// T7/T8 (design.md D5, D3): the viewer's held-ahead, the reports the host has
// seen, and the resume rule's own ring. Kept beside `acquisition`, not inside
// it — held-ahead and the resume rule are both pure modules of their own.
let heldAheadValue = null;
let lastAheadSentAtPageMs = null;
let lastAheadSentKey = null;
let lastAheadSentReady = false;
const aheadReports = new Map();
let malformedAheadReports = 0;
const holdResume = createHoldResume();
const resumeRing = createResumeRing(256);

function updateHeldAhead() {
  // T7: never from `video.currentTime` (CONSTRAINTS.md → playback), and never
  // on the host's page — the drift line's "not reported" arm covers exactly
  // this absence and a viewer's own before its first value.
  if (client.role === 'host') return;
  const state = viewState();
  if (!state) return;
  const segments = peerBytesPublisher.finishedSegments();
  const positionMs = state.current.mediaMs;
  const sharedMs = clockSync.sharedNow();
  const ownPosition = ownPositionMs({
    control: controlInForce().control,
    state,
    sharedMs,
    elementMs: elementMediaMs,
  });
  const ownHeldAhead = Number.isFinite(ownPosition)
    ? heldAheadMs({ positionMs: ownPosition, segments })
    : null;
  const edgeIndex = Number.isFinite(ownPosition) ? edgeIndexAfter({ positionMs: ownPosition, segments }) : null;
  heldAheadValue = {
    heldAheadMs: heldAheadMs({ positionMs, segments }),
    ownPositionMs: ownPosition,
    ownHeldAheadMs: ownHeldAhead,
    edgeIndex,
    positionMs,
    atPageMs: pageNow(),
  };
}

function sendAheadReport() {
  if (!roomHasPeerExchange || client.role === 'host') return;
  const state = acquisition.state;
  if (!state || state.current.held !== true || !heldAheadValue) return;
  const nowPageMs = pageNow();
  const key = `${state.lineage}:${state.version}`;
  if (!aheadReportDue({
    nowMs: nowPageMs,
    lastSentMs: lastAheadSentAtPageMs,
    lastSentKey: lastAheadSentKey,
    lastSentReady: lastAheadSentReady,
    key,
    heldAheadMs: heldAheadValue.heldAheadMs,
    readyMs: READY_HELD_AHEAD_MS,
    intervalMs: 1000,
  })) return;
  const host = client.roster.find((member) => member && member.role === 'host');
  if (!host) return;
  lastAheadSentAtPageMs = nowPageMs;
  lastAheadSentKey = key;
  lastAheadSentReady = heldAheadValue.heldAheadMs >= READY_HELD_AHEAD_MS;
  client.send(buildAheadEnvelope({
    to: host.clientId,
    lineage: state.lineage,
    version: state.version,
    heldAheadMs: heldAheadValue.heldAheadMs,
  }));
}

onEnvelope(TYPE_AHEAD, 'ahead report', (env) => {
  if (!roomHasPeerExchange || client.role !== 'host') return;
  const report = readAheadReport(env);
  if (!report) {
    malformedAheadReports += 1;
    return;
  }
  aheadReports.set(report.from, { lineage: report.lineage, version: report.version, heldAheadMs: report.heldAheadMs });
  driveHoldResume();
});

function driveHoldResume() {
  if (!roomHasPeerExchange || client.role !== 'host') return;
  const nowSharedMs = clockSync.sharedNow();
  const result = holdResume.evaluate({
    nowSharedMs,
    state: acquisition.state,
    roster: client.roster,
    reports: Object.fromEntries(aheadReports),
  });
  if (!result) return;
  const issuedOk = issue('play');
  holdResume.issued(result.identity, issuedOk, nowSharedMs);
  resumeRing.push({ ...result, issuedAtSharedMs: nowSharedMs, holdMs: nowSharedMs - result.heldAtSharedMs });
}

const viewState = () => offsetView(acquisition.state, offsetMs);
const timeline = createRoomTimeline({ readState: viewState });
const roomTimeline = createRoomTimeline({ readState: () => acquisition.state });

function updateUrgentContext() {
  const viewerIds = viewerOrder(client.roster);
  setUrgentOrder({ viewerIds, selfId: client.clientId });
  const nowSharedMs = clockSync.sharedNow();
  const roomMediaMs = Number.isFinite(nowSharedMs) ? timeline.mediaMsAt(nowSharedMs) : null;
  if (!Number.isFinite(roomMediaMs)) return;
  if (elementMediaMs !== null) elementMediaMs = mediaFromElementMs(video.currentTime * 1000);
  const ownMediaMs = ownPositionMs({
    control: controlInForce().control,
    state: viewState(),
    sharedMs: nowSharedMs,
    elementMs: elementMediaMs,
  });
  const current = acquisition.state?.current;
  const held = current?.held === true;
  setUrgentContext({
    held,
    // The held state's instant on the engine's clock, `performance.now()` (design.md D4).
    notBeforeMs: held && Number.isFinite(current.atSharedMs) ? Math.max(0, performance.now() + current.atSharedMs - nowSharedMs) : 0,
    roomMediaMs,
    ownMediaMs: ownMediaMs ?? roomMediaMs,
    viewerIds,
    selfId: client.clientId,
  });
}

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

// The title's end, as the playlist gives it; null until the last segment is known.
function titleEndMs() {
  return player.lastSegment()?.mediaEndMs ?? null;
}

// Where the load's media time sits on the element's timeline, in ms; null while unknown.
function placementMs() {
  return player.placement().placementMs;
}

function mediaFromElementMs(ms) {
  const p = placementMs();
  return Number.isFinite(p) && Number.isFinite(ms) ? ms - p : null;
}

function mediaDurationS() {
  const p = placementMs();
  return Number.isFinite(p) && Number.isFinite(video.duration) ? video.duration - p / 1000 : NaN;
}

function titleEnded() {
  return isEnded(acquisition.state, titleEndMs());
}

function renderControls() {
  const state = acquisition.state;
  const ended = titleEnded();
  const preparing = hostBlocks();
  const ready = (kind) => controlsReady(kind);
  const controls = {
    play: {
      text: ended ? 'Watch again' : 'play',
      disabled: preparing || (ended ? !ready('seek') : !(ready('play') && !state?.current.playing)),
      hidden: false,
    },
    // T5 (design.md D3, "any member's own play or pause ends a hold"): a held
    // state is paused, so pause is enabled to let a person end the hold.
    pause: { text: 'pause', disabled: !(ready('pause') && (state?.current.playing || state?.current.held)), hidden: false },
    'back-10': { text: 'back 10s', disabled: preparing || !ready('seek'), hidden: false },
    'forward-10': { text: 'forward 10s', disabled: preparing || !ready('seek'), hidden: false },
    // Every member sees the settings menu; a viewer's group is disabled, not hidden (design.md D11).
    'control-mode': { text: `mode: ${state?.controlMode === 'host' ? 'open' : 'host'}`, disabled: client.role !== 'host' || !ready('control-mode'), hidden: false },
    mute: { text: view.get().controls.mute.text, disabled: false, hidden: false },
  };
  view.set('ended', ended);
  view.set('controls', controls);
  view.set('controlMode', state?.controlMode === 'host' ? 'host' : 'open');
  const playSlot = state?.current.playing === true ? 'pause' : 'play';
  view.set('playSlot', playSlot);
  if (video?.dataset) video.dataset.clickable = String(clickActs(controls, playSlot));
}

function renderBar() {
  const durationMs = titleEndMs();
  const nowSharedMs = clockSync.sharedNow();
  const mappedMs = Number.isFinite(nowSharedMs) ? timeline.mediaMsAt(nowSharedMs) : null;
  const positionMs = Number.isFinite(mappedMs)
    ? Math.max(0, Number.isFinite(durationMs) ? Math.min(durationMs, mappedMs) : mappedMs)
    : 0;
  const playing = start.state().playing === true;
  const nowPageMs = pageNow();
  if (lastPointerMoveAt === null) lastPointerMoveAt = nowPageMs;
  const faded = playing && nowPageMs - lastPointerMoveAt >= FADE_AFTER_MS;
  const ended = titleEnded();
  const preparing = hostBlocks();
  const controllerState = controllerView();
  view.set('bar', {
    faded,
    positionMs,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    preparing,
    time: ended ? 'Ended' : `${formatMediaTime(positionMs)} / ${formatMediaTime(durationMs)}`,
    syncDot: syncDot({ playing, mode: controllerState.mode, estimateMs: controllerState.estimateMs }),
    // Beside `syncDot`, whose two fields `sync-dot.mjs` holds: the tooltip's figure needs the number.
    syncEstimateMs: Number.isFinite(controllerState.estimateMs) ? controllerState.estimateMs : null,
    // The dot shows once a title is loaded and someone else is in the room, so an idle one can
    // say why it has no figure (11b design.md D10; 12e D9); `syncPlaying` picks which words.
    syncShown: Number.isFinite(durationMs) && client.roster.length > 1,
    syncPlaying: playing,
  });
}

function issue(kind, args) {
  const issued = acquisition.issue(kind, args);
  renderControls();
  return issued;
}

// D8: a viewer holds one title's media. An adopted state changes the title with no
// applied operation, so the tick runs this as well as the outcome handler.
function discardStaleTitle() {
  if (loadedTitle === undefined || (acquisition.state?.title ?? null) === loadedTitle) return;
  sampler.stop();
  player.destroy();
  peerEngine = null;
  start.unload();
  startWait.reset();
  loadedTitle = undefined;
  schedulePollStart(0);
}

function maybeIssueTitle() {
  const state = acquisition.state;
  const id = titleDue({ own: ownStatus(), state });
  const nowSharedMs = clockSync.sharedNow();
  if (!id || !state || !Number.isFinite(nowSharedMs) || nowSharedMs < state.current.atSharedMs
    || !titleLatch.take({ lineage: state.lineage, version: state.version })) return;
  issue('title', { title: id });
}

function seekBy(deltaMs) {
  const now = clockSync.sharedNow();
  if (!Number.isFinite(now)) return false;
  const positionMs = roomTimeline.mediaMsAt(now + TRANSITION_LEAD_MS);
  if (!Number.isFinite(positionMs)) return false;
  return issue('seek', { positionMs: positionMs + deltaMs });
}

const harnessSeek = harnessSeekConfig.enabled
  ? (deltaMs) => {
      if (!Number.isFinite(deltaMs)) throw new TypeError('harnessSeek deltaMs must be finite');
      const atPageMs = pageNow();
      return { issued: seekBy(deltaMs), atPageMs };
    }
  : null;

function hostRoom() {
  if (route !== 'front') return;
  room = newReclaimSecret();
  role = 'host';
  tabId = randomTabId();
  route = 'room';
  history.replaceState(null, '', `?room=${room}&role=host&tab=${tabId}`);
  view.set('route', route);
  view.set('invite', { href: `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`, text: 'invite link' });
  activateClient();
  startRoomApp();
}

function joinRoom(text) {
  const target = joinTarget(text);
  if (target === null) {
    view.set('joinError', 'enter an invite link or a room name');
    return;
  }
  location.assign(`/room.html?room=${encodeURIComponent(target)}`);
}

const actions = {
  host: hostRoom,
  join: joinRoom,
  play: () => (titleEnded() ? issue('seek', { positionMs: 0 }) : issue('play')),
  pause: () => issue('pause'),
  back10: () => seekBy(-10_000),
  forward10: () => seekBy(10_000),
  seekBy: (deltaMs) => seekBy(deltaMs),
  controlMode: () => {
    const state = acquisition.state;
    if (state) issue('control-mode', { controlMode: state.controlMode === 'host' ? 'open' : 'host' });
  },
  mute: () => {
    video.muted = !video.muted;
    renderMute();
  },
  seek: (positionMs) => {
    if (Number.isFinite(positionMs)) return issue('seek', { positionMs });
    return false;
  },
  volume: (value) => {
    const next = Number(value);
    if (Number.isFinite(next)) video.volume = Math.max(0, Math.min(1, next));
  },
  fullscreen: () => {
    if (document.fullscreenElement) return document.exitFullscreen?.();
    return document.getElementById('player')?.requestFullscreen?.();
  },
  stats: () => view.set('overlayVisible', !view.get().overlayVisible),
  // The page keeps only the name the roster hands back.
  setName: (text) => sendOwn('name', text, NAME_MAX_CODE_POINTS, (name) => client.setName(name)),
  sendChat: (text) => sendOwn('chat', text, CHAT_MAX_CODE_POINTS, (message) => client.sendChat(message)),
  openNamePrompt: () => view.set('namePromptRequest', view.get().namePromptRequest + 1),
  pointerMove: () => {
    lastPointerMoveAt = pageNow();
    const bar = view.get().bar;
    if (bar.faded) view.set('bar', { ...bar, faded: false });
  },
  copyFile: () => {
    const command = view.get().hostFile.help?.command;
    if (command && typeof globalThis.navigator?.clipboard?.writeText === 'function') return globalThis.navigator.clipboard.writeText(command);
    return undefined;
  },
  chooseHostFile: (file) => {
    if (!hostFileChooserOpen) return;
    if (file) {
      // A pick the source ignores must not rename the title it is preparing (12a D8).
      if (!CHOOSABLE_STATES.includes(hostFile.snapshot().state)) return;
      if (isValidHostName(file.name)) preparedName?.set(file.name);
      else preparedName?.clear();
      void hostFile.choose(file);
    }
  },
};
renderMute();

const driftLog = createDriftLog();
// The video element carries its own `requestVideoFrameCallback`; the sampler's
// default binding calls it on the element it was handed.
const sampler = createFrameSampler({ video, timeline, clock: clockSync, log: driftLog, placement: placementMs });

// A second observer on the same frames, never stopped, so the frame the park
// presented is identifiable too. It holds no log and no timeline: the product
// sampler above is untouched, and the two streams join offline on
// `presentedFrames` (executor-spec.md §11.1).
const frameObserver = startTiming
  ? createFrameObserver({ video, telemetry, context: telemetryContext, now: pageNow, placement: placementMs })
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

const start = createPlaybackStart({
  prepareLeadMs: PREPARE_LEAD_MS,
  presentationAdvanceMs: PRESENTATION_ADVANCE_MS,
  reparkAfterMs: LATE_START_REPARK_MS,
  maxReparks: MAX_LATE_REPARKS,
  coverMarginMs: START_COVER_MARGIN_MS,
  projectionMs: START_PROJECTION_MS,
  projectionMaxMs: START_PROJECTION_MAX_MS,
});
const farSkip = createFarSkip({ dwellMs: SKIP_DWELL_MS, repeatIntervalMs: SKIP_REPEAT_INTERVAL_MS });
const STARTS_KEPT = 32;
const starts = [];
let lastSkipAtSharedMs = null;
let lastSkipAbandonedMs = null;
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

for (const type of ['timeupdate', 'seeking']) {
  video.addEventListener(type, () => runTickSteps([
    ['element-position', () => {
      elementMediaMs = mediaFromElementMs(video.currentTime * 1000);
      updateUrgentContext();
    }],
  ], reportStep));
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
      reparkOf: action.reparkOf ?? null,
      reparks: action.reparks ?? null,
      abandonedLatenessMs: action.abandonedLatenessMs ?? null,
      firstStartAtSharedMs: action.firstStartAtSharedMs ?? null,
      reprojections: action.reprojections ?? null,
      reprojectionOf: action.reprojectionOf ?? null,
      projectionMs: action.projectionMs ?? null,
      coverElapsedMs: action.coverElapsedMs ?? null,
      skipOf: action.skipOf ?? null,
      abandonedDriftMs: action.abandonedDriftMs ?? null,
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
    reparks: action.reparks,
    firstStartAtSharedMs: action.firstStartAtSharedMs,
    reprojections: action.reprojections,
    projectionMs: action.projectionMs,
    coverElapsedMs: action.coverElapsedMs,
    ...(Object.hasOwn(action, 'skipOf') ? {
      skipOf: action.skipOf,
      abandonedDriftMs: action.abandonedDriftMs,
    } : {}),
  });
  startWait.played(driftLog.latestSeq);
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
        if (action.kind === 'load') {
          elementMediaMs = null;
          const p2p = roomHasPeerExchange && client.role !== 'host'
            ? {
                core: peerEngineConfig({
                  roomId: room,
                  titleId: mediaSource === 'file' ? acquisition.state?.title ?? null : null,
                  trackerUrl,
                  iceServers,
                  windows: engineWindows.windows,
                }).core,
                onEngine: (engine) => {
                  peerEngine = engine;
                  peerBytesPublisher.attach(engine);
                  engine.addEventListener('onSegmentLoaded', () => runTickSteps([
                    ['held-ahead', updateHeldAhead],
                    ['ahead-report', sendAheadReport],
                  ], reportStep));
                  peerBytesRead = (afterSeq = 0) => peerBytesPublisher.read(afterSeq);
                },
              }
            : null;
          treatment.open(() => player.load({ startPositionMs: action.positionMs, p2p }), 'load');
          loadedTitle = acquisition.state?.title ?? null;
        }
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

// A ready report that names a title other than the room state's.
function readyForOtherTitle(status) {
  return status.state === 'ready' && status.identity != null && status.identity !== acquisition.state?.title;
}

function titleReady() {
  if (delivery !== 'host') return true;
  const status = hostStatusNow();
  return status.state === 'ready' && !readyForOtherTitle(status);
}

function hostBlocks() {
  return delivery === 'host' && ['choosing', 'preparing', 'absent'].includes(hostStatusNow().state);
}

function hostWithholds() {
  if (delivery !== 'host') return false;
  const status = hostStatusNow();
  return status.state === 'choosing' || status.state === 'preparing' || readyForOtherTitle(status);
}

function pollStart() {
  if (positionOffset.error !== null || engineWindows.error !== null || harnessSeekConfig.error !== null) return;
  maybeAskStartWait();
  checkReady();
  const state = viewState();
  const nowSharedMs = clockSync.sharedNow();
  const result = start.poll({
    nowSharedMs,
    resolved: acquisition.snapshot.resolved,
    state,
    linkOpen: link ? link.snapshot().state === 'open' : true,
    titleReady: titleReady(),
    finished: player.finishedSegments(),
    last: player.lastSegment(),
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

function evaluateFarSkip() {
  const controllerState = controllerView();
  const playback = start.state();
  const decision = farSkip.evaluate({
    nowMs: pageNow(),
    named: controllerState.mode === 'beyond-rate-authority',
    estimateMs: controllerState.estimateMs,
    eligible: playback.resolved === true && playback.playing === true,
  });
  if (!decision.skip || !start.skip({ abandonedDriftMs: decision.abandonedDriftMs })) return;
  lastSkipAtSharedMs = clockSync.sharedNow();
  lastSkipAbandonedMs = decision.abandonedDriftMs;
  addNotice(`far skip: ${decision.abandonedDriftMs}ms drift`);
  pollStart();
}

document.addEventListener('click', () => {
  start.click();
  pollStart();
});

// ---------------------------------------------------------------------------
// The diagnostics overlay
// ---------------------------------------------------------------------------

const overlay = createDiagnosticsOverlay({
  clock: clockSync,
  controller: { state: controllerView },
  bytes: { read: () => peerBytesRead() },
  log: driftLog,
  playback: start,
  heldAhead: () => heldAheadValue,
});

// ON THE TICK, NOT ON A CLOCK EVENT: the half-width widens with age between
// samples, so a repaint tied to new samples alone freezes a growing number.
function paintOverlay() {
  const lines = overlay.lines();
  view.set('overlay', {
    clock: lines.clock,
    drift: lines.drift,
    bytes: lines.bytes,
    controller: lines.controller,
    startWait: startWaitText(startWait.waitMs()),
    links: linkKinds.text(),
  });
}

// Each step in its own try (D10): the controller's stale rule is what returns
// the rate to 1.0 when frames stop, so a failing start must not skip it.
function tickPlayback() {
  runTickSteps([
    ['acquisition', () => acquisition.poll()],
    ['start-wait', maybeAskStartWait],
    ['start-wait-frame', captureStartWaitFrame],
    ['title-discard', discardStaleTitle],
    ['title', maybeIssueTitle],
    ['playback-start', pollStart],
    ['title-end', () => {
      const state = acquisition.state;
      // D7, joint D1 F1: the element's own end, or it parks short of it and never ends.
      const durationMs = endPauseMs(titleEndMs(), mediaDurationS());
      const instant = endInstant(state, durationMs);
      const nowSharedMs = clockSync.sharedNow();
      if (instant === null || !Number.isFinite(nowSharedMs) || nowSharedMs < instant
        || !endLatch.take(acquisition.snapshot.identity)) return;
      if (issue('pause', { atSharedMs: instant })) lastEndPauseInstant = instant;
    }],
    ['host-grace', () => {
      const endsAt = hostGrace?.due(clockSync.sharedNow()) ?? null;
      const state = acquisition.state;
      if (endsAt === null || state?.current.playing !== true || !graceLatch.take(stateIdentity(state))) return;
      lastGracePauseInstant = endsAt;
      if (issue('pause', { atSharedMs: endsAt })) gracePauses += 1;
    }],
    ['urgent-context', updateUrgentContext],
    ['host-class', () => link?.reclassify?.()],
    ['links', () => linkKinds.tick(pageNow())],
    ['held-ahead', updateHeldAhead],
    ['ahead-report', sendAheadReport],
    ['hold-resume', driveHoldResume],
    ['controller', () => treatment.pollController(() => controller.poll())],
    ['far-skip', evaluateFarSkip],
    ['overlay', paintOverlay],
    ['controls', renderControls],
    ['bar', renderBar],
  ], reportStep);
}

renderControls();
renderBar();
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
  get room() { return room; },
  get tabId() { return tabId; },
  control: () => ({ ...controlInForce() }),
  clock: () => clockSync.read(),
  positionOffset: () => ({ ...positionOffset }),
  hostStats: () => (hostOrigin ? hostOrigin.stats() : null),
  ...(harnessSeekConfig.enabled ? { harnessSeek } : {}),
  harnessSeekError: harnessSeekConfig.error,
  engineWindows: () => ({ windows: engineWindows.windows ? { ...engineWindows.windows } : null, error: engineWindows.error }),
  headroom: () => ({ ...headroomFraction }),
  hostPace: (afterSeq = 0) => (hostOrigin ? hostOrigin.pace(afterSeq) : null),
  drift: (afterSeq = 0) => driftLog.read({ afterSeq }),
  // THE CANONICAL ROLLING WINDOW. Published so no consumer has to re-derive a
  // median from `drift().records` and get a second one — the browser pass did,
  // and its two figures did not share a definition of the middle of an even set.
  summary: () => driftLog.summary(),
  // BESIDE `clock` AND `drift`, not inside `playback()`. The seam below spreads
  // `start.state()`, so a key of the same name there would be silently
  // overwritten by this one rather than colliding visibly.
  controller: controllerView,
  placement: () => player.placement(),
  // Measurement instrumentation, inert without `startTiming=1` (§11.2).
  startTiming: (afterSeq = 0) => startTimingWithOffset(afterSeq),
  pitch: () => treatment.pitch(),
  treatmentEvidence: (maxEvents) => treatment.drainEvidence(maxEvents),
  delivery: () => delivery,
  hostLink: () => (link ? link.snapshot() : null),
  urgentContext,
  hostAsks: (afterSeq = 0) => readHostAsks(afterSeq),
  hostCounters: () => (hostOrigin ? hostOrigin.snapshot() : null),
  hostReceipts: (afterSeq = 0) => (link ? link.receipts(afterSeq) : null),
  title: () => {
    const status = hostStatusNow();
    return {
      title: acquisition.state?.title ?? null,
      reportIdentity: status.state === 'ready' ? status.identity ?? null : null,
      name: status.state === 'ready' ? status.name ?? null : null,
      loadedTitle: loadedTitle ?? null,
    };
  },
  peerExchange: () => peerExchange,
  urgentDelay,
  peerEngineConfig: () => (peerEngine ? peerEngine.getConfig().core : null),
  peerBytes: (afterSeq = 0) => peerBytesRead(afterSeq),
  // T7/T8: the viewer's own held-ahead, and the host's resume ring.
  heldAhead: () => heldAheadValue,
  resumes: (afterSeq = 0) => {
    const ring = resumeRing.read(afterSeq);
    return { records: ring.records, evicted: ring.evicted, malformedReports: malformedAheadReports };
  },
  playback: () => ({
    ...start.state(),
    lastSkipAtSharedMs,
    lastSkipAbandonedMs,
    placementMs: placementMs(),
    callbacks: sampler.callbacks,
    sampling: sampler.running,
    seams: controller.seams,
    starts: starts.map((entry) => ({ ...entry })),
  }),
  playbackState: () => {
    const state = acquisition.state;
    if (!state) return null;
    return {
      lineage: state.lineage,
      version: state.version,
      playing: state.current.playing,
      positionMs: state.current.mediaMs,
      atSharedMs: state.current.atSharedMs,
      held: state.current.held === true,
    };
  },
  timeline: () => acquisition.snapshot,
  hostFile: () => hostFile ? hostFile.snapshot() : hostFileSnapshot({ mediaSource, targetSegmentSeconds }),
  hostGrace: () => ({
    ...(hostGrace?.snapshot() ?? {
      running: false,
      pending: false,
      startedAtSharedMs: null,
      endsAtSharedMs: null,
    }),
    graceMs: hostGraceMs,
    pauses: gracePauses,
  }),
};

// A file host's page that cannot prepare: it reports `state` and serves nothing.
function unpreparedHostFile(state, failure) {
  return {
    snapshot: () => hostFileSnapshot({ mediaSource, targetSegmentSeconds, state, failure }),
    read: async () => ({ status: 404, bytes: new Uint8Array() }),
  };
}

async function startApp() {
  try {
    // No fetch means no settings: the page does not guess a delivery (7a d1-findings D1-4).
    if (typeof window.fetch !== 'function') throw new Error('fetch is unavailable');
    const settingsResponse = await window.fetch('/app-settings', { cache: 'no-store' });
    if (!settingsResponse.ok) throw new Error(`HTTP ${settingsResponse.status}`);
    const settings = await settingsResponse.json();
    if (!settings || (settings.delivery !== 'host' && settings.delivery !== 'http') || !Array.isArray(settings.iceServers) || (settings.trackerUrl !== null && typeof settings.trackerUrl !== 'string') || (settings.mediaSource !== 'dir' && settings.mediaSource !== 'file') || !Number.isFinite(settings.targetSegmentSeconds) || settings.targetSegmentSeconds <= 0 || typeof settings.autoStart !== 'boolean' || !Number.isInteger(settings.hostGraceMs) || settings.hostGraceMs < 0 || settings.hostGraceMs > 3_600_000) {
      throw new TypeError('invalid application settings');
    }
    delivery = settings.delivery;
    mediaSource = settings.mediaSource;
    targetSegmentSeconds = settings.targetSegmentSeconds;
    iceServers = settings.iceServers;
    trackerUrl = settings.trackerUrl;
    autoStart = settings.autoStart;
    hostGraceMs = settings.hostGraceMs;
    hostGrace = createHostGrace({ graceMs: hostGraceMs });
    peerExchange = delivery !== 'host'
      ? 'off'
      : client.role === 'host'
        ? 'host'
        : typeof trackerUrl === 'string' ? 'on' : 'off';
    roomHasPeerExchange = delivery === 'host' && typeof trackerUrl === 'string';
    if (mediaSource === 'file' && role === 'host') {
      const storageGetter = globalThis.navigator?.storage?.getDirectory;
      if (typeof storageGetter !== 'function') {
        hostFile = unpreparedHostFile('failed', 'navigator.storage.getDirectory');
        view.set('hostFile', { status: 'failed: navigator.storage.getDirectory', inputHidden: true, state: 'failed', choosable: false });
        return;
      }
      const storage = await probeStorage(() => {
        return storageGetter.call(globalThis.navigator.storage);
      });
      if (!storage.ok) {
        hostFile = unpreparedHostFile('storage-refused', storage.name);
        view.set('hostFile', { status: `storage-refused: ${storage.name}`, inputHidden: false, state: 'storage-refused', choosable: false });
        client.connect();
        return;
      }
      const missing = !globalThis.navigator?.locks ? 'navigator.locks' : typeof Worker !== 'function' ? 'Worker' : null;
      if (missing) {
        hostFile = unpreparedHostFile('failed', missing);
        // Not choosable although `failed` is a choosable state: the chooser never opens on this
        // page, so an enabled input would take a pick and drop it (design.md D15).
        view.set('hostFile', { status: `failed: ${missing}`, inputHidden: true, state: 'failed', choosable: false });
        return;
      }
      const locks = createWebLocks(navigator.locks);
      const store = createPreparedStore({ backend: createOpfsBackend(() => navigator.storage.getDirectory()), locks });
      const memory = {
        get: () => sessionStorage.getItem(PREPARED_KEY_NAME),
        set: (value) => sessionStorage.setItem(PREPARED_KEY_NAME, value),
        clear: () => {
          sessionStorage.removeItem(PREPARED_KEY_NAME);
          sessionStorage.removeItem(PREPARED_NAME_KEY);
        },
      };
      hostFile = createHostFileSource({
        store, locks, memory,
        client: createPrepareClient({ worker: new Worker('/prepare.worker.bundle.js') }),
        isTypeSupported: (mime) => MediaSource.isTypeSupported(mime),
        estimate: () => navigator.storage.estimate(),
        targetSeconds: targetSegmentSeconds,
        onChange: paintHostFile,
      });
      await installHostFileLink();
      client.connect();
      const openState = hostFile.snapshot().state;
      view.set('hostFile', { ...view.get().hostFile, inputHidden: false, state: openState, choosable: CHOOSABLE_STATES.includes(openState) });
      // 11-2 D7: the page hands the File over and never reads its name.
      hostFileChooserOpen = true;
      await hostFile.start();
    } else if (delivery === 'host') {
      await loadHostTransport();
      if (role === 'viewer') installViewerLink();
    }
    if (!hostFile) client.connect();
  } catch (error) {
    setStatus(`settings unavailable: ${error?.message ?? error}`, { final: true });
    addNotice(`settings unavailable: ${error?.message ?? error}`, { warn: true });
  }
}

function startRoomApp() {
  if (route !== 'room' || appStarted) return;
  appStarted = true;
  void startApp();
}

mountScreens({ view, actions });
startRoomApp();
