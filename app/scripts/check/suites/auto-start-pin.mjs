import http from 'node:http';
import { assert, assertEqual, check } from '../harness.mjs';
import { createOriginProxy } from '../../../harness/origin-proxy.mjs';
import { requireAutoStart } from '../../delivery-pin.mjs';
import { autoStartPinOrigins } from '../../harness-run.mjs';
import { HOST_PAGE_URL, ORIGIN_HOST_URL, SERVER_HOST_URL, urlsForDelivery } from '../../harness/topology.mjs';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

export default async function autoStartPinSuite() {
  const origin = 'http://pin.test';
  const fake = (value) => async () => response(value);

  await check('auto-start pin: enabled setting resolves true', async () => {
    assertEqual(await requireAutoStart(origin, { fetchImpl: fake({ autoStart: true }) }), true, 'enabled setting is accepted');
  });

  await check('auto-start pin: disabled, absent, failed and malformed settings refuse', async () => {
    const cases = [
      ['false', fake({ autoStart: false })],
      ['absent', fake({})],
      ['HTTP 500', async () => response(null, { ok: false, status: 500 })],
      ['bad JSON', async () => ({ ok: true, status: 200, json: async () => { throw new Error('invalid json'); } })],
    ];
    for (const [label, fetchImpl] of cases) {
      let error = null;
      try { await requireAutoStart(origin, { fetchImpl }); } catch (caught) { error = caught; }
      assert(error instanceof Error, `${label} setting refuses`);
    }
  });

  // Joint D1 F3: under host delivery the host page's proxy listens inside its container, so the
  // pin reads the server, from which that proxy serves /app-settings.
  await check('auto-start pin: the harness reads machine-side origins for each delivery', async () => {
    const host = autoStartPinOrigins(urlsForDelivery('host'), 'host');
    assertEqual(JSON.stringify(host), JSON.stringify([SERVER_HOST_URL]), 'host delivery reads the server alone');
    assert(!host.includes(HOST_PAGE_URL) && !host.includes(ORIGIN_HOST_URL), 'host delivery reads no address of the host-page container');
    assertEqual(JSON.stringify(autoStartPinOrigins(urlsForDelivery('http'), 'http')), JSON.stringify([ORIGIN_HOST_URL]), 'http delivery reads the origin once');
  });

  await check('auto-start pin: the host-page proxy serves /app-settings from its room target', async () => {
    const upstream = (name) => http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: name, path: req.url }));
    });
    const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const media = upstream('media');
    const room = upstream('room');
    const proxy = createOriginProxy({ mediaTarget: `http://127.0.0.1:${await listen(media)}`, roomTarget: `http://127.0.0.1:${await listen(room)}` });
    try {
      const port = await listen(proxy);
      const read = async (pathname) => (await fetch(`http://127.0.0.1:${port}${pathname}`, { cache: 'no-store' })).json();
      assertEqual((await read('/app-settings')).from, 'room', 'the settings every page reads come from the room target');
      assertEqual((await read('/media/master.m3u8')).from, 'media', 'media paths go to the media target');
    } finally {
      await Promise.all([proxy, media, room].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });
}
