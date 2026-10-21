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

// classifyInterval decides whether one interval saw the link bound (design.md D2, the
// echo): bytes on the wire, bytes leaving the channels, and every channel's round
// trip above its floor by more than the margin. A stall hands nothing down and
// answers no echo, so a stall is not a link. `reason` names the first failing condition.
export function classifyInterval({ samples, startMs, durationMs, paceBoundMs, wireBytes, handedBytes, queueMs, marginMs }) {
  validateInterval({ wireBytes, durationMs });
  if (queueMs !== null && !(queueMs >= 0)) throw new RangeError('capacity-estimate: queueMs must be null or not negative');
  if (!(largestGapMs(samples, startMs, startMs + durationMs) <= MAX_SAMPLE_GAP_MS)) return { linkBound: false, reason: 'sample-gap' };
  for (const sample of samples) {
    if (!sample.channels.some((channel) => channel.inProgress)) return { linkBound: false, reason: 'no-request' };
  }
  if (wireBytes === null || !(wireBytes > 0)) return { linkBound: false, reason: 'no-wire' };
  if (!(handedBytes > 0)) return { linkBound: false, reason: 'stalled' };
  if (queueMs !== null && queueMs > marginMs) return { linkBound: true, reason: null };
  if (paceBoundMs !== 0) return { linkBound: false, reason: 'pace-bound' };
  return { linkBound: false, reason: 'no-queue' };
}

// One interval's wire count is off by up to 40 % and two together read the link
// (design.md D2, remedy investigation), so a reading is the wire rate over this many
// consecutive link-bound intervals. A longer run yields a reading per pair.
// The wire count is taken where bytes enter the queue, so a run across which the
// round trip rose read the queue filling, not the link, and gives no reading; nor
// does one whose first or last half answered no echo.
export const READING_INTERVALS = 2;

export function createQueuedRun({ intervals = READING_INTERVALS, marginMs = 0, chunkBytes = 0 } = {}) {
  let count = 0;
  let bytes = 0;
  let ms = 0;
  let startQueueMs = null;
  // Returns the finished reading as { wireBytes, durationMs }, or null.
  return Object.freeze({
    add({ wireBytes, durationMs, linkBound, headQueueMs = null, tailQueueMs = null }) {
      validateInterval({ wireBytes, durationMs });
      if (!linkBound) { count = 0; bytes = 0; ms = 0; return null; }
      if (count === 0) startQueueMs = headQueueMs ?? tailQueueMs;
      count += 1;
      bytes += wireBytes;
      ms += durationMs;
      if (count < intervals) return null;
      const endQueueMs = tailQueueMs ?? headQueueMs;
      // An echo waits behind whole chunks: one chunk's time at this rate is not a rise.
      const allowedMs = marginMs + chunkBytes * ms / bytes;
      const stood = startQueueMs !== null && endQueueMs !== null && endQueueMs <= startQueueMs + allowedMs;
      const reading = stood ? { wireBytes: bytes, durationMs: ms } : null;
      count = 0; bytes = 0; ms = 0;
      return reading;
    },
  });
}

// createProbePlan says when the host probes above its estimate and what a probe
// proved. A probe raises the estimate only when the bucket bound it and the round
// trip stayed flat through its second half and the next interval's first. Until a
// probe first meets a queue the host climbs: it probes after every pace-bound
// interval rather than every `after`. The climb restarts at a probe that raised the estimate.
export function createProbePlan({ after, climbAfter = 1, factor, marginMs, restartOnRaise = true }) {
  let run = 0;
  let climbing = true;
  let pending = null;
  const flat = (ms) => ms !== null && ms <= marginMs;
  const seen = (ms) => ms !== null && ms > marginMs;

  function close(interval, estimateBytesPerSecond) {
    let raiseTo = null;
    if (pending) {
      if (pending.linkBound || interval.linkBound || seen(pending.tailQueueMs) || seen(interval.headQueueMs)) climbing = false;
      else if (pending.reason === 'pace-bound' && flat(pending.tailQueueMs) && flat(interval.headQueueMs)
        && estimateBytesPerSecond !== null && pending.rate > estimateBytesPerSecond) {
        raiseTo = Math.min(pending.rate, factor * estimateBytesPerSecond);
        if (restartOnRaise) climbing = true;
      }
      pending = null;
    }
    if (interval.probe) { pending = interval; run = 0; }
    else if (interval.linkBound) run = 0;
    else if (interval.reason === 'pace-bound') run += 1;
    return { raiseTo, probeNext: run >= (climbing ? climbAfter : after), climbing };
  }

  return Object.freeze({ close });
}

// createCapacityEstimate keeps the median wire rate of the last `window` readings,
// formed at the first. `raise` replaces them all: a probe proved the link faster
// than every one. A host page lives one room; a new page makes a new module.
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
