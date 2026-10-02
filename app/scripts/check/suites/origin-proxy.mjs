import http from 'node:http';
import net from 'node:net';

import { assert, assertEqual, check } from '../harness.mjs';
import { createOriginProxy } from '../../../harness/origin-proxy.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };
    server.close(finish);
    setTimeout(finish, 250);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

function upgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /ws HTTP/1.1\r\nHost: proxy.test\r\nConnection: Upgrade\r\nUpgrade: chat\r\n\r\nhello');
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('upgrade timed out'));
    }, 2_000);
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.includes(Buffer.from('\r\n\r\nhello'))) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(data.toString());
      }
    });
    socket.on('error', reject);
  });
}

export default async function originProxySuite() {
  await check('origin proxy: media and room requests route with bytes, headers and websocket upgrades unchanged', async () => {
    let mediaCount = 0;
    let roomCount = 0;
    const media = http.createServer((req, res) => {
      mediaCount += 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'x-target': 'media' });
      res.end(Buffer.from('segment-bytes'));
    });
    const room = http.createServer((req, res) => {
      roomCount += 1;
      res.writeHead(200, { 'content-type': 'text/html', 'x-target': 'room' });
      res.end('room-page');
    });
    room.on('upgrade', (req, socket, head) => {
      roomCount += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: chat\r\n\r\n');
      socket.on('data', (chunk) => socket.write(chunk));
      if (head?.length) socket.write(head);
    });
    const mediaPort = await listen(media);
    const roomPort = await listen(room);
    const proxy = createOriginProxy({ mediaTarget: `http://127.0.0.1:${mediaPort}`, roomTarget: `http://127.0.0.1:${roomPort}` });
    const proxyPort = await listen(proxy);
    try {
      const mediaResponse = await get(proxyPort, '/media/seg-00001.m4s?x=1');
      assertEqual(mediaResponse.status, 206, 'media status');
      assertEqual(mediaResponse.headers['x-target'], 'media', 'media header');
      assertEqual(mediaResponse.body.toString(), 'segment-bytes', 'media body');
      const roomResponse = await get(proxyPort, '/room.html');
      assertEqual(roomResponse.status, 200, 'room status');
      assertEqual(roomResponse.headers['x-target'], 'room', 'room header');
      assertEqual(roomResponse.body.toString(), 'room-page', 'room body');
      const upgraded = await upgrade(proxyPort);
      assert(upgraded.includes('101 Switching Protocols\r\n') && upgraded.includes('hello'), 'upgrade round trip');
      assertEqual(mediaCount, 1, 'media target count');
      assertEqual(roomCount, 2, 'room page and upgrade count');
    } finally {
      await close(proxy);
      await close(media);
      await close(room);
    }
  });

  // Mutation proof: one /media/ request gives the routing opportunity and the
  // room target is the forbidden action boundary. Sending every request to the
  // room target makes the room-count assertion red; restoring the path split is
  // green again.
  await check('origin proxy: media reads never reach the room target', async () => {
    let mediaCount = 0;
    let roomCount = 0;
    const media = http.createServer((req, res) => { mediaCount += 1; res.end('media'); });
    const room = http.createServer((req, res) => { roomCount += 1; res.end('room'); });
    const mediaPort = await listen(media);
    const roomPort = await listen(room);
    const proxy = createOriginProxy({ mediaTarget: `http://127.0.0.1:${mediaPort}`, roomTarget: `http://127.0.0.1:${roomPort}` });
    const proxyPort = await listen(proxy);
    try {
      await get(proxyPort, '/media/seg.m4s');
      assertEqual(mediaCount, 1, 'media target sees media read');
      assertEqual(roomCount, 0, 'room target sees no media read');
    } finally {
      await close(proxy);
      await close(media);
      await close(room);
    }
  });

  await check('origin proxy: an upstream refusal names its target with 502', async () => {
    const room = http.createServer((req, res) => res.end('room'));
    const roomPort = await listen(room);
    const proxy = createOriginProxy({ mediaTarget: 'http://127.0.0.1:1', roomTarget: `http://127.0.0.1:${roomPort}` });
    const proxyPort = await listen(proxy);
    try {
      const response = await get(proxyPort, '/media/refused.m4s');
      assertEqual(response.status, 502, 'upstream refusal status');
      assert(response.body.toString().includes('media'), 'upstream target is named');
    } finally {
      await close(proxy);
      await close(room);
    }
  });
}
