// public/lib/player.mjs
//
// Minimal hls.js player wrapper. Takes the <video> element as an argument —
// never looks it up itself — so this module has no DOM lookups of its own
// and a later React rewrite can reuse it unedited. No rate cap, no sync,
// no P2P: this change is plain hls.js over HTTP (see step0/public/player.js
// for the fuller harness this deliberately does not carry over).
// The host path's shim drops x-app-tab while serving media from the host.
//
// Constraints: this file lives under public/lib/, so it must never touch the
// global DOM objects directly — enforced by app/scripts/check-structure.mjs.

import Hls from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';

const DEFAULT_SRC = '/media/master.m3u8';
const HlsP2P = HlsJsP2PEngine.injectMixin(Hls);

/**
 * @param {object} config
 * @param {HTMLVideoElement} config.video   the video element to attach to; passed in, never looked up
 * @param {string} [config.src]             defaults to '/media/master.m3u8'
 * @param {object} [config.hlsConfig]       extra hls.js config, merged in
 * @param {string} [config.clientTag]       per-tab header value for media requests
 */
export function createPlayer({ video, src = DEFAULT_SRC, hlsConfig = {}, clientTag } = {}) {
  if (!video) throw new Error('createPlayer: "video" is required');

  const playerConfig = typeof clientTag === 'string' && clientTag.length > 0
    ? {
        ...hlsConfig,
        xhrSetup: (xhr, url) => {
          xhr.open('GET', url, true);
          xhr.setRequestHeader('x-app-tab', clientTag);
        },
      }
    : hlsConfig;

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

  /**
   * Open the media at `startPositionMs`, which hls.js applies as it starts
   * loading. THIS IS NOT A SEEK: nothing here writes `currentTime`, and the
   * position is chosen before anything is playing (3b design.md D1).
   *
   * @param {{startPositionMs?: number|null, p2p?: {core: object, onEngine: Function}|null}} [at]
   */
  function load({ startPositionMs = null, p2p = null } = {}) {
    const startPosition = Number.isFinite(startPositionMs) ? startPositionMs / 1000 : -1;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (Hls.isSupported()) {
      // `startPosition` LAST. It is this call's argument, chosen by the load
      // rule; `hlsConfig` is construction-time config, and letting it silently
      // win would put playback somewhere no decision named.
      const HlsConstructor = p2p ? HlsP2P : Hls;
      hls = new HlsConstructor({
        ...playerConfig,
        startPosition,
        ...(p2p ? {
          p2p: {
            core: p2p.core,
            onHlsJsCreated: (instance) => p2p.onEngine(instance.p2pEngine),
          },
        } : {}),
      });
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
      // A media fragment, not a seek — the position is part of the source the
      // element is given, the same way `startPosition` is for hls.js.
      video.src = startPosition >= 0 ? `${src}#t=${startPosition}` : src;
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

  /** Park is the only position write, and scheduled start calls it paused. */
  function park(positionMs) {
    if (!video.paused) throw new Error('player.park requires a paused element');
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new TypeError('player.park requires a non-negative position');
    video.currentTime = positionMs / 1000;
  }

  return {
    load,
    park,
    destroy,
    /** Subscribe to fatal player errors. Returns an unsubscribe function. */
    onError(fn) {
      errorHandlers.add(fn);
      return () => errorHandlers.delete(fn);
    },
  };
}
