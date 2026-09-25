// The local processes a browser verifier starts: its ports and its children.

import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';

/** Resolves true when the port can be bound on loopback; rejects when it is held. */
export function portFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve(true)));
  });
}

export async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

/** Kills a child, waits up to 3 s for it, then force-kills its tree if Windows still lists it. */
export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (child.pid) {
    try {
      const listed = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (listed.status === 0 && new RegExp(`\\b${child.pid}\\b`).test(listed.stdout ?? '')) {
        try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
      }
    } catch {}
  }
}
