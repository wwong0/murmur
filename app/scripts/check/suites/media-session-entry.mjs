// Page-level Media Session controls, through the real entry.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

function mediaSession() {
  return {
    handlers: {},
    setActionHandler(kind, fn) {
      this.handlers[kind] = fn;
    },
  };
}

function operation(page, kind) {
  return page.sent().filter((envelope) => envelope.payload?.kind === kind);
}

export default async function mediaSessionEntrySuite() {
  const product = await bundleProductEntry();

  await check('media-session-entry: registers only play and pause handlers and tolerates no API', async () => {
    const session = mediaSession();
    const page = runEntry(product.code, { globals: { navigator: { mediaSession: session } } });
    assertEqual(Object.keys(session.handlers).sort().join(','), 'pause,play', 'Media Session surface is exactly play and pause');

    const noApi = runEntry(product.code);
    noApi.tick();
    assert(true, 'a page without Media Session loads and ticks');
  });

  await check('media-session-entry: an enabled pause handler issues the bar pause operation', async () => {
    const session = mediaSession();
    const page = runEntry(product.code, { globals: { navigator: { mediaSession: session } } });
    page.resolveSole({ nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    assertEqual(page.view().controls.pause.disabled, false, 'pause control is enabled');
    session.handlers.pause();
    assertEqual(operation(page, 'pause').length, 1, 'media pause issues one room operation');
    assertEqual(operation(page, 'pause')[0].payload.kind, 'pause', 'media pause uses the bar operation kind');
  });

  await check('media-session-entry: a disabled pause handler does nothing', async () => {
    const session = mediaSession();
    const page = runEntry(product.code, { globals: { navigator: { mediaSession: session } }, role: 'viewer' });
    page.resolveSole({ nowMs: 10_000 });
    page.harness.role = 'viewer';
    page.harness.sharedNowMs = 11_000;
    page.tick();
    const state = page.app.playbackState();
    page.deliver({
      type: 'playback-operation',
      from: 'c1',
      seq: 3,
      ts: { recv: 11_001 },
      payload: {
        kind: 'control-mode',
        controlMode: 'host',
        basis: { lineage: state.lineage, version: state.version },
        atSharedMs: 11_000,
      },
    });
    page.harness.sharedNowMs = 12_000;
    page.tick();
    assertEqual(page.view().controls.pause.disabled, true, 'viewer pause control is disabled in host mode');
    let actionCalls = 0;
    page.screens().actions.pause = () => { actionCalls += 1; };
    session.handlers.pause();
    assertEqual(actionCalls, 0, 'disabled media pause does not call the bar action');
    assertEqual(operation(page, 'pause').length, 0, 'unresolved pause control issues no operation');
    assertEqual(page.count('pause'), 0, 'unresolved pause control does not call the element');
  });

  await check('media-session-entry: an enabled play handler issues the bar play operation', async () => {
    const session = mediaSession();
    const page = runEntry(product.code, { globals: { navigator: { mediaSession: session } } });
    page.resolveSole({ nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    page.click('pause');
    const pause = operation(page, 'pause')[0];
    page.deliver({ ...pause, seq: 3, from: 'c1', ts: { recv: 11_001 } });
    page.harness.sharedNowMs = 11_302;
    page.tick();
    assertEqual(page.view().controls.play.disabled, false, 'play control is enabled');
    session.handlers.play();
    assertEqual(operation(page, 'play').length, 1, 'media play issues one room operation');
    assertEqual(operation(page, 'play')[0].payload.kind, 'play', 'media play uses the bar operation kind');
  });
}
