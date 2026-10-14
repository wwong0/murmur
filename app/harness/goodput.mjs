// What the shaped link actually delivers, measured from inside a client
// container.
//
// The byte count is the file's size and the elapsed time is the client's own
// monotonic clock (executor-spec.md §3.3). Both ends of that are deliberate:
// a goodput computed from `Date.now()` would be a measurement of the container's
// wall clock, and a byte count taken from the sender would be a measurement of
// what the origin queued rather than of what arrived.
//
// Every segment's received length is compared against its `Content-Length`, so
// a truncated transfer is a failure rather than a fast one.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name, fallback = null) {
  const found = process.argv.slice(2).find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

export async function fetchSegment(origin, name) {
  const startedAt = process.hrtime.bigint();
  const response = await fetch(`${origin}/media/${name}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  const body = await response.arrayBuffer();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    name,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    receivedBytes: body.byteLength,
    complete: Number.isFinite(contentLength) && body.byteLength === contentLength,
    elapsedMs,
  };
}

export function goodputOf(segments, elapsedMs) {
  const bytes = segments.reduce((total, segment) => total + segment.receivedBytes, 0);
  return { bytes, elapsedMs, bitsPerSecond: elapsedMs > 0 ? (bytes * 8) / (elapsedMs / 1000) : null };
}

function segmentSecondsOf(mediaDir) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(mediaDir, 'content-manifest.json'), 'utf8')); } catch (error) {
    throw new Error(`content manifest unavailable: ${error.message}`);
  }
  if (!Number.isFinite(manifest.segmentSeconds) || manifest.segmentSeconds <= 0) {
    throw new Error('segment-seconds-unavailable');
  }
  return manifest.segmentSeconds;
}

export function segmentNameForMediaPosition(mediaMs, segmentSeconds) {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) throw new Error('segment-seconds-unavailable');
  if (!Number.isFinite(mediaMs) || mediaMs < 0) throw new Error('goodput media position is invalid');
  return `seg-${String(Math.floor(mediaMs / (segmentSeconds * 1000))).padStart(5, '0')}.m4s`;
}

export async function measureGoodput({ origin, count, start, mediaDir = process.env.APP_MEDIA_DIR ?? '/media' }) {
  if (!Number.isFinite(start) || start < 0) throw new Error('goodput media position is invalid');
  const segmentSeconds = segmentSecondsOf(mediaDir);
  const segments = [];
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < count; index++) {
    segments.push(await fetchSegment(origin, segmentNameForMediaPosition(start + index * segmentSeconds * 1000, segmentSeconds)));
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const summary = goodputOf(segments, elapsedMs);
  return {
    origin,
    count,
    start,
    segmentSeconds,
    ...summary,
    mbps: summary.bitsPerSecond === null ? null : summary.bitsPerSecond / 1e6,
    incomplete: segments.filter((segment) => !segment.complete).map((segment) => segment.name),
    segments,
    measuredAt: new Date().toISOString(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await measureGoodput({
    origin: argument('origin', process.env.APP_ORIGIN ?? 'http://origin-media:8100'),
    count: Number(argument('segments', '40')),
    start: Number(argument('start', '0')),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
