// scripts/build.mjs
//
// Bundles the browser entry point (public/room.entry.js) into
// public/room.bundle.js with esbuild's JS API. This is the only place the
// bundler config is defined — scripts/dev.mjs imports `buildOptions` from
// here instead of duplicating it, so watch mode and a one-shot build can
// never drift apart.
//
// The entry point is written by a parallel change and does not exist yet at
// the time this script was written. Rather than make `npm run build` unusable
// until that lands, a missing-entry esbuild failure is treated as "not ready
// yet" and exits 0 with a one-line note; any other esbuild failure (a real
// syntax error, a bad import, etc.) exits 1 with the error, same as always.
//
// Node 24, ESM. esbuild is the only dependency used here.

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enginePatchPlugin } from './engine-patch.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

export const ENTRY_POINT = path.join(PUBLIC_DIR, 'room.entry.js');
export const OUT_FILE = path.join(PUBLIC_DIR, 'room.bundle.js');
export const WORKER_ENTRY_POINT = path.join(PUBLIC_DIR, 'prepare.worker.js');
export const WORKER_OUT_FILE = path.join(PUBLIC_DIR, 'prepare.worker.bundle.js');

/** A short random suffix so two builds in the same millisecond still get distinct ids. */
function randomSuffix() {
  return Math.random().toString(16).slice(2, 8);
}

/** Compile-time build id: ISO timestamp + short random suffix, e.g. "2026-08-20T14:03:11.402Z-a1b2c3". */
export function makeBuildId() {
  return `${new Date().toISOString()}-${randomSuffix()}`;
}

/**
 * Shared esbuild config for both the one-shot build (this file) and watch
 * mode (scripts/dev.mjs). `buildId` is injected fresh per call via `define`
 * so __BUILD_ID__ in room.entry.js resolves to a JSON string literal at
 * bundle time.
 */
export function buildOptions(buildId) {
  return {
    entryPoints: [ENTRY_POINT],
    outfile: OUT_FILE,
    format: 'iife',
    bundle: true,
    sourcemap: true,
    target: 'es2022',
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [enginePatchPlugin()],
  };
}

export function workerBuildOptions(buildId) {
  return {
    entryPoints: [WORKER_ENTRY_POINT],
    outfile: WORKER_OUT_FILE,
    format: 'iife',
    bundle: true,
    sourcemap: true,
    target: 'es2022',
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
  };
}

/** True if an esbuild error set is entirely "entry point not found" (i.e. room.entry.js doesn't exist yet). */
function isMissingEntryError(err) {
  const errors = err?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => typeof e.text === 'string' && /could not resolve|no such file|cannot find/i.test(e.text));
}

async function main() {
  const buildId = makeBuildId();
  let result;
  try {
    result = await esbuild.build({ ...buildOptions(buildId), metafile: true });
  } catch (err) {
    if (isMissingEntryError(err)) {
      console.log('[build] public/room.entry.js does not exist yet — nothing to bundle. Skipping (this is expected before that file lands).');
      process.exit(0);
    }
    console.error('[build] esbuild failed:');
    console.error(err.message ?? err);
    process.exit(1);
  }

  const outputs = result.metafile?.outputs ?? {};
  const outKey = Object.keys(outputs).find((k) => k.endsWith('room.bundle.js'));
  const bytes = outKey ? outputs[outKey].bytes : undefined;

  console.log(`[build] build id: ${buildId}`);
  console.log(`[build] wrote ${path.relative(APP_DIR, OUT_FILE)}${bytes !== undefined ? ` (${bytes} bytes)` : ''}`);
  const worker = await esbuild.build({ ...workerBuildOptions(buildId), metafile: true });
  const workerKey = Object.keys(worker.metafile?.outputs ?? {}).find((key) => key.endsWith('prepare.worker.bundle.js'));
  const workerBytes = workerKey ? worker.metafile.outputs[workerKey].bytes : undefined;
  console.log(`[build] wrote ${path.relative(APP_DIR, WORKER_OUT_FILE)}${workerBytes !== undefined ? ` (${workerBytes} bytes)` : ''}`);
}

// Only run when invoked directly (`node scripts/build.mjs`), not when
// scripts/dev.mjs imports buildOptions/makeBuildId from this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
