import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const CORE_DIR = path.join(APP_DIR, 'node_modules', 'p2p-media-loader-core');
export const PINNED_VERSION = '3.0.1';
export const PINNED_SHA256 = '0888E992BE5B03934EC96CFCF80760A5E36B69406BFE1C2672608308C8534036';
export const ORIGINAL_HYBRID_LOADER = path.join(CORE_DIR, 'lib', 'hybrid-loader.js');
export const PATCHED_HYBRID_LOADER = path.join(APP_DIR, 'patches', 'p2p-media-loader-core-3.0.1', 'hybrid-loader.js');
export const URGENT_SOURCE = path.join(APP_DIR, 'public', 'lib', 'urgent-source.mjs');

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'package.json'), 'utf8')).version;
}

export function pinnedHash() {
  return createHash('sha256').update(fs.readFileSync(ORIGINAL_HYBRID_LOADER)).digest('hex').toUpperCase();
}

function assertPinned() {
  const version = packageVersion();
  if (version !== PINNED_VERSION) {
    throw new Error(`engine patch requires p2p-media-loader-core ${PINNED_VERSION}; installed ${version}`);
  }
  const actual = pinnedHash();
  if (actual !== PINNED_SHA256) {
    throw new Error(`engine patch hash mismatch: expected ${PINNED_SHA256}, got ${actual}`);
  }
}

export function enginePatchPlugin() {
  return {
    name: 'watchalong-p2p-engine-patch',
    setup(build) {
      assertPinned();
      build.initialOptions.banner = { ...(build.initialOptions.banner ?? {}), js: `${build.initialOptions.banner?.js ?? ''}/* wa-patch: p2p urgent queue */\n` };
      build.onResolve({ filter: /^\.\/hybrid-loader\.js$/ }, (args) => {
        if (path.resolve(args.resolveDir) !== path.dirname(ORIGINAL_HYBRID_LOADER)) return null;
        return { path: PATCHED_HYBRID_LOADER };
      });
      build.onResolve({ filter: /^\.\/urgent-source\.mjs$/ }, (args) => {
        if (path.resolve(args.importer) !== path.resolve(PATCHED_HYBRID_LOADER)) return null;
        return { path: URGENT_SOURCE };
      });
      build.onResolve({ filter: /^\.\// }, (args) => {
        if (path.resolve(args.importer) !== path.resolve(PATCHED_HYBRID_LOADER)) return null;
        return { path: path.resolve(path.dirname(ORIGINAL_HYBRID_LOADER), args.path) }; // wa-patch: keep unchanged core dependencies on the pinned package
      });
    },
  };
}
