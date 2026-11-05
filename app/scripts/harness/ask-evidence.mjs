// Each viewer's host asks, drained by cursor from its join to
// the end of the run, and the host's response counts at both boundaries.

import fs from 'node:fs';
import path from 'node:path';
import { median } from '../../public/lib/frame-drift.mjs';

export const ASK_HEALTH_FILE = 'viewer-asks-health.json';
export const ASK_DRAIN_EVERY_MS = 1_000;
export const askFile = (tag) => `viewer-asks-${tag}.ndjson`;
export const hostStatsFile = (kind) => `host-stats-${kind}.json`;

const finite = (value) => Number.isFinite(value);
const STATS_FIELDS = ['protocolErrors', 'responses', 'urgentResponses', 'nearResponses', 'channels'];

// The page's wall instant is read beside the asks, on the clock an ask's `atMs` is on.
export const askExpression = (cursor) => `(() => ({ asks: __app.hostAsks(${Number(cursor)}), wallMs: performance.timeOrigin + performance.now() }))()`;

function assertAskReading(tag, reading) {
  const asks = reading?.asks;
  if (!asks || !Array.isArray(asks.records) || !finite(asks.latestSeq) || !finite(asks.evicted) || !finite(reading.wallMs)) {
    throw new Error(`host ask reading is malformed: ${tag}`);
  }
  return asks;
}

export function createAskEvidence({ ndjson, runDir = null, now = Date.now, everyMs = ASK_DRAIN_EVERY_MS } = {}) {
  const byTag = {};
  const stateFor = (tag) => (byTag[tag] ??= { cursor: 0, received: 0, evicted: 0, gaps: 0, reads: 0, lastReadAtMs: null, offsets: [], maxBracketMs: 0 });

  async function drain(session, { force = false } = {}) {
    const state = stateFor(session.tag);
    if (!force && state.lastReadAtMs !== null && now() - state.lastReadAtMs < everyMs) return null;
    const harnessBeforeMs = now();
    const reading = await session.tab.evaluate(askExpression(state.cursor));
    const harnessAfterMs = now();
    const asks = assertAskReading(session.tag, reading);
    state.lastReadAtMs = harnessAfterMs;
    state.reads += 1;
    state.offsets.push(reading.wallMs - (harnessBeforeMs + harnessAfterMs) / 2);
    state.maxBracketMs = Math.max(state.maxBracketMs, harnessAfterMs - harnessBeforeMs);
    state.evicted = Math.max(state.evicted, asks.evicted);
    for (const record of asks.records) {
      if (!finite(record?.seq) || record.seq <= state.cursor) throw new Error(`host ask seq is not increasing: ${session.tag}`);
      if (record.seq !== state.cursor + 1) state.gaps += 1;
      state.cursor = record.seq;
    }
    // A page that says it holds more than was read lost the difference.
    if (asks.latestSeq > state.cursor) state.gaps += 1;
    state.received += asks.records.length;
    if (asks.records.length) ndjson.append(askFile(session.tag), asks.records.map((record) => ({ ...record, harnessBeforeMs, harnessAfterMs })));
    return asks.records.length;
  }

  function health() {
    return Object.fromEntries(Object.entries(byTag).map(([tag, state]) => [tag, {
      received: state.received, latestSeq: state.cursor, evicted: state.evicted, gaps: state.gaps, reads: state.reads,
      wallOffsetMs: state.offsets.length ? median(state.offsets.slice().sort((a, b) => a - b)) : null,
      maxBracketMs: state.maxBracketMs,
    }]));
  }

  function finalize() {
    const value = health();
    if (runDir) fs.writeFileSync(path.join(runDir, ASK_HEALTH_FILE), `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  return { drain, health, finalize };
}

/** The host's response counts at a boundary. A host page with none is not a host page. */
export async function recordHostStats({ kind, hostSession, runDir, now = Date.now }) {
  const stats = await hostSession.tab.evaluate('__app.hostStats()');
  if (stats === null || typeof stats !== 'object' || STATS_FIELDS.some((field) => !finite(stats[field]))) {
    throw new Error(`host stats are unavailable at the ${kind} boundary: ${JSON.stringify(stats ?? null)}`);
  }
  const value = { ...stats, atMs: now() };
  fs.writeFileSync(path.join(runDir, hostStatsFile(kind)), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
