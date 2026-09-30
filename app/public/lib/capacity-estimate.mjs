// The host's uplink capacity estimate (design.md D2). Pure: no timer, no clock read.
// Every instant and interval is supplied by the caller.

export const MIN_LINK_BOUND_SAMPLES = 48;

function validateInterval({ drainedBodyBytes, durationMs }) {
  if (!(durationMs > 0)) throw new RangeError('capacity-estimate: durationMs must be greater than 0');
  if (!(drainedBodyBytes >= 0)) throw new RangeError('capacity-estimate: drainedBodyBytes must not be negative');
}

// classifyInterval decides whether one drain interval was link-bound: every
// in-progress channel had bytes waiting for admission throughout, with no pace and
// some real drain. `reason` names the first failing condition, in this fixed order.
export function classifyInterval({ samples, drainedBodyBytes, durationMs, paceBoundMs }) {
  validateInterval({ drainedBodyBytes, durationMs });
  if (samples.length < MIN_LINK_BOUND_SAMPLES) return { linkBound: false, reason: 'few-samples' };
  for (const sample of samples) {
    if (!sample.channels.some((channel) => channel.inProgress)) return { linkBound: false, reason: 'no-request' };
  }
  for (const sample of samples) {
    for (const channel of sample.channels) {
      if (channel.inProgress && !(channel.waitingBodyBytes > 0)) return { linkBound: false, reason: 'channel-idle' };
    }
  }
  if (paceBoundMs !== 0) return { linkBound: false, reason: 'pace-bound' };
  if (!(drainedBodyBytes > 0)) return { linkBound: false, reason: 'no-drain' };
  return { linkBound: true, reason: null };
}

// createCapacityEstimate keeps the median rate of the last `window` link-bound
// intervals. A non-link-bound interval changes nothing. The module never resets —
// a host page lives one room, and a new page makes a new module.
export function createCapacityEstimate({ window = 5 } = {}) {
  const rates = [];
  let linkBoundTotal = 0;

  function record({ drainedBodyBytes, durationMs, linkBound }) {
    validateInterval({ drainedBodyBytes, durationMs });
    if (!linkBound) return;
    linkBoundTotal += 1;
    rates.push(drainedBodyBytes * 1000 / durationMs);
    if (rates.length > window) rates.shift();
  }

  function read() {
    const intervalsBehind = Math.min(linkBoundTotal, window);
    if (linkBoundTotal < window) return { bytesPerSecond: null, intervalsBehind, linkBoundTotal };
    const sorted = [...rates].sort((left, right) => left - right);
    const bytesPerSecond = sorted[Math.floor(sorted.length / 2)];
    return { bytesPerSecond, intervalsBehind, linkBoundTotal };
  }

  return Object.freeze({ record, read });
}
