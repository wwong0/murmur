// The startup delivery and ICE settings are served once, and invalid values
// fail before a server can listen. The script pins both the default and a
// deliberately different configured server so a constant response cannot pass.

import fs from 'node:fs';
import { check, assert, assertEqual } from '../harness.mjs';
import { HTTP, mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { requireDelivery } from '../../delivery-pin.mjs';

async function settingsAt(origin) {
  const response = await fetch(`${origin}/app-settings`);
  assertEqual(response.status, 200, `${origin} settings status`);
  assert(response.headers.get('content-type')?.startsWith('application/json'), `${origin} settings are JSON`);
  assertEqual(response.headers.get('cache-control'), 'no-store', `${origin} settings are not cached`);
  return response.json();
}

export default async function settingsSuite() {
  await check('settings: the default server serves host delivery and no ICE servers', async () => {
    assertEqual(JSON.stringify(await settingsAt(HTTP)), JSON.stringify({ delivery: 'host', iceServers: [] }), 'default settings are exact');
  });

  await check('settings: configured delivery and ICE servers are served exactly', async () => {
    const iceServers = [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }];
    const configured = startRoomServer({ port: 0, mediaDir, delivery: 'http', iceServers, livenessMs: 120, quiet: true });
    try {
      const port = await configured.ready;
      assertEqual(JSON.stringify(await settingsAt(`http://127.0.0.1:${port}`)), JSON.stringify({ delivery: 'http', iceServers }), 'configured settings round-trip');
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
