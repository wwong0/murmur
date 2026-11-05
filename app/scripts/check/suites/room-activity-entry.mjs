// The people and activity view values, through the real entry.

import { assert, assertEqual, check } from '../harness.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

const LINEAGE = 'activity-lineage';
const HOST = { clientId: 'c1', tabId: 'th', role: 'host', joinedAt: 1 };
const V2 = { clientId: 'c2', tabId: 'tv2', role: 'viewer', joinedAt: 2 };
const V3 = { clientId: 'c3', tabId: 'tv3', role: 'viewer', joinedAt: 3 };

const lines = (page) => page.view().activity.map((entry) => entry.text);
const json = (value) => JSON.stringify(value);

function presence(event, member, roster, { seq = 3, from = 'server' } = {}) {
  return { type: 'presence', from, seq, ts: { recv: 10_005 }, payload: { event, member, roster } };
}

function operation(lineage, from, seq, kind, basisVersion, atSharedMs, extra = {}) {
  return {
    type: 'playback-operation', from, seq, ts: { recv: atSharedMs },
    payload: { kind, basis: { lineage, version: basisVersion }, atSharedMs, ...extra },
  };
}

// The sole host, whose creation plays from `t0`.
function hostRoom(code) {
  const page = runEntry(code);
  page.resolveSole({ nowMs: 10_000 });
  const create = page.sent().find((env) => env.payload?.kind === 'create');
  return { page, t0: create.payload.current.atSharedMs, lineage: page.app.timeline().identity.lineage };
}

// A viewer (c2) in a room whose host (c1) created a playing state at 10 000.
function viewerRoom(code, roster = [HOST, V2]) {
  const page = runEntry(code, { role: 'viewer', search: '?room=r&tab=tv2' });
  page.harness.sharedNowMs = 10_000;
  page.emit('joined', { clientId: 'c2', role: 'viewer', seq: 1, roster });
  page.deliver({
    type: 'playback-operation', from: 'c1', seq: 2, ts: { recv: 10_001 },
    payload: { kind: 'create', lineage: LINEAGE, current: { playing: true, atSharedMs: 10_000, mediaMs: 0 }, previous: null, controlMode: 'open' },
  });
  return page;
}

