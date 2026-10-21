// The host side of the segment protocol.  The source is injected so this
// module can be exercised without a page, a filesystem, or a real peer.

import {
  asBytes,
  createChannelSender,
  parseControl,
  sliceForRange,
  FIRST_BYTE_BUDGET_MS,
} from './segment-protocol.mjs';
import { createHostAccounting } from './host-accounting.mjs';
import { HEADROOM_DEFAULT, validateHeadroomFraction } from './send-pace.mjs';
import { createHostPace } from './host-pace.mjs';

const MEDIA_PREFIX = '/media/';
const MAP_LINE_RE = /^#EXT-X-MAP:.*$/gm;
const MAP_URI_RE = /URI="([^"]+)"/;
const BYTERANGE_RE = /\bBYTERANGE\s*=/i;
const BAD_GATEWAY = Object.freeze({ status: 502, bytes: new Uint8Array() });

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function sourcePathForUri(path, uri) {
  try {
    return new URL(uri, `http://host.invalid${path}`).pathname;
  } catch {
    return null;
  }
}

function encodeBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function bytesText(bytes) {
  return new TextDecoder().decode(bytes);
}

function inlinePlaylist(path, source, readSource) {
  const text = bytesText(source);
  if (text.includes('#EXT-X-STREAM-INF')) return Promise.resolve({ status: 200, bytes: source });

  const lines = text.match(MAP_LINE_RE) ?? [];
  if (lines.length !== 1) return Promise.resolve(null);
  const mapLine = lines[0];
  if (BYTERANGE_RE.test(mapLine)) return Promise.resolve(null);
  const match = MAP_URI_RE.exec(mapLine);
  if (!match) return Promise.resolve(null);
  const initPath = sourcePathForUri(path, match[1]);
  if (!initPath) return Promise.resolve(null);

  return Promise.resolve()
    .then(() => readSource(initPath))
    .then((init) => {
      if (!init || init.status !== 200) return null;
      const initBytes = asBytes(init.bytes);
      const replacement = `URI="data:video/mp4;base64,${encodeBase64(initBytes)}"`;
      const rewrittenLine = mapLine.replace(`URI="${match[1]}"`, replacement);
      return {
        status: 200,
        bytes: utf8Bytes(text.replace(mapLine, rewrittenLine)),
      };
    }, () => null);
}

/**
 * @param {{readSource: (path: string) => Promise<{status: number, bytes: Uint8Array|ArrayBuffer}>, clock?: object, settings?: object}} config
 */
