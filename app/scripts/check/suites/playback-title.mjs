import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';
import { createPlaybackAcquisition } from '../../../public/lib/playback-acquisition.mjs';
import { createPlaybackStateHolder, readPlaybackState } from '../../../public/lib/playback-state.mjs';

const TITLE_A = `v1:${'a'.repeat(64)}`;
const TITLE_B = `v1:${'b'.repeat(64)}`;
const BASE = Object.freeze({
  lineage: 'lineage-title',
  version: 10,
  current: { playing: true, atSharedMs: 300_000, mediaMs: 120_000 },
  previous: null,
  controlMode: 'open',
  title: TITLE_A,
});
const HOST_ROSTER = Object.freeze([
  { clientId: 'H', tabId: 'h', role: 'host', joinedAt: 1 },
  { clientId: 'V', tabId: 'v', role: 'viewer', joinedAt: 2 },
]);

function env(seq, from, recv, payload) {
  return { seq, from, ts: { recv }, payload };
}

function operation(seq, from, recv, kind, basis, extra = {}) {
  return env(seq, from, recv, { kind, basis, ...extra });
}

function titleOperation(seq, from, recv, basis, title = TITLE_B, atSharedMs = recv) {
  return operation(seq, from, recv, 'title', basis, { atSharedMs, title });
}

function makeHolder(state = BASE, maxFutureMs = 10_000) {
  const holder = createPlaybackStateHolder({ maxFutureMs });
  holder.adopt(state);
  return holder;
}

function outcome(holder, message, expected, roster = HOST_ROSTER) {
  assertEqual(holder.apply(message, roster).outcome, expected, `${message.payload.kind} outcome`);
}

function creation(seq, from, recv, state, title = undefined) {
  return env(seq, from, recv, {
    kind: 'create',
    lineage: state.lineage,
    current: state.current,
    previous: state.previous,
    controlMode: state.controlMode,
    ...(title === undefined ? {} : { title }),
  });
}

function fakeClient(clientId, role) {
  const events = new Map();
  const handlers = new Map();
  const sent = [];
  const add = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  return {
    clientId,
    role,
    sent,
    send(message) { sent.push(message); },
    request() { return new Promise(() => {}); },
    onEvent(type, fn) { add(events, type, fn); return () => {}; },
    on(type, fn) { add(handlers, type, fn); return () => {}; },
    emit(type, value) { for (const fn of events.get(type) ?? []) fn(value); },
    deliver(message) { for (const fn of handlers.get(message.type) ?? []) fn(message); },
  };
}

function acquireSole({ clientId = 'H', role = 'host' } = {}) {
  let now = 10_000;
  const client = fakeClient(clientId, role);
  const driver = createPlaybackAcquisition({
    client,
    clock: { sharedNow: () => now },
    settings: { transitionLeadMs: 100, maxFutureMs: 1_000, autoStart: () => false },
    mintLineage: () => `lineage-${clientId}`,
  });
  client.emit('joined', {
    clientId,
    seq: 1,
    roster: [{ clientId, tabId: clientId, role, joinedAt: 1 }],
  });
  const first = client.sent.find((message) => message.payload?.kind === 'create');
  if (!first) throw new Error('sole client did not issue creation');
  client.deliver({ ...first, seq: 2, from: clientId, ts: { recv: now } });
  return {
    client,
    driver,
    get now() { return now; },
    set now(value) { now = value; },
  };
}

