import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, check, sleep } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { optionsFromEnv, startRoomServer } from '../../../server/room-server.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

async function withServer(options, fn) {
  const server = startRoomServer({ port: 0, mediaDir, quiet: true, harnessCounters: true, ...options });
  try {
    const port = await server.ready;
    return await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

async function childRefusal() {
  const child = spawn(process.execPath, ['server/room-server.mjs'], {
    cwd: APP_DIR,
    env: { ...process.env, APP_MEDIA_SOURCE: 'file', APP_DELIVERY: 'http', APP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve({ ...value, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ killed: true, code: child.exitCode, signal: null });
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ killed: false, code: null, signal: null, error });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      finish({ killed: false, code, signal });
    });
  });
}

export default async function mediaSourceSettingSuite() {
  await check('media-source-setting: default directory serves media and reports defaults', async () => {
    await withServer({}, async (server, origin) => {
      const expected = fs.readFileSync(path.join(mediaDir, 'master.m3u8'));
      const response = await fetch(`${origin}/media/master.m3u8`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const settings = await (await fetch(`${origin}/app-settings`)).json();
      assertEqual(response.status, 200, 'directory media status');
      assertEqual(bytes.toString('hex'), expected.toString('hex'), 'directory media bytes');
      assertEqual(JSON.stringify(settings), JSON.stringify({ delivery: 'host', iceServers: [], trackerUrl: null, mediaSource: 'dir', targetSegmentSeconds: 2, autoStart: false, hostGraceMs: 10_000 }), 'directory settings');
      await sleep(10);
      assert(server.counters.snapshot().playlistBytesDelivered > 0, 'directory playlist is counted as media');
    });
  });

  await check('media-source-setting: file source refuses every media path as overhead', async () => {
    await withServer({ mediaSource: 'file' }, async (server, origin) => {
      const requests = [
        ['/media/master.m3u8', { method: 'GET' }],
        ['/media/init.mp4', { method: 'GET' }],
        ['/media/seg-00000.m4s', { method: 'GET' }],
        ['/media/nothing', { method: 'GET' }],
        ['/media/seg-00000.m4s', { method: 'POST', headers: { 'x-app-tab': 'file-tab' } }],
      ];
      const responses = await Promise.all(requests.map(([url, init]) => fetch(`${origin}${url}`, init)));
      const results = await Promise.all(responses.map(async (response) => ({
        status: response.status,
        type: response.headers.get('content-type'),
        body: await response.text(),
      })));
      assertEqual(JSON.stringify(results.map(({ status }) => status)), JSON.stringify([404, 404, 404, 404, 404]), 'file media statuses');
      assert(results.every(({ type }) => type === 'text/plain'), 'file media content types');
      assert(results.every(({ body }) => body === 'not found'), 'file media bodies');
      await sleep(10);
      const snapshot = server.counters.snapshot();
      const records = snapshot.responseRecords.filter(({ urlPath }) => urlPath.startsWith('/media/'));
      assertEqual(snapshot.mediaBytesDelivered, 0, 'file source media bytes');
      assertEqual(snapshot.segmentBytesDelivered, 0, 'file source segment bytes');
      assertEqual(snapshot.initBytesDelivered, 0, 'file source init bytes');
      assertEqual(snapshot.playlistBytesDelivered, 0, 'file source playlist bytes');
      assertEqual(snapshot.unattributedMediaBytesDelivered, 0, 'file source unattributed bytes');
      assertEqual(JSON.stringify(Object.keys(snapshot.byClient)), '[]', 'file source has no media clients');
      assertEqual(records.length, 5, 'file source records five media responses');
      assert(records.every(({ kind }) => kind === 'overhead'), 'file source records overhead');
      assert(records.some(({ clientTag }) => clientTag === 'file-tab'), 'file source records the tab header');
    });
  });

  await check('media-source-setting: validation and environment options are exact', async () => {
    const configured = optionsFromEnv({ APP_MEDIA_SOURCE: 'file', APP_SEGMENT_TARGET_S: '4' });
    assertEqual(configured.mediaSource, 'file', 'environment source is preserved');
    assertEqual(configured.targetSegmentSeconds, 4, 'environment target is numeric');
    const unset = optionsFromEnv({});
    assertEqual(unset.mediaSource, undefined, 'unset source stays undefined');
    assertEqual(unset.targetSegmentSeconds, undefined, 'unset target stays undefined');

    let sourceError = null;
    try { startRoomServer({ port: 0, mediaDir, mediaSource: 'other', quiet: true }); } catch (error) { sourceError = error; }
    assert(sourceError instanceof TypeError && sourceError.message.includes('APP_MEDIA_SOURCE'), 'invalid source throws before listening');

    let targetError = null;
    try { startRoomServer({ port: 0, mediaDir, targetSegmentSeconds: 0, quiet: true }); } catch (error) { targetError = error; }
    assert(targetError instanceof TypeError && targetError.message.includes('APP_SEGMENT_TARGET_S'), 'invalid target throws before listening');

    let refusal = null;
    try { startRoomServer({ port: 0, mediaDir, mediaSource: 'file', delivery: 'http', quiet: true }); } catch (error) { refusal = error; }
    assert(refusal instanceof TypeError && refusal.message.includes('APP_MEDIA_SOURCE') && refusal.message.includes('APP_DELIVERY'), 'file and http are refused in process');
    const result = await childRefusal();
    assertEqual(result.killed, false, 'file and http refusal child exits');
    assert(result.code !== 0, 'file and http refusal child is non-zero');
    assert(result.stderr.includes('APP_MEDIA_SOURCE') && result.stderr.includes('APP_DELIVERY'), 'file and http refusal names both settings');
  });

  await check('media-source-setting: target segment seconds accepts only exact valid values', async () => {
    await withServer({ targetSegmentSeconds: 4 }, async (_server, origin) => {
      const settings = await (await fetch(`${origin}/app-settings`)).json();
      assertEqual(settings.targetSegmentSeconds, 4, 'configured target is served');
    });
    const invalid = [0, 4.0001, '4'];
    const errors = invalid.map((targetSegmentSeconds) => {
      try {
        startRoomServer({ port: 0, mediaDir, targetSegmentSeconds, quiet: true });
        return null;
      } catch (error) {
        return error;
      }
    });
    assert(errors.every((error) => error instanceof TypeError && error.message.includes('APP_SEGMENT_TARGET_S')), 'invalid target values are refused');
  });
}