export function createHostOrigin({ readSource, clock, settings = {}, wallNow = () => Date.now(), pace = {}, wire = null } = {}) {
  if (typeof readSource !== 'function') throw new TypeError('createHostOrigin: readSource is required');
  const { fraction, error: fractionError } = validateHeadroomFraction(pace.fraction ?? HEADROOM_DEFAULT);
  if (fractionError) throw new TypeError(`createHostOrigin: pace.fraction ${fractionError}`);
  const instanceId = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const accounting = createHostAccounting({ wallNow, instanceId });
  let responseCounter = 0;
  let urgentResponses = 0;
  let nearResponses = 0;
  let protocolErrors = 0;
  const memo = new Map();
  let attachedChannels = 0;
  const channelState = new Map(); // channelKey -> { pendingReads }
  const hostPace = createHostPace({
    clock,
    wallNow,
    fraction,
    wire,
    queueCapMs: Number.isFinite(settings?.firstByteBudgetMs) ? settings.firstByteBudgetMs : FIRST_BYTE_BUDGET_MS,
    inProgress: (channelKey) => accounting.openCount(channelKey) > 0 || (channelState.get(channelKey)?.pendingReads ?? 0) > 0,
  });

  function nextRid() {
    responseCounter += 1;
    return `${instanceId}:${responseCounter}`;
  }

  async function read(path) {
    if (!path.endsWith('.m3u8')) {
      const source = await readSource(path);
      return { status: source.status, bytes: asBytes(source.bytes) };
    }
    if (memo.has(path)) return memo.get(path);
    const source = await readSource(path);
    if (source.status !== 200) return { status: source.status, bytes: new Uint8Array() };
    const rewritten = await inlinePlaylist(path, asBytes(source.bytes), readSource);
    if (!rewritten) return { status: 500, bytes: new Uint8Array() };
    memo.set(path, rewritten);
    return rewritten;
  }

  function attach(channel, { viewerTag = null } = {}) {
    const channelKey = {};
    const sender = createChannelSender({
      channel,
      clock,
      settings,
      gate: hostPace.gate,
      held: () => paced.held(),
      onChunk: () => paced.chunkSent(),
      onWaiting: hostPace.waiting,
      onCredited(id, bytes) {
        accounting.credited(channelKey, id, bytes);
        accounting.settleIfDone(channelKey, id, sender.pendingFrames(id));
      },
      onClosed() {
        accounting.closeChannel(channelKey);
        retire();
      },
    });
    const paced = hostPace.join(channelKey, sender);
    const retire = () => {
      paced.retire();
      channelState.delete(channelKey);
    };
    const active = new Map();
    let detached = false;

    channelState.set(channelKey, { pendingReads: 0 });

    const onMessage = (event) => {
      const control = parseControl(event?.data);
      if (!control) return;
      if (control.t === 'echo') {
        paced.echoAnswered(control.n);
        return;
      }
      if (control.t === 'abort') {
        if (uint32(control.id) && active.has(control.id)) {
          active.get(control.id).aborted = true;
          accounting.abort(channelKey, control.id);
          sender.abort(control.id);
          accounting.settleIfDone(channelKey, control.id, sender.pendingFrames(control.id));
          active.delete(control.id);
        }
        return;
      }
      if (control.t === 'class') {
        if (!uint32(control.id)) {
          protocolErrors += 1;
          return;
        }
        const cls = control.urgent === true ? 'urgent' : control.near === true ? 'near' : null;
        const entry = active.get(control.id);
        if (!cls || !entry) return;
        if (cls === 'urgent') {
          entry.urgent = true;
          entry.near = false;
        } else if (!entry.urgent) entry.near = true;
        sender.raise(control.id, cls);
        return;
      }
      if (control.t !== 'req') return;
      if (!uint32(control.id) || active.has(control.id) || typeof control.path !== 'string' || !control.path.startsWith(MEDIA_PREFIX)) {
        protocolErrors += 1;
        return;
      }
      const entry = {
        aborted: false,
        urgent: control.urgent === true,
        near: control.near === true && control.urgent !== true,
      };
      active.set(control.id, entry);
      channelState.get(channelKey).pendingReads += 1;
      Promise.resolve()
        .then(() => read(control.path))
        .then((source) => respond(control, entry, source), () => respond(control, entry, BAD_GATEWAY));
    };

    // Every answer, a failed read included, is a head and a body; a non-2xx
    // slice is empty, so its body is only the `end`.
    function respond(control, entry, source) {
      const state = channelState.get(channelKey);
      if (state) state.pendingReads -= 1;
      if (detached || entry.aborted) return;
      const bytes = asBytes(source.bytes);
      const range = control.range && typeof control.range === 'object' ? control.range : null;
      const slice = source.status === 200 ? sliceForRange(bytes.byteLength, range) : { status: source.status, start: 0, end: -1, length: 0 };
      const head = { t: 'head', id: control.id, rid: nextRid(), status: slice.status, length: slice.length };
      if (slice.status === 206) head.total = bytes.byteLength;
      if (sender.sendControl(head)) accounting.open({
        channelKey,
        id: control.id,
        rid: head.rid,
        path: control.path,
        viewerTag,
        expected: head.length,
      });
      if (entry.urgent) urgentResponses += 1;
      if (entry.near) nearResponses += 1;
      sender.start(control.id, bytes.subarray(slice.start, slice.start + slice.length), {
        urgent: entry.urgent,
        near: entry.near,
      });
      if (head.length === 0) accounting.settleIfDone(channelKey, control.id, sender.pendingFrames(control.id));
    }

    channel.addEventListener('message', onMessage);
    const detach = () => {
      if (detached) return;
      detached = true;
      channel.removeEventListener('message', onMessage);
      for (const id of active.keys()) sender.abort(id);
      active.clear();
      sender.close();
      accounting.closeChannel(channelKey);
      retire();
      attachedChannels -= 1;
      paced.leave();
    };
    attachedChannels += 1;
    paced.start();
    return detach;
  }

  return {
    attach,
    snapshot() {
      for (const sender of hostPace.senders()) sender.flush();
      return accounting.snapshot();
    },
    stats() {
      return { protocolErrors, responses: responseCounter, urgentResponses, nearResponses, channels: attachedChannels };
    },
    pace: (afterSeq = 0) => hostPace.read(afterSeq),
  };
}
