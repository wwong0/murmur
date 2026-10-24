import { assert, assertEqual, check, Peer, sleep } from '../harness.mjs';
import { mediaDir, server as defaultServer } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import { ADDR_ROOM, buildClientEnvelope, ERROR_CODES, TYPE_ERROR } from '../../../public/lib/envelope.mjs';

const relay = (id, type = `unregistered-${id}`) => buildClientEnvelope({ type, to: ADDR_ROOM, id, payload: {} });
const isError = (env) => env.type === TYPE_ERROR;
const isRelay = (env, id) => env.type === `unregistered-${id}`;

async function withServer(options, fn) {
  const local = startRoomServer({
    port: 0,
    mediaDir,
    quiet: true,
    joinBurst: 1000,
    ...options,
  });
  try {
    return await fn(local, `ws://127.0.0.1:${await local.ready}/ws`);
  } finally {
    await local.close();
  }
}

export default async function envelopeAllowanceSuite() {
  await check('envelope allowance: the available post-join burst is relayed and the next send is refused', async () => {
    await withServer({ envelopeBurst: 4, envelopeRefillMs: 100_000 }, async (local, url) => {
      const a = await Peer.open(url, 'allow-a');
      const b = await Peer.open(url, 'allow-b');
      try {
        await a.join({ room: 'allow-room', tabId: 'a', role: 'host' });
        await b.join({ room: 'allow-room', tabId: 'b', role: 'viewer' });
        const available = local.envelopeBurst - 1;
        const baseSeq = local.rooms.get('allow-room').seq;
        for (let i = 0; i <= available; i++) a.send(relay(`f-${i}`));
        for (let i = 0; i < available; i++) await b.next((env) => isRelay(env, `f-${i}`));
        const refused = await a.next(isError);
        assertEqual(refused.payload.code, ERROR_CODES.RATE_LIMITED, 'envelope refusal code');
        assertEqual(refused.payload.detail, 'sending too fast', 'envelope refusal detail');
        assertEqual(local.rooms.get('allow-room').seq, baseSeq + available, 'refusal does not advance room sequence');
        await b.none((env) => isRelay(env, `f-${available}`), 50);
        assert(!a.closed, 'envelope refusal keeps the connection');
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('envelope allowance: one refill admits one more envelope', async () => {
    await withServer({ envelopeBurst: 2, envelopeRefillMs: 500 }, async (_local, url) => {
      const a = await Peer.open(url, 'refill-a');
      const b = await Peer.open(url, 'refill-b');
      try {
        await a.join({ room: 'refill-envelope', tabId: 'a', role: 'host' });
        await b.join({ room: 'refill-envelope', tabId: 'b', role: 'viewer' });
        a.send(relay('first'));
        await b.next((env) => isRelay(env, 'first'));
        a.send(relay('blocked'));
        await a.next(isError);
        await sleep(550);
        a.send(relay('after-refill'));
        await b.next((env) => isRelay(env, 'after-refill'));
      } finally {
        a.close();
        b.close();
      }
    });
  });

  await check('envelope allowance: reclaim hands the spent membership bucket to the new socket', async () => {
    await withServer({ envelopeBurst: 3, envelopeRefillMs: 100_000 }, async (_local, url) => {
      const a = await Peer.open(url, 'reclaim-a');
      try {
        const joined = await a.join({ room: 'reclaim-envelope', tabId: 'a', role: 'viewer' });
        a.send(relay('one'));
        await a.next((env) => isRelay(env, 'one'));
        a.send(relay('two'));
        await a.next((env) => isRelay(env, 'two'));

        const b = await Peer.open(url, 'reclaim-b');
        try {
          await b.join({ room: 'reclaim-envelope', tabId: 'a', role: 'viewer', secret: joined.payload.secret });
          b.send(relay('after-reclaim'));
          const refused = await b.next(isError);
          assertEqual(refused.payload.code, ERROR_CODES.RATE_LIMITED, 'reclaimed bucket remains empty');
        } finally {
          b.close();
        }
      } finally {
        a.close();
      }
    });
  });

  await check('envelope allowance: defaults admit the derived 236-envelope opening burst', async () => {
    const a = await Peer.open(`ws://127.0.0.1:${defaultServer.httpServer.address().port}/ws`, 'default-burst-a');
    const b = await Peer.open(`ws://127.0.0.1:${defaultServer.httpServer.address().port}/ws`, 'default-burst-b');
    try {
      const room = `default-envelope-${Date.now()}`;
      await a.join({ room, tabId: 'a', role: 'host' });
      await b.join({ room, tabId: 'b', role: 'viewer' });
      assertEqual(defaultServer.envelopeBurst, 472, 'default envelope burst');
      assertEqual(defaultServer.envelopeRefillMs, 100, 'default envelope refill');
      for (let i = 0; i < 236; i++) a.send(relay(`default-${i}`, `operation-${i}`));
      for (let i = 0; i < 236; i++) await b.next((env) => env.type === `operation-${i}`);
      await a.none(isError, 30);
    } finally {
      a.close();
      b.close();
    }
  });
}
