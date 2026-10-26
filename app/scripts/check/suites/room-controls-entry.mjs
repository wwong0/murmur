// Page surface checks for D9 controls and invite links, through the real entry.

import { check, assert, assertEqual } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const ISSUING_BUTTONS = ['play', 'pause', 'back-10', 'forward-10', 'control-mode'];

export default async function roomControlsEntrySuite() {
  const product = await bundleProductEntry();

  await check('room-controls-entry: Host on a room-less page creates a host room and pushes its URL', async () => {
    const page = runEntry(product.code, { search: '' });
    page.screens().actions.host();
    await page.settled();
    assertEqual(page.history.pushes.length, 1, 'no-room search makes exactly one pushState call');
    const query = new URLSearchParams(page.history.pushes[0].url.slice(1));
    assert(/^[0-9a-f]{32}$/.test(query.get('room')), 'generated room is 32 lowercase hex characters');
    assertEqual(query.get('role'), 'host', 'generated URL carries host role');
    assert(typeof query.get('tab') === 'string' && query.get('tab').length > 0, 'generated URL carries a tab');
    assertEqual(page.view().invite.href, `http://127.0.0.1:8100/room.html?room=${query.get('room')}`, 'invite href carries only room');
  });

  await check('room-controls-entry: an invited page keeps its room URL', async () => {
    const page = runEntry(product.code, { search: '?room=r&tab=t' });
    assertEqual(page.history.replacements.length + page.history.pushes.length, 0, 'room search writes no history entry');
    assertEqual(page.view().invite.href, 'http://127.0.0.1:8100/room.html?room=r', 'invite href omits role and tab');
  });

  await check('room-controls-entry: an invite names a room whose name holds query syntax', async () => {
    const page = runEntry(product.code, { search: '?room=a%26role%3Dhost&tab=t' });
    const invite = new URL(page.view().invite.href);
    assertEqual(invite.searchParams.get('room'), 'a&role=host', 'the invite names the whole room');
    assertEqual(invite.searchParams.has('role'), false, 'and carries no role');
  });

  await check('room-controls-entry: unresolved acquisition disables every issuing button', async () => {
    const page = runEntry(product.code);
    for (const id of ISSUING_BUTTONS) {
      assertEqual(page.view().controls[id].disabled, true, `${id} is disabled while acquisition is unresolved`);
    }
  });

  await check('room-controls-entry: resolved host controls follow the playing state and local mute stays local', async () => {
    const page = runEntry(product.code);
    page.resolveSole({ nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    assertEqual(page.view().controls.pause.disabled, false, 'pause is enabled for a resolved playing state');
    assertEqual(page.view().controls.play.disabled, true, 'play is disabled for a resolved playing state');

    const sent = page.sent().length;
    const muted = page.video.muted;
    page.click('mute');
    assertEqual(page.video.muted, !muted, 'mute flips only the local video');
    assertEqual(page.sent().length, sent, 'mute issues no playback operation');
    assertEqual(page.view().controls.mute.text, muted ? 'mute' : 'unmute', 'mute label follows the local flag');
  });

  await check('room-controls-entry: screens mount after the app seam is assigned', async () => {
    const page = runEntry(product.code);
    assertEqual(page.screens().appAtMount, true, 'app exists at screen mount');
  });

  await check('room-controls-entry: the engine reads no panel element', async () => {
    const page = runEntry(product.code);
    assert(page.screens().view !== undefined, 'the screens mount without panel reads');
  });

  await check('room-controls-entry: initial view matches the shell after one tick', async () => {
    const page = runEntry(product.code);
    page.tick();
    assertEqual(page.view().status, 'unknown', 'initial status');
    assertEqual(JSON.stringify(page.view().controls), JSON.stringify({
      play: { text: 'play', disabled: true, hidden: false },
      pause: { text: 'pause', disabled: true, hidden: false },
      'back-10': { text: 'back 10s', disabled: true, hidden: false },
      'forward-10': { text: 'forward 10s', disabled: true, hidden: false },
      // D11: every member sees the settings menu, so a viewer's entry is disabled, not hidden.
      'control-mode': { text: 'mode: host', disabled: true, hidden: false },
      mute: { text: 'unmute', disabled: false, hidden: false },
    }), 'initial controls');
    assertEqual(page.view().controlMode, 'open', 'the current mode starts open');
  });

  await check('room-controls-entry: the play/pause slot names pause while the replicated state plays and play otherwise (D8)', async () => {
    const page = runEntry(product.code);
    assertEqual(page.view().playSlot, 'play', 'play before any state');
    page.resolveSole({ nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    assertEqual(page.view().playSlot, 'pause', 'pause once the created room plays');

    const operation = (kind, seq, atSharedMs) => {
      const { lineage, version } = page.app.playbackState();
      return { type: 'playback-operation', from: 'c1', seq, ts: { recv: atSharedMs }, payload: { kind, basis: { lineage, version }, atSharedMs } };
    };
    page.deliver(operation('pause', 3, 11_000));
    assertEqual(page.app.playbackState().playing, false, 'the pause was applied');
    assertEqual(page.view().playSlot, 'play', 'play after an applied pause');
    page.deliver(operation('play', 4, 12_000));
    assertEqual(page.app.playbackState().playing, true, 'the play was applied');
    assertEqual(page.view().playSlot, 'pause', 'pause after an applied play');
  });

  await check('room-controls-entry: the control-mode entry is enabled for a resolved host and the current mode follows the applied operation', async () => {
    const page = runEntry(product.code);
    page.resolveSole({ nowMs: 10_000 });
    page.harness.sharedNowMs = 11_000;
    page.tick();
    assertEqual(page.view().controls['control-mode'].hidden, false, 'the host sees the control');
    assertEqual(page.view().controls['control-mode'].disabled, false, 'a resolved host can press it');
    assertEqual(page.view().controlMode, 'open', 'the room starts in open mode');

    page.screens().actions.controlMode();
    const change = page.sent().find((env) => env.payload?.kind === 'control-mode');
    assert(change, 'the host issued a control-mode operation');
    page.deliver({ ...change, seq: 3, from: 'c1', ts: { recv: 11_002 } });
    page.tick();
    assertEqual(page.view().controlMode, 'host', 'the applied operation moves the current mode');
    assertEqual(page.view().controls['control-mode'].text, 'mode: open', 'the entry text still names the mode a press would set');
  });
}
