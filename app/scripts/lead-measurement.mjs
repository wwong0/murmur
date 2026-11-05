// Lead measurement arithmetic and browser probes. The runner owns timing and
// publication; these functions keep its figures and in-page observations
// independently testable.

import { median as medianOfSorted } from '../public/lib/frame-drift.mjs';

export const TICK_BACKSTOP_MS = 250;
export const CLOCK_ERROR_ALLOWANCE_MS = 1000;
export const POPULATIONS = Object.freeze(['buffered', 'unbuffered']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function ceil50(value) {
  if (!finite(value) || value < 0) throw new Error(`ceil50 needs a finite non-negative value, got ${value}`);
  return Math.ceil(value / 50) * 50;
}

/**
 * The one sorting median every script here reads. The middle of an even set is
 * `frame-drift.mjs`'s and nobody else's: a second definition is how the page and
 * the browser pass came to disagree once already.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return medianOfSorted([...values].sort((a, b) => a - b));
}

export function nearestRankP99(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
}

export function stats(values) {
  const usable = values.filter(finite);
  return {
    count: usable.length,
    maxMs: usable.length ? Math.max(...usable) : null,
    p99Ms: nearestRankP99(usable),
    medianMs: median(usable),
  };
}

function keyOf(record) {
  return `${record.sender}:${record.i}:${record.receiver}`;
}

export function expectedDeliveryKeys(samplesPerSender, senders = ['P', 'Q'], receivers = ['P', 'Q']) {
  const keys = [];
  for (const sender of senders) {
    for (let i = 0; i < samplesPerSender; i += 1) {
      for (const receiver of receivers) keys.push(`${sender}:${i}:${receiver}`);
    }
  }
  return keys;
}

export function reduceDelivery(records, { samplesPerSender, senders = ['P', 'Q'], receivers = ['P', 'Q'] } = {}) {
  if (!Number.isInteger(samplesPerSender) || samplesPerSender <= 0) {
    throw new Error(`samplesPerSender must be positive, got ${samplesPerSender}`);
  }
  const expected = new Set(expectedDeliveryKeys(samplesPerSender, senders, receivers));
  const seen = new Set();
  const duplicates = [];
  const unexpected = [];
  const missingClocks = [];
  const usable = [];
  for (const record of records) {
    const key = keyOf(record);
    if (!expected.has(key)) unexpected.push(key);
    else if (seen.has(key)) duplicates.push(key);
    else seen.add(key);
    const inputs = [record.sentSharedMs, record.recvSharedMs, record.halfWidthSendMs, record.halfWidthRecvMs];
    if (inputs.every(finite)) {
      const latencyMs = record.recvSharedMs - record.sentSharedMs;
      const upperMs = latencyMs + record.halfWidthSendMs + record.halfWidthRecvMs;
      if (finite(latencyMs) && finite(upperMs)) usable.push({ ...record, latencyMs, upperMs });
      else missingClocks.push({ key, reason: 'non-finite-derived' });
    } else {
      missingClocks.push({ key, reason: 'missing-clock' });
    }
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  const expectedCount = expected.size;
  const excludedCount = missingClocks.length + missing.length;
  return {
    expectedCount,
    retainedCount: records.length,
    usable,
    stats: stats(usable.map((record) => record.upperMs)),
    maxHalfWidthMs: usable.length
      ? Math.max(...usable.flatMap((record) => [record.halfWidthSendMs, record.halfWidthRecvMs]))
      : null,
    missing,
    duplicates,
    unexpected,
    missingClocks,
    excludedCount,
    usableFraction: expectedCount ? usable.length / expectedCount : 0,
    complete: missing.length === 0 && duplicates.length === 0 && unexpected.length === 0,
  };
}

function elapsed(record, startField, endField) {
  if (record.timedOut || record.skipped) return null;
  if (!finite(record[startField]) || !finite(record[endField])) return null;
  const value = record[endField] - record[startField];
  return finite(value) && value >= 0 ? value : null;
}

export function reducePark(records, population) {
  const rows = records.filter((record) => record.population === population);
  const values = rows.map((record) => elapsed(record, 'writeAtMs', 'readyAtMs')).filter((value) => value !== null);
  const timedOut = rows.filter((record) => record.timedOut === true).length;
  const skipped = rows.filter((record) => record.skipped === true).length;
  return { population, plannedCount: rows.length, timedOut, skipped, usableCount: values.length, stats: stats(values) };
}

export function reduceLoad(records) {
  const values = records.map((record) => elapsed(record, 'startAtMs', 'readyAtMs')).filter((value) => value !== null);
  const timedOut = records.filter((record) => record.timedOut === true).length;
  return { plannedCount: records.length, timedOut, usableCount: values.length, stats: stats(values) };
}

export function reduceEvidence({ delivery, park, load, samplesPerSender, enforceMinimums = false }) {
  const deliveryResult = reduceDelivery(delivery, { samplesPerSender });
  const parkResult = Object.fromEntries(POPULATIONS.map((population) => [population, reducePark(park, population)]));
  const loadResult = reduceLoad(load);
  const stops = [];
  if (enforceMinimums) {
    if (deliveryResult.excludedCount > samplesPerSender * 4 * 0.05) stops.push('delivery-clock-exclusions-over-5-percent');
    if (deliveryResult.maxHalfWidthMs > 100) stops.push('clock-half-width-over-100ms');
    if (deliveryResult.stats.maxMs > 250) stops.push('delivery-upper-over-250ms');
    if (parkResult.unbuffered.timedOut > 3) stops.push('unbuffered-timeouts-over-3');
    if (parkResult.buffered.plannedCount < 30 || parkResult.unbuffered.plannedCount < 30) stops.push('park-planned-count-under-30');
    if (parkResult.buffered.usableCount < 24 || parkResult.unbuffered.usableCount < 24) stops.push('park-population-under-24');
    if (loadResult.plannedCount < 10) stops.push('first-load-planned-count-under-10');
    if (loadResult.usableCount < 10) stops.push('first-load-under-10');
  }
  const prepareMax = Math.max(parkResult.unbuffered.stats.maxMs ?? -Infinity, loadResult.stats.maxMs ?? -Infinity);
  const transitionLeadMs = deliveryResult.stats.maxMs === null ? null : ceil50(deliveryResult.stats.maxMs + TICK_BACKSTOP_MS);
  const prepareLeadMs = Number.isFinite(prepareMax) ? ceil50(prepareMax + TICK_BACKSTOP_MS) : null;
  if (enforceMinimums && (transitionLeadMs > 1000 || prepareLeadMs > 1500)) stops.push('lead-threshold-exceeded');
  return {
    delivery: deliveryResult,
    park: parkResult,
    load: loadResult,
    transitionLeadMs,
    prepareLeadMs,
    maxFutureMs: transitionLeadMs === null ? null : transitionLeadMs + CLOCK_ERROR_ALLOWANCE_MS,
    stops,
    acceptance: stops.length === 0 && deliveryResult.complete && transitionLeadMs !== null && prepareLeadMs !== null,
  };
}

export function parseNdjson(text, label) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return records;
}

const pageClock = `(() => {
  const reading = window.__app?.clock?.();
  const localMs = performance.timeOrigin + performance.now();
  if (!reading || !Number.isFinite(reading.offsetMs) || !Number.isFinite(reading.halfWidthMs)) {
    return { sentSharedMs: null, halfWidthSendMs: null };
  }
  return { sentSharedMs: localMs + reading.offsetMs, halfWidthSendMs: reading.halfWidthMs };
})()`;

export function deliveryProbeExpression({ room, tabId, samples, intervalMs = 100 }) {
  const body = JSON.stringify({ room, tabId: `${tabId}-probe`, role: 'viewer' });
  return `(() => {
    const records = [];
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    const joined = ${body};
    let sent = 0;
    let done = false;
    let joinedRoom = false;
    let started = false;
    let finishError = null;
    let resolveResult;
    let sendTimer = null;
    let finishTimer = null;
    const result = new Promise((resolve) => { resolveResult = resolve; });
    const finish = (error = null) => {
      if (done) return;
      done = true;
      finishError = error;
      clearTimeout(sendTimer);
      clearTimeout(finishTimer);
      try { ws.close(); } catch {}
      resolveResult({ records, sent, error });
    };
    const sendOne = () => {
      if (done || ws.readyState !== WebSocket.OPEN) return;
      if (sent >= ${samples}) {
        finishTimer = setTimeout(() => finish(), 1500);
        return;
      }
      const clock = ${pageClock};
      const payload = { i: sent, sender: ${JSON.stringify(tabId)}, sentSharedMs: clock.sentSharedMs, halfWidthSendMs: clock.halfWidthSendMs };
      try {
        ws.send(JSON.stringify({ v: 1, type: 'lead-probe', to: 'room', payload }));
        sent += 1;
        sendTimer = setTimeout(sendOne, ${intervalMs});
      } catch (error) {
        finish(String(error?.message ?? error));
      }
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ v: 1, type: 'join', to: 'server', payload: joined })));
    const start = () => {
      if (started || !joinedRoom) return;
      started = true;
      sendOne();
    };
    ws.addEventListener('message', (event) => {
      let env;
      try { env = JSON.parse(event.data); } catch { return; }
      if (env.type === 'joined') {
        joinedRoom = true;
        return;
      }
      if (env.type !== 'lead-probe') return;
      const payload = env.payload ?? {};
      const clock = ${pageClock};
      records.push({
        receiver: ${JSON.stringify(tabId)},
        sender: payload.sender,
        i: payload.i,
        sentSharedMs: payload.sentSharedMs,
        recvSharedMs: clock.sentSharedMs,
        halfWidthSendMs: payload.halfWidthSendMs,
        halfWidthRecvMs: clock.halfWidthSendMs,
        tsRecv: env.ts?.recv ?? null,
      });
    });
    ws.addEventListener('close', () => { if (!done) setTimeout(() => finish('probe socket closed'), 500); });
    ws.addEventListener('error', () => { if (!done) setTimeout(() => finish('probe socket error'), 500); });
    setTimeout(() => finish('probe deadline'), ${Math.max(30000, samples * intervalMs + 15000)});
    window.__leadProbe = { start, result, state: () => ({ joined: joinedRoom, started, sent, done, error: finishError }) };
    return { installed: true };
  })()`;
}

export function deliveryProbeStateExpression() {
  return `(() => window.__leadProbe?.state?.() ?? { joined: false, started: false, sent: 0, done: false, error: 'probe not installed' })()`;
}

export function deliveryProbeStartExpression() {
  return `(() => { const probe = window.__leadProbe; if (!probe) return { records: [], sent: 0, error: 'probe not installed' }; probe.start(); return probe.result; })()`;
}

export function parkProbeExpression({ samplesPerPopulation }) {
  return `(() => new Promise(async (resolve) => {
    const video = document.querySelector('video');
    const rows = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rangesOf = () => Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]);
    const inRange = (value, ranges) => ranges.some(([start, end]) => start <= value && value <= end);
    const unbufferedTarget = (current, duration, ranges, forward) => {
      const direct = forward ? current + 600 : current - 600;
      if (direct >= 60 && direct < duration - 60 && !inRange(direct, ranges)) return direct;
      const points = [60, duration - 60];
      for (const [start, end] of ranges) points.push(Math.max(60, start), Math.min(duration - 60, end));
      points.sort((a, b) => a - b);
      for (let i = 1; i < points.length; i += 1) {
        const left = points[i - 1];
        const right = points[i];
        if (right - left < 2) continue;
        const candidate = (left + right) / 2;
        if (candidate >= 60 && candidate < duration - 60 && Math.abs(candidate - current) >= 60 && !inRange(candidate, ranges)) return candidate;
      }
      return null;
    };
    const readiness = (writeAtMs) => new Promise((done) => {
      let sawSeeked = false;
      let finished = false;
      const events = ['canplay', 'canplaythrough', 'seeked'];
      const finish = (eventName) => {
        if (finished || !sawSeeked || video.readyState < 3) return;
        finished = true;
        for (const name of events) video.removeEventListener(name, onEvent);
        clearTimeout(timer);
        done({ readyAtMs: performance.now(), readyState: video.readyState, event: eventName, timedOut: false });
      };
      const onEvent = (event) => {
        if (event.type === 'seeked') sawSeeked = true;
        finish(event.type);
      };
      for (const name of events) video.addEventListener(name, onEvent);
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        for (const name of events) video.removeEventListener(name, onEvent);
        done({ readyAtMs: null, readyState: video.readyState, event: null, timedOut: true });
      }, 20000);
      if (video.readyState >= 3 && writeAtMs < performance.now()) finish('already-ready');
    });
    for (let i = 0; i < ${samplesPerPopulation * 2}; i += 1) {
      video.pause();
      await wait(500);
      const currentMs = video.currentTime * 1000;
      const durationMs = video.duration * 1000;
      const bufferedRanges = rangesOf().map(([start, end]) => [start * 1000, end * 1000]);
      const population = i % 2 === 0 ? 'buffered' : 'unbuffered';
      let targetMs = null;
      let skipReason = null;
      if (population === 'buffered') {
        const target = video.currentTime + 2;
        const range = rangesOf().find(([start, end]) => start <= video.currentTime && target + 1 <= end);
        if (range) targetMs = target * 1000;
        else skipReason = 'no-buffered-range-containing-current-and-target-plus-one-second';
      } else {
        targetMs = unbufferedTarget(video.currentTime, video.duration, rangesOf(), i % 4 !== 3);
        if (targetMs === null) skipReason = 'no-interior-unbuffered-target';
        else targetMs *= 1000;
      }
      if (targetMs === null) {
        rows.push({ population, currentMs, targetMs, durationMs, bufferedRanges, skipped: true, skipReason, timedOut: false });
      } else {
        const writeAtMs = performance.now();
        const readyPromise = readiness(writeAtMs);
        video.currentTime = targetMs / 1000;
        const ready = await readyPromise;
        rows.push({ population, currentMs, targetMs, durationMs, bufferedRanges, writeAtMs, ...ready, skipped: false });
      }
      try { await Promise.resolve(video.play()); } catch {}
      await wait(3000);
    }
    resolve(rows);
  }))()`;
}

export function loadInitScript() {
  return `(() => {
    const state = { startAtMs: null, readyAtMs: null, readyState: null, event: null };
    window.__leadLoad = state;
    const isVideo = (target) => target && target.tagName === 'VIDEO';
    document.addEventListener('loadstart', (event) => {
      if (isVideo(event.target) && state.startAtMs === null) state.startAtMs = performance.now();
    }, true);
    const onReady = (event) => {
      if (isVideo(event.target) && state.readyAtMs === null && event.target.readyState >= 3) {
        state.readyAtMs = performance.now();
        state.readyState = event.target.readyState;
        state.event = event.type;
      }
    };
    document.addEventListener('canplay', onReady, true);
    document.addEventListener('canplaythrough', onReady, true);
  })();`;
}

export function loadProbeExpression(timeoutMs = 20000) {
  return `(() => new Promise((resolve) => {
    const deadline = performance.now() + ${timeoutMs};
    const poll = () => {
      const state = window.__leadLoad ?? { startAtMs: null, readyAtMs: null, readyState: null, event: null };
      if (state.readyAtMs !== null || performance.now() >= deadline) resolve({ ...state, timedOut: state.readyAtMs === null });
      else setTimeout(poll, 50);
    };
    poll();
  }))()`;
}
