import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const T0 = 10_000;
const HOST = { clientId: 'h', tabId: 'h', role: 'host', joinedAt: 1 };
const VIEWER = { clientId: 'v', tabId: 'v', role: 'viewer', joinedAt: 2 };

async function drain() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function viewerPage(code, graceMs) {
  return runEntry(code, {
    role: 'viewer',
    search: '?room=r&role=viewer&tab=v',
    settings: {
      delivery: 'host',
      iceServers: [],
      trackerUrl: null,
      mediaSource: 'dir',
      targetSegmentSeconds: 2,
      autoStart: false,
      hostGraceMs: graceMs,
    },
    globals: { RTCPeerConnection: class {}, TextEncoder, TextDecoder },
  });
}

function stateEnvelope({ playing, from = 'h', seq = 2, atSharedMs = T0, lineage = 'lineage-a' }) {
  return {
    type: 'playback-operation',
    from,
    seq,
    ts: { recv: atSharedMs, send: atSharedMs },
    payload: {
      kind: 'create',
      lineage,
      current: { playing, atSharedMs, mediaMs: 0 },
      previous: null,
      controlMode: 'open',
    },
  };
}

function presence({ from = 'server', roster, atSharedMs = T0, event = 'leave' }) {
  return {
    type: 'presence',
    from,
    seq: 3,
    ts: { recv: atSharedMs, send: atSharedMs },
    payload: { event, member: { clientId: 'h', role: 'host' }, roster },
  };
}

function pauses(page) {
  return page.sent().filter((env) => env.type === 'playback-operation' && env.payload?.kind === 'pause');
}

async function pageWithState(code, graceMs, playing = true) {
  const page = viewerPage(code, graceMs);
  await drain();
  page.harness.sharedNowMs = T0;
  page.emit('joined', { clientId: 'v', role: 'viewer', seq: 1, roster: [HOST, VIEWER] });
  page.deliver(stateEnvelope({ playing }));
  return page;
}

