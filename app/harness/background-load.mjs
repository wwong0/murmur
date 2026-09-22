import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const USAGE = 'node harness/background-load.mjs --to=<host:port> --mbps=<number|null> [--granularity-ms=<ms>] [--max-ms=<ms>] [--report=<path>]';

function parseArgs(argv) {
  const allowed = new Set(['to', 'mbps', 'granularity-ms', 'max-ms', 'report']);
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`invalid argument "${arg}"; use ${USAGE}`);
    const [key, ...rest] = arg.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
    if (!rest.length || rest.join('=') === '') throw new Error(`flag --${key} needs a value`);
    values[key] = rest.join('=');
  }
  for (const key of ['to', 'mbps']) if (values[key] === undefined) throw new Error(`missing required flag --${key}`);
  const mbps = values.mbps === 'null' ? null : Number(values.mbps);
  if (mbps !== null && (!Number.isFinite(mbps) || mbps < 0)) throw new Error('--mbps must be null or a finite non-negative number');
  const granularityMs = values['granularity-ms'] === undefined ? 10 : Number(values['granularity-ms']);
  if (!Number.isFinite(granularityMs) || granularityMs <= 0) throw new Error('--granularity-ms must be greater than zero');
  const maxMs = values['max-ms'] === undefined ? null : Number(values['max-ms']);
  if (maxMs !== null && (!Number.isFinite(maxMs) || maxMs < 0)) throw new Error('--max-ms must be finite and non-negative');
  return { to: values.to, mbps, granularityMs, maxMs, report: values.report ?? null };
}

function parseEndpoint(value) {
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/);
  const match = bracketed ?? value.match(/^(.+):(\d+)$/);
  if (!match) throw new Error(`--to must be host:port, got "${value}"`);
  const host = match[1];
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --to endpoint "${value}"`);
  return { host, port };
}

function writeReport(options, report) {
  if (!options.report) return;
  fs.writeFileSync(path.resolve(options.report), `${JSON.stringify(report)}\n`);
}

function waitUntil(monotonicStart, targetMs) {
  const elapsedMs = Number(process.hrtime.bigint() - monotonicStart) / 1e6;
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, targetMs - elapsedMs)));
}

async function run(options) {
  const startedAtMs = Date.now();
  const monotonicStart = process.hrtime.bigint();
  const state = {
    bytesWritten: 0,
    drainWaits: 0,
    errors: [],
    endedAtMs: null,
    stopping: false,
    finished: false,
  };
  let socket = null;
  const finish = (errorMessage) => {
    if (errorMessage) state.errors.push(errorMessage);
    state.stopping = true;
  };
  const makeReport = () => {
    const endedAtMs = state.endedAtMs ?? Date.now();
    const elapsedMs = Math.max(1, endedAtMs - startedAtMs);
    return {
      mbps: options.mbps,
      granularityMs: options.granularityMs,
      startedAtMs,
      endedAtMs,
      bytesWritten: state.bytesWritten,
      achievedMbps: (state.bytesWritten * 8 * 1000) / (elapsedMs * 1e6),
      drainWaits: state.drainWaits,
      errors: state.errors,
    };
  };
  const finalize = (code = 0) => {
    if (state.finished) return;
    state.finished = true;
    state.endedAtMs = Date.now();
    writeReport(options, makeReport());
    process.exitCode = code;
  };

  const stopForSignal = () => {
    state.stopping = true;
    if (socket) socket.destroy();
  };
  process.once('SIGTERM', stopForSignal);
  process.once('SIGINT', stopForSignal);

  if (options.mbps === null || options.mbps === 0) {
    finalize(0);
    return;
  }

  const endpoint = parseEndpoint(options.to);
  socket = net.createConnection(endpoint);
  let socketError = null;
  socket.on('error', (error) => {
    socketError = error;
    if (!state.stopping) finish(error.message);
  });
  socket.on('close', () => {
    if (!state.stopping) finish('sink socket closed early');
  });
  try {
    await once(socket, 'connect');
  } catch (error) {
    if (!state.stopping) finish(error instanceof Error ? error.message : String(error));
    socket.destroy();
    finalize(state.errors.length ? 1 : 0);
    return;
  }

  const bytesPerTick = options.mbps * 1e6 / 8 * options.granularityMs / 1000;
  let bucket = 0;
  let tick = options.granularityMs;
  while (!state.stopping) {
    if (options.maxMs !== null && tick > options.maxMs) break;
    await waitUntil(monotonicStart, tick);
    if (state.stopping) break;
    bucket += bytesPerTick;
    const amount = Math.floor(bucket);
    bucket -= amount;
    if (amount > 0) {
      let accepted;
      try {
        accepted = socket.write(Buffer.alloc(amount));
        state.bytesWritten += amount;
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
        break;
      }
      if (!accepted) {
        state.drainWaits += 1;
        try {
          await Promise.race([
            once(socket, 'drain'),
            once(socket, 'error').then(([error]) => { throw error; }),
            once(socket, 'close').then(() => { throw new Error('sink socket closed during drain'); }),
          ]);
        } catch (error) {
          if (!state.stopping) finish(error instanceof Error ? error.message : String(error));
        }
      }
    }
    tick += options.granularityMs;
    if (options.maxMs !== null && tick > options.maxMs) break;
  }
  if (socketError && !state.errors.includes(socketError.message)) state.errors.push(socketError.message);
  state.stopping = true;
  if (!socket.destroyed) socket.end();
  finalize(state.errors.length ? 1 : 0);
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
