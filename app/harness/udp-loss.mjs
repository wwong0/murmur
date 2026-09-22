import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_BYTES = 12;
const USAGE = 'node harness/udp-loss.mjs --send --to=<host:port> --count=<n> --interval-ms=<ms> --size=<bytes> [--report=<path>]';

function parseArgs(argv) {
  const allowed = new Set(['send', 'receive', 'to', 'port', 'count', 'interval-ms', 'size', 'report', 'max-ms']);
  const values = {};
  for (const arg of argv) {
    if (arg === '--send' || arg === '--receive') {
      if (values[arg.slice(2)] !== undefined) throw new Error(`duplicate flag ${arg}`);
      values[arg.slice(2)] = true;
      continue;
    }
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`invalid argument "${arg}"; use ${USAGE}`);
    const [key, ...rest] = arg.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
    if (!rest.length || rest.join('=') === '') throw new Error(`flag --${key} needs a value`);
    values[key] = rest.join('=');
  }
  if (Boolean(values.send) === Boolean(values.receive)) throw new Error('choose exactly one of --send or --receive');
  if (values.send) {
    for (const key of ['to', 'count', 'interval-ms', 'size']) if (values[key] === undefined) throw new Error(`missing required flag --${key}`);
    const count = positiveInteger(values.count, 'count');
    const intervalMs = positiveNumber(values['interval-ms'], 'interval-ms');
    const size = positiveInteger(values.size, 'size');
    if (size < HEADER_BYTES) throw new Error(`--size must be at least ${HEADER_BYTES} bytes`);
    return { mode: 'send', to: values.to, count, intervalMs, size, report: values.report ?? null };
  }
  if (values.port === undefined) throw new Error('missing required flag --port');
  const port = positiveInteger(values.port, 'port');
  const count = values.count === undefined ? null : positiveInteger(values.count, 'count');
  const maxMs = values['max-ms'] === undefined ? null : nonNegativeNumber(values['max-ms'], 'max-ms');
  return { mode: 'receive', port, count, maxMs, report: values.report ?? null };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be a positive integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be a finite number greater than zero`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be a finite non-negative number`);
  return number;
}

function parseEndpoint(value) {
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/);
  const match = bracketed ?? value.match(/^(.+):(\d+)$/);
  if (!match) throw new Error(`--to must be host:port, got "${value}"`);
  const port = Number(match[2]);
  if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --to endpoint "${value}"`);
  return { host: match[1], port };
}

// Stdout ALWAYS, and the file as well when one was asked for. The receiver is
// started detached and read back from its file; the sender is read from its
// stdout. A probe whose only answer is a file it may not have reached says
// nothing at all when it fails, which is how this returned an empty string.
function writeReport(file, report) {
  const line = `${JSON.stringify(report)}\n`;
  process.stdout.write(line);
  if (file) fs.writeFileSync(path.resolve(file), line);
}

/** Compute directional loss from unique sequence numbers; impossible math is a hard error. */
export function summarizeLoss(sequences) {
  if (sequences.length === 0) throw new Error('cannot compute loss without a received sequence');
  const unique = [...new Set(sequences)].sort((a, b) => a - b);
  const firstSeq = unique[0];
  const lastSeq = unique[unique.length - 1];
  const expected = lastSeq - firstSeq + 1;
  const received = unique.length;
  const lost = expected - received;
  if (!Number.isInteger(expected) || expected <= 0 || lost < 0 || lost > expected) throw new Error('physically impossible loss arithmetic');
  const lossFraction = lost / expected;
  if (!Number.isFinite(lossFraction) || lossFraction < 0 || lossFraction > 1) throw new Error('physically impossible loss fraction');
  return { expected, received, lost, lossFraction, firstSeq, lastSeq };
}

async function send(options) {
  const endpoint = parseEndpoint(options.to);
  const socket = dgram.createSocket('udp4');
  const state = { sent: 0, errors: [], stopping: false, finished: false };
  const report = () => ({ sent: state.sent, count: options.count, intervalMs: options.intervalMs, sizeBytes: options.size });
  const finish = (code) => {
    if (state.finished) return;
    state.finished = true;
    writeReport(options.report, report());
    try { socket.close(); } catch { /* an unbound socket has nothing to close */ }
    process.exitCode = code;
  };
  process.once('SIGTERM', () => { state.stopping = true; finish(0); });
  process.once('SIGINT', () => { state.stopping = true; finish(0); });
  socket.on('error', (error) => {
    state.errors.push(error.message);
    state.stopping = true;
    finish(1);
  });
  const start = process.hrtime.bigint();
  for (let seq = 0; seq < options.count && !state.stopping; seq += 1) {
    const dueMs = seq * options.intervalMs;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (dueMs > elapsedMs) await new Promise((resolve) => setTimeout(resolve, dueMs - elapsedMs));
    if (state.stopping) break;
    const packet = Buffer.alloc(options.size);
    packet.writeUInt32BE(seq >>> 0, 0);
    packet.writeBigUInt64BE(process.hrtime.bigint(), 4);
    await new Promise((resolve, reject) => {
      socket.send(packet, endpoint.port, endpoint.host, (error) => error ? reject(error) : resolve());
    }).then(() => { state.sent += 1; }).catch((error) => {
      state.errors.push(error.message);
      state.stopping = true;
    });
  }
  finish(state.errors.length ? 1 : 0);
}

async function receive(options) {
  const socket = dgram.createSocket('udp4');
  const sequences = [];
  let duplicates = 0;
  let reordered = 0;
  let highestSeq = -1;
  let receivedPackets = 0;
  let done = false;
  let resolveDone;
  const stopped = new Promise((resolve) => { resolveDone = resolve; });
  const finish = () => {
    if (done) return;
    done = true;
    try { socket.close(); } catch { /* bind failure leaves no active socket */ }
    resolveDone();
  };
  socket.on('message', (message) => {
    if (message.length < HEADER_BYTES || done) return;
    const seq = message.readUInt32BE(0);
    receivedPackets += 1;
    const duplicate = sequences.includes(seq);
    if (duplicate) duplicates += 1;
    else {
      if (seq < highestSeq) reordered += 1;
      sequences.push(seq);
    }
    highestSeq = Math.max(highestSeq, seq);
    if (options.count !== null && receivedPackets >= options.count) finish();
  });
  socket.on('error', (error) => {
    if (!done) {
      console.error(error.message);
      finish();
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('listening', resolve);
    socket.once('error', reject);
    socket.bind(options.port, '0.0.0.0');
  }).catch((error) => {
    console.error(error.message);
    finish();
  });
  if (options.maxMs !== null) setTimeout(finish, options.maxMs).unref();
  process.once('SIGTERM', finish);
  process.once('SIGINT', finish);
  await stopped;
  try {
    const summary = summarizeLoss(sequences);
    writeReport(options.report, { ...summary, duplicates, reordered });
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'send') await send(options);
    else await receive(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
