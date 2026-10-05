import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { CONTROL_8B, CONTROL_PRODUCT, controlInForce, readControl } from '../../../public/lib/edge-control.mjs';

const json = (value) => JSON.stringify(value);

function expected(supplied) {
  return supplied === undefined
    ? { control: CONTROL_PRODUCT, supplied: false, error: null }
    : supplied === CONTROL_8B
      ? { control: CONTROL_8B, supplied: true, error: null }
      : { control: CONTROL_PRODUCT, supplied: true, error: 'control-must-be-8b' };
}

export default async function edgeControlSuite() {
  await check('edge-control: readControl returns the exact frozen result for every input', async () => {
    for (const supplied of [undefined, CONTROL_8B, null, 'product', '', true, {}]) {
      const result = readControl(supplied);
      assertEqual(json(result), json(expected(supplied)), `${String(supplied)} has the exact control result`);
      assert(Object.isFrozen(result), `${String(supplied)} result is frozen`);
    }
    assertEqual(json(controlInForce()), json(expected(undefined)), 'the module load has no supplied control');
  });

  const product = await bundleProductEntry();

  await check('edge-control: a page without a switch publishes product control', async () => {
    const page = runEntry(product.code, { settings: { delivery: 'http', iceServers: [] } });
    assertEqual(json(page.app.control()), json(expected(undefined)), 'absent switch publishes product control');
    const reading = page.app.control();
    reading.control = CONTROL_8B;
    assertEqual(json(page.app.control()), json(expected(undefined)), 'published control remains fixed after a caller mutates a copy');
  });

  await check('edge-control: a page supplied with 8b publishes the archived control', async () => {
    const page = runEntry(product.code, {
      settings: { delivery: 'http', iceServers: [] },
      globals: { __waControl: CONTROL_8B },
    });
    // Mutation (a) proof, D8: the pre-load __waControl='8b' opportunity reaches
    // this page assertion; returning product control for '8b' made it red
    // (1347/1349). `git checkout -- app/public/lib/edge-control.mjs` exited 0
    // and restored the staged copy; the rerun was green (1349/1349).
    assertEqual(json(page.app.control()), json(expected(CONTROL_8B)), '8b page publishes the archived control');
  });

  await check('edge-control: an invalid page switch falls back while reporting supplied input', async () => {
    const page = runEntry(product.code, {
      settings: { delivery: 'http', iceServers: [] },
      globals: { __waControl: 'x' },
    });
    // Mutation (b) proof, D8: the pre-load invalid __waControl='x' opportunity
    // reaches this page assertion; reporting supplied=false made it red
    // (1347/1349). `git checkout -- app/public/lib/edge-control.mjs` exited 0
    // and restored the staged copy; the rerun was green (1349/1349).
    assertEqual(json(page.app.control()), json(expected('x')), 'invalid switch publishes product control with supplied error');
  });
}
