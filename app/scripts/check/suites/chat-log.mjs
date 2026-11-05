// scripts/check/suites/chat-log.mjs — no name or message reaches the server's log.

import crypto from 'node:crypto';

import { check, assert, assertEqual, sleep, Peer } from '../harness.mjs';
import { mediaDir } from '../fixtures.mjs';
import { startRoomServer } from '../../../server/room-server.mjs';
import {
  TYPE_CHAT,
  TYPE_ERROR,
  TYPE_PRESENCE,
  buildChatEnvelope,
  buildNameEnvelope,
  buildClientEnvelope,
} from '../../../public/lib/envelope.mjs';

export default async function chatLogSuite() {
  await check('chat log: a named member who renames, chats, is refused, reclaims and leaves leaves no name or text in the log', async () => {
    const m = crypto.randomBytes(6).toString('hex');
    const lines = [];
    const server = startRoomServer({ port: 0, mediaDir, livenessMs: 5000, logSink: (line) => lines.push(line) });
    const url = `ws://127.0.0.1:${await server.ready}/ws`;
    const peers = [];
    try {
      const a = await Peer.open(url, 'A');
      peers.push(a);
      const joined = await a.join({ room: 'log', tabId: 'A', role: 'host', name: `Ada-${m}` });
      a.send(buildNameEnvelope({ id: 'm-1', name: `Bo-${m}` }));
      await a.next((e) => e.type === TYPE_PRESENCE && e.payload.event === 'name');
      a.send(buildChatEnvelope({ id: 'm-2', text: `hello-${m}` }));
      await a.next((e) => e.type === TYPE_CHAT);
      a.send(buildNameEnvelope({ id: 'm-3', name: `${'x'.repeat(33)}-${m}` }));
      const refusedName = await a.next((e) => e.type === TYPE_ERROR && e.replyTo === 'm-3');
      a.send({ ...buildChatEnvelope({ id: 'm-4', text: `pad-${m}` }), payload: { text: `pad-${m}`, extra: m } });
      const refusedChat = await a.next((e) => e.type === TYPE_ERROR && e.replyTo === 'm-4');

      const a2 = await Peer.open(url, 'A2');
      peers.push(a2);
      const reclaimed = await a2.join({ room: 'log', tabId: 'A', role: 'host', secret: joined.payload.secret, name: `Eve-${m}` });
      a2.send(buildClientEnvelope({ type: 'leave', to: 'server', payload: {} }));
      await a2.waitClosed();
      await sleep(100);

      assert(lines.some((l) => l.includes(joined.payload.clientId)), 'opportunity: a line names the first membership by clientId');
      assert(lines.some((l) => l.includes('membership reclaimed') && l.includes(reclaimed.payload.clientId)), 'opportunity: a reclaim line names the new clientId');
      assert(lines.some((l) => l.startsWith('[room] depart') && l.includes('(leave)')), 'opportunity: the leave was logged');
      assert(lines.length >= 4, `the sink captured the run (${lines.length} lines)`);
      assertEqual(lines.filter((l) => l.includes(m)).length, 0, 'no log line contains the marker');
      assertEqual(JSON.stringify(refusedName).includes(m), false, 'the refused name’s reply quotes nothing');
      assertEqual(JSON.stringify(refusedChat).includes(m), false, 'the refused chat’s reply quotes nothing');
    } finally {
      for (const p of peers) p.close();
      await server.close();
    }
  });
}
