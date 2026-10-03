// The host's queue signal (design.md D2, the echo round trip): how far each
// channel's round trip sits above its floor. Pure: every instant is supplied.

export const ECHO_PERIOD_MS = 100;
export const ECHO_MARGIN_MS = 30;
// A stalled channel answers nothing; its unanswered echoes stop at this many.
export const ECHO_OUTSTANDING_MAX = 64;

function lowest(values) {
  let low = null;
  for (const value of values) if (value !== null && (low === null || value < low)) low = value;
  return low;
}

export function createEchoDelay({ periodMs = ECHO_PERIOD_MS } = {}) {
  const channels = new Map();

  // The echo number to send on this channel now, or null when none is due.
  function due(key, nowMs) {
    const channel = channels.get(key);
    if (!channel) return null;
    if (channel.lastSentMs !== null && nowMs - channel.lastSentMs < periodMs) return null;
    if (channel.sent.size >= ECHO_OUTSTANDING_MAX) return null;
    channel.lastSentMs = nowMs;
    channel.sent.set(channel.next, { sentMs: nowMs, endBytes: null, timed: true });
    return channel.next++;
  }

  // An echo that follows a body chunk: its answer confirms bytes and times nothing,
  // since it waits behind that chunk. It leaves the cadence alone.
  function after(key, nowMs) {
    const channel = channels.get(key);
    if (!channel || channel.sent.size >= ECHO_OUTSTANDING_MAX) return null;
    channel.sent.set(channel.next, { sentMs: nowMs, endBytes: null, timed: false });
    return channel.next++;
  }

  // Where echo `n` ends in the bytes this channel has been handed. Its answer
  // confirms every byte before it arrived (design.md D2, the cap).
  function handed(key, n, endBytes) {
    const entry = channels.get(key)?.sent.get(n);
    if (entry) entry.endBytes = endBytes;
  }

  // The bytes this channel's answers confirmed, in all and over the last `windowMs`.
  function confirmed(key, nowMs, windowMs) {
    const channel = channels.get(key);
    if (!channel) return null;
    const marks = channel.confirmed;
    while (marks.length > 1 && marks[1].atMs <= nowMs - windowMs) marks.shift();
    const totalBytes = marks.length > 0 ? marks[marks.length - 1].bytes : 0;
    const based = marks.length > 0 && marks[0].atMs <= nowMs - windowMs;
    const windowBytes = based ? (totalBytes - marks[0].bytes) * windowMs / (nowMs - marks[0].atMs) : totalBytes;
    return { totalBytes, windowBytes };
  }

  function answered(key, n, nowMs) {
    const channel = channels.get(key);
    const entry = channel?.sent.get(n);
    if (entry === undefined) return;
    channel.sent.delete(n);
    const roundTripMs = nowMs - entry.sentMs;
    if (roundTripMs < 0) throw new RangeError('echo-delay: an echo was answered before it was sent');
    if (entry.timed) {
      channel.floorMs = channel.floorMs === null ? roundTripMs : Math.min(channel.floorMs, roundTripMs);
      channel.samples.push({ atMs: nowMs, roundTripMs });
    }
    const last = channel.confirmed[channel.confirmed.length - 1];
    if (entry.endBytes !== null && entry.endBytes > (last?.bytes ?? 0)) channel.confirmed.push({ atMs: nowMs, bytes: entry.endBytes });
  }

  // The lowest round trip above its floor in each half of the interval and over the
  // whole of it, per channel, then the lowest across channels: a queue on the host's
  // own uplink delays every channel, a slow viewer only its own. Null: no answer.
  function closeInterval(startMs, endMs) {
    const midMs = (startMs + endMs) / 2;
    const heads = [];
    const tails = [];
    let samples = 0;
    for (const channel of channels.values()) {
      const above = (half) => {
        const low = lowest(half.map((sample) => sample.roundTripMs));
        return low === null ? null : low - channel.floorMs;
      };
      heads.push(above(channel.samples.filter((sample) => sample.atMs < midMs)));
      tails.push(above(channel.samples.filter((sample) => sample.atMs >= midMs)));
      samples += channel.samples.length;
      channel.samples = [];
    }
    const perChannel = heads.map((head, index) => lowest([head, tails[index]]));
    return { queueMs: lowest(perChannel), headQueueMs: lowest(heads), tailQueueMs: lowest(tails), samples };
  }

  return Object.freeze({
    add(key) {
      channels.set(key, { floorMs: null, next: 1, lastSentMs: null, sent: new Map(), samples: [], confirmed: [] });
    },
    drop(key) {
      channels.delete(key);
    },
    due,
    after,
    handed,
    confirmed,
    answered,
    closeInterval,
  });
}
