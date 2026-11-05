// public/lib/player.mjs
//
// Minimal hls.js player wrapper. Takes the <video> element as an argument —
// never looks it up itself — so this module has no DOM lookups of its own
// and a later React rewrite can reuse it unedited. No rate cap, no sync,
// no P2P: this change is plain hls.js over HTTP.
// The host path's shim drops x-app-tab while serving media from the host.
//
// Constraints: this file lives under public/lib/, so it must never touch the
// global DOM objects directly — enforced by app/scripts/check-structure.mjs.

import Hls from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';
import { createPlacementTracker } from './fmp4-placement.mjs';

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
  /** @type {Set<Function>} */
  const finishedHandlers = new Set();
  const finished = new Map();
  let last = null;
  let hls = null;
  const tracker = createPlacementTracker();

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
   * position is chosen before anything is playing.
   *
   * @param {{startPositionMs?: number|null, p2p?: {core: object, onEngine: Function}|null}} [at]
   */
  function load({ startPositionMs = null, p2p = null } = {}) {
    const startPosition = Number.isFinite(startPositionMs) ? startPositionMs / 1000 : -1;
    finished.clear();
    last = null;
    tracker.reset();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (Hls.isSupported()) {
      if (Number.isFinite(startPositionMs)) tracker.noteWrite(startPositionMs);
      // `startPosition` LAST. It is this call's argument, chosen by the load
      // rule; `hlsConfig` is construction-time config, and letting it silently
      // win would put playback somewhere no decision named.
      const HlsConstructor = p2p ? HlsP2P : Hls;
      const instance = new HlsConstructor({
        ...playerConfig,
        startPosition,
        ...(p2p ? {
          p2p: {
            core: p2p.core,
            onHlsJsCreated: (instance) => p2p.onEngine(instance.p2pEngine),
          },
        } : {}),
      });
      hls = instance;
      instance.on(Hls.Events.BUFFER_APPENDING, (_event, data) => {
        if (hls !== instance) return;
        tracker.onAppend({ data: data?.data, offset: data?.offset, playlistOffsetS: data?.frag?.playlistOffset, parent: data?.parent });
      });
      instance.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
        if (hls !== instance) return;
        const write = tracker.takePendingWrite();
        if (write && video.paused) video.currentTime = write.elementSeconds;
        const frag = data?.frag;
        if (frag?.type !== 'main' || !Number.isFinite(frag.sn)
          || !Number.isFinite(frag.start) || !Number.isFinite(frag.end)) return;
        finished.set(frag.sn, { index: frag.sn, mediaStartMs: frag.start * 1000, mediaEndMs: frag.end * 1000 });
        for (const fn of finishedHandlers) {
          try {
            fn();
          } catch {
            // A broken subscriber must not take the player down with it.
          }
        }
      });
      instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (hls !== instance) return;
        const details = data?.details;
        const fragments = details?.fragments;
        if (details?.live !== false || !Array.isArray(fragments) || fragments.length === 0) return;
        const frag = fragments.at(-1);
        if (!Number.isFinite(frag?.sn) || !Number.isFinite(frag?.start) || !Number.isFinite(frag?.end)) return;
        last = { index: frag.sn, mediaStartMs: frag.start * 1000, mediaEndMs: frag.end * 1000 };
      });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          emitError({ fatal: true, type: data.type, details: data.details, error: data.error });
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              instance.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              instance.recoverMediaError();
              break;
            default:
              instance.destroy();
              break;
          }
        } else {
          console.log('[player] non-fatal hls.js error', data.type, data.details);
        }
      });
      instance.attachMedia(video);
      instance.on(Hls.Events.MEDIA_ATTACHED, () => {
        instance.loadSource(src);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // A media fragment, not a seek — the position is part of the source the
      // element is given, the same way `startPosition` is for hls.js.
      tracker.none();
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
    last = null;
  }

  /** Park is the only position write, and scheduled start calls it paused. */
  function park(positionMs) {
    if (!video.paused) throw new Error('player.park requires a paused element');
    if (!Number.isFinite(positionMs) || positionMs < 0) throw new TypeError('player.park requires a non-negative position');
    video.currentTime = tracker.elementSeconds(positionMs);
  }

  return {
    load,
    park,
    placement: () => tracker.snapshot(),
    destroy,
    finishedSegments() {
      if (!Hls.isSupported()) return null;
      return [...finished.values()].map((segment) => ({ ...segment }));
    },
    lastSegment() {
      return last ? { ...last } : null;
    },
    onFinished(fn) {
      finishedHandlers.add(fn);
      return () => finishedHandlers.delete(fn);
    },
    /** Subscribe to fatal player errors. Returns an unsubscribe function. */
    onError(fn) {
      errorHandlers.add(fn);
      return () => errorHandlers.delete(fn);
    },
  };
}
