import fs from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const USAGE = 'node harness/background-load.mjs --to=<host:port> --mbps=<number|null> [--protocol=tcp|udp] [--granularity-ms=<ms>] [--max-ms=<ms>] [--report=<path>]';
export const UDP_PAYLOAD_BYTES = 1400;
// The kernel holds a sender back once its send buffer is queued, and the default
// 212 992 B is about 90 datagrams, ~10 ms at 100 Mbit. Asking for 4 MiB (the
// container's wmem_max; Linux doubles it) leaves tbf's own limit to bound the
// queue.
export const UDP_SEND_BUFFER_BYTES = 4 * 1024 * 1024;

export function parseArgs(argv) {
  const allowed = new Set(['to', 'mbps', 'granularity-ms', 'max-ms', 'report', 'protocol']);
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
  const protocol = values.protocol ?? 'tcp';
  if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('--protocol must be tcp or udp');
  return { to: values.to, mbps, granularityMs, maxMs, protocol, report: values.report ?? null };
}

// Carrying sub-datagram bytes prevents paced UDP from underfilling each tick.
export function udpPacingTick({ mbps, granularityMs, remainderBytes = 0, payloadBytes = UDP_PAYLOAD_BYTES }) {
  if (!Number.isFinite(mbps) || mbps < 0) throw new RangeError('mbps must be a finite non-negative number');
  if (!Number.isFinite(granularityMs) || granularityMs <= 0) throw new RangeError('granularityMs must be greater than zero');
  if (!Number.isFinite(remainderBytes) || remainderBytes < 0) throw new RangeError('remainderBytes must be finite and non-negative');
  if (!Number.isInteger(payloadBytes) || payloadBytes <= 0) throw new RangeError('payloadBytes must be a positive integer');
  const bytesPerTick = mbps * 1e6 / 8 * granularityMs / 1000;
  const availableBytes = remainderBytes + bytesPerTick;
  const datagrams = Math.floor(availableBytes / payloadBytes);
  return { bytesPerTick, datagrams, remainderBytes: availableBytes - datagrams * payloadBytes };
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

function recordUdpError(state, error) {
  const code = error?.code ?? 'UNKNOWN';
  state.sendErrors[code] = (state.sendErrors[code] ?? 0) + 1;
}

async function run(options) {
  const startedAtMs = Date.now();
  const monotonicStart = process.hrtime.bigint();
  const state = {
    bytesWritten: 0,
    datagramsSent: 0,
    sendErrors: {},
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
    const report = {
      mbps: options.mbps,
      protocol: options.protocol,
      payloadBytes: options.protocol === 'udp' ? UDP_PAYLOAD_BYTES : null,
      granularityMs: options.granularityMs,
      startedAtMs,
      endedAtMs,
      bytesWritten: state.bytesWritten,
      achievedMbps: (state.bytesWritten * 8 * 1000) / (elapsedMs * 1e6),
      drainWaits: state.drainWaits,
      errors: state.errors,
    };
    if (options.protocol === 'udp') {
      report.datagramsSent = state.datagramsSent;
      report.sendErrors = state.sendErrors;
      report.sendBufferBytes = state.sendBufferBytes ?? null;
    }
    return report;
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
    if (socket) {
      if (options.protocol === 'udp') socket.close();
      else socket.destroy();
    }
  };
  process.once('SIGTERM', stopForSignal);
  process.once('SIGINT', stopForSignal);

  if (options.mbps === null || options.mbps === 0) {
    finalize(0);
    return;
  }

  const endpoint = parseEndpoint(options.to);
  if (options.protocol === 'udp') {
    socket = dgram.createSocket('udp4');
    socket.on('error', (error) => recordUdpError(state, error));
    await new Promise((resolve, reject) => {
      socket.once('listening', resolve);
      socket.once('error', reject);
      socket.bind(0, '0.0.0.0');
    });
    socket.setSendBufferSize(UDP_SEND_BUFFER_BYTES);
    state.sendBufferBytes = socket.getSendBufferSize();
    const payload = Buffer.alloc(UDP_PAYLOAD_BYTES);
    let remainderBytes = 0;
    let tick = options.granularityMs;
    while (!state.stopping) {
      if (options.maxMs !== null && tick > options.maxMs) break;
      await waitUntil(monotonicStart, tick);
      if (state.stopping) break;
      const pacing = udpPacingTick({ mbps: options.mbps, granularityMs: options.granularityMs, remainderBytes });
      remainderBytes = pacing.remainderBytes;
      for (let index = 0; index < pacing.datagrams; index++) {
        try {
          socket.send(payload, endpoint.port, endpoint.host, (error) => {
            if (error) recordUdpError(state, error);
            else {
              state.datagramsSent += 1;
              state.bytesWritten += payload.length;
            }
          });
        } catch (error) {
          recordUdpError(state, error);
        }
      }
      tick += options.granularityMs;
    }
    state.stopping = true;
    if (socket) {
      await new Promise((resolve) => {
        try { socket.close(resolve); } catch { resolve(); }
      });
    }
    finalize(0);
    return;
  }
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
