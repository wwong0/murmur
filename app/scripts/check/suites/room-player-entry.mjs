import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

export default async function roomPlayerEntrySuite() {
  const product = await bundleProductEntry();

  await check('room-player-entry: the sync dot needs a loaded title and company', async () => {
    const page = runEntry(product.code, { role: 'host' });
    page.harness.last = { mediaEndMs: 120_000 };
    page.resolveSole({ nowMs: 10_000 });
    page.harness.roster = [{ clientId: 'c1', tabId: 't', role: 'host', joinedAt: 1 }];
    page.tick();
    assertEqual(page.view().bar.syncShown, false, 'one member hides the dot');
    page.harness.roster = [
      { clientId: 'c1', tabId: 't', role: 'host', joinedAt: 1 },
      { clientId: 'c2', tabId: 'v', role: 'viewer', joinedAt: 2 },
    ];
    page.tick();
    assertEqual(page.view().bar.syncShown, true, 'two members show the dot');
  });

  await check('room-player-entry: fullscreen action and change tracking use the static player', async () => {
    const page = runEntry(product.code);
    let exits = 0;
    let requests = 0;
    page.document.exitFullscreen = () => { exits += 1; page.document.fullscreenElement = null; };
    page.player.requestFullscreen = () => { requests += 1; };
    page.document.fullscreenElement = page.player;
    page.screens().actions.fullscreen();
    assertEqual(exits, 1, 'fullscreen exits when already set');
    page.screens().actions.fullscreen();
    assertEqual(requests, 1, 'fullscreen requests the player when absent');
    page.document.fullscreenElement = page.player;
    page.fireDocument('fullscreenchange');
    assertEqual(page.view().fullscreen, true, 'fullscreenchange enters');
    page.document.fullscreenElement = null;
    page.fireDocument('fullscreenchange');
    assertEqual(page.view().fullscreen, false, 'fullscreenchange leaves');
  });
}
