import net from 'node:net';

import { assert, assertEqual, check } from '../harness.mjs';
import { HTTP, mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';

const REQUIRED = ['content-security-policy', 'x-content-type-options', 'referrer-policy'];

function parseHeaders(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const lines = head.split('\r\n');
  const headers = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at !== -1) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number(lines[0]?.slice(9, 12)), headers };
}

function rawHeaders(target, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => resolve(parseHeaders(raw)));
    socket.on('error', reject);
  });
}

function assertHeaders(headers, label) {
  for (const name of REQUIRED) assert(headers[name], `${label} includes ${name}`);
  assert(headers['content-security-policy'].includes("frame-ancestors 'none'"), `${label} forbids framing`);
  assert(headers['content-security-policy'].includes("script-src 'self'"), `${label} restricts scripts`);
  assertEqual(headers['x-content-type-options'], 'nosniff', `${label} nosniff`);
  assertEqual(headers['referrer-policy'], 'no-referrer', `${label} referrer policy`);
}

export default async function securityHeadersSuite() {
  await check('security headers: every HTTP response path carries the hardening headers', async () => {
    const fileServer = startRoomServer({ port: 0, mediaDir, mediaSource: 'file', quiet: true });
    try {
      const port = await fileServer.ready;
      const cases = [
        ['/', 200],
        ['/missing-security-header', 404],
        ['/..%2f', 403],
        ['/media/anything', 404],
        ['/app-settings', 200],
      ];
      for (const [target, status] of cases) {
        const result = await rawHeaders(target, port);
        assertEqual(result.status, status, `${target} status`);
        assertHeaders(result.headers, target);
      }
    } finally {
      await fileServer.close();
    }
  });

  await check('security headers: the tracker origin is added to connect-src', async () => {
    const tracker = 'ws://tracker.example.test:8101/announce';
    const local = startRoomServer({ port: 0, mediaDir, trackerUrl: tracker, quiet: true });
    try {
      const response = await fetch(`http://127.0.0.1:${await local.ready}/`);
      const csp = response.headers.get('content-security-policy');
      assert(csp.includes("connect-src 'self' data: blob: ws://tracker.example.test:8101"), 'CSP includes tracker origin');
      assert(!csp.includes('/announce'), 'CSP uses tracker origin without a path');
    } finally {
      await local.close();
    }
  });

  await check('security headers: the global room page also carries the policy', async () => {
    const response = await fetch(`${HTTP}/`);
    assertEqual(response.status, 200, 'room page status');
    assertHeaders(Object.fromEntries(response.headers.entries()), 'room page');
  });
}
