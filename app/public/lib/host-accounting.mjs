// Delivered-byte accounting for host-origin responses.

import { classifyPath, createCounters } from '../../server/byte-accounting.mjs';

function tagOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function expectedOf(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('expected must be a non-negative finite number');
  return value;
}

/**
 * @param {{wallNow?: () => number, instanceId: string}} config
 */
export function createHostAccounting({ wallNow = () => Date.now(), instanceId } = {}) {
  if (typeof wallNow !== 'function') throw new TypeError('createHostAccounting: wallNow must be a function');
  if (typeof instanceId !== 'string' || instanceId.length === 0) throw new TypeError('createHostAccounting: instanceId is required');
  const counters = createCounters();
  const responses = new Map();

  function responseFor(channelKey, id) {
    return responses.get(channelKey)?.get(id) ?? null;
  }

  function open({ channelKey, id, rid, path, viewerTag, expected }) {
    let channel = responses.get(channelKey);
    if (!channel) {
      channel = new Map();
      responses.set(channelKey, channel);
    }
    if (channel.has(id)) throw new Error(`response already open for id ${id}`);
    channel.set(id, {
      rid,
      path,
      kind: classifyPath(path),
      viewerTag: tagOf(viewerTag),
      expected: expectedOf(expected),
      credited: 0,
      aborted: false,
      settled: false,
    });
  }

  function settle(response, aborted) {
    if (response.settled) return;
    response.aborted = aborted;
    const delivered = Math.min(response.credited, response.expected);
    counters.record({
      kind: response.kind,
      clientTag: response.viewerTag,
      urlPath: response.path,
      delivered,
      waste: aborted ? delivered : 0,
      aborted,
      expectedBytes: response.expected,
      originResponseId: response.rid,
    });
    response.settled = true;
  }

  return {
    open,
    credited(channelKey, id, bytes) {
      const response = responseFor(channelKey, id);
      if (response && !response.settled) response.credited += Math.max(0, Number(bytes) || 0);
    },
    abort(channelKey, id) {
      const response = responseFor(channelKey, id);
      if (response && !response.settled) response.aborted = true;
    },
    settleIfDone(channelKey, id, pendingFrames) {
      const response = responseFor(channelKey, id);
      if (!response || response.settled) return false;
      const pending = Math.max(0, Number(pendingFrames) || 0);
      if (!response.aborted && response.credited >= response.expected) settle(response, false);
      else if (response.aborted && pending === 0) settle(response, true);
      return response.settled;
    },
    closeChannel(channelKey) {
      const channel = responses.get(channelKey);
      if (!channel) return;
      for (const response of channel.values()) {
        if (!response.settled) settle(response, true);
      }
    },
    snapshot() {
      let openResponses = 0;
      for (const channel of responses.values()) {
        for (const response of channel.values()) if (!response.settled) openResponses += 1;
      }
      const atMs = wallNow();
      return {
        source: 'host-origin',
        instanceId,
        atMs,
        atIso: new Date(atMs).toISOString(),
        openResponses,
        counters: counters.snapshot(),
      };
    },
  };
}
