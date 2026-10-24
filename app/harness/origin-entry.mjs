import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optionsFromEnv, startRoomServer } from '../server/room-server.mjs';
import { requireTrackerStarted, startTracker, trackerFailure } from '../scripts/runner/tracker.mjs';
import { createOriginProxy } from './origin-proxy.mjs';
import { startSocketControl } from './socket-control.mjs';

let roomServer = null;
let proxy = null;
let tracker = null;
let socketControl = null;
let shuttingDown = false;

function closeServer(server) {
  return server ? server.close() : Promise.resolve();
}

function closeProxy(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeProxy(proxy);
  if (socketControl) await socketControl.close();
  await closeServer(roomServer);
  if (tracker && tracker.exitCode === null) tracker.kill();
  process.exit(code);
}

async function startTrackerIfConfigured(env) {
  const port = env.APP_TRACKER_PORT;
  if (!port) return null;
  const state = startTracker({ port, hostname: null, stdio: 'inherit', cwd: process.cwd(), env });
  await requireTrackerStarted(state);
  tracker = state.child;
  state.exited.then(async (result) => {
    if (!shuttingDown) {
      console.error(`[origin] ${trackerFailure(result)}`);
      await shutdown(1);
    }
  });
  return state;
}

async function startServerRole(env) {
  const trackerPort = env.APP_TRACKER_PORT;
  const trackerHost = env.APP_TRACKER_HOST ?? 'origin-media';
  const trackerState = await startTrackerIfConfigured(env);
  const serverEnv = { ...env };
  if (trackerPort) serverEnv.APP_TRACKER_URL = `ws://${trackerHost}:${trackerPort}`;
  else delete serverEnv.APP_TRACKER_URL;
  roomServer = startRoomServer({ ...optionsFromEnv(serverEnv), harnessCounters: true, host: env.APP_HOST ?? '0.0.0.0' });
  socketControl = startSocketControl({ roomServer, port: Number(env.APP_SOCKET_CONTROL_PORT ?? 8190), host: '127.0.0.1' });
  roomServer.ready.then((port) => console.log(`[origin] ready on ${port}`));
  return trackerState;
}

async function startHostPageRole(env) {
  const serverEnv = { ...env, APP_PORT: '8102', APP_HOST: '127.0.0.1', APP_DELIVERY: 'host' };
  delete serverEnv.APP_TRACKER_PORT;
  delete serverEnv.APP_TRACKER_URL;
  roomServer = startRoomServer({ ...optionsFromEnv(serverEnv), harnessCounters: true, host: '127.0.0.1', port: 8102 });
  proxy = createOriginProxy({ mediaTarget: 'http://127.0.0.1:8102', roomTarget: 'http://server-media:8100' });
  await new Promise((resolve) => proxy.listen(8100, '127.0.0.1', resolve));
  roomServer.ready.then((port) => console.log(`[origin] media instance ready on ${port}`));
  console.log('[origin] host-page proxy ready on 8100');
}

async function main() {
  const env = { ...process.env };
  const role = env.WA_ORIGIN_ROLE ?? 'server';
  if (role !== 'server' && role !== 'host-page') throw new Error(`unknown WA_ORIGIN_ROLE ${JSON.stringify(role)}`);
  if (role === 'host-page') await startHostPageRole(env);
  else await startServerRole(env);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[origin] ${signal} received, closing`);
    shutdown(0);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(async (error) => {
  console.error(`[origin] fatal: ${error?.message ?? error}`);
  await shutdown(1);
});

export { main };
