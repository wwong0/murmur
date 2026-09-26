// scripts/dev.mjs
//
// The normal way to run the app while developing (`npm run dev`). One
// process watches the bundle and owns the room server; the tracker is a
// separate child because it speaks a different protocol.
//
// This process does two things:
//   1. Runs esbuild in watch mode using the exact same bundler config as
//      scripts/build.mjs (imported, not duplicated — see that file for why
//      that matters).
//   2. Starts the tracker and room server.
//
// Why watch mode lives here and not just "run build.mjs then start the
// server": the page loads public/room.bundle.js, not the source modules
// directly, so editing a module under public/ changes nothing on screen
// until a rebuild happens. Without watch mode that's a silent trap — you
// edit, refresh, and see stale behaviour with no indication why. Watch mode
// removes the trap at its source by rebuilding automatically on every save.
// (A stale-bundle banner or a page-visible build indicator was considered
// and deliberately rejected — the fix is to make staleness not happen, not
// to announce it.)
//
// Node 24, ESM.

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOptions, makeBuildId } from './build.mjs';
import { startTracker } from './runner/tracker.mjs';
import { optionsFromEnv, startRoomServer } from '../server/room-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const TRACKER_PORT = 8101;
const APP_TRACKER_URL = `ws://127.0.0.1:${TRACKER_PORT}`;

let buildContext = null;
let roomServer = null;
let tracker = null;
let shuttingDown = false;

function trackerFailure(result) {
  if (result.error) return `tracker failed to start: ${result.error.message}`;
  return `tracker exited early (code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'})`;
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  if (roomServer) await roomServer.close();
  if (buildContext) await buildContext.dispose();
  if (tracker && tracker.exitCode === null) tracker.kill();
}

async function main() {
  const buildId = makeBuildId();
  buildContext = await esbuild.context(buildOptions(buildId));
  await buildContext.watch();
  console.log('[dev] esbuild watch mode active — edits under public/ rebuild room.bundle.js automatically, no manual rebuild needed.');
  console.log(`[dev] build id: ${buildId}`);

  const trackerState = startTracker({
    port: TRACKER_PORT,
    hostname: '127.0.0.1',
    stdio: 'inherit',
    cwd: APP_DIR,
    env: process.env,
  });
  tracker = trackerState.child;
  const earlyExit = await Promise.race([
    trackerState.exited,
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  if (earlyExit) throw new Error(trackerFailure(earlyExit));

  roomServer = startRoomServer(optionsFromEnv({ ...process.env, APP_TRACKER_URL }));
  console.log('[dev] room server started (server/room-server.mjs)');

  trackerState.exited.then(async (result) => {
    if (shuttingDown) return;
    console.error(`[dev] ${trackerFailure(result)}`);
    await shutdown(1);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    console.log('\n[dev] shutting down (SIGINT)...');
    await shutdown(0);
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error('[dev] fatal error:');
  console.error(err);
  await shutdown(1);
  process.exit(1);
});
