import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';

const NOW = 10_000;
const LEAD = 100;
const TARGET = 600_000;
const json = (value) => JSON.stringify(value);

function fakeClient() {
  const events = new Map();
  const handlers = new Map();
  const sent = [];
  const add = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  return {
    clientId: 'c1',
    role: 'host',
    sent,
    send(envelope) { sent.push(envelope); },
    request() { return new Promise(() => {}); },
    onEvent(type, fn) { add(events, type, fn); return () => {}; },
    on(type, fn) { add(handlers, type, fn); return () => {}; },
    emit(type, value) { for (const fn of events.get(type) ?? []) fn(value); },
    deliver(value) { for (const fn of handlers.get(value.type) ?? []) fn(value); },
  };
}

function acquire({ playing, held, holds }) {
  const client = fakeClient();
  const driver = createPlaybackAcquisition({
    client,
    clock: { sharedNow: () => NOW },
    settings: { transitionLeadMs: LEAD, maxFutureMs: 1_000, autoStart: () => false, holds: () => holds },
    mintLineage: () => 'lineage-paused-seek',
  });
  client.emit('joined', { clientId: 'c1', seq: 1, roster: [{ clientId: 'c1', role: 'host', tabId: 't', joinedAt: 1 }] });
  const creation = client.sent.find((entry) => entry.payload?.kind === 'create');
  const current = { playing, atSharedMs: NOW, mediaMs: 0, ...(held ? { held: true } : {}) };
  client.deliver({ ...creation, payload: { ...creation.payload, current }, seq: 1, from: 'c1', ts: { recv: NOW } });
  return { client, driver };
}

function issueAndApply(options) {
  const { client, driver } = acquire(options);
  assert(driver.issue('seek', { positionMs: TARGET }), 'the acquisition issues a seek');
  const seek = client.sent.find((entry) => entry.payload?.kind === 'seek');
  client.deliver({ ...seek, seq: 2, from: 'c1', ts: { recv: NOW } });
  return { driver, seek, state: driver.state.current };
}

let product;

export default async function pausedSeekSuite() {
  product = await bundleProductEntry();

  await check('P1 tracker paused seek sends no hold and stays paused at 600000', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      globals: { __waHarnessSeek: true },
      settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [], autoStart: false },
    });
    await page.settled();
    page.resolveSole({ clientId: 'p1', nowMs: NOW });
    page.harness.sharedNowMs = NOW + 5_000;
    const result = page.app.harnessSeek(TARGET);
    const seek = page.sent().find((entry) => entry.payload?.kind === 'seek');
    assert(result.issued, 'the paused page issues its seek');
    assert(!Object.hasOwn(seek.payload, 'hold'), 'paused tracker seek has no hold field');
    page.deliver({ ...seek, seq: 3, from: 'p1', ts: { recv: NOW + 5_000 } });
    const state = page.app.playbackState();
    assertEqual(json({ playing: state.playing, positionMs: state.positionMs, atSharedMs: state.atSharedMs, held: state.held }), json({ playing: false, positionMs: TARGET, atSharedMs: seek.payload.atSharedMs, held: false }), 'paused seek maps to an unheld pause at the landing');
    assertEqual(page.app.timeline().playing, false, 'the applied timeline remains paused');
    assertEqual(page.app.timeline().held, false, 'the applied timeline is not held');
    assertEqual(page.count('play'), 0, 'the element never starts');
  });

  await check('P2 tracker playing seek sends hold and applies held pause', async () => {
    const { driver, seek, state } = issueAndApply({ playing: true, held: false, holds: true });
    assertEqual(seek.payload.hold, true, 'playing tracker seek carries hold');
    assertEqual(json(state), json({ playing: false, atSharedMs: seek.payload.atSharedMs, mediaMs: TARGET, held: true }), 'held seek pauses at the landing');
    driver.dispose();
  });

  await check('P3 tracker held seek sends hold and remains held', async () => {
    const { driver, seek, state } = issueAndApply({ playing: false, held: true, holds: true });
    assertEqual(seek.payload.hold, true, 'held tracker seek carries hold');
    assertEqual(json(state), json({ playing: false, atSharedMs: seek.payload.atSharedMs, mediaMs: TARGET, held: true }), 'held seek preserves the held landing');
    driver.dispose();
  });

  await check('P4 no tracker playing seek sends no hold and stays playing', async () => {
    const { driver, seek, state } = issueAndApply({ playing: true, held: false, holds: false });
    assert(!Object.hasOwn(seek.payload, 'hold'), 'non-peer playing seek has no hold field');
    assertEqual(json(state), json({ playing: true, atSharedMs: seek.payload.atSharedMs, mediaMs: TARGET }), 'non-peer seek preserves playing');
    driver.dispose();
  });

  await check('P5 no tracker paused seek sends no hold and stays paused', async () => {
    const { driver, seek, state } = issueAndApply({ playing: false, held: false, holds: false });
    assert(!Object.hasOwn(seek.payload, 'hold'), 'non-peer paused seek has no hold field');
    assertEqual(json(state), json({ playing: false, atSharedMs: seek.payload.atSharedMs, mediaMs: TARGET }), 'non-peer seek preserves paused');
    driver.dispose();
  });
}
