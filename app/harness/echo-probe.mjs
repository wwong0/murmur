import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  TYPE_ECHO_REPLY,
  TYPE_ERROR,
  TYPE_JOINED,
  buildEchoEnvelope,
  buildJoinEnvelope,
} from '../public/lib/envelope.mjs';

// Fifty milliseconds is the declared allowance after the next fixed cadence due time.
const PROBE_GRACE_MS = 50;
const USAGE = 'node harness/echo-probe.mjs --origin=<url> --room=<room> --tab=<tag> --out=<path> --interval-ms=<ms> [--max-ms=<budget>]';

function parseArgs(argv) {
  const allowed = new Set(['origin', 'room', 'tab', 'out', 'interval-ms', 'max-ms']);
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`invalid argument "${arg}"; use ${USAGE}`);
    const [key, ...rest] = arg.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
    if (!rest.length || rest.join('=') === '') throw new Error(`flag --${key} needs a value`);
    values[key] = rest.join('=');
  }
  for (const key of ['origin', 'room', 'tab', 'out', 'interval-ms']) if (values[key] === undefined) throw new Error(`missing required flag --${key}`);
  const intervalMs = Number(values['interval-ms']);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('--interval-ms must be greater than zero');
  const maxMs = values['max-ms'] === undefined ? null : Number(values['max-ms']);
  if (maxMs !== null && (!Number.isFinite(maxMs) || maxMs < 0)) throw new Error('--max-ms must be finite and non-negative');
  return { origin: values.origin, room: values.room, tab: values.tab, out: values.out, intervalMs, maxMs };
}

function outputPath(out) {
  return path.resolve(out);
}

function healthPath(out) {
  return out.endsWith('.ndjson') ? `${out.slice(0, -'.ndjson'.length)}-health.json` : `${out}-health.json`;
}

function wsUrl(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function writeRecord(outPath, record) {
  fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`);
}

async function run(options) {
  const outPath = outputPath(options.out);
  const healthFile = healthPath(outPath);
  const room = options.room.endsWith('-probe') ? options.room : `${options.room}-probe`;
  const state = {
    room,
    tab: options.tab,
    issued: 0,
    replied: 0,
    lost: 0,
    startedAtMs: Date.now(),
    endedAtMs: null,
    closedEarly: false,
    error: null,
    joined: false,
    stopping: false,
    finished: false,
    pending: new Map(),
    ws: null,
  };
  const health = () => ({
    room: state.room,
    tab: state.tab,
    issued: state.issued,
    replied: state.replied,
    lost: state.lost,
    lossFraction: state.issued === 0 ? null : state.lost / state.issued,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs ?? Date.now(),
    closedEarly: state.closedEarly,
    error: state.error,
  });
  const writeHealth = () => fs.writeFileSync(healthFile, `${JSON.stringify(health())}\n`);
  const markLost = (pending) => {
    if (!state.pending.delete(pending.id)) return;
    clearTimeout(pending.timer);
    writeRecord(outPath, { seq: pending.seq, t1: pending.t1, t4: null, rttMs: null, lost: true });
    state.lost += 1;
  };
  const expire = (nowMs) => {
    for (const pending of state.pending.values()) if (nowMs >= pending.deadlineMs) markLost(pending);
  };
  const finish = (errorMessage, code) => {
    if (state.finished) return;
    state.stopping = true;
    if (errorMessage) state.error = errorMessage;
    for (const pending of [...state.pending.values()]) markLost(pending);
    state.endedAtMs = Date.now();
    writeHealth();
    state.finished = true;
    if (state.ws && state.ws.readyState !== WebSocket.CLOSED) state.ws.close(1000, 'probe complete');
    process.exitCode = code;
  };

  process.once('SIGTERM', () => finish('stopped by SIGTERM', 0));
  process.once('SIGINT', () => finish('stopped by SIGINT', 0));

  let endpoint;
  try {
    endpoint = wsUrl(options.origin);
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error), 1);
    return;
  }
  const ws = new WebSocket(endpoint);
  state.ws = ws;
  let closePromiseResolve;
  const closePromise = new Promise((resolve) => { closePromiseResolve = resolve; });

  ws.on('open', () => {
    ws.send(JSON.stringify(buildJoinEnvelope({ room, tabId: options.tab, role: 'viewer' })));
  });
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      state.error = 'received invalid JSON';
      return;
    }
    if (message.type === TYPE_JOINED) {
      state.joined = true;
      return;
    }
    if (message.type === TYPE_ERROR) {
      finish(`server error: ${message.payload?.code ?? 'unknown'}`, 1);
      return;
    }
    if (message.type !== TYPE_ECHO_REPLY || typeof message.replyTo !== 'string') return;
    const pending = state.pending.get(message.replyTo);
    if (!pending) return;
    state.pending.delete(message.replyTo);
    clearTimeout(pending.timer);
    const t4 = Date.now();
    writeRecord(outPath, { seq: pending.seq, t1: pending.t1, t4, rttMs: t4 - pending.t1, lost: false });
    state.replied += 1;
  });
  ws.on('error', (error) => {
    if (!state.stopping) state.error = error.message;
  });
  ws.on('close', (code, reason) => {
    closePromiseResolve();
    if (!state.stopping) {
      state.closedEarly = true;
      finish(`websocket closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`, 1);
    }
  });

  const startMonotonic = process.hrtime.bigint();
  let nextDueMs = options.intervalMs;
  while (!state.stopping) {
    const elapsedMs = Number(process.hrtime.bigint() - startMonotonic) / 1e6;
    if (options.maxMs !== null && elapsedMs >= options.maxMs) break;
    const delay = Math.max(0, nextDueMs - elapsedMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (state.stopping) break;
    const nowMs = Date.now();
    expire(nowMs);
    if (state.joined && ws.readyState === WebSocket.OPEN) {
      const seq = state.issued;
      const id = `echo-${seq}`;
      const t1 = Date.now();
      state.issued += 1;
      const pending = { id, seq, t1, deadlineMs: nowMs + options.intervalMs + PROBE_GRACE_MS, timer: null };
      pending.timer = setTimeout(() => markLost(pending), options.intervalMs + PROBE_GRACE_MS);
      state.pending.set(id, pending);
      ws.send(JSON.stringify(buildEchoEnvelope(id)));
    }
    nextDueMs += options.intervalMs;
  }
  if (!state.stopping) finish(null, state.closedEarly ? 1 : 0);
  if (ws.readyState !== WebSocket.CLOSED) await closePromise;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
