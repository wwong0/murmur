import { assert, assertEqual, check } from '../harness.mjs';
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

  // 11b-2 H: the host page's URL is container-side under host delivery, so the pin reads the origin's published one.
  await check('auto-start pin: the harness reads machine-side origins for each delivery', async () => {
    const host = autoStartPinOrigins(urlsForDelivery('host'), 'host');
    assertEqual(JSON.stringify(host), JSON.stringify([SERVER_HOST_URL, ORIGIN_HOST_URL]), 'host delivery reads the server and the origin');
    assert(!host.includes(HOST_PAGE_URL), 'host delivery never reads the container-side host page URL');
    assertEqual(JSON.stringify(autoStartPinOrigins(urlsForDelivery('http'), 'http')), JSON.stringify([ORIGIN_HOST_URL]), 'http delivery reads the origin once');
  });
}
