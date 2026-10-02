// The host's uplink capacity estimate (design.md D2). Pure: no timer, no clock read.
// Every instant and interval is supplied by the caller.

// "Throughout" is judged by coverage, not a count: no span of the interval, its two
// edges included, may go unsampled longer than this. Three of the host's 20 ms polls,
// so a loaded page's slower timer still qualifies (8b d1-findings.md F3).
export const MAX_SAMPLE_GAP_MS = 60;

function largestGapMs(samples, startMs, endMs) {
  let previous = startMs;
  let largest = 0;
  for (const { atMs } of samples) {
    largest = Math.max(largest, atMs - previous);
    previous = atMs;
  }
  return Math.max(largest, endMs - previous);
}

function validateInterval({ drainedBodyBytes, durationMs }) {
  if (!(durationMs > 0)) throw new RangeError('capacity-estimate: durationMs must be greater than 0');
  if (!(drainedBodyBytes >= 0)) throw new RangeError('capacity-estimate: drainedBodyBytes must not be negative');
}

// classifyInterval decides whether one drain interval was link-bound: every
// in-progress channel had bytes waiting for admission throughout, with no pace and
// some real drain. `reason` names the first failing condition, in this fixed order.
export function classifyInterval({ samples, startMs, drainedBodyBytes, durationMs, paceBoundMs }) {
  validateInterval({ drainedBodyBytes, durationMs });
  if (!(largestGapMs(samples, startMs, startMs + durationMs) <= MAX_SAMPLE_GAP_MS)) return { linkBound: false, reason: 'sample-gap' };
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
