// public/lib/player.mjs
//
// Minimal hls.js player wrapper. Takes the <video> element as an argument —
// never looks it up itself — so this module has no DOM lookups of its own
// and a later React rewrite can reuse it unedited. No rate cap, no sync,
// no P2P: this change is plain hls.js over HTTP (see step0/public/player.js
// for the fuller harness this deliberately does not carry over).
//
// Constraints: this file lives under public/lib/, so it must never touch the
// global DOM objects directly — enforced by app/scripts/check-structure.mjs.

import Hls from 'hls.js';

const DEFAULT_SRC = '/media/master.m3u8';

/**
 * @param {object} config
 * @param {HTMLVideoElement} config.video   the video element to attach to; passed in, never looked up
 * @param {string} [config.src]             defaults to '/media/master.m3u8'
 * @param {object} [config.hlsConfig]       extra hls.js config, merged in
 */
export function createPlayer({ video, src = DEFAULT_SRC, hlsConfig = {} } = {}) {
  if (!video) throw new Error('createPlayer: "video" is required');

  /** @type {Set<Function>} */
  const errorHandlers = new Set();
  let hls = null;

  function emitError(detail) {
    for (const fn of errorHandlers) {
      try {
        fn(detail);
      } catch {
        // A broken subscriber must not take the player down with it.
      }
    }
  }

  function load() {
    if (Hls.isSupported()) {
      hls = new Hls({ ...hlsConfig });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          emitError({ fatal: true, type: data.type, details: data.details, error: data.error });
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        } else {
          console.log('[player] non-fatal hls.js error', data.type, data.details);
        }
      });
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(src);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      emitError({ fatal: true, type: 'unsupported', details: 'neither hls.js nor native HLS is supported' });
    }
  }

  function destroy() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  return {
    load,
    destroy,
    /** Subscribe to fatal player errors. Returns an unsubscribe function. */
    onError(fn) {
      errorHandlers.add(fn);
      return () => errorHandlers.delete(fn);
    },
  };
}
