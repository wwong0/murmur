// The touch-reveal decision (design.md D7), as a table.

import { assertEqual, check } from '../harness.mjs';
import { swallowTouch } from '../../../public/lib/touch-reveal.mjs';

export default async function touchRevealSuite() {
  await check('touch-reveal: a touch on a faded bar is swallowed, a touch on a shown bar is not', async () => {
    assertEqual(swallowTouch({ pointerType: 'touch', faded: true }), true, 'touch and faded');
    assertEqual(swallowTouch({ pointerType: 'touch', faded: false }), false, 'touch and shown');
  });

  await check('touch-reveal: a mouse or pen is never swallowed, faded or not', async () => {
    for (const pointerType of ['mouse', 'pen']) {
      assertEqual(swallowTouch({ pointerType, faded: true }), false, `${pointerType} and faded`);
      assertEqual(swallowTouch({ pointerType, faded: false }), false, `${pointerType} and shown`);
    }
  });

  await check('touch-reveal: a missing field is not a touch on a faded bar', async () => {
    assertEqual(swallowTouch({ faded: true }), false, 'no pointer type');
    assertEqual(swallowTouch({ pointerType: 'touch' }), false, 'no faded flag');
    assertEqual(swallowTouch({}), false, 'neither');
    assertEqual(swallowTouch(), false, 'no argument');
  });
}
