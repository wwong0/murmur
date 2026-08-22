// scripts/dev.mjs
//
// The normal way to run the app while developing (`npm run dev`). One
// process does two things:
//   1. Runs esbuild in watch mode using the exact same bundler config as
//      scripts/build.mjs (imported, not duplicated — see that file for why
//      that matters).
//   2. Starts the room server (server/room-server.mjs).
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
// server/room-server.mjs is written by a parallel change and does not exist
// yet. The import is guarded: if it's missing, dev.mjs prints a note and
// keeps the watcher running rather than crashing, so this script is usable
// (for bundling) before that file lands.
//
// Node 24, ESM.

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOptions, makeBuildId } from './build.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const ROOM_SERVER_PATH = path.join(APP_DIR, 'server', 'room-server.mjs');

/** Try to start the room server by importing it. Missing file is a warning, not a crash. */
async function startRoomServer() {
  const url = pathToFileURL(ROOM_SERVER_PATH).href;
  try {
    await import(url);
    console.log('[dev] room server started (server/room-server.mjs)');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('[dev] server/room-server.mjs does not exist yet — skipping server startup (bundler watch is still running).');
      return;
    }
    console.error('[dev] room server failed to start:');
    console.error(err);
  }
}

async function main() {
  const buildId = makeBuildId();
  const ctx = await esbuild.context(buildOptions(buildId));
  await ctx.watch();
  console.log('[dev] esbuild watch mode active — edits under public/ rebuild room.bundle.js automatically, no manual rebuild needed.');
  console.log(`[dev] build id: ${buildId}`);

  await startRoomServer();

  process.on('SIGINT', async () => {
    console.log('\n[dev] shutting down (SIGINT)...');
    await ctx.dispose();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[dev] fatal error:');
  console.error(err);
  process.exit(1);
});
