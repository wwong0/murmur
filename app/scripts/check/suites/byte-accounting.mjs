import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

import { startRoomServer } from '../../../server/room-server.mjs';
import { classifyPath, countDelivered } from '../../../server/byte-accounting.mjs';
import { assert, assertEqual, check, sleep } from '../harness.mjs';

const SIZE = 8 * 1024 * 1024;
const CRLF = '\r\n';

function makeMediaRoot() {
  const root = fs.mkdtempSync(path.join(path.resolve('.tmp'), 'byte-accounting-'));
  const media = path.join(root, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, 'seg-00000.m4s'), Buffer.alloc(SIZE, 2));
  fs.writeFileSync(path.join(media, 'init.mp4'), Buffer.alloc(1373, 1));
  fs.writeFileSync(path.join(media, 'master.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg-00000.m4s\n');
  return { root, media };
}

function waitFor(server, predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      const value = server.counters.snapshot();
      if (predicate(value)) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function snapshotCounters(base) {
  return fetch(`${base}/harness/counters`).then(async (response) => {
    assertEqual(response.status, 200, 'counter snapshot status');
    assertEqual(response.headers.get('cache-control'), 'no-store', 'counter snapshot cache policy');
    return response.json();
  });
}

function abortGet(port, target, tag) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = 0;
    let destroyed = false;
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1${CRLF}` +
          `Host: 127.0.0.1:${port}${CRLF}` +
          `x-app-tab: ${tag}${CRLF}` +
          `Connection: close${CRLF}${CRLF}`
      );
    });
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (!destroyed && received >= 64 * 1024) {
        destroyed = true;
        socket.destroy();
      }
    });
    socket.on('error', (error) => {
      if (!destroyed) reject(error);
    });
    socket.on('close', () => resolve(received));
  });
}

function assertMonotonic(previous, current, label = 'counters') {
  for (const key of Object.keys(previous)) {
    const before = previous[key];
    const after = current[key];
    if (typeof before === 'number') {
      assert(after >= before, `${label}.${key} decreased from ${before} to ${after}`);
    } else if (Array.isArray(before)) {
      assert(after.length >= before.length, `${label}.${key} lost records`);
    } else if (before && typeof before === 'object') {
      assert(after && typeof after === 'object', `${label}.${key} disappeared`);
      assertMonotonic(before, after, `${label}.${key}`);
    }
  }
}

function clientBytes(snapshot, tag) {
  return snapshot.byClient[tag]?.segmentBytesDelivered ?? 0;
}

function clientInitBytes(snapshot, tag) {
  return snapshot.byClient[tag]?.initBytesDelivered ?? 0;
}

export default async function byteAccountingSuite() {
  const { root, media } = makeMediaRoot();
  const server = startRoomServer({ port: 0, mediaDir: media, quiet: true, harnessCounters: true });
  const port = await server.ready;
  const base = `http://127.0.0.1:${port}`;
  const tag = `tab-${crypto.randomUUID()}`;
  const alternateTag = `tab-${crypto.randomUUID()}`;

  try {
    await check('byte-accounting: countDelivered cases are bounded and hand-computable', async () => {
      const cases = [
        [{ socketBytesAtStart: 100, socketBytesAtEnd: 1100, expectedBytes: 1000, writableFinished: true }, { delivered: 1000, waste: 0, aborted: false }],
        [{ socketBytesAtStart: 100, socketBytesAtEnd: 400, expectedBytes: 1000, writableFinished: false }, { delivered: 300, waste: 300, aborted: true }],
        [{ socketBytesAtStart: 100, socketBytesAtEnd: 5000, expectedBytes: 1000, writableFinished: false }, { delivered: 1000, waste: 1000, aborted: true }],
        [{ socketBytesAtStart: 100, socketBytesAtEnd: 50, expectedBytes: 1000, writableFinished: false }, { delivered: 0, waste: 0, aborted: true }],
        [{ socketBytesAtStart: 100, socketBytesAtEnd: 100, expectedBytes: 0, writableFinished: false }, { delivered: 0, waste: 0, aborted: true }],
      ];
      for (const [input, expected] of cases) {
        const actual = countDelivered(input);
        assertEqual(JSON.stringify(actual), JSON.stringify(expected), `countDelivered ${JSON.stringify(input)}`);
        assert(actual.delivered >= 0, 'delivered must not be negative');
        assert(actual.delivered <= input.expectedBytes, 'delivered must not exceed expectedBytes');
      }
    });

    await check('byte-accounting: classifyPath is exhaustive for media and overhead content', async () => {
      for (const [urlPath, kind] of [
        ['/media/seg-00000.m4s', 'segment'],
        ['/media/init.mp4', 'init'],
        ['/media/master.m3u8', 'playlist'],
        ['/room.html', 'overhead'],
        ['/room.bundle.js', 'overhead'],
        ['/media/unknown.bin', 'overhead'],
      ]) assertEqual(classifyPath(urlPath), kind, `${urlPath} classification`);
    });

    await check('byte-accounting: complete media response banks exactly the file size', async () => {
      const response = await fetch(`${base}/media/seg-00000.m4s`, { headers: { 'x-app-tab': tag } });
      assertEqual(response.status, 200, 'complete segment status');
      assertEqual((await response.arrayBuffer()).byteLength, SIZE, 'complete segment body');
      const counters = await waitFor(server, (value) => value.byPath['/media/seg-00000.m4s']?.completedHits === 1, 'complete segment');
      assertEqual(counters.byClient[tag].segmentBytesDelivered, SIZE, 'complete segment accounting');
      assertEqual(counters.completedResponses, 1, 'completed response count');
      assertEqual(counters.abortedResponses, 0, 'aborted response count');
      assertEqual(counters.abortedMediaBytesDelivered, 0, 'complete response waste');
    });

    await check('byte-accounting: aborted response banks only delivered bytes and waste', async () => {
      const before = server.counters.snapshot();
      const abortTag = `tab-${crypto.randomUUID()}`;
      await abortGet(port, '/media/seg-00000.m4s', abortTag);
      const after = await waitFor(
        server,
        (value) => (value.byPath['/media/seg-00000.m4s']?.hits ?? 0) >= (before.byPath['/media/seg-00000.m4s']?.hits ?? 0) + 1,
        'aborted segment'
      );
      const record = [...after.responseRecords].reverse().find((entry) => entry.urlPath === '/media/seg-00000.m4s' && entry.aborted);
      const delivered = record?.delivered ?? 0;
      assert(delivered > 0 && delivered < SIZE, `aborted delivered=${delivered}, expected 0 < delivered < ${SIZE}`);
      assertEqual(after.abortedMediaBytesDelivered - before.abortedMediaBytesDelivered, delivered, 'aborted waste');
      assertEqual(after.abortedResponses - before.abortedResponses, 1, 'aborted response count');
      assertEqual(clientBytes(after, abortTag) - clientBytes(before, abortTag), delivered, 'aborted client total');
    });

    await check('byte-accounting: missing tags are unattributed and overhead is separate', async () => {
      const beforeMedia = server.counters.snapshot();
      const mediaResponse = await fetch(`${base}/media/seg-00000.m4s`);
      await mediaResponse.arrayBuffer();
      const afterMedia = await waitFor(server, (value) => value.unattributedMediaBytesDelivered > beforeMedia.unattributedMediaBytesDelivered, 'unattributed media');
      assertEqual(afterMedia.unattributedMediaBytesDelivered - beforeMedia.unattributedMediaBytesDelivered, SIZE, 'unattributed media bytes');
      assertEqual(JSON.stringify(afterMedia.byClient), JSON.stringify(beforeMedia.byClient), 'unattributed media client buckets');

      const beforeOverhead = server.counters.snapshot();
      const page = await fetch(`${base}/room.html`);
      const pageBytes = (await page.arrayBuffer()).byteLength;
      const afterOverhead = await waitFor(server, (value) => value.overheadBytesDelivered > beforeOverhead.overheadBytesDelivered, 'overhead response');
      assertEqual(afterOverhead.overheadBytesDelivered - beforeOverhead.overheadBytesDelivered, pageBytes, 'overhead bytes');
      assertEqual(afterOverhead.mediaBytesDelivered, beforeOverhead.mediaBytesDelivered, 'overhead must not move media bytes');
    });

    await check('byte-accounting: snapshots are monotonic and do not count their own response bytes', async () => {
      const snapshots = [];
      for (let i = 0; i < 10; i++) snapshots.push((await snapshotCounters(base)).counters);
      for (let i = 1; i < snapshots.length; i++) assertMonotonic(snapshots[i - 1], snapshots[i]);
      assertEqual(snapshots.at(-1).snapshotRequests - snapshots[0].snapshotRequests, 9, 'snapshot request count');
      assertEqual(snapshots.at(-1).byPath['/harness/counters'], undefined, 'snapshot endpoint has no byPath record');
    });

    await check('byte-accounting: header attribution discriminates supplied tags and restores green', async () => {
      const before = server.counters.snapshot();
      const response = await fetch(`${base}/media/init.mp4`, { headers: { 'x-app-tab': tag } });
      await response.arrayBuffer();
      const after = await waitFor(server, (value) => clientInitBytes(value, tag) > clientInitBytes(before, tag), 'supplied tag');
      assertEqual(after.byClient[tag].initBytesDelivered, 1373, 'supplied tag init bytes');

      const changed = await fetch(`${base}/media/init.mp4`, { headers: { 'x-app-tab': alternateTag } });
      await changed.arrayBuffer();
      const afterChanged = await waitFor(server, (value) => clientInitBytes(value, alternateTag) > clientInitBytes(after, alternateTag), 'alternate tag');
      let redMessage = null;
      try {
        assertEqual(afterChanged.byClient[tag].initBytesDelivered, 2746, 'the original tag must not receive the alternate request');
      } catch (error) {
        redMessage = error.message;
      }
      assert(redMessage, 'the supplied-tag attribution assertion must go red when the tag changes');
      assertEqual(afterChanged.byClient[tag].initBytesDelivered, after.byClient[tag].initBytesDelivered, 'original tag stays unchanged');

      const restored = await fetch(`${base}/media/init.mp4`, { headers: { 'x-app-tab': tag } });
      await restored.arrayBuffer();
      const final = await waitFor(server, (value) => value.byClient[tag].initBytesDelivered > afterChanged.byClient[tag].initBytesDelivered, 'restored tag');
      assertEqual(final.byClient[tag].initBytesDelivered, 2746, 'restored supplied tag');
    });

    await check('byte-accounting: one socket response indexes do not overlap and Range stays whole-file', async () => {
      const response = await fetch(`${base}/media/seg-00000.m4s`, {
        headers: { Range: 'bytes=0-99', 'x-app-tab': tag },
      });
      assertEqual(response.status, 200, 'Range status');
      assertEqual(response.headers.get('content-range'), null, 'Range must not produce Content-Range');
      assertEqual((await response.arrayBuffer()).byteLength, SIZE, 'Range body remains whole file');
      await waitFor(server, (value) => value.byPath['/media/seg-00000.m4s']?.hits >= 3, 'Range response');

      const grouped = new Map();
      for (const record of server.counters.snapshot().responseRecords) {
        if (record.socketId === null) continue;
        const records = grouped.get(record.socketId) ?? [];
        records.push(record);
        grouped.set(record.socketId, records);
      }
      for (const records of grouped.values()) {
        records.sort((a, b) => a.responseIndex - b.responseIndex);
        for (let i = 1; i < records.length; i++) {
          assert(records[i - 1].socketBytesAtEnd <= records[i].socketBytesAtStart, 'one socket response deltas overlap');
        }
      }
    });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
