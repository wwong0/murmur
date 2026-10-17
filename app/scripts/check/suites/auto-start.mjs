import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { optionsFromEnv } from '../../../server/room-server.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';

const NOW = 10_000;
const LEAD = 100;

function fakeClient(clientId = 'c1') {
  const events = new Map();
  const handlers = new Map();
  const sent = [];
  const add = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  return {
    clientId,
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

function acquire({ autoStart, holds, nowMs = NOW } = {}) {
  const client = fakeClient();
  const driver = createPlaybackAcquisition({
    client,
    clock: { sharedNow: () => nowMs },
    settings: {
      transitionLeadMs: LEAD,
      maxFutureMs: 1_000,
      autoStart: typeof autoStart === 'function' ? autoStart : () => autoStart,
      holds: () => holds,
    },
    mintLineage: () => 'lineage-auto-start',
  });
  client.emit('joined', { clientId: 'c1', seq: 1, roster: [{ clientId: 'c1', role: 'host', tabId: 't', joinedAt: 1 }] });
  const creation = client.sent.find((entry) => entry.payload?.kind === 'create');
  assert(creation, 'the sole member issues a creation');
  client.deliver({ ...creation, seq: 1, from: 'c1', ts: { recv: nowMs } });
  return { client, driver, creation };
}

export default async function autoStartSuite() {
  await check('A1 auto-start off without a tracker creates paused at zero and not held', async () => {
    const { driver } = acquire({ autoStart: false, holds: false });
    assertEqual(JSON.stringify(driver.state.current), JSON.stringify({ playing: false, atSharedMs: NOW + LEAD, mediaMs: 0 }), 'off creation is paused at zero');
    assert(!Object.hasOwn(driver.state.current, 'held'), 'off creation has no held key');
    assertEqual(driver.state.version, 1, 'off creation starts at version one');
    driver.dispose();
  });

  await check('A2 auto-start off with a tracker still creates paused and not held', async () => {
    const { driver } = acquire({ autoStart: false, holds: true });
    assertEqual(JSON.stringify(driver.state.current), JSON.stringify({ playing: false, atSharedMs: NOW + LEAD, mediaMs: 0 }), 'tracker does not override the product default');
    assert(!Object.hasOwn(driver.state.current, 'held'), 'off creation with tracker has no held key');
    driver.dispose();
  });

  await check('A3 auto-start on with a tracker creates paused and held', async () => {
    const { driver } = acquire({ autoStart: true, holds: true });
    assertEqual(JSON.stringify(driver.state.current), JSON.stringify({ playing: false, atSharedMs: NOW + LEAD, mediaMs: 0, held: true }), 'tracker creation is held at zero');
    driver.dispose();
  });

  await check('A4 auto-start on without a tracker creates playing from zero', async () => {
    const { driver } = acquire({ autoStart: true, holds: false });
    assertEqual(JSON.stringify(driver.state.current), JSON.stringify({ playing: true, atSharedMs: NOW + LEAD, mediaMs: 0 }), 'non-peer creation is playing');
    driver.dispose();
  });

  await check('A5 auto-start off with an earlier playing state copies its mappings', async () => {
    let on = true;
    const first = acquire({ autoStart: () => on, holds: false });
    const earlier = JSON.stringify(first.driver.state.current);
    assert(first.driver.state.current.playing === true, 'the earlier state is playing');
    on = false;
    first.client.emit('joined', { clientId: 'c1', seq: 3, roster: [{ clientId: 'c1', role: 'host', tabId: 't', joinedAt: 1 }] });
    const creations = first.client.sent.filter((entry) => entry.payload?.kind === 'create');
    assertEqual(creations.length, 2, 'the rejoin issues a second creation');
    assertEqual(JSON.stringify(creations.at(-1).payload.current), earlier, 'with the setting off, the rejoin creation carries the earlier playing mapping');
    first.driver.dispose();
  });

  const product = await bundleProductEntry();

  await check('A6 entry-level auto-start off does not play and leaves play enabled', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      settings: { delivery: 'host', trackerUrl: null, iceServers: [], autoStart: false },
    });
    await page.settled();
    page.resolveSole({ clientId: 'entry-off', nowMs: NOW });
    // Past the creation's instant: inside the scheduled lead both buttons are disabled.
    page.harness.sharedNowMs = NOW + 5_000;
    for (let index = 0; index < 8; index += 1) page.tick();
    const creation = page.sent().find((entry) => entry.payload?.kind === 'create');
    assertEqual(creation.payload.current.playing, false, 'the page creates paused');
    assertEqual(page.app.timeline().playing, false, 'the applied state is paused');
    assertEqual(page.count('play'), 0, 'no element play() is recorded');
    assertEqual(page.view().controls.play.disabled, false, 'play is enabled for a paused creation');
  });

  await check('A7 APP_AUTO_START accepts unset and 1 but rejects true', async () => {
    assertEqual(optionsFromEnv({}).autoStart, false, 'unset auto-start is false');
    assertEqual(optionsFromEnv({ APP_AUTO_START: '' }).autoStart, false, 'empty auto-start is false');
    assertEqual(optionsFromEnv({ APP_AUTO_START: '1' }).autoStart, true, '1 enables auto-start');
    let error = null;
    try { optionsFromEnv({ APP_AUTO_START: 'true' }); } catch (caught) { error = caught; }
    assert(error instanceof TypeError, 'true is rejected as a TypeError');
    assertEqual(error?.message, 'APP_AUTO_START must be 1 or unset', 'invalid auto-start names the accepted values');
  });

  await check('A8 entry-level non-boolean auto-start reports settings unavailable', async () => {
    // A pair that differs only in the field: the valid one must not take the branch.
    const statusWith = async (autoStart) => {
      const page = runEntry(product.code, { settings: { delivery: 'http', iceServers: [], autoStart } });
      await page.settled();
      return page.view().status;
    };
    const valid = await statusWith(true);
    const invalid = await statusWith('yes');
    assert(!valid.startsWith('settings unavailable'), `a boolean auto-start is accepted: ${valid}`);
    assert(invalid.startsWith('settings unavailable'), `a non-boolean auto-start takes the settings-unavailable branch: ${invalid}`);
  });
}
