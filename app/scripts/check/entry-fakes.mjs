// scripts/check/entry-fakes.mjs
//
// Stand-ins for the four entry imports that would reach the network or hls.js
// (room-client, clock-sync, player, playback-start), for running room.entry.js
// in a vm. Everything else the entry imports stays real. Each reads the test's
// script from `globalThis.__entryHarness`, which entry-harness.mjs installs.

const harness = () => globalThis.__entryHarness;

export function createRoomClient() {
  return { onEvent() {}, on() {}, connect() { harness().log('connect'); } };
}

export function createClockSync() {
  return { start() {}, read: () => harness().clock };
}

export function websocketProbe() {
  return () => {};
}

export function createPlayer() {
  harness().log('player-created');
  return {
    onError() {},
    load(options) {
      harness().log('load', options);
      harness().onLoad?.();
    },
    reopen(options) {
      harness().log('reopen', options);
      harness().onReopen?.();
    },
  };
}

/** Opens only when the test queues one, through the entry's own tick. */
export function createPlaybackStart({ open }) {
  harness().log('playback-start-created');
  return {
    poll() {
      const pending = harness().pendingOpen;
      if (pending === null) return;
      harness().pendingOpen = null;
      open(pending);
    },
    state: () => ({ playing: harness().playing, epochMs: null, missing: null }),
  };
}
