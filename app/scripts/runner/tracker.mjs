import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRACKER_SCRIPT = path.join(APP_DIR, 'node_modules', 'bittorrent-tracker', 'bin', 'cmd.js');

export function trackerArguments({ port, hostname = null } = {}) {
  const args = [TRACKER_SCRIPT, '--ws', '--port', String(port)];
  if (hostname !== null) args.push('--http-hostname', hostname);
  args.push('--quiet');
  return args;
}

export function startTracker({ port, hostname = null, stdio, cwd, env } = {}) {
  const child = spawn(process.execPath, trackerArguments({ port, hostname }), { stdio, cwd, env });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}
