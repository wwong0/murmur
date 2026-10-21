// scripts/check/suites/theatre-flip.mjs — the player's theatre move as keyframes (12e design.md
// D11; tasks 3.5). Pure: no server, no clock.

import { check, assert, assertEqual } from '../harness.mjs';
import { flipKeyframes } from '../../../public/lib/theatre-flip.mjs';

const box = (left, top, width, height) => ({ left, top, width, height });

export default async function theatreFlipSuite() {
  await check('theatre-flip: the first frame puts the new box where the old one was', async () => {
    const frames = flipKeyframes(box(16, 64, 1000, 562.5), box(100, 16, 1200, 675));
    assert(Array.isArray(frames) && frames.length === 2, 'two keyframes');
    assertEqual(frames[0].transform, `translate(-84px, 48px) scale(${1000 / 1200}, ${562.5 / 675})`, 'first frame');
    assertEqual(frames[0].transformOrigin, '0 0', 'first frame origin');
    assertEqual(frames[1].transform, 'none', 'last frame');
    assertEqual(frames[1].transformOrigin, '0 0', 'last frame origin');
  });

  await check('theatre-flip: equal boxes, within half a pixel, and boxes with no area do not animate', async () => {
    assertEqual(flipKeyframes(box(10, 10, 800, 450), box(10.4, 9.6, 800.5, 449.5)), null, 'equal within 0.5 px');
    assert(flipKeyframes(box(10, 10, 800, 450), box(10.6, 10, 800, 450)) !== null, '0.6 px apart animates');
    assertEqual(flipKeyframes(box(0, 0, 0, 0), box(10, 10, 800, 450)), null, 'before has no area');
    assertEqual(flipKeyframes(box(10, 10, 800, 450), box(10, 10, 800, 0)), null, 'after has no area');
  });
}
