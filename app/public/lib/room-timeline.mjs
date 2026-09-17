// public/lib/room-timeline.mjs
//
// The room timeline is a thin interface over replicated playback state (D5).
// It is pure: the caller supplies the shared instant and state reader.

import { epochMsAt as stateEpochMsAt, mediaMsAt as stateMediaMsAt } from './playback-state.mjs';

/**
 * @param {{readState: () => object|null}} config
 * @returns {{mediaMsAt: (sharedMs: number) => number|null,
 *   epochMsAt: (sharedMs: number) => number|null}}
 */
export function createRoomTimeline({ readState } = {}) {
  if (typeof readState !== 'function') throw new TypeError('createRoomTimeline: readState is required');
  return {
    mediaMsAt(sharedMs) {
      return stateMediaMsAt(readState(), sharedMs);
    },
    epochMsAt(sharedMs) {
      return stateEpochMsAt(readState(), sharedMs);
    },
  };
}

/** A stable playing mapping for deterministic drift and controller rigs. */
export function fixedPlayingState(epochMs) {
  return {
    lineage: 'fixed',
    version: 0,
    current: { playing: true, atSharedMs: epochMs, mediaMs: 0 },
    previous: null,
    controlMode: 'open',
  };
}