export default async function playbackTitleSuite() {
  await check('playback title: viewer title is notPermitted in open and host modes', async () => {
    for (const controlMode of ['open', 'host']) {
      const state = { ...BASE, controlMode };
      const holder = makeHolder(state);
      const before = JSON.stringify(holder.state);
      outcome(holder, titleOperation(11, 'V', 300_000, { lineage: state.lineage, version: state.version }), 'notPermitted');
      assertEqual(JSON.stringify(holder.state), before, `${controlMode} viewer title leaves state unchanged`);
    }
  });

  await check('playback title: a host title pauses two holders at zero and keeps mode', async () => {
    for (const controlMode of ['open', 'host']) {
      const state = { ...BASE, controlMode };
      const holders = [makeHolder(state), makeHolder(state)];
      const message = titleOperation(11, 'H', 300_000, { lineage: state.lineage, version: state.version }, TITLE_B, 301_000);
      for (const holder of holders) {
        outcome(holder, message, 'applied');
        assertEqual(JSON.stringify(holder.state.current), JSON.stringify({
          playing: false, atSharedMs: 301_000, mediaMs: 0,
        }), `${controlMode} title resets current`);
        assert(!Object.hasOwn(holder.state.current, 'held'), `${controlMode} title is not held`);
        assertEqual(JSON.stringify(holder.state.previous), JSON.stringify(state.current), `${controlMode} title keeps previous`);
        assertEqual(holder.state.title, TITLE_B, `${controlMode} title identity is carried`);
        assertEqual(holder.state.controlMode, controlMode, `${controlMode} remains unchanged`);
        assertEqual(holder.state.version, 11, `${controlMode} version follows sequence`);
      }
    }
  });

  await check('playback title: a held state becomes an unheld paused title', async () => {
    const state = {
      ...BASE,
      current: { playing: false, atSharedMs: 300_000, mediaMs: 90_000, held: true },
    };
    const holder = makeHolder(state);
    outcome(holder, titleOperation(11, 'H', 300_000, { lineage: state.lineage, version: state.version }), 'applied');
    assertEqual(holder.state.current.playing, false, 'held title remains paused');
    assertEqual(holder.state.current.mediaMs, 0, 'held title resets media position');
    assert(!Object.hasOwn(holder.state.current, 'held'), 'title clears held');
  });

  await check('playback title: regular transitions retain the title', async () => {
    const holder = makeHolder();
    const basis = { lineage: BASE.lineage, version: BASE.version };
    outcome(holder, titleOperation(11, 'H', 300_000, basis, TITLE_B, 301_000), 'applied');
    outcome(holder, operation(12, 'H', 302_000, 'play', { lineage: BASE.lineage, version: 11 }, { atSharedMs: 303_000 }), 'applied');
    outcome(holder, operation(13, 'H', 304_000, 'pause', { lineage: BASE.lineage, version: 12 }, { atSharedMs: 305_000 }), 'applied');
    outcome(holder, operation(14, 'H', 306_000, 'seek', { lineage: BASE.lineage, version: 13 }, { atSharedMs: 306_000, positionMs: 4_000 }), 'applied');
    outcome(holder, operation(15, 'H', 307_000, 'control-mode', { lineage: BASE.lineage, version: 14 }, { controlMode: 'host' }), 'applied');
    assertEqual(holder.state.title, TITLE_B, 'play, pause, seek and mode retain title B');
    assertEqual(holder.state.controlMode, 'host', 'control mode still applies after title');
  });

  await check('playback title: malformed title operations and state titles are rejected', async () => {
    const cases = [
      titleOperation(11, 'H', 300_000, { lineage: BASE.lineage, version: BASE.version }, 'v1:not-an-identity'),
      operation(12, 'H', 300_000, 'title', {}, { atSharedMs: 300_000, title: TITLE_B }),
      operation(13, 'H', 300_000, 'title', { lineage: BASE.lineage, version: BASE.version }, { atSharedMs: 300_000, title: 42 }),
      titleOperation(14, 'H', 300_000, { lineage: BASE.lineage, version: BASE.version }, TITLE_B, 310_001),
    ];
    for (const [index, message] of cases.entries()) {
      const holder = makeHolder(BASE, 10_000);
      outcome(holder, message, 'malformed');
      assertEqual(holder.state.version, BASE.version, `malformed case ${index} leaves version`);
    }
    assert(readPlaybackState({ ...BASE, title: TITLE_B })?.title === TITLE_B, 'a valid state title is readable');
    assert(readPlaybackState({ ...BASE, title: 'v1:bad' }) === null, 'a malformed state title is rejected');
    assert(readPlaybackState({ ...BASE, title: null }) === null, 'a null state title is rejected');
  });

  await check('playback title: creation carries a title only when proposed', async () => {
    const withTitle = createPlaybackStateHolder({ maxFutureMs: 1_000 });
    withTitle.expectCreation();
    outcome(withTitle, creation(2, 'H', 300_000, { ...BASE, title: undefined }, TITLE_B), 'applied');
    assertEqual(withTitle.state.title, TITLE_B, 'creation carries proposal title');

    const withoutTitle = createPlaybackStateHolder({ maxFutureMs: 1_000 });
    withoutTitle.expectCreation();
    const noTitleState = { ...BASE, title: undefined };
    outcome(withoutTitle, creation(2, 'H', 300_000, noTitleState), 'applied');
    assert(!Object.hasOwn(withoutTitle.state, 'title'), 'fresh creation omits title');
    assertEqual(JSON.stringify(withoutTitle.state), JSON.stringify({
      lineage: noTitleState.lineage,
      version: 2,
      current: noTitleState.current,
      previous: null,
      controlMode: noTitleState.controlMode,
    }), 'creation without title keeps existing JSON shape');
  });

  await check('playback title: acquisition issues host titles and carries a proposed title into creation', async () => {
    const host = acquireSole();
    try {
      assertEqual(host.driver.permitted('title'), true, 'host may issue title');
      host.now = 10_200;
      assertEqual(host.driver.issue('title', { title: TITLE_B }), true, 'host title issue succeeds');
      const titleMessage = host.client.sent.find((message) => message.payload?.kind === 'title');
      assert(titleMessage, 'title operation was sent');
      assertEqual(titleMessage.payload.atSharedMs, 10_300, 'title uses transition lead');
      assertEqual(titleMessage.payload.title, TITLE_B, 'title payload carries identity');
      host.client.deliver({ ...titleMessage, seq: 3, from: 'H', ts: { recv: host.now } });
      host.client.emit('joined', {
        clientId: 'H', seq: 4, roster: [{ clientId: 'H', tabId: 'H', role: 'host', joinedAt: 1 }],
      });
      const recreated = host.client.sent.filter((message) => message.payload?.kind === 'create').at(-1);
      assertEqual(recreated.payload.title, TITLE_B, 'recreation carries the proposed title');
    } finally {
      host.driver.dispose();
    }

    const fresh = acquireSole({ clientId: 'V', role: 'viewer' });
    try {
      assertEqual(fresh.driver.permitted('title'), false, 'viewer cannot issue title');
      const created = fresh.client.sent.find((message) => message.payload?.kind === 'create');
      assert(!Object.hasOwn(created.payload, 'title'), 'fresh creation has no title');
    } finally {
      fresh.driver.dispose();
    }
  });

  const product = await bundleProductEntry();

  await check('playback title: automatic-start entry receives title without playing', async () => {
    const page = runEntry(product.code, {
      role: 'host',
      settings: {
        delivery: 'host', trackerUrl: null, iceServers: [], mediaSource: 'file', autoStart: true,
      },
    });
    await page.settled();
    const before = page.resolveSole({ clientId: 'entry-title', nowMs: 10_000 });
    assertEqual(before.playing, true, 'automatic-start creation begins playing');
    const playback = page.app.playbackState();
    page.deliver({
      type: 'playback-operation',
      from: 'entry-title',
      seq: playback.version + 1,
      ts: { recv: playback.atSharedMs },
      payload: {
        kind: 'title',
        basis: { lineage: playback.lineage, version: playback.version },
        atSharedMs: playback.atSharedMs,
        title: TITLE_B,
      },
    });
    page.harness.sharedNowMs = playback.atSharedMs + 5_000;
    for (let index = 0; index < 8; index += 1) page.tick();
    assertEqual(page.app.timeline().playing, false, 'title leaves the entry timeline paused');
    assertEqual(page.app.playback().playing, false, 'the start reducer reports paused');
    assertEqual(page.app.playbackState().positionMs, 0, 'title starts at zero');
    assertEqual(page.count('play'), 0, 'title never calls element play');
  });
}
