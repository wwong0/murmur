import dgram from 'node:dgram';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'node harness/sink.mjs --port=<port> [--report-ms=<ms>]';

function parseArgs(argv) {
  const allowed = new Set(['port', 'report-ms']);
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`invalid argument "${arg}"; use ${USAGE}`);
    const [key, ...rest] = arg.slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
    if (!rest.length || rest.join('=') === '') throw new Error(`flag --${key} needs a value`);
    values[key] = rest.join('=');
  }
  if (values.port === undefined) throw new Error('missing required flag --port');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 through 65535');
  const reportMs = values['report-ms'] === undefined ? 1000 : Number(values['report-ms']);
  if (!Number.isFinite(reportMs) || reportMs <= 0) throw new Error('--report-ms must be greater than zero');
  return { port, reportMs };
}

async function run(options) {
  const startedAtMs = Date.now();
  let totalBytes = 0;
  let udpBytes = 0;
  let udpDatagrams = 0;
  let connections = 0;
  let previousBytes = 0;
  let previousReportAtMs = startedAtMs;
  const sockets = new Set();
  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', (chunk) => {
    udpBytes += chunk.length;
    udpDatagrams += 1;
  });
  udpSocket.on('error', () => {});
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    connections += 1;
    let mode = 'undecided';
    let prefix = Buffer.alloc(0);
    let connectionBytes = 0;

    const countReply = () => {
      const body = { totalBytes, connections, startedAtMs, atMs: Date.now() };
      socket.end(`${JSON.stringify(body)}\n`);
    };

    socket.on('data', (chunk) => {
      if (mode === 'count') return;
      if (mode === 'discard') {
        connectionBytes += chunk.length;
        totalBytes += chunk.length;
        return;
      }

      prefix = Buffer.concat([prefix, chunk]);
      const newline = prefix.indexOf(0x0a);
      if (newline === -1 && prefix.length < 1024) return;
      const firstLine = newline === -1 ? prefix.toString() : prefix.subarray(0, newline).toString();
      if (newline !== -1 && firstLine === 'COUNT' && newline === 5) {
        // COUNT is a deliberate control dispatch, excluded from filler bytes so filler-null proves 0 exactly.
        mode = 'count';
        countReply();
        return;
      }

      mode = 'discard';
      connectionBytes += prefix.length;
      totalBytes += prefix.length;
      prefix = Buffer.alloc(0);
    });
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (mode === 'undecided' && prefix.length > 0) {
        mode = 'discard';
        connectionBytes += prefix.length;
        totalBytes += prefix.length;
      }
    });
    socket.on('close', () => {
      void connectionBytes;
    });
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '0.0.0.0', resolve);
    }),
    new Promise((resolve, reject) => {
      udpSocket.once('error', reject);
      udpSocket.bind(options.port, '0.0.0.0', resolve);
    }),
  ]);

  const report = () => {
    const atMs = Date.now();
    const elapsedMs = Math.max(1, atMs - previousReportAtMs);
    const bytesPerSecond = ((totalBytes - previousBytes) * 1000) / elapsedMs;
    console.log(JSON.stringify({ atMs, connections, totalBytes, bytesPerSecond, udpBytes, udpDatagrams }));
    previousBytes = totalBytes;
    previousReportAtMs = atMs;
  };
  const timer = setInterval(report, options.reportMs);
  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        resolve();
      };
      try { udpSocket.close(finish); } catch { finish(); }
      server.close(finish);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await run(parseArgs(process.argv.slice(2)));
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
