import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, assert, assertEqual, Peer } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer, optionsFromEnv } from '../../../server/room-server.mjs';
import { USAGE_KEYS, usageLine, writeUsageFile } from '../../../server/usage-count.mjs';
import { buildPlaybackOperationEnvelope, buildNameEnvelope, buildChatEnvelope, buildClientEnvelope, TYPE_PLAYBACK_OPERATION } from '../../../public/lib/envelope.mjs';

async function scope(run) {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(path.resolve('.tmp'), 'usage-count-'));
  const servers = [];
  const peers = [];
  let fake = 1000;
  const file = path.join(dir, 'usage.json');
  const boot = (options = {}) => {
    const server = startRoomServer({ port: 0, mediaDir, quiet: true, joinBurst: 1_000_000, usageFile: file, usageFlushMs: 60_000, usageNow: () => fake, ...options });
    servers.push(server);
    return server;
  };
  const join = async (server, room, tabId, role = 'viewer', extra = {}) => {
    const peer = await Peer.open(`ws://127.0.0.1:${await server.ready}/ws`, tabId);
    peers.push(peer);
    const joined = await peer.join({ room, tabId, role, ...extra });
    assertEqual(joined.type, 'joined', 'join accepted');
    return peer;
  };
  try { await run({ dir, file, boot, join, time: (n) => { fake = n; } }); }
  finally {
    for (const peer of peers) peer.close();
    for (const server of servers) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function operation(server, peer, room, body) {
  const holder = server.rooms.get(room).usage.holder;
  const before = holder.counters.applied;
  peer.send(buildPlaybackOperationEnvelope(body));
  const result = await peer.next((e) => e.type === TYPE_PLAYBACK_OPERATION);
  assertEqual(holder.counters.applied, before + 1, `U3 operation ${body.kind} applied`);
  return result.seq;
}

async function create(server, peer, room) {
  return operation(server, peer, room, { kind: 'create', lineage: 'lineage', current: { playing: false, atSharedMs: server.serverNow() - 1, mediaMs: 0 }, previous: null, controlMode: 'open' });
}

async function change(server, peer, room, kind, version) {
  return operation(server, peer, room, { kind, basis: { lineage: 'lineage', version }, atSharedMs: server.serverNow() - 1 });
}

export default async function usageCountSuite() {
  await check('U1 only the totals', () => scope(async ({ file, boot, join }) => {
    const server = boot();
    const host = await join(server, 'u1-room-zebra', 'tabq1', 'host', { name: 'Quillon' });
    const viewer = await join(server, 'u1-room-zebra', 'tabm1', 'viewer', { name: 'Marrow' });
    viewer.send(buildNameEnvelope({ name: 'Moss' }));
    await viewer.next((e) => e.type === 'presence' && e.payload.event === 'name');
    viewer.send(buildChatEnvelope({ text: 'gossamer-lantern' }));
    await viewer.next((e) => e.type === 'chat');
    let version = await create(server, host, 'u1-room-zebra');
    version = await change(server, host, 'u1-room-zebra', 'play', version);
    viewer.send(buildClientEnvelope({ type: 'leave', to: 'server' }));
    await host.next((e) => e.type === 'presence' && e.payload.event === 'leave');
    await server.close();
    const text = fs.readFileSync(file, 'utf8');
    assertEqual(JSON.stringify(Object.keys(JSON.parse(text))), JSON.stringify(USAGE_KEYS), 'ordered keys');
    for (const value of ['u1-room-zebra', 'Quillon', 'Marrow', 'gossamer-lantern', host.clientId, viewer.clientId, 'tabq1', 'tabm1', '127.0.0.1']) assert(!text.includes(value), `contains ${value}`);
  }));

  await check('U2 totals from constructed events', () => scope(async ({ file, boot, join }) => {
    const server = boot();
    const host = await join(server, 'a', 'ha', 'host');
    const va = await join(server, 'a', 'va');
    const vb = await join(server, 'a', 'vb');
    vb.send(buildClientEnvelope({ type: 'leave', to: 'server' }));
    await host.next((e) => e.type === 'presence' && e.payload.event === 'leave');
    await join(server, 'a', 'vb');
    await join(server, 'a', 'va', 'viewer', { secret: va.secret });
    await join(server, 'b', 'hb', 'host');
    const totals = server.usage.totals();
    assertEqual(totals.roomsOpened, 2, 'rooms');
    assertEqual(totals.visits, 4, 'visits');
    assertEqual(totals.largestRoom, 3, 'largest');
    await server.close();
    assertEqual(JSON.stringify(JSON.parse(fs.readFileSync(file))), JSON.stringify(totals), 'persisted totals');
  }));

  await check('U3 only playing time counts', () => scope(async ({ file, boot, join, time }) => {
    let server = boot();
    let host = await join(server, 'a', 'ha', 'host');
    await join(server, 'a', 'va');
    let version = await create(server, host, 'a');
    time(2000); version = await change(server, host, 'a', 'play', version);
    time(5000); await change(server, host, 'a', 'pause', version);
    time(9000); await server.close();
    assertEqual(JSON.parse(fs.readFileSync(file)).watchedMs, 6000, 'paused interval excluded');
    fs.unlinkSync(file);
    time(1000); server = boot();
    host = await join(server, 'b', 'hb', 'host');
    await join(server, 'b', 'vb');
    version = await create(server, host, 'b');
    await change(server, host, 'b', 'play', version);
    time(2000); await join(server, 'b', 'vc');
    time(4000); await server.close();
    assertEqual(JSON.parse(fs.readFileSync(file)).watchedMs, 8000, 'membership intervals');
  }));

  await check('U4 survives a restart', () => scope(async ({ file, boot, join }) => {
    let server = boot();
    await join(server, 'a', 'a', 'host'); await join(server, 'a', 'b');
    await server.close();
    const since = JSON.parse(fs.readFileSync(file)).since;
    server = boot(); await join(server, 'b', 'c', 'host'); await server.close();
    const totals = JSON.parse(fs.readFileSync(file));
    assertEqual(totals.visits, 3, 'visits'); assertEqual(totals.roomsOpened, 2, 'rooms'); assertEqual(totals.since, since, 'since');
  }));

  await check('U5 refuses an unreadable file', () => scope(async ({ dir }) => {
    const valid = { since: '2026-11-02', roomsOpened: 0, visits: 0, largestRoom: 0, watchedMs: 0 };
    for (const [i, content] of ['not json', JSON.stringify({ ...valid, room: 'x' }), JSON.stringify({ ...valid, watchedMs: -1 })].entries()) {
      const file = path.join(dir, `${i}.json`); fs.writeFileSync(file, content);
      let error; try { startRoomServer({ port: 0, mediaDir, quiet: true, usageFile: file }); } catch (e) { error = e; }
      assert(error instanceof TypeError && error.message.includes('APP_USAGE_FILE'), 'reject invalid file');
      assertEqual(fs.readFileSync(file, 'utf8'), content, 'unchanged');
    }
  }));

  await check('U6 off by default', () => scope(async ({ dir, boot, join }) => {
    assertEqual(optionsFromEnv({}).usageFile, null, 'unset');
    assertEqual(optionsFromEnv({ APP_USAGE_FILE: '' }).usageFile, null, 'empty');
    const before = fs.readdirSync(process.cwd()).sort();
    const server = boot({ usageFile: null });
    assertEqual(server.usage, null, 'off');
    const host = await join(server, 'a', 'a', 'host');
    host.send(buildPlaybackOperationEnvelope({ kind: 'create', lineage: 'l', current: { playing: true, atSharedMs: server.serverNow() - 1, mediaMs: 0 }, previous: null, controlMode: 'open' }));
    await host.next((e) => e.type === TYPE_PLAYBACK_OPERATION);
    host.send(buildClientEnvelope({ type: 'leave', to: 'server' }));
    await server.close();
    assertEqual(JSON.stringify(fs.readdirSync(process.cwd()).sort()), JSON.stringify(before), 'no new working directory entries');
    assertEqual(fs.readdirSync(dir).length, 0, 'no file');
  }));

  await check('U7 the sentence', () => scope(async ({ file, dir }) => {
    const totals = { since: '2026-11-02', roomsOpened: 3, visits: 7, largestRoom: 4, watchedMs: 5_400_000 };
    const line = '3 rooms, 7 visits, 1.5 hours watched since 2026-11-02 (largest room 4)';
    assertEqual(usageLine(totals), line, 'sentence'); writeUsageFile(file, totals);
    const good = spawnSync(process.execPath, ['scripts/usage-line.mjs', file], { encoding: 'utf8' });
    assertEqual(good.status, 0, 'valid exit'); assertEqual(good.stdout.trim(), line, 'valid output');
    assertEqual(spawnSync(process.execPath, ['scripts/usage-line.mjs', path.join(dir, 'missing')]).status, 1, 'missing exit');
  }));

  await check('U8 write failure does not stop counting', () => scope(async ({ file, boot, join }) => {
    const lines = [];
    const server = boot({ quiet: false, logSink: (line) => lines.push(line) });
    fs.mkdirSync(`${file}.tmp`);
    await join(server, 'a', 'a', 'host');
    assertEqual(server.usage.totals().visits, 1, 'visit counted');
    assert(lines.some((line) => line.includes('usage write failed')), 'write failure logged');
  }));
}
