// The host side of the segment protocol.  The source is injected so this
// module can be exercised without a page, a filesystem, or a real peer.

import {
  createChannelSender,
  parseControl,
  sliceForRange,
} from './segment-protocol.mjs';
import { createHostAccounting } from './host-accounting.mjs';

const MEDIA_PREFIX = '/media/';
const MAP_LINE_RE = /^#EXT-X-MAP:.*$/gm;
const MAP_URI_RE = /URI="([^"]+)"/;
const BYTERANGE_RE = /\bBYTERANGE\s*=/i;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('host source bytes must be a Uint8Array or ArrayBuffer');
}

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
export function createHostOrigin({ readSource, clock, settings = {}, wallNow = () => Date.now() } = {}) {
  if (typeof readSource !== 'function') throw new TypeError('createHostOrigin: readSource is required');
  const instanceId = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const accounting = createHostAccounting({ wallNow, instanceId });
  let responseCounter = 0;
  let protocolErrors = 0;
  const memo = new Map();
  const channels = new Set();
  const liveSenders = new Map();

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
      onCredited(id, bytes) {
        accounting.credited(channelKey, id, bytes);
        accounting.settleIfDone(channelKey, id, sender.pendingFrames(id));
      },
      onClosed() {
        accounting.closeChannel(channelKey);
        liveSenders.delete(channelKey);
      },
    });
    const active = new Map();
    let detached = false;

    liveSenders.set(channelKey, sender);

    const onMessage = (event) => {
      const control = parseControl(event?.data);
      if (!control) return;
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
      if (control.t !== 'req') return;
      if (!uint32(control.id) || active.has(control.id) || typeof control.path !== 'string' || !control.path.startsWith(MEDIA_PREFIX)) {
        protocolErrors += 1;
        return;
      }
      const entry = { aborted: false };
      active.set(control.id, entry);
      Promise.resolve()
        .then(() => read(control.path))
        .then((source) => {
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
          if (source.status === 200 && slice.status === 200 || slice.status === 206) {
            sender.start(control.id, bytes.subarray(slice.start, slice.start + slice.length));
          } else {
            sender.start(control.id, new Uint8Array());
          }
          if (head.length === 0) accounting.settleIfDone(channelKey, control.id, sender.pendingFrames(control.id));
        }, () => {
          if (detached || entry.aborted) return;
          const head = { t: 'head', id: control.id, rid: nextRid(), status: 502, length: 0 };
          if (sender.sendControl(head)) accounting.open({
            channelKey,
            id: control.id,
            rid: head.rid,
            path: control.path,
            viewerTag,
            expected: head.length,
          });
          sender.start(control.id, new Uint8Array());
          accounting.settleIfDone(channelKey, control.id, sender.pendingFrames(control.id));
        });
    };

    channel.addEventListener('message', onMessage);
    const detach = () => {
      if (detached) return;
      detached = true;
      channel.removeEventListener('message', onMessage);
      for (const id of active.keys()) sender.abort(id);
      active.clear();
      sender.close();
      accounting.closeChannel(channelKey);
      liveSenders.delete(channelKey);
      channels.delete(detach);
    };
    channels.add(detach);
    return detach;
  }

  return {
    attach,
    snapshot() {
      for (const sender of liveSenders.values()) sender.flush();
      return accounting.snapshot();
    },
    stats() {
      return { protocolErrors, responses: responseCounter, channels: channels.size };
    },
  };
}
