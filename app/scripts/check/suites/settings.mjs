// The startup delivery and ICE settings are served once, and invalid values
// fail before a server can listen. The script pins both the default and a
// deliberately different configured server so a constant response cannot pass.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, assert, assertEqual } from '../harness.mjs';
import { HTTP, mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { requireDelivery } from '../../delivery-pin.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

async function settingsAt(origin) {
  const response = await fetch(`${origin}/app-settings`);
  assertEqual(response.status, 200, `${origin} settings status`);
  assert(response.headers.get('content-type')?.startsWith('application/json'), `${origin} settings are JSON`);
  assertEqual(response.headers.get('cache-control'), 'no-store', `${origin} settings are not cached`);
  return response.json();
}

export default async function settingsSuite() {
  await check('settings: the default server serves host delivery and no ICE servers', async () => {
    assertEqual(JSON.stringify(await settingsAt(HTTP)), JSON.stringify({ delivery: 'host', iceServers: [], trackerUrl: null }), 'default settings are exact');
  });

  await check('settings: configured delivery and ICE servers are served exactly', async () => {
    const iceServers = [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }];
    const configured = startRoomServer({ port: 0, mediaDir, delivery: 'http', iceServers, livenessMs: 120, quiet: true });
    try {
      const port = await configured.ready;
      assertEqual(JSON.stringify(await settingsAt(`http://127.0.0.1:${port}`)), JSON.stringify({ delivery: 'http', iceServers, trackerUrl: null }), 'configured settings round-trip');
    } finally {
      await configured.close();
    }
  });

  await check('settings: a tracker URL with host delivery is served exactly', async () => {
    const iceServers = [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }];
    const trackerUrl = 'ws://tracker.test:1';
    const configured = startRoomServer({ port: 0, mediaDir, delivery: 'host', iceServers, trackerUrl, livenessMs: 120, quiet: true });
    try {
      const port = await configured.ready;
      assertEqual(JSON.stringify(await settingsAt(`http://127.0.0.1:${port}`)), JSON.stringify({ delivery: 'host', iceServers, trackerUrl }), 'configured tracker round-trips');
    } finally {
      await configured.close();
    }
  });

  await check('settings: invalid delivery and ICE settings throw at startup', async () => {
    let deliveryError = null;
    try { startRoomServer({ port: 0, mediaDir, delivery: 'carrier-pigeon', quiet: true }); } catch (error) { deliveryError = error; }
    assert(deliveryError instanceof TypeError, 'invalid delivery throws a TypeError');

    let iceError = null;
    try { startRoomServer({ port: 0, mediaDir, iceServers: {}, quiet: true }); } catch (error) { iceError = error; }
    assert(iceError instanceof TypeError, 'non-array ICE servers throw a TypeError');

    let trackerError = null;
    try { startRoomServer({ port: 0, mediaDir, trackerUrl: 'http://tracker.test:1', quiet: true }); } catch (error) { trackerError = error; }
    assert(trackerError instanceof TypeError, 'non-ws tracker URLs throw a TypeError');
  });

  await check('settings: tracker and http delivery refuse in-process', async () => {
    let error = null;
    try {
      startRoomServer({ port: 0, mediaDir, delivery: 'http', trackerUrl: 'ws://tracker.test:1', quiet: true });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TypeError, 'tracker with http delivery throws a TypeError');
    assert(error.message.includes('APP_TRACKER_URL') && error.message.includes('APP_DELIVERY'), 'tracker refusal names both settings');
  });

  await check('settings: tracker and http delivery refuse in a child process', async () => {
    const child = spawn(process.execPath, ['server/room-server.mjs'], {
      cwd: APP_DIR,
      env: { ...process.env, APP_PORT: '0', APP_DELIVERY: 'http', APP_TRACKER_URL: 'ws://tracker.test:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve) => {
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
    assertEqual(result.killed, false, 'refusal child exits before the 10 s bound');
    assert(result.code !== 0, `refusal child exits non-zero (got ${result.code})`);
    assert(stderr.includes('APP_TRACKER_URL') && stderr.includes('APP_DELIVERY'), 'child stderr names both settings');
    assert(!stdout.includes('listening'), 'refusal child never prints listening');
  });

  await check('settings: delivery pins refuse host and resolve http', async () => {
    let hostError = null;
    try { await requireDelivery(HTTP, 'http'); } catch (error) { hostError = error; }
    assert(hostError?.message.includes('delivery is "host"') && hostError.message.includes('requires "http"'), 'host delivery refusal names both values');

    const configured = startRoomServer({ port: 0, mediaDir, delivery: 'http', iceServers: [], livenessMs: 120, quiet: true });
    try {
      const port = await configured.ready;
      await requireDelivery(`http://127.0.0.1:${port}`, 'http');
    } finally {
      await configured.close();
    }
  });

  await check('settings: every HTTP measurement script retains its delivery pin', async () => {
    const scripts = [
      '../../measure-leads.mjs',
      '../../measure-start-timing.mjs',
      '../../harness-verify-impairment.mjs',
    ];
    for (const relative of scripts) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
      assert(/requireDelivery\(/.test(source), `${relative} calls requireDelivery`);
    }
  });
}
