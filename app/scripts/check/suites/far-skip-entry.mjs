// Far-skip entry wiring through the standard vm fakes and the real controller.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry } from '../entry-harness.mjs';
import { playingPage, settleNamed } from '../far-skip-page.mjs';

export default async function farSkipEntrySuite() {
  const product = await bundleProductEntry();

  await check('far-skip-entry F6: a closable difference never moves the position', async () => {
    const page = playingPage(product.code);
    settleNamed(page, -400, 12_000);
    assertEqual(page.app.playback().skips, 0, '400 ms behind for ten seconds never skips');
    assertEqual(page.events.filter((event) => event.kind === 'park').length, 0, 'the closable difference causes no position write');
  });

  await check('far-skip-entry F6: an unclosable difference skips without an envelope', async () => {
    const page = playingPage(product.code);
    page.harness.acceptSkip = true;
    const before = page.sent().length;
    settleNamed(page, -25_000, 4000);
    const afterSkip = page.sent().length;
    assertEqual(page.app.playback().skips, 1, '25000 ms behind produces one skip');
    const parks = page.events.filter((event) => event.kind === 'park');
    assertEqual(parks.length, 1, 'the skip produces one position write');
    assertEqual(parks[0].detail.paused, true, 'the skip writes the position while paused');
    assertEqual(afterSkip, before, 'the skip sends zero envelopes');
    page.click('forward-10');
    assertEqual(page.sent().length, before + 1, 'an ordinary operation can move the send count in this check');
  });
}
