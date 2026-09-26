// The origin container's process: the existing room server, bound where other
// containers can reach it.
//
// `room-server.mjs` defaults to 127.0.0.1, which inside a container accepts
// nothing from the client containers; the host is an option it already takes.

import { optionsFromEnv, startRoomServer } from '../server/room-server.mjs';
import { startTracker } from '../scripts/runner/tracker.mjs';

let server = null;
let tracker = null;
let shuttingDown = false;

function trackerFailure(result) {
  if (result.error) return `tracker failed to start: ${result.error.message}`;
  return `tracker exited early (code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'})`;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) await server.close();
  if (tracker && tracker.exitCode === null) tracker.kill();
  process.exit(code);
}

async function main() {
  const trackerPort = process.env.APP_TRACKER_PORT;
  let trackerState = null;
  if (trackerPort) {
    trackerState = startTracker({
      port: trackerPort,
      hostname: null,
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    tracker = trackerState.child;
    const earlyExit = await Promise.race([
      trackerState.exited,
      new Promise((resolve) => setImmediate(() => resolve(null))),
    ]);
    if (earlyExit) throw new Error(trackerFailure(earlyExit));
  }
  const env = { ...process.env };
  if (trackerPort) env.APP_TRACKER_URL = `ws://origin-media:${trackerPort}`;
  else delete env.APP_TRACKER_URL;
  server = startRoomServer({ ...optionsFromEnv(env), host: process.env.APP_HOST ?? '0.0.0.0' });
  server.ready.then((port) => console.log(`[origin] ready on ${port}`));
  trackerState?.exited.then(async (result) => {
    if (shuttingDown) return;
    console.error(`[origin] ${trackerFailure(result)}`);
    await shutdown(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[origin] ${signal} received, closing`);
    shutdown(0);
  });
}

main().catch(async (error) => {
  console.error(`[origin] fatal: ${error?.message ?? error}`);
  await shutdown(1);
});
