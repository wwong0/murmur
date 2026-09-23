// scripts/check/entry-fakes.mjs
//
// Stand-ins for the four entry imports that would reach the network or hls.js
// (room-client, clock-sync, player, playback-start), for running room.entry.js
// in a vm. Everything else the entry imports stays real. Each reads the test's
// script from `globalThis.__entryHarness`, which entry-harness.mjs installs.

const harness = () => globalThis.__entryHarness;

/** Subscribers are kept so a test can emit `joined` and deliver room envelopes. */
export function createRoomClient() {
  const subscribe = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
    return () => {};
  };
  return {
    get clientId() { return harness().clientId; },
    get role() { return harness().role; },
    get roster() { return harness().roster; },
    onEvent(type, fn) { return subscribe(harness().clientEvents, type, fn); },
    on(type, fn) { return subscribe(harness().clientHandlers, type, fn); },
    send(envelope) { harness().log('send', envelope); },
    request: () => new Promise(() => {}),
    connect() { harness().log('connect'); },
  };
}

export function createClockSync() {
  return { start() {}, read: () => harness().clock, sharedNow: () => harness().sharedNowMs };
}

export function websocketProbe() {
  return () => {};
}

export function createPlayer({ video }) {
  harness().log('player-created');
  return {
    onError() {},
    load(options) {
      harness().log('load', options);
      harness().onLoad?.();
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
export function createPlaybackStart(options) {
  harness().log('playback-start-created', options);
  return {
    poll(input) {
      harness().log('playback-start-poll', input);
      if (harness().pollThrows) throw new Error('scripted poll failure');
      const actions = harness().pendingActions.splice(0);
      return { ...harness().startState, actions, nextAtSharedMs: null };
    },
    ready(attemptId, observedSharedMs) { harness().log('ready', { attemptId, observedSharedMs }); },
    playResolved(attemptId) { harness().log('play-resolved', attemptId); },
    playRejected(attemptId, error) { harness().log('play-rejected', { attemptId, error }); },
    click() { harness().log('start-click'); },
    state: () => ({ ...harness().startState, playing: harness().playing }),
  };
}
