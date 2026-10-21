// What the host knows about its own uplink, and what it does with it: the one bucket
// and capacity estimate every attached channel shares, the echo that reads the queue
// below the host, and the interval sampler that feeds them (8b design.md D2).

import { CHUNK_PAYLOAD_BYTES, DRAIN_POLL_MS, BUFFER_FLOOR_BYTES } from './segment-protocol.mjs';
import { createSendPace } from './send-pace.mjs';
import { classifyInterval, createCapacityEstimate, createProbePlan, createQueuedRun } from './capacity-estimate.mjs';
import { createEchoDelay, ECHO_MARGIN_MS } from './echo-delay.mjs';
import { createSendArbiter } from './send-arbiter.mjs';

const INTERVAL_NOMINAL_MS = 1000;
const INTERVAL_RING_CAPACITY = 3600;
// Four chunks deep, not one: at one, two channels admitting within a chunk's refill
// drove the level negative and every link-bound interval read pace-bound, so a paced
// host never saw its capacity fall (8b d1-findings.md F2).
export const PACE_CAP_BYTES = 4 * CHUNK_PAYLOAD_BYTES;
// T14, T15 (design.md D2): a probe follows 10 pace-bound intervals, or each one
// while the estimate still climbs.
export const PROBE_AFTER_INTERVALS = 10;
export const PROBE_FACTOR = 1.1;

/**
 * `fraction` is already validated. `queueCapMs` is design.md D2's cap: a channel is
 * held while the bytes handed to it that no echo answer has confirmed pass what its
 * answers confirmed in the last of these. `inProgress(channelKey)` says whether the
 * channel has a response open or a source read pending.
 */
