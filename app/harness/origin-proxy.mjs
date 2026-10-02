import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function targetParts(target) {
  const url = target instanceof URL ? target : new URL(target);
  return { hostname: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), name: url.href };
}

function requestTarget(req) {
  return req.url?.split('?', 1)[0].startsWith('/media/') ? 'media' : 'room';
}

function sendBadGateway(res, name, error) {
  if (res.headersSent) return res.destroy(error);
  res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
  res.end(`upstream ${name} unavailable: ${error?.message ?? error}`);
}

function proxyRequest(req, res, targets) {
  const name = requestTarget(req);
  const target = targets[name];
  const request = http.request({ ...target, method: req.method, path: req.url, headers: req.headers });
  request.once('response', (upstream) => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(res);
  });
  request.once('error', (error) => sendBadGateway(res, name, error));
  req.pipe(request);
}

function rawRequestHead(req) {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let index = 0; index < req.rawHeaders.length; index += 2) lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function proxyUpgrade(req, client, target, head) {
  const upstream = net.connect(target.port, target.hostname);
  const fail = () => client.destroy();
  upstream.once('connect', () => {
    upstream.write(rawRequestHead(req));
    if (head?.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once('error', fail);
  client.once('error', () => upstream.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
}

export function createOriginProxy({ mediaTarget, roomTarget } = {}) {
  if (!mediaTarget || !roomTarget) throw new TypeError('mediaTarget and roomTarget are required');
  const targets = { media: targetParts(mediaTarget), room: targetParts(roomTarget) };
  const server = http.createServer((req, res) => proxyRequest(req, res, targets));
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, targets.room, head));
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  return server;
}

function options(argv) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--(listen|media|room)=(.+)$/);
    if (!match) throw new Error('usage: node harness/origin-proxy.mjs --listen=<port> --media=<url> --room=<url>');
    values[match[1]] = match[2];
  }
  return {
    port: Number(values.listen ?? process.env.APP_PROXY_PORT ?? 8100),
    mediaTarget: values.media ?? process.env.APP_MEDIA_TARGET ?? 'http://127.0.0.1:8102',
    roomTarget: values.room ?? process.env.APP_ROOM_TARGET ?? 'http://server-media:8100',
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const config = options(process.argv.slice(2));
  createOriginProxy(config).listen(config.port, process.env.APP_PROXY_HOST ?? '127.0.0.1');
}
