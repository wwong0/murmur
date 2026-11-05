// scripts/check/suites/chat-rate.mjs — the send allowance on the membership.

import { check, assert, assertEqual, sleep, Peer } from '../harness.mjs';
import { server, mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import {
  TYPE_CHAT,
  TYPE_ERROR,
  TYPE_PRESENCE,
  ERROR_CODES,
  buildChatEnvelope,
  buildNameEnvelope,
} from '../../../public/lib/envelope.mjs';

const isChat = (e) => e.type === TYPE_CHAT;
const isError = (e) => e.type === TYPE_ERROR;
const BURST = server.chatBurst;

/** Spend the burst on `p`, then wait and send once more; resolves to what the last send met. */
async function refillProbe(refillMs, waitMs) {
  const small = startRoomServer({ port: 0, mediaDir, quiet: true, chatRefillMs: refillMs });
  const url = `ws://127.0.0.1:${await small.ready}/ws`;
  const p = await Peer.open(url, `refill-${refillMs}`);
  try {
    await p.join({ room: 'refill', tabId: 'T', role: 'viewer' });
    for (let i = 0; i < small.chatBurst; i++) p.send(buildChatEnvelope({ id: `s-${i}`, text: `spend ${i}` }));
    await p.next((e) => isChat(e) && e.replyTo === undefined && e.payload.text === `spend ${small.chatBurst - 1}`);
    await sleep(waitMs);
    p.send(buildChatEnvelope({ id: 'probe', text: 'probe' }));
    const met = await p.next((e) => (isChat(e) && e.payload.text === 'probe') || (isError(e) && e.replyTo === 'probe'));
    return met.type;
  } finally {
    p.close();
    await small.close();
  }
}

export default async function chatRateSuite() {
  await check('chat rate: the defaults are a burst of 5 and one refill a second', async () => {
    assertEqual(server.chatBurst, 5, 'burst');
    assertEqual(server.chatRefillMs, 1000, 'refill');
  });

  await check('chat rate: burst is relayed and burst + 1 at once is refused rate-limited with replyTo', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    for (let i = 0; i <= BURST; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.RATE_LIMITED, 'rate-limited');
    assertEqual(refused.replyTo, `m-${BURST}`, 'it names the last send');
    assertEqual(refused.payload.detail, 'sending too fast', 'fixed detail');
    for (let i = 0; i < BURST; i++) await b.next((e) => isChat(e) && e.payload.text === `t${i}`);
    await b.none((e) => isChat(e) && e.payload.text === `t${BURST}`);
    assert(!a.closed, 'the connection is kept');
  });

  await check('chat rate: a refused send does not advance seq', async ({ room, member }) => {
    const a = await member('A', 'host');
    for (let i = 0; i < BURST; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    const last = await a.next((e) => isChat(e) && e.payload.text === `t${BURST - 1}`);
    a.send(buildChatEnvelope({ id: 'over', text: 'over' }));
    await a.next((e) => isError(e) && e.replyTo === 'over');
    assertEqual(server.rooms.get(room).seq, last.seq, 'the room counter is where the last relay left it');
  });

  await check('chat rate: a name spends from the same allowance', async ({ member }) => {
    const a = await member('A', 'host');
    for (let i = 0; i < BURST - 1; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    a.send(buildNameEnvelope({ id: 'n-1', name: 'Ada' }));
    await a.next((e) => e.type === TYPE_PRESENCE && e.payload.event === 'name');
    a.send(buildChatEnvelope({ id: 'over', text: 'over' }));
    const refused = await a.next(isError);
    assertEqual(refused.replyTo, 'over', 'the chat after burst - 1 chats and a name is refused');
    assertEqual(refused.payload.code, ERROR_CODES.RATE_LIMITED, 'rate-limited');
    a.send(buildNameEnvelope({ id: 'n-2', name: 'Bo' }));
    const renameRefused = await a.next((e) => isError(e) && e.replyTo === 'n-2');
    assertEqual(renameRefused.payload.code, ERROR_CODES.RATE_LIMITED, 'a rename is limited too');
  });

  await check('chat rate: a name in join spends nothing', async ({ room, peer }) => {
    const a = await peer('A');
    await a.join({ room, tabId: 'A', role: 'viewer', name: 'Ada' });
    for (let i = 0; i < BURST; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    await a.next((e) => isChat(e) && e.payload.text === `t${BURST - 1}`);
    await a.none(isError);
  });

  await check('chat rate: a refused bad chat spends nothing', async ({ member }) => {
    const a = await member('A', 'host');
    for (let i = 0; i < BURST; i++) a.send({ ...buildChatEnvelope({ id: `bad-${i}`, text: 'x' }), payload: { text: 'x', extra: 1 } });
    for (let i = 0; i < BURST; i++) {
      const refused = await a.next(isError);
      assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, `bad chat ${i} is bad-envelope`);
    }
    for (let i = 0; i < BURST; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    await a.next((e) => isChat(e) && e.payload.text === `t${BURST - 1}`);
    await a.none(isError);
  });

  await check('chat rate: a reclaim keeps the empty allowance', async ({ room, peer }) => {
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'viewer' });
    for (let i = 0; i < BURST; i++) a1.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    await a1.next((e) => isChat(e) && e.payload.text === `t${BURST - 1}`);
    const a2 = await peer('A2');
    await a2.join({ room, tabId: 'A', role: 'viewer', secret: j1.payload.secret });
    a2.send(buildChatEnvelope({ id: 'again', text: 'again' }));
    const refused = await a2.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.RATE_LIMITED, 'still empty after the reclaim');
    assertEqual(refused.replyTo, 'again', 'it names the send');
  });

  await check('chat rate: a new membership starts full', async ({ room, peer }) => {
    const a = await peer('A');
    await a.join({ room, tabId: 'A', role: 'viewer' });
    for (let i = 0; i < BURST; i++) a.send(buildChatEnvelope({ id: `m-${i}`, text: `t${i}` }));
    await a.next((e) => isChat(e) && e.payload.text === `t${BURST - 1}`);
    const b = await peer('B');
    await b.join({ room, tabId: 'B', role: 'viewer' });
    b.send(buildChatEnvelope({ id: 'fresh', text: 'fresh' }));
    await b.next((e) => isChat(e) && e.payload.text === 'fresh');
  });

  // Serial: each probe boots its own server, and the discriminating wait sits
  // between the two refill settings. A constant refill passes at most one row.
  await check('chat rate: the refill follows the setting — relayed at 150 ms and refused at 600 ms after 300 ms', async () => {
    const at150 = await refillProbe(150, 300);
    assertEqual(at150, TYPE_CHAT, 'relayed at chatRefillMs 150');
    const at600 = await refillProbe(600, 300);
    assertEqual(at600, TYPE_ERROR, 'refused at chatRefillMs 600');
  });

  await check('chat rate: the server refuses a burst or refill that is not a positive integer', async () => {
    for (const bad of [{ chatBurst: 0 }, { chatBurst: 1.5 }, { chatRefillMs: 0 }, { chatRefillMs: -1 }, { chatRefillMs: '5' }]) {
      let threw = null;
      try {
        const s = startRoomServer({ port: 0, mediaDir, quiet: true, ...bad });
        await s.close();
      } catch (err) {
        threw = err;
      }
      assert(threw instanceof TypeError, `${JSON.stringify(bad)} is a TypeError`);
    }
  });
}
