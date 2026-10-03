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

function validateInterval({ wireBytes, durationMs }) {
  if (!(durationMs > 0)) throw new RangeError('capacity-estimate: durationMs must be greater than 0');
  if (wireBytes !== null && !(wireBytes >= 0)) throw new RangeError('capacity-estimate: wireBytes must be null or not negative');
}

// classifyInterval decides whether one interval was link-bound (design.md D2,
// reversed): a queue grew below the host, or every in-progress channel had bytes
// waiting throughout with no pace. `reason` names the first failing condition.
export function classifyInterval({ samples, startMs, durationMs, paceBoundMs, wireBytes, handedBytes, queueGrowthBytes }) {
  validateInterval({ wireBytes, durationMs });
  if (!(largestGapMs(samples, startMs, startMs + durationMs) <= MAX_SAMPLE_GAP_MS)) return { linkBound: false, reason: 'sample-gap' };
  for (const sample of samples) {
    if (!sample.channels.some((channel) => channel.inProgress)) return { linkBound: false, reason: 'no-request' };
  }
  if (wireBytes === null || !(wireBytes > 0)) return { linkBound: false, reason: 'no-wire' };
  if (handedBytes - wireBytes > queueGrowthBytes) return { linkBound: true, reason: null, queued: true };
  for (const sample of samples) {
    for (const channel of sample.channels) {
      if (channel.inProgress && !(channel.waitingBodyBytes > 0)) return { linkBound: false, reason: 'channel-idle' };
    }
  }
  if (paceBoundMs !== 0) return { linkBound: false, reason: 'pace-bound' };
  return { linkBound: true, reason: null, queued: false };
}

// createCapacityEstimate keeps the median wire rate of the last `window` link-bound
// intervals, formed at the first. `raise` replaces them all: a probe proved the link
// faster than every one. A host page lives one room; a new page makes a new module.
export function createCapacityEstimate({ window = 5 } = {}) {
  let rates = [];
  let linkBoundTotal = 0;

  function record({ wireBytes, durationMs, linkBound }) {
    validateInterval({ wireBytes, durationMs });
    if (!linkBound) return;
    linkBoundTotal += 1;
    rates.push(wireBytes * 1000 / durationMs);
    if (rates.length > window) rates.shift();
  }

  function raise(bytesPerSecond) {
    if (!(bytesPerSecond > 0)) throw new RangeError('capacity-estimate: a raise must be positive');
    rates = [bytesPerSecond];
  }

  function read() {
    if (rates.length === 0) return { bytesPerSecond: null, intervalsBehind: 0, linkBoundTotal };
    const sorted = [...rates].sort((left, right) => left - right);
    return { bytesPerSecond: sorted[Math.floor(sorted.length / 2)], intervalsBehind: rates.length, linkBoundTotal };
  }

  return Object.freeze({ record, raise, read });
}
