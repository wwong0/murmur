import { assert, assertEqual, check } from '../harness.mjs';
import { requireAutoStart } from '../../delivery-pin.mjs';

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
}
