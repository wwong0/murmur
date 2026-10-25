import { assert, assertEqual, check, Peer, sleep } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { createKeyedAllowances } from '../../../server/member-sends.mjs';
import { ERROR_CODES, TYPE_ERROR } from '../../../public/lib/envelope.mjs';

async function withServer(options, fn) {
  const local = startRoomServer({
    port: 0,
    mediaDir,
    quiet: true,
    envelopeBurst: 1000,
    ...options,
  });
  try {
    return await fn(local, `ws://127.0.0.1:${await local.ready}/ws`);
  } finally {
    await local.close();
  }
}

const rateLimited = (env) => env.type === TYPE_ERROR && env.payload.code === ERROR_CODES.RATE_LIMITED;

export default async function joinAllowanceSuite() {
  await check('join allowance: the fourth new membership is refused and its empty room is reaped', async () => {
    await withServer({ joinBurst: 3, joinRefillMs: 100_000 }, async (local, url) => {
      const peers = [];
      try {
        for (let i = 0; i < 3; i++) {
          const peer = await Peer.open(url, `join-${i}`);
          peers.push(peer);
          await peer.join({ room: 'join-limit', tabId: `tab-${i}`, role: 'viewer' });
        }
        const refused = await Peer.open(url, 'join-refused');
        peers.push(refused);
        const result = await refused.join({ room: 'join-limit', tabId: 'tab-3', role: 'viewer' });
        assert(rateLimited(result), 'fourth membership is rate-limited');
        assertEqual(result.payload.detail, 'too many new memberships from this address', 'join refusal detail');
        assert(!refused.closed, 'join refusal keeps the socket open');

        const empty = await Peer.open(url, 'empty-refused');
        peers.push(empty);
        const emptyResult = await empty.join({ room: 'empty-limit', tabId: 'tab', role: 'viewer' });
        assert(rateLimited(emptyResult), 'empty room join is rate-limited');
        assert(!local.rooms.has('empty-limit'), 'refused empty room is reaped');
      } finally {
        for (const peer of peers) peer.close();
      }
    });
  });

  await check('join allowance: a reclaim does not spend the address bucket', async () => {
    await withServer({ joinBurst: 1, joinRefillMs: 100_000 }, async (_local, url) => {
      const a = await Peer.open(url, 'host-original');
      const b = await Peer.open(url, 'host-reclaim');
      try {
        const joined = await a.join({ room: 'reclaim-join', tabId: 'host', role: 'host' });
        const reclaimed = await b.join({ room: 'reclaim-join', tabId: 'different', role: 'viewer', secret: joined.payload.secret });
        assertEqual(reclaimed.type, 'joined', 'reclaim succeeds after the bucket is spent');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('join allowance: trusted proxy uses the last forwarded address', async () => {
    await withServer({ joinBurst: 1, joinRefillMs: 100_000, trustedProxy: true }, async (_local, url) => {
      const a = await Peer.open(url, 'proxy-a', { headers: { 'x-forwarded-for': 'forged-a, 10.0.0.1' } });
      const b = await Peer.open(url, 'proxy-b', { headers: { 'x-forwarded-for': 'forged-b, 10.0.0.2' } });
      const c = await Peer.open(url, 'proxy-forged-first', { headers: { 'x-forwarded-for': 'forged-c, 10.0.0.2' } });
      try {
        assertEqual((await a.join({ room: 'proxy-a', tabId: 'a', role: 'viewer' })).type, 'joined', 'first proxy address joins');
        assertEqual((await b.join({ room: 'proxy-b', tabId: 'b', role: 'viewer' })).type, 'joined', 'second proxy address joins');
        const reused = await c.join({ room: 'proxy-c', tabId: 'c', role: 'viewer' });
        assert(rateLimited(reused), 'same last forwarded address is reused');
      } finally {
        a.close();
        b.close();
        c.close();
      }
    });
  });

  await check('join allowance: without a trusted proxy, forwarded values do not split one peer', async () => {
    await withServer({ joinBurst: 1, joinRefillMs: 100_000 }, async (_local, url) => {
      const a = await Peer.open(url, 'untrusted-a', { headers: { 'x-forwarded-for': '10.0.0.1' } });
      const b = await Peer.open(url, 'untrusted-b', { headers: { 'x-forwarded-for': '10.0.0.2' } });
      try {
        assertEqual((await a.join({ room: 'untrusted-a', tabId: 'a', role: 'viewer' })).type, 'joined', 'socket address joins');
        assert(rateLimited(await b.join({ room: 'untrusted-b', tabId: 'b', role: 'viewer' })), 'forwarded value is ignored');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('join allowance: the configured refill admits one new membership', async () => {
    await withServer({ joinBurst: 1, joinRefillMs: 35 }, async (_local, url) => {
      const a = await Peer.open(url, 'refill-join-a');
      const b = await Peer.open(url, 'refill-join-b');
      try {
        assertEqual((await a.join({ room: 'refill-join-a', tabId: 'a', role: 'viewer' })).type, 'joined', 'first join');
        await sleep(45);
        assertEqual((await b.join({ room: 'refill-join-b', tabId: 'b', role: 'viewer' })).type, 'joined', 'join after configured refill');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('join allowance: settings are positive and options are exposed', async () => {
    await withServer({ joinBurst: 7, joinRefillMs: 13 }, async (local) => {
      assertEqual(local.joinBurst, 7, 'configured join burst');
      assertEqual(local.joinRefillMs, 13, 'configured join refill');
    });
    for (const bad of [{ joinBurst: 0 }, { joinRefillMs: 0 }, { joinBurst: 1.5 }, { joinRefillMs: '5' }]) {
      let error;
      try {
        startRoomServer({ port: 0, mediaDir, quiet: true, ...bad });
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof TypeError, `${JSON.stringify(bad)} is rejected`);
      assert(error.message.includes(bad.joinBurst !== undefined ? 'APP_JOIN_BURST' : 'APP_JOIN_REFILL_MS'), `${JSON.stringify(bad)} names its setting`);
    }
  });

  await check('join allowance: keyed allowances are separate and a sweep forgets only full ones', async () => {
    const rule = { burst: 2, refillMs: 100 };
    const keyed = createKeyedAllowances(rule);
    assert(keyed.spend('a', 0) && keyed.spend('a', 0), 'a full burst for a new key');
    assert(!keyed.spend('a', 0), 'past the burst is refused');
    assert(keyed.spend('b', 0), 'another key has its own burst');
    keyed.sweep(100);
    assert(keyed.spend('a', 100), 'one token refilled');
    assert(!keyed.spend('a', 100), 'the sweep kept the part-spent key, so no fresh burst');
    keyed.sweep(1_000);
    assert(keyed.spend('a', 1_000) && keyed.spend('a', 1_000) && !keyed.spend('a', 1_000), 'a refilled key starts again from one burst');
  });
}