export function createHostPace({ clock, wallNow, fraction, wire = null, queueCapMs, inProgress }) {
  const sendPace = createSendPace({ capBytes: PACE_CAP_BYTES });
  const arbiter = createSendArbiter({ pace: sendPace, clock });
  const capacityEstimate = createCapacityEstimate({});
  const queuedRun = createQueuedRun({ marginMs: ECHO_MARGIN_MS, chunkBytes: CHUNK_PAYLOAD_BYTES });
  const probePlan = createProbePlan({ after: PROBE_AFTER_INTERVALS, factor: PROBE_FACTOR, marginMs: ECHO_MARGIN_MS });
  const echo = createEchoDelay();
  const liveSenders = new Map();
  const retiredChannels = new Set();
  // Started channels not yet left. A channel whose sender closed is retired and no
  // longer live, and still counts here until its detach.
  let started = 0;
  let waitingChannelCount = 0;
  let samplerTimer = null;
  let previousCloseMs = null;
  let currentSamples = [];
  let closedDrainedTotal = 0;
  let previousTotalDrained = 0;
  let closedHandedTotal = 0;
  let previousTotalHanded = 0;
  // Readings arrive in order; a sampler restart starts a new generation.
  let wireGeneration = 0;
  let previousWire = null;
  let wireChain = null;
  let probing = false;
  let climbing = true;
  let paceInForce = null;
  let intervalSeq = 0;
  let intervalsEvicted = 0;
  const intervalRing = [];

  function totalDrainedNow() {
    let total = closedDrainedTotal;
    for (const sender of liveSenders.values()) total += sender.drainedBodyBytes();
    return total;
  }

  // Every byte the channels moved below `bufferedAmount`: frames and controls.
  function totalHandedNow() {
    let total = closedHandedTotal;
    for (const sender of liveSenders.values()) total += sender.stats().drainedBytes;
    return total;
  }

  // Without a transport below the channel (the fake links), the drain is the wire.
  function readWire(then) {
    let value;
    try {
      value = wire ? wire.read() : totalHandedNow();
    } catch {
      value = null;
    }
    const settle = (bytes) => then(Number.isFinite(bytes) ? bytes : null);
    if (value && typeof value.then === 'function') {
      const previous = wireChain ?? Promise.resolve();
      wireChain = previous.then(() => value).then(settle, () => settle(null));
    } else if (wireChain) {
      wireChain = wireChain.then(() => settle(value));
    } else {
      settle(value);
    }
  }

  function setPaceRate(nowMs) {
    if (fraction === 'unpaced') return;
    const { bytesPerSecond } = capacityEstimate.read();
    const factor = probing ? PROBE_FACTOR : fraction;
    const rate = bytesPerSecond === null ? null : (factor * bytesPerSecond) / 1000;
    sendPace.setRate(rate, nowMs);
    paceInForce = rate === null ? null : rate * 1000;
  }

  // Unpaced and a few times a second, so the answer's delay is the queue below the host.
  function sendEchoIfDue(channelKey, sender, nowMs, afterChunk = false) {
    const n = afterChunk ? echo.after(channelKey, nowMs) : echo.due(channelKey, nowMs);
    if (n === null || !sender.sendControl({ t: 'echo', n })) return;
    echo.handed(channelKey, n, sender.stats().handedBytes);
  }

  function channelHeld(channelKey, nowMs) {
    const seen = echo.confirmed(channelKey, nowMs, queueCapMs);
    const sender = liveSenders.get(channelKey);
    if (!seen || !sender) return false;
    return sender.stats().handedBytes - seen.totalBytes > Math.max(BUFFER_FLOOR_BYTES, seen.windowBytes);
  }

  function closeSamplerInterval(nowMs) {
    const startMs = previousCloseMs;
    const durationMs = nowMs - startMs;
    if (!(durationMs > 0)) throw new RangeError('host-origin: interval durationMs must be positive');
    const total = totalDrainedNow();
    const drainedBodyBytes = total - previousTotalDrained;
    if (drainedBodyBytes < 0) throw new RangeError('host-origin: drainedBodyBytes delta must not be negative');
    previousTotalDrained = total;
    const handedTotal = totalHandedNow();
    const handedBytes = handedTotal - previousTotalHanded;
    previousTotalHanded = handedTotal;
    const paceBoundMs = sendPace.closeInterval(nowMs);
    if (paceBoundMs < 0 || paceBoundMs > durationMs) throw new RangeError('host-origin: paceBoundMs out of bounds for its interval');
    const echoed = echo.closeInterval(startMs, nowMs);
    const interval = { samples: currentSamples, startMs, endMs: nowMs, endWallMs: wallNow(), durationMs, drainedBodyBytes, handedBytes, paceBoundMs, probe: probing, echoed };
    previousCloseMs = nowMs;
    currentSamples = [];
    const generation = wireGeneration;
    readWire((bytes) => {
      if (generation !== wireGeneration) return;
      const wireBytes = bytes === null || previousWire === null ? null : Math.max(0, bytes - previousWire);
      if (bytes !== null) previousWire = bytes;
      finishInterval(interval, wireBytes);
    });
  }

  function finishInterval(interval, wireBytes) {
    const { samples, startMs, durationMs, handedBytes, paceBoundMs, probe, echoed } = interval;
    const verdict = classifyInterval({ samples, startMs, durationMs, paceBoundMs, wireBytes, handedBytes, queueMs: echoed.queueMs, marginMs: ECHO_MARGIN_MS });
    const reading = queuedRun.add({ wireBytes, durationMs, linkBound: verdict.linkBound, headQueueMs: echoed.headQueueMs, tailQueueMs: echoed.tailQueueMs });
    if (reading) capacityEstimate.record({ ...reading, linkBound: true });
    const rate = wireBytes === null ? null : wireBytes * 1000 / durationMs;
    const plan = probePlan.close({ probe, linkBound: verdict.linkBound, reason: verdict.reason, rate, headQueueMs: echoed.headQueueMs, tailQueueMs: echoed.tailQueueMs }, capacityEstimate.read().bytesPerSecond);
    if (plan.raiseTo !== null) capacityEstimate.raise(plan.raiseTo);
    probing = fraction !== 'unpaced' && plan.probeNext;
    climbing = plan.climbing;
    const paceBytesPerSecond = paceInForce;
    setPaceRate(clock.now());
    intervalSeq += 1;
    intervalRing.push({
      seq: intervalSeq,
      startMs,
      endMs: interval.endMs,
      endWallMs: interval.endWallMs,
      samples: samples.length,
      drainedBodyBytes: interval.drainedBodyBytes,
      handedBytes,
      wireBytes,
      durationMs,
      linkBound: verdict.linkBound,
      queued: verdict.linkBound,
      reason: verdict.reason,
      paceBoundMs,
      probe,
      queueMs: echoed.queueMs,
      headQueueMs: echoed.headQueueMs,
      tailQueueMs: echoed.tailQueueMs,
      echoSamples: echoed.samples,
      heldSamples: samples.filter((sample) => sample.channels.some((channel) => channel.held)).length,
      readingBytesPerSecond: reading ? reading.wireBytes * 1000 / reading.durationMs : null,
      raised: plan.raiseTo !== null,
      climbing,
      paceBytesPerSecond,
      estimateBytesPerSecond: capacityEstimate.read().bytesPerSecond,
    });
    if (intervalRing.length > INTERVAL_RING_CAPACITY) {
      intervalRing.shift();
      intervalsEvicted += 1;
    }
  }

  function samplerTick() {
    const now = clock.now();
    const channelsSample = [];
    for (const [channelKey, sender] of liveSenders) {
      channelsSample.push({ inProgress: inProgress(channelKey), waitingBodyBytes: sender.waitingBodyBytes(), held: channelHeld(channelKey, now) });
      sendEchoIfDue(channelKey, sender, now);
    }
    currentSamples.push({ atMs: now, channels: channelsSample });
    if (now >= previousCloseMs + INTERVAL_NOMINAL_MS) closeSamplerInterval(now);
    scheduleSampler();
  }

  function scheduleSampler() {
    if (samplerTimer !== null || started === 0) return;
    samplerTimer = clock.setTimeout(() => {
      samplerTimer = null;
      if (started === 0) return;
      samplerTick();
    }, DRAIN_POLL_MS);
  }

  function startSamplerIfIdle() {
    if (started !== 1) return; // this start is not the first
    previousCloseMs = clock.now();
    currentSamples = [];
    previousTotalHanded = totalHandedNow();
    wireGeneration += 1;
    previousWire = null;
    wireChain = null;
    const generation = wireGeneration;
    readWire((bytes) => { if (generation === wireGeneration) previousWire = bytes; });
    scheduleSampler();
  }

  // One channel's part in the pace. `retire` runs when its sender closes and again at
  // detach; `leave` only at detach.
  function join(channelKey, sender) {
    liveSenders.set(channelKey, sender);
    echo.add(channelKey);
    return {
      held: () => channelHeld(channelKey, clock.now()),
      chunkSent: () => sendEchoIfDue(channelKey, sender, clock.now(), true),
      echoAnswered: (n) => echo.answered(channelKey, n, clock.now()),
      start() {
        started += 1;
        startSamplerIfIdle();
        // The first echo leaves before any body, so the floor is read on an empty channel.
        sendEchoIfDue(channelKey, sender, clock.now());
      },
      retire() {
        if (retiredChannels.has(channelKey)) return;
        retiredChannels.add(channelKey);
        closedHandedTotal += sender.stats().drainedBytes;
        closedDrainedTotal += sender.drainedBodyBytes();
        liveSenders.delete(channelKey);
        echo.drop(channelKey);
      },
      leave() {
        started -= 1;
        if (started === 0 && samplerTimer !== null) {
          clock.clearTimeout(samplerTimer);
          samplerTimer = null;
        }
      },
    };
  }

  return {
    gate: arbiter,
    join,
    senders: () => liveSenders.values(),
    waiting(hasWaiting) {
      waitingChannelCount += hasWaiting ? 1 : -1;
      sendPace.setWaiting(waitingChannelCount, clock.now());
    },
    read(afterSeq = 0) {
      const estimate = capacityEstimate.read();
      const paceBytesPerSecond = fraction === 'unpaced' || estimate.bytesPerSecond === null
        ? null : fraction * estimate.bytesPerSecond;
      return {
        fraction,
        estimate,
        paceBytesPerSecond,
        intervals: intervalRing.filter((entry) => entry.seq > afterSeq),
        evicted: intervalsEvicted,
      };
    },
  };
}