export default async function roomActivityEntrySuite() {
  const product = await bundleProductEntry();

  await check('room-activity-entry: before any roster there are no people and no lines', async () => {
    const page = runEntry(product.code);
    assertEqual(json(page.view().people), '[]', 'no people yet');
    assertEqual(json(page.view().activity), '[]', 'no activity yet');
  });

  await check('room-activity-entry: the server\'s join and leave write lines, a leaver labelled from the roster before', async () => {
    const { page } = hostRoom(product.code);
    assertEqual(json(page.view().people.map((p) => p.label)), json(['Host']), 'the joined roster is the sole host');
    assertEqual(lines(page).length, 0, 'the page\'s own join writes no line');

    page.deliver(presence('join', V2, [HOST, V2], { seq: 3 }));
    page.deliver(presence('join', V3, [HOST, V2, V3], { seq: 4 }));
    assertEqual(json(lines(page)), json(['Guest 1 joined', 'Guest 2 joined']), 'a joiner is labelled from the roster that holds them');

    page.deliver(presence('leave', V2, [HOST, V3], { seq: 5 }));
    assertEqual(lines(page).at(-1), 'Guest 1 left', 'the leaver is the Guest 1 of the roster before the leave');
    assertEqual(json(page.view().people.map((p) => [p.clientId, p.label])), json([['c1', 'Host'], ['c3', 'Guest 1']]), 'the remaining guest takes the lower number');
    assertEqual(json(page.view().roster), json(['th · host · c1', 'tv3 · viewer · c3']), '#roster keeps its identifier strings');

    page.deliver(presence('leave', HOST, [V3], { seq: 6 }));
    assertEqual(lines(page).at(-1), 'Host left', 'the host leaving is named');
    assertEqual(lines(page).length, 4, 'one line per event');
  });

  await check('room-activity-entry: this page\'s own join and a relayed presence write nothing', async () => {
    const { page } = hostRoom(product.code);
    page.deliver(presence('join', HOST, [HOST], { seq: 3 }));
    assertEqual(lines(page).length, 0, 'the server\'s join of this very member');
    page.deliver(presence('join', V2, [HOST], { seq: 4, from: 'c3' }));
    page.deliver(presence('leave', HOST, [HOST], { seq: 5, from: 'c3' }));
    assertEqual(lines(page).length, 0, 'a member can relay an envelope typed presence; only the server\'s counts');
  });

  await check('room-activity-entry: applied play, pause and seek are labelled by their sender, a pause with the state\'s position', async () => {
    const { page, t0, lineage } = hostRoom(product.code);
    page.deliver(presence('join', V2, [HOST, V2], { seq: 3 }));

    page.deliver(operation(lineage, 'c2', 4, 'pause', 2, t0 + 41_000));
    assertEqual(lines(page).at(-1), 'Guest 1 paused at 0:41', 'the pause is at the position the delivered state implies');
    page.deliver(operation(lineage, 'c2', 5, 'play', 4, t0 + 100_000));
    assertEqual(lines(page).at(-1), 'Guest 1 played', 'a play');
    page.deliver(operation(lineage, 'c1', 6, 'pause', 5, t0 + 142_000));
    assertEqual(lines(page).at(-1), 'Host paused at 1:23', 'a different position gives a different line (41 s + 42 s)');
    page.deliver(operation(lineage, 'c2', 7, 'seek', 6, t0 + 150_000, { positionMs: 125_000 }));
    assertEqual(lines(page).at(-1), 'Guest 1 skipped to 2:05', 'a seek carries its own position');
    assertEqual(lines(page).length, 5, 'one line per applied operation after the join');
    assert(page.view().activity.every((entry) => entry.warn === false), 'none of them is a warning');
  });

  await check('room-activity-entry: the end pause writes "The film ended", not a member line', async () => {
    const { page, t0, lineage } = hostRoom(product.code);
    page.harness.last = { mediaEndMs: 60_000 };
    page.deliver(operation(lineage, 'c1', 3, 'pause', 2, t0 + 60_000));
    assertEqual(page.view().ended, true, 'the title is at its end');
    assertEqual(json(lines(page)), json(['The film ended']), 'one line, and it is not the host\'s');
  });

  await check('room-activity-entry: a pause applied while the roster holds no host (the grace pause) writes nothing', async () => {
    const page = viewerRoom(product.code);
    page.deliver(presence('leave', HOST, [V2], { seq: 3 }));
    assertEqual(json(lines(page)), json(['Host left']), 'the host\'s leaving is the only line');
    page.deliver(operation(LINEAGE, 'c2', 4, 'pause', 2, 20_000));
    assertEqual(page.app.timeline().playing, false, 'the pause was applied');
    assertEqual(json(lines(page)), json(['Host left']), 'and says nothing more');
  });

  await check('room-activity-entry: this member\'s stale operation writes nothing but keeps its notice', async () => {
    const page = viewerRoom(product.code);
    page.deliver(operation(LINEAGE, 'c2', 3, 'pause', 99, 20_000));
    assertEqual(page.app.timeline().playing, true, 'the stale pause was not applied');
    assertEqual(lines(page).length, 0, 'no activity line');
    assert(page.notices().some((text) => text.includes('your pause was rejected: stale')), 'the stamped notice stays');
  });

  await check('room-activity-entry: this member\'s notPermitted refusal writes a warning line and keeps its notice', async () => {
    const page = viewerRoom(product.code);
    page.deliver({ type: 'playback-operation', from: 'c1', seq: 3, ts: { recv: 10_002 }, payload: { kind: 'control-mode', basis: { lineage: LINEAGE, version: 2 }, controlMode: 'host' } });
    assertEqual(page.app.timeline().controlMode, 'host', 'the room is host-only');

    page.deliver(operation(LINEAGE, 'c2', 4, 'pause', 3, 20_000));
    page.deliver(operation(LINEAGE, 'c2', 5, 'seek', 3, 20_000, { positionMs: 5_000 }));
    assertEqual(json(page.view().activity.map(({ text, warn }) => [text, warn])), json([
      ['Your pause was refused — host only', true],
      ['Your skip was refused — host only', true],
    ]), 'the refusals are warnings, a seek named as a skip');
    assert(page.notices().some((text) => text.includes('your pause was rejected: notPermitted')), 'the stamped notice stays');
  });

  await check('room-activity-entry: another member\'s refusal says nothing to this member', async () => {
    const page = viewerRoom(product.code, [HOST, V2, V3]);
    page.deliver({ type: 'playback-operation', from: 'c1', seq: 3, ts: { recv: 10_002 }, payload: { kind: 'control-mode', basis: { lineage: LINEAGE, version: 2 }, controlMode: 'host' } });
    page.deliver(operation(LINEAGE, 'c3', 4, 'pause', 3, 20_000));
    assertEqual(lines(page).length, 0, 'c3\'s refused pause is not this member\'s');
  });

  await check('room-activity-entry: a disconnect after a connect says Reconnecting…, the next connect Reconnected, the first connect nothing', async () => {
    const page = runEntry(product.code);
    page.emit('status', { connected: true });
    assertEqual(lines(page).length, 0, 'the first connect');
    page.emit('status', { connected: false });
    page.emit('status', { connected: false });
    assertEqual(json(lines(page)), json(['Reconnecting…']), 'a second disconnect adds nothing');
    page.emit('status', { connected: true });
    assertEqual(json(lines(page)), json(['Reconnecting…', 'Reconnected']), 'the next connect');
    page.emit('status', { connected: false, superseded: true });
    assertEqual(lines(page).length, 2, 'a page that will not reconnect does not say it is trying');
  });

  await check('room-activity-entry: a disconnect before any connect says nothing', async () => {
    const page = runEntry(product.code);
    page.emit('status', { connected: false });
    page.emit('status', { connected: true });
    assertEqual(lines(page).length, 0, 'neither a lost first attempt nor the connect after it');
  });

  await check('room-activity-entry: the list keeps the newest hundred, with distinct ascending ids', async () => {
    const page = runEntry(product.code);
    page.emit('status', { connected: true });
    for (let cycle = 0; cycle < 60; cycle += 1) {
      page.emit('status', { connected: false });
      page.emit('status', { connected: true });
    }
    const activity = page.view().activity;
    assertEqual(activity.length, 100, 'capped');
    assertEqual(activity.at(-1).text, 'Reconnected', 'the newest is last');
    const ids = activity.map((entry) => entry.id);
    assert(ids.every((id, index) => index === 0 || id > ids[index - 1]), 'ids ascend, so they are unique keys');
    assertEqual(ids.at(-1) - ids[0], 99, 'the hundred are the latest hundred');
  });
}
