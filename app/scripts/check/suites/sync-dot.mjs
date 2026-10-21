import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { syncDot } from '../../../public/lib/sync-dot.mjs';

export default async function syncDotSuite() {
  await check('D1 sync-dot: a settled finite estimate is in sync and offers its figure', async () => {
    const dot = syncDot({ playing: true, mode: 'settled', estimateMs: 12 });
    assertEqual(dot.state, 'in-sync', 'settled state');
    assert(dot.figure.includes('12'), 'settled figure carries 12 ms');
  });

  await check('D2 sync-dot: correction state is correcting', async () => {
    assertEqual(syncDot({ playing: true, mode: 'correcting', estimateMs: 85 }).state, 'correcting', 'controller correction');
    assertEqual(syncDot({ playing: true, mode: 'settled', estimateMs: 85 }).state, 'correcting', 'large estimate correction');
  });

  await check('D3 sync-dot: paused playback is idle', async () => {
    assertEqual(syncDot({ playing: false, mode: 'settled', estimateMs: 12 }).state, 'idle', 'paused state');
  });

  await check('D4 sync-dot: the forty millisecond boundary is in sync', async () => {
    const at = syncDot({ playing: true, mode: 'settled', estimateMs: 40 });
    const over = syncDot({ playing: true, mode: 'settled', estimateMs: 41 });
    assertEqual(at.state, 'in-sync', 'inclusive threshold');
    assertEqual(over.state, 'correcting', 'just over threshold');
  });

  await check('D5 sync-dot: a non-finite estimate is idle', async () => {
    assertEqual(syncDot({ playing: true, mode: 'settled', estimateMs: Number.NaN }).state, 'idle', 'missing estimate');
    assertEqual(syncDot({ playing: true, mode: 'settled', estimateMs: 12 }).figure, '+12.0 ms', 'finite figure');
  });

  const product = await bundleProductEntry();
  await check('D6 sync-dot: overlay lines are current while the overlay starts hidden', async () => {
    const page = runEntry(product.code, { settings: { delivery: 'http', iceServers: [], autoStart: false } });
    await page.settled();
    page.tick();
    const view = page.view();
    assertEqual(view.overlayVisible, false, 'overlay starts hidden');
    for (const name of ['clock', 'drift', 'bytes', 'controller']) assert(view.overlay[name].length > 0, `${name} line is readable while hidden`);
    page.screens().actions.stats();
    assertEqual(page.view().overlayVisible, true, 'stats shows overlay without reload');
  });
}
