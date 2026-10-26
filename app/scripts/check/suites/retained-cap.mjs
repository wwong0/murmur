import { assert, assertEqual, check } from '../harness.mjs';
import { conditionValidationReason, retainedCapBytes, retainedOverflow } from '../../harness-run.mjs';

export default async function retainedCapSuite() {
  await check('13c: retained evidence uses the declared cap and validates its range', async () => {
    assertEqual(retainedCapBytes({}), 209_715_200, 'an absent cap keeps the 200 MiB default');
    assertEqual(retainedCapBytes({ retainedBytesMax: 500 * 1024 * 1024 }), 524_288_000, 'a declared 500 MiB cap is used');
    for (const value of [100 * 1024 * 1024, 4_294_967_297, 1.5, '300000000']) {
      assertEqual(conditionValidationReason({ retainedBytesMax: value }), 'retained-bytes-max-invalid',
        `invalid retained cap ${String(value)} is refused`);
    }
  });

  await check('13c: retained evidence overflows only past the cap', async () => {
    for (const condition of [{}, { retainedBytesMax: 500 * 1024 * 1024 }]) {
      const cap = retainedCapBytes(condition);
      assert(!retainedOverflow(cap, condition), 'evidence exactly at the cap is retained');
      assert(retainedOverflow(cap + 1, condition), 'evidence one byte over the cap overflows');
    }
  });
}
