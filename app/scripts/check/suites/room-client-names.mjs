// scripts/check/suites/room-client-names.mjs — the room client's name and chat sends (12d D2).

import { check, assert, assertEqual, recordingSocket, joinsIn, waitEvent, sleep } from '../harness.mjs';
import { TYPE_NAME, TYPE_CHAT, ERROR_CODES } from '../../../public/lib/envelope.mjs';

const sentOf = (wire, type) => wire.sent.filter((e) => e.type === type);
const entryOf = (roster, clientId) => roster.find((m) => m.clientId === clientId);

function nextError(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('room-client: no error envelope within 3000ms')), 3000);
    const off = client.on('error', (env) => {
      clearTimeout(timer);
      off();
      resolve(env);
    });
  });
}

export default async function roomClientNamesSuite() {
  await check('room client names: the join carries the configured name', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl, name: 'Ada' });
    assertEqual(c.name, 'Ada', 'the getter');
    const joinedEvent = waitEvent(c, 'joined');
    c.connect();
    const joined = await joinedEvent;
    assertEqual(joinsIn(wire)[0].payload.name, 'Ada', 'the join body');
    assertEqual(entryOf(joined.roster, joined.clientId).name, 'Ada', 'the roster');
    assertEqual(sentOf(wire, TYPE_NAME).length, 0, 'no separate name was needed');
  });

  await check('room client names: a name set before the join rides the join, and one set after goes as a name', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl });
    assertEqual(c.setName('Bo'), null, 'before the join nothing is sent');
    const joinedEvent = waitEvent(c, 'joined');
    c.connect();
    await joinedEvent;
    assertEqual(joinsIn(wire)[0].payload.name, 'Bo', 'the join carries it');
    assertEqual(sentOf(wire, TYPE_NAME).length, 0, 'and no name message followed');
    const id = c.setName('Cy');
    assert(typeof id === 'string', 'after the join an id is returned');
    assertEqual(sentOf(wire, TYPE_NAME)[0].payload.name, 'Cy', 'the name went out');
    assertEqual(sentOf(wire, TYPE_NAME)[0].to, 'server', 'to the server');
    assertEqual(c.name, 'Cy', 'the getter follows');
  });

  await check('room client names: name and chat ids come from the counter requests use', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl });
    const joinedEvent = waitEvent(c, 'joined');
    c.connect();
    await joinedEvent;
    const echo = c.echo();
    const nameId = c.setName('Ada');
    const chatId = c.sendChat('hello');
    await echo;
    const echoId = wire.sent.find((e) => e.type === 'echo').id;
    assertEqual(new Set([echoId, nameId, chatId]).size, 3, 'three distinct ids');
    for (const id of [echoId, nameId, chatId]) assert(/^m-\d+$/.test(id), `${id} is m-N`);
    assertEqual(sentOf(wire, TYPE_CHAT)[0].id, chatId, 'the chat envelope holds its id');
    assertEqual(sentOf(wire, TYPE_CHAT)[0].to, 'room', 'to the room');
  });

  await check('room client names: a refused rename leaves the name at the roster’s and is not replayed', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl, name: 'Ada' });
    const joinedEvent = waitEvent(c, 'joined');
    c.connect();
    await joinedEvent;
    const refusal = nextError(c);
    const id = c.setName('x'.repeat(33));
    const error = await refusal;
    assertEqual(error.replyTo, id, 'the refusal names the rename');
    assertEqual(error.payload.code, ERROR_CODES.BAD_ENVELOPE, 'bad-envelope');
    assertEqual(c.name, 'Ada', 'the name is back at the roster’s');
    await sleep(100);
    assertEqual(sentOf(wire, TYPE_NAME).length, 1, 'nothing was resent');
  });

  await check('room client names: a reconnect carries the current name, not the first', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl, name: 'Ada' });
    const first = waitEvent(c, 'joined');
    c.connect();
    await first;
    c.setName('Bo');
    await sleep(50);
    const second = waitEvent(c, 'joined', 4000);
    wire.socket.close();
    const rejoined = await second;
    assertEqual(joinsIn(wire).length, 2, 'two joins');
    assertEqual(joinsIn(wire)[1].payload.name, 'Bo', 'the second join carries Bo');
    assertEqual(entryOf(rejoined.roster, rejoined.clientId).name, 'Bo', 'the roster agrees');
  });

  await check('room client names: sendChat while not joined returns null and writes nothing', async ({ client }) => {
    const { Impl, wire } = recordingSocket();
    const c = client('A', 'viewer', { WebSocketImpl: Impl });
    assertEqual(c.sendChat('early'), null, 'before connect');
    c.connect();
    assertEqual(c.sendChat('during'), null, 'while connecting');
    assertEqual(wire.sent.filter((e) => e.type === TYPE_CHAT).length, 0, 'no chat written');
    await waitEvent(c, 'joined');
    assertEqual(wire.sent.filter((e) => e.type === TYPE_CHAT).length, 0, 'none written once joined either');
  });
}
