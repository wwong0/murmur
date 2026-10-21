// scripts/check/suites/chat.mjs — the room relays chat and keeps none (12d D4).

import { check, assert, assertEqual } from '../harness.mjs';
import {
  TYPE_CHAT,
  TYPE_ERROR,
  TYPE_JOINED,
  ERROR_CODES,
  buildChatEnvelope,
} from '../../../public/lib/envelope.mjs';

const isChat = (e) => e.type === TYPE_CHAT;
const isError = (e) => e.type === TYPE_ERROR;

export default async function chatSuite() {
  await check('chat: every member, senders included, receives both messages in one order with consecutive seq', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    const c = await member('C');
    const first = buildChatEnvelope({ id: 'm-1', text: 'first message' });
    const second = buildChatEnvelope({ id: 'm-2', text: 'second message' });
    a.send(first);
    b.send(second);
    const seen = [];
    for (const p of [a, b, c]) {
      const one = await p.next(isChat);
      const two = await p.next(isChat);
      seen.push([one, two]);
    }
    for (const [one, two] of seen) {
      assertEqual(one.payload.text, 'first message', 'first in order');
      assertEqual(two.payload.text, 'second message', 'second in order');
      assertEqual(two.seq, one.seq + 1, 'consecutive seq');
    }
    assertEqual(new Set(seen.map(([one]) => one.seq)).size, 1, 'one seq for every member');
    assertEqual(seen[0][0].from, a.clientId, 'from is the sender');
    assertEqual(seen[0][1].from, b.clientId, 'from is the second sender');
  });

  await check('chat: an accepted message reaches the room with its payload byte-identical', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send(buildChatEnvelope({ id: 'm-1', text: ' spaced <b>x</b> 𝒜 ' }));
    const got = await b.next(isChat);
    assertEqual(JSON.stringify(got.payload), JSON.stringify({ text: ' spaced <b>x</b> 𝒜 ' }), 'payload bytes');
    assertEqual(got.to, 'room', 'addressed to the room');
  });

  await check('chat: 500 code points are relayed and 501 are refused with replyTo, and seq does not advance', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send(buildChatEnvelope({ id: 'm-1', text: '𝒜'.repeat(500) }));
    const ok = await b.next(isChat);
    assertEqual([...ok.payload.text].length, 500, '500 relayed');
    a.send(buildChatEnvelope({ id: 'm-2', text: 'x'.repeat(501) }));
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, 'refused as bad-envelope');
    assertEqual(refused.replyTo, 'm-2', 'it names the refused id');
    a.send(buildChatEnvelope({ id: 'm-3', text: 'after' }));
    const next = await b.next(isChat);
    assertEqual(next.payload.text, 'after', 'the next accepted message');
    assertEqual(next.seq, ok.seq + 1, 'seq did not advance for the refusal');
    assertEqual(b.received.filter((e) => isChat(e) && [...e.payload.text].length > 500).length, 0, 'nobody saw the long one');
    assert(!a.closed, 'the sender stays');
  });

  await check('chat: a padded body is refused and relayed to no one', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send({ ...buildChatEnvelope({ id: 'm-1', text: 'hi' }), payload: { text: 'hi', extra: 'x'.repeat(1000) } });
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, 'refused as bad-envelope');
    assertEqual(refused.replyTo, 'm-1', 'it names the refused id');
    await b.none(isChat);
    await a.none(isChat);
  });

  await check('chat: a control character is refused', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send(buildChatEnvelope({ id: 'm-1', text: 'two\nlines' }));
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, 'refused as bad-envelope');
    await b.none(isChat);
  });

  await check('chat: a directed chat is refused, the target receives nothing and the sender stays', async ({ member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send({ ...buildChatEnvelope({ id: 'm-1', text: 'psst' }), to: b.clientId });
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, 'refused as bad-envelope');
    assertEqual(refused.replyTo, 'm-1', 'it names the refused id');
    await b.none(isChat);
    assert(!a.closed, 'the sender stays');
  });

  await check('chat: a chat before the join is refused with replyTo', async ({ peer }) => {
    const a = await peer('A');
    a.send(buildChatEnvelope({ id: 'm-1', text: 'early' }));
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.NOT_JOINED, 'not joined');
    assertEqual(refused.replyTo, 'm-1', 'it names the refused id');
  });

  await check('chat: a late joiner sees neither earlier text in joined nor afterwards', async ({ room, peer, member }) => {
    const a = await member('A', 'host');
    const b = await member('B');
    a.send(buildChatEnvelope({ id: 'm-1', text: 'earlier-one' }));
    b.send(buildChatEnvelope({ id: 'm-2', text: 'earlier-two' }));
    await b.next((e) => isChat(e) && e.payload.text === 'earlier-two');
    const late = await peer('late');
    const joined = await late.join({ room, tabId: 'late', role: 'viewer' });
    assertEqual(joined.type, TYPE_JOINED, 'admitted');
    a.send(buildChatEnvelope({ id: 'm-3', text: 'later' }));
    await late.next((e) => isChat(e) && e.payload.text === 'later');
    const everything = JSON.stringify(late.received);
    assert(!everything.includes('earlier-one') && !everything.includes('earlier-two'), 'no earlier text reached the late joiner');
  });
}
