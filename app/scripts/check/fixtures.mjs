// scripts/check/fixtures.mjs
//
// The servers and the media root every suite runs against, booted once at
// import time and shared by all of them.
//
// Importing this module STARTS THREE SERVERS. That is deliberate and it is the
// only side-effecting module in the check: the alternative is an init() the
// runner must call before any suite is imported, which makes every suite's
// correctness depend on an import order nothing enforces. One side effect in a
// named place beats an ordering rule in a comment.
//
// Node 24, ESM.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startRoomServer } from '../../server/room-server.mjs';

// Short enough that the liveness assertions cost a fraction of a second, long
// enough that a loaded machine does not spuriously terminate a healthy socket.
export const LIVENESS_MS = 120;

// Two more intervals, for the D13 assertions.
//
// ANYTHING CLAIMING TO TRACK THE LIVENESS INTERVAL MUST BE SHOWN AT MORE THAN
// ONE INTERVAL, or it is being asserted against itself — the fault D13
// replaced was invisible at a single setting.
//
// `slow` is far enough above the client's 250ms first backoff that a fixed
// one-second budget fails there. `frozen` never sweeps within a run, so its
// holders sit in a known state and any ping one sees was sent deliberately.
//
// Cheap: a server is a listen() call, and neither carries media traffic.
export const SLOW_LIVENESS_MS = 480;
export const FROZEN_LIVENESS_MS = 60000;

// ---------------------------------------------------------------------------
// A throwaway media root, so the media assertions do not depend on step0/
// having been generated.
// ---------------------------------------------------------------------------

function makeMediaRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-protocol-check-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(
    path.join(media, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg-00000.m4s\n#EXT-X-ENDLIST\n'
  );
  fs.writeFileSync(path.join(media, 'init.mp4'), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(media, 'seg-00000.m4s'), Buffer.alloc(256, 2));
  // Outside the media root, so the traversal assertion has something real to
  // reach for. A guard tested against a file that does not exist proves
  // nothing — a 404 would pass while the guard was broken.
  fs.writeFileSync(path.join(dir, 'outside-the-media-root.txt'), 'this must never be served');
  return { dir, media };
}

const { dir: tmpRoot, media } = makeMediaRoot();

export const mediaDir = media;

// ---------------------------------------------------------------------------
// The servers
// ---------------------------------------------------------------------------

export const server = startRoomServer({ port: 0, mediaDir, livenessMs: LIVENESS_MS, quiet: true, harnessCounters: true, joinBurst: 1_000_000 });
export const port = await server.ready;
export const HTTP = `http://127.0.0.1:${port}`;
export const WS = `ws://127.0.0.1:${port}/ws`;

export const slowServer = startRoomServer({ port: 0, mediaDir, livenessMs: SLOW_LIVENESS_MS, quiet: true, harnessCounters: true, joinBurst: 1_000_000 });
export const frozenServer = startRoomServer({ port: 0, mediaDir, livenessMs: FROZEN_LIVENESS_MS, quiet: true, harnessCounters: true, joinBurst: 1_000_000 });
export const SLOW_WS = `ws://127.0.0.1:${await slowServer.ready}/ws`;
export const FROZEN_WS = `ws://127.0.0.1:${await frozenServer.ready}/ws`;

export function describeFixtures() {
  return (
    `protocol-check: server on ${port}, liveness ${LIVENESS_MS}ms, media root ${mediaDir}\n` +
    `protocol-check: plus liveness ${SLOW_LIVENESS_MS}ms and ${FROZEN_LIVENESS_MS}ms servers for the D13 assertions\n`
  );
}

export async function disposeFixtures() {
  await server.close();
  await slowServer.close();
  await frozenServer.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
