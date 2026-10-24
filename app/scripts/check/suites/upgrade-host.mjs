import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, check, Peer } from '../harness.mjs';
import { buildClientEnvelope } from '../../../public/lib/envelope.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function startChild() {
  const child = spawn(process.execPath, ['server/room-server.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, APP_PORT: '0', APP_LIVENESS_INTERVAL_MS: '5000', APP_ENVELOPE_BURST: '1000', APP_JOIN_BURST: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not listen: ${stderr}`)), 10_000);
    const poll = () => {
      const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`child exited ${child.exitCode}: ${stderr}`));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
  return { child, ready, output: () => ({ stdout, stderr }) };
}

function malformedHostUpgrade(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(raw ? Number(raw.slice(9, 12)) : 0);
    };
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      raw += chunk;
      if (raw.includes('\r\n\r\n')) finish();
    });
    socket.on('error', () => finish());
    socket.on('close', () => finish());
  });
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill();
  return new Promise((resolve) => child.once('close', resolve));
}

export default async function upgradeHostSuite() {
  await check('upgrade host: malformed Host headers cannot end the child server', async () => {
    const running = startChild();
    let a;
    let b;
    try {
      const port = await running.ready;
      const url = `ws://127.0.0.1:${port}/ws`;
      a = await Peer.open(url, 'upgrade-a');
      b = await Peer.open(url, 'upgrade-b');
      await a.join({ room: 'upgrade-host', tabId: 'a', role: 'host' });
      await b.join({ room: 'upgrade-host', tabId: 'b', role: 'viewer' });
      const bracketStatus = await malformedHostUpgrade(port, '[');
      assert([0, 101, 400].includes(bracketStatus), `bracket Host is handled without process exit (got ${bracketStatus})`);
      assertEqual(running.child.exitCode, null, 'child survives bracket Host');
      const spaceStatus = await malformedHostUpgrade(port, 'a b');
      assert([0, 101, 400].includes(spaceStatus), `space Host is handled without process exit (got ${spaceStatus})`);
      assertEqual(running.child.exitCode, null, 'child survives space Host');
      a.send(buildClientEnvelope({ type: 'upgrade-survivor', to: 'room', id: 'survivor', payload: { ok: true } }));
      const relayed = await b.next((env) => env.type === 'upgrade-survivor');
      assertEqual(relayed.payload.ok, true, 'room remains able to relay after malformed Hosts');
      assertEqual(running.child.exitCode, null, 'child remains alive after relay');
    } finally {
      a?.close();
      b?.close();
      await stopChild(running.child);
    }
  });
}
