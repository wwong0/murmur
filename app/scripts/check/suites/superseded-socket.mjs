import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, check, Peer, sleep } from '../harness.mjs';
import { buildChatEnvelope, buildNameEnvelope } from '../../../public/lib/envelope.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function startChild() {
  const child = spawn(process.execPath, ['server/room-server.mjs'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      APP_PORT: '0',
      APP_LIVENESS_INTERVAL_MS: '5000',
      APP_ENVELOPE_BURST: '1000',
      APP_JOIN_BURST: '100',
      APP_CHAT_BURST: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`child did not listen: ${stderr}`)), 10_000);
    const poll = () => {
      const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(`ws://127.0.0.1:${match[1]}/ws`);
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(deadline);
        reject(new Error(`child exited ${child.exitCode}: ${stderr}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
  return { child, ready, getOutput: () => ({ stdout, stderr }) };
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill();
  return new Promise((resolve) => child.once('close', resolve));
}

export default async function supersededSocketSuite() {
  await check('superseded socket: a paused replaced connection cannot crash its child server', async () => {
    const running = startChild();
    let a;
    let b;
    let c;
    try {
      const url = await running.ready;
      a = await Peer.open(url, 'superseded-a');
      const first = await a.join({ room: 'superseded-room', tabId: 'tab', role: 'host' });
      a.goSilent();

      b = await Peer.open(url, 'superseded-b');
      await b.join({ room: 'superseded-room', tabId: 'tab', role: 'viewer', secret: first.payload.secret });
      a.send(buildChatEnvelope({ id: 'stale-chat', text: 'stale' }));
      a.send(buildNameEnvelope({ id: 'stale-name', name: 'stale' }));
      await sleep(150);
      assertEqual(running.child.exitCode, null, 'child remains running after stale sends');

      c = await Peer.open(url, 'superseded-c');
      await c.join({ room: 'superseded-room', tabId: 'fresh', role: 'viewer' });
      c.send(buildChatEnvelope({ id: 'fresh-chat', text: 'fresh' }));
      await c.next((env) => env.type === 'chat' && env.payload.text === 'fresh');
      assertEqual(running.child.exitCode, null, 'fresh member can join and chat');
    } finally {
      a?.close();
      b?.close();
      c?.close();
      await stopChild(running.child);
    }
  });
}
