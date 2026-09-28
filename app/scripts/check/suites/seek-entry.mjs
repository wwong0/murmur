import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { armFor } from '../../harness/arms.mjs';

const json = (value) => JSON.stringify(value);
let product;

function page(globals = {}, role = 'viewer') {
  return runEntry(product.code, {
    role,
    settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] },
    globals,
  });
}

export default async function seekEntrySuite() {
  product = await bundleProductEntry();

  await check('seek entry (a): an unarmed page has no harness seek entry', async () => {
    const current = page().app;
    assert(!Object.hasOwn(current, 'harnessSeek'), 'absence assertion sees no harnessSeek key');
    assertEqual(current.harnessSeekError, null, 'an absent flag is not an error');
  });

  await check('seek entry (b): armed seek issues one product transition at the computed position', async () => {
    const current = page({ __waHarnessSeek: true }, 'host');
    current.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    current.harness.sharedNowMs = 12_000;
    const created = current.sent().find((entry) => entry.payload?.kind === 'create');
    const expected = created.payload.current.mediaMs + 12_000 + 300 - created.payload.current.atSharedMs + 600;
    const result = current.app.harnessSeek(600);
    const seeks = current.sent().filter((entry) => entry.payload?.kind === 'seek');
    assertEqual(seeks.length, 1, 'the hook issues exactly one seek');
    assertEqual(seeks[0].payload.positionMs, expected, 'seek position uses mediaMsAt(now + 300) plus delta');
    assert(result.issued === true && Number.isFinite(result.atPageMs), 'hook returns its issue and page instant');
  });

  await check('seek entry (c): malformed supplied flags publish an error and no hook', async () => {
    for (const value of [1, 'true']) {
      const current = page({ __waHarnessSeek: value }).app;
      assert(!Object.hasOwn(current, 'harnessSeek'), `${JSON.stringify(value)} leaves no hook`);
      assert(typeof current.harnessSeekError === 'string', `${JSON.stringify(value)} publishes harnessSeekError`);
    }
  });

  await check('seek entry (d): playbackState reads the newly applied acquisition state', async () => {
    const current = page({ __waHarnessSeek: true }, 'host');
    current.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    current.harness.sharedNowMs = 12_000;
    current.app.harnessSeek(600);
    const seek = current.sent().find((entry) => entry.payload?.kind === 'seek');
    current.deliver({ ...seek, seq: 3, from: 'host-1', ts: { recv: 12_001 } });
    assertEqual(json(current.app.playbackState()), json({
      lineage: seek.payload.basis.lineage,
      version: 3,
      playing: true,
      positionMs: seek.payload.positionMs,
      atSharedMs: seek.payload.atSharedMs,
    }), 'playbackState carries the applied seek version and position');
  });

  await check('seek entry (e): only a seeking host receives the pre-navigation hook', async () => {
    const arm = armFor({ delivery: 'host', peerExchange: true, clients: 1 });
    const condition = { delivery: 'host', peerExchange: true, clients: 1, seek: { issueAfterReadyMs: 120, deltaMs: 600, appliedTimeoutMs: 5000 } };
    let hostOptions;
    await arm.openSessions({
      room: 'room', clientOriginUrl: 'http://origin', condition, runDir: '.', deadline: null,
      newSession: (tag, role) => ({ tag, role }),
      clientFactory: async () => ({ tab: { send: async () => {} } }),
      prepareHostClient: async (...args) => { hostOptions = args[3]; },
    });
    const sent = [];
    await hostOptions.beforeNavigate({ role: 'host', tab: { send: async (_method, value) => sent.push(value) } });
    assert(sent[0].source.includes('__waHarnessSeek = true'), 'seeking host gets the flag');
    const viewerSent = [];
    const viewer = arm.prepareClientOptions({ condition, manifestFile: { merge() {}, get: () => ({ clients: {} }), write() {} } });
    await viewer.beforeNavigate({ role: 'viewer', tag: 'c01', tab: { send: async (_method, value) => viewerSent.push(value) } });
    assert(!viewerSent[0].source.includes('__waHarnessSeek'), 'viewer never gets the host seek flag');
  });
}
