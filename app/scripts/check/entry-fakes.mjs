// scripts/check/entry-fakes.mjs
//
// Stand-ins for the four entry imports that would reach the network or hls.js
// (room-client, clock-sync, player, playback-start), for running room.entry.js
// in a vm. Everything else the entry imports stays real. Each reads the test's
// script from `globalThis.__entryHarness`, which entry-harness.mjs installs.

const harness = () => globalThis.__entryHarness;

export function mountScreens({ view, actions }) {
  harness().screens = { view, actions, appAtMount: globalThis.__app !== undefined };
}

/** Subscribers are kept so a test can emit `joined` and deliver room envelopes. */
export function createRoomClient(config) {
  harness().clientConfig = config;
  const sendId = (kind, value) => {
    if (!harness().isJoined) return null;
    harness().log(kind, value);
    return `m-${harness().nextSendId++}`;
  };
  const subscribe = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
    return () => {};
  };
  return {
    get clientId() { return harness().clientId; },
    get role() { return harness().role; },
    get roster() { return harness().roster; },
    get isJoined() { return harness().isJoined; },
    get name() { return harness().name ?? null; },
    // The id the real client would return; null before the join, as it does.
    setName(name) { return sendId('set-name', name); },
    sendChat(text) { return sendId('send-chat', text); },
    onEvent(type, fn) { return subscribe(harness().clientEvents, type, fn); },
    on(type, fn) { return subscribe(harness().clientHandlers, type, fn); },
    send(envelope) { harness().log('send', envelope); },
    // Unanswered unless a check scripts `onRequest`, as the adoption check does.
    request: (fields) => harness().onRequest?.(fields) ?? new Promise(() => {}),
    connect() { harness().log('connect'); },
    echo(timeoutMs) { harness().log('echo', timeoutMs); return Promise.resolve(null); },
  };
}

export function createClockSync() {
  return { start() {}, read: () => harness().clock, sharedNow: () => harness().sharedNowMs };
}

export function websocketProbe(roomClient) {
  harness().probeClient = roomClient;
  return () => {};
}

export function createPlayer({ video }) {
  harness().log('player-created');
  return {
    onError() {},
    placement() { return { placementMs: 0, source: 'none', disagreements: 0, lastDisagreementMs: null }; },
    finishedSegments() { return harness().finished; },
    lastSegment() { return harness().last ?? null; },
    onFinished(fn) {
      harness().finishedHandlers.push(fn);
      return () => {
        const index = harness().finishedHandlers.indexOf(fn);
        if (index >= 0) harness().finishedHandlers.splice(index, 1);
      };
    },
    load(options) {
      harness().log('load', options);
      harness().onLoad?.();
    },
    destroy() {
      harness().log('player-destroy');
    },
    park(positionMs) {
      harness().log('park', { positionMs, paused: video.paused });
      harness().onPark?.();
    },
  };
}

/**
 * Emits only the actions the test queues, through the entry's own tick. The
 * construction options are logged because they are the entry's own wiring and
 * nothing else in `npm run check` observes it: the real reducer is faked here,
 * so its own suite cannot see what the page passes (d1-findings.md R2).
 */
export const WAITING_PREPARING = 'preparing';
export function createPlaybackStart(options) {
  harness().log('playback-start-created', options);
  return {
    poll(input) {
      harness().log('playback-start-poll', input);
      if (harness().pollThrows) throw new Error('scripted poll failure');
      const actions = harness().pendingActions.splice(0);
      return { ...harness().startState, playing: harness().playing, skips: harness().skips ?? 0, actions, nextAtSharedMs: null };
    },
    skip({ abandonedDriftMs = null } = {}) {
      if (harness().acceptSkip !== true || harness().playing !== true) return false;
      harness().playing = false;
      harness().skips = (harness().skips ?? 0) + 1;
      const skipOf = harness().startState.attemptId ?? 1;
      harness().pendingActions.push(
        { kind: 'pause', attemptId: skipOf },
        {
          kind: 'park', attemptId: skipOf + 1, positionMs: harness().skipPositionMs ?? 1234,
          scheduledPositionMs: harness().skipPositionMs ?? 1234, advanceMs: 0, seamEpochMs: 0,
          skipOf, abandonedDriftMs,
        },
      );
      return true;
    },
    ready(attemptId, observedSharedMs) { harness().log('ready', { attemptId, observedSharedMs }); },
    playResolved(attemptId) { harness().log('play-resolved', attemptId); },
    playRejected(attemptId, error) { harness().log('play-rejected', { attemptId, error }); },
    unload() { harness().log('start-unload'); },
    click() { harness().log('start-click'); },
    state: () => ({ ...harness().startState, playing: harness().playing, skips: harness().skips ?? 0 }),
  };
}