export default async function hostGraceEntrySuite() {
  const product = await bundleProductEntry();

  await check('host-grace-entry: configured grace pauses once at the exact setting', async () => {
    for (const graceMs of [2_000, 5_000]) {
      const page = await pageWithState(product.code, graceMs);
      page.deliver(presence({ roster: [VIEWER] }));
      page.harness.sharedNowMs = T0 + graceMs - 1;
      page.tick();
      assertEqual(pauses(page).length, 0, `no pause before ${graceMs}ms grace`);
      page.harness.sharedNowMs = T0 + graceMs;
      page.tick();
      assertEqual(pauses(page).length, 1, `one pause at the ${graceMs}ms boundary`);
      assertEqual(pauses(page)[0].payload.atSharedMs, T0 + graceMs, 'pause names the grace end');
      assertEqual(page.app.hostGrace().graceMs, graceMs, 'entry publishes the configured grace');
      assertEqual(page.app.hostGrace().pauses, 1, 'entry counts the issued grace pause');
      page.harness.sharedNowMs = T0 + graceMs + 1_000;
      page.tick();
      assertEqual(pauses(page).length, 1, `expired ${graceMs}ms grace does not repeat`);
    }
    // Guarded claim: replacing hostGraceMs with 10_000 makes the 2_000ms instant red.
  });

  await check('host-grace-entry: a returning host cancels before the boundary', async () => {
    const graceMs = 2_000;
    const page = await pageWithState(product.code, graceMs);
    page.deliver(presence({ roster: [VIEWER] }));
    page.harness.sharedNowMs = T0 + graceMs - 1;
    page.deliver(presence({ roster: [HOST, VIEWER], atSharedMs: T0 + graceMs - 1, event: 'join' }));
    page.harness.sharedNowMs = T0 + graceMs;
    page.tick();
    page.harness.sharedNowMs = T0 + graceMs + 1_000;
    page.tick();
    assertEqual(pauses(page).length, 0, 'a host returning within the grace prevents a pause');
    assertEqual(page.app.hostGrace().running, false, 'the returning host leaves no running grace');
    // Guarded claim: dropping the host-present cancellation makes this check red.
  });

  await check('host-grace-entry: joined roster starts only without a host and member presence is ignored', async () => {
    const noHost = viewerPage(product.code, 2_000);
    await drain();
    noHost.harness.sharedNowMs = T0;
    noHost.emit('joined', { clientId: 'v', role: 'viewer', seq: 1, roster: [VIEWER] });
    assertEqual(noHost.app.hostGrace().running, true, 'joined without a host starts the grace');

    const withHost = await pageWithState(product.code, 2_000);
    withHost.deliver(presence({ from: 'c-x', roster: [], event: 'leave' }));
    withHost.harness.sharedNowMs = T0 + 2_000;
    withHost.tick();
    assertEqual(withHost.app.hostGrace().running, false, 'member presence does not start the grace');
    assertEqual(pauses(withHost).length, 0, 'member presence does not cause a pause');
  });

  await check('host-grace-entry: absence text disables viewer controls and ready host re-enables paused play', async () => {
    const page = await pageWithState(product.code, 2_000, false);
    page.deliver(presence({ roster: [VIEWER] }));
    page.harness.sharedNowMs = T0;
    page.tick();
    const absent = page.view();
    assertEqual(absent.hostStatus.state, 'absent', 'host status is absent without a host');
    // The rendered text is read on a real page by N1's RC6; screens.jsx is faked here.
    assertEqual(absent.bar.preparing, true, 'absent host marks the bar as blocked');
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(absent.controls[id].disabled, true, `${id} is disabled without a host`);
    page.deliver(presence({ roster: [HOST, VIEWER], atSharedMs: T0 + 1, event: 'join' }));
    page.deliver({ type: 'host-status', from: 'h', payload: { state: 'ready' } });
    page.tick();
    const ready = page.view();
    for (const id of ['play', 'back-10', 'forward-10']) assertEqual(ready.controls[id].disabled, false, `${id} is enabled after a ready host returns`);
  });

  await check('host-grace-entry: concurrent grace pauses converge on one lineage and version', async () => {
    const first = await pageWithState(product.code, 2_000);
    const second = await pageWithState(product.code, 2_000);
    const absence = presence({ roster: [VIEWER] });
    first.deliver(absence);
    second.deliver(absence);
    first.harness.sharedNowMs = T0 + 2_000;
    second.harness.sharedNowMs = T0 + 2_000;
    first.tick();
    second.tick();
    const firstPause = pauses(first)[0];
    const secondPause = pauses(second)[0];
    assert(firstPause && secondPause, 'both viewers issue a grace pause');
    assertEqual(firstPause.payload.atSharedMs, T0 + 2_000, 'first pause uses the shared grace end');
    assertEqual(secondPause.payload.atSharedMs, T0 + 2_000, 'second pause uses the shared grace end');

    const applied = (from, seq, payload) => ({
      ...payload,
      from,
      seq,
      ts: { recv: T0 + 2_000, send: T0 + 2_000 },
    });
    first.deliver(applied('v1', 3, firstPause));
    second.deliver(applied('v1', 3, firstPause));
    first.deliver(applied('v2', 4, secondPause));
    second.deliver(applied('v2', 4, secondPause));
    const firstState = first.app.playbackState();
    const secondState = second.app.playbackState();
    assertEqual(firstState.lineage, secondState.lineage, 'both viewers retain one lineage');
    assertEqual(firstState.version, 3, 'the first pause wins compare-and-set');
    assertEqual(secondState.version, 3, 'the stale second pause does not advance version');
    assertEqual(firstState.playing, false, 'first viewer ends paused');
    assertEqual(secondState.playing, false, 'second viewer ends paused');
    assertEqual(firstState.positionMs, T0 + 2_000 - T0, 'first viewer maps the grace instant');
    assertEqual(secondState.positionMs, T0 + 2_000 - T0, 'second viewer maps the grace instant');
  });
}
