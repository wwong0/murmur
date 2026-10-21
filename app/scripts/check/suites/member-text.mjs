// scripts/check/suites/member-text.mjs — the one text rule and its three readers (12d D3, D4).

import { check, assert, assertEqual } from '../harness.mjs';
import {
  readMemberText,
  readJoinRequest,
  readNameRequest,
  readChatMessage,
  buildJoinEnvelope,
  buildNameEnvelope,
  buildChatEnvelope,
  ADDR_ROOM,
  ADDR_SERVER,
  NAME_MAX_CODE_POINTS,
  CHAT_MAX_CODE_POINTS,
} from '../../../public/lib/envelope.mjs';

const join = (extra) => ({ payload: { room: 'r', tabId: 't', role: 'viewer', ...extra } });
const nameOf = (value) => readJoinRequest(join({ name: value }));
const chat = (payload) => readChatMessage({ payload });

export default async function memberTextSuite() {
  await check('member text: a name is accepted at 32 code points and dropped at 33', async () => {
    assertEqual(NAME_MAX_CODE_POINTS, 32, 'the name cap');
    assertEqual(nameOf('a'.repeat(32)).name, 'a'.repeat(32), '32 accepted');
    assert(!('name' in nameOf('a'.repeat(33))), '33 dropped');
    assertEqual(readNameRequest({ payload: { name: 'a'.repeat(32) } }).ok, true, '32 accepted by the name reader');
    assertEqual(readNameRequest({ payload: { name: 'a'.repeat(33) } }).ok, false, '33 refused by the name reader');
  });

  await check('member text: the cap counts code points, not UTF-16 units', async () => {
    const astral = '𝒜'.repeat(32);
    assertEqual(astral.length, 64, 'the fixture is 64 UTF-16 units');
    assertEqual(nameOf(astral).name, astral, '32 astral characters accepted');
    assert(!('name' in nameOf('𝒜'.repeat(33))), '33 astral characters dropped');
  });

  await check('member text: a name is trimmed, and white space alone is no name', async () => {
    assertEqual(nameOf(' Ada ').name, 'Ada', 'trimmed');
    assertEqual(readNameRequest({ payload: { name: ' Ada ' } }).name, 'Ada', 'trimmed by the name reader');
    assert(!('name' in nameOf('   ')), 'white space alone');
    assert(!('name' in nameOf('')), 'empty');
    assertEqual(readNameRequest({ payload: { name: '  ' } }).ok, false, 'white space alone refused as a rename');
  });

  await check('member text: control, direction and line and paragraph separator characters are refused', async () => {
    const forbidden = {
      LF: '\n', TAB: '\t', DEL: '\u007f', NEL: '\u0085', LRE: '\u202A', RLO: '\u202E', LRI: '\u2066', PDI: '\u2069', LS: '\u2028', PS: '\u2029',
    };
    for (const [label, ch] of Object.entries(forbidden)) {
      assertEqual(readMemberText(`a${ch}b`, 32), null, `${label} refused`);
      assert(!('name' in nameOf(`a${ch}b`)), `${label} dropped from a join`);
    }
    assertEqual(readMemberText('a b', 32), 'a b', 'a plain space is allowed');
    assertEqual(readMemberText('', 32), null, 'empty refused');
    assertEqual(readMemberText(7, 32), null, 'non-string refused');
  });

  await check('member text: a message is accepted at 500 code points and refused at 501, untrimmed', async () => {
    assertEqual(CHAT_MAX_CODE_POINTS, 500, 'the message cap');
    assertEqual(chat({ text: 'x'.repeat(500) }).ok, true, '500 accepted');
    assertEqual(chat({ text: 'x'.repeat(501) }).ok, false, '501 refused');
    assertEqual(chat({ text: '𝒜'.repeat(500) }).ok, true, '500 astral characters accepted');
    assertEqual(chat({ text: ' hi ' }).text, ' hi ', 'not trimmed');
    assertEqual(chat({ text: 'a\nb' }).ok, false, 'a line feed refused');
  });

  await check('member text: a chat body holds only text', async () => {
    assertEqual(chat({ text: 'hi', extra: 1 }).ok, false, 'an extra key refused');
    assertEqual(chat({}).ok, false, 'no text refused');
    assertEqual(chat({ txt: 'hi' }).ok, false, 'another key alone refused');
    assertEqual(chat('hi').ok, false, 'a string body refused');
    assertEqual(chat(null).ok, false, 'a null body refused');
    assertEqual(chat(['hi']).ok, false, 'an array body refused');
    assertEqual(readNameRequest({ payload: null }).ok, false, 'a null name body refused');
    assertEqual(readNameRequest({ payload: 'Ada' }).ok, false, 'a string name body refused');
    assertEqual(readNameRequest({ payload: { name: 'Ada', other: 1 } }).name, 'Ada', 'a name body ignores other keys');
  });

  await check('member text: a join reads the existing fields, plus a name only when it passes', async () => {
    const plain = readJoinRequest(join({}));
    assertEqual(plain.ok, true, 'admitted shape');
    assert(!('name' in plain), 'no name key without a name');
    assertEqual(nameOf('Ada').name, 'Ada', 'with a name');
    const bad = nameOf('a'.repeat(33));
    assertEqual(bad.ok, true, 'a failing name is not a refusal');
    assert(!('name' in bad), 'and leaves no name key');
    assertEqual(nameOf(7).ok, true, 'a non-string name is not a refusal');
    assert(!('name' in nameOf(7)), 'and leaves no name key');
  });

  await check('member text: the builders address server and room, and a join carries a name only when given', async () => {
    assert(!('name' in buildJoinEnvelope({ room: 'r', tabId: 't', role: 'viewer' }).payload), 'no name');
    assert(!('name' in buildJoinEnvelope({ room: 'r', tabId: 't', role: 'viewer', name: '' }).payload), 'empty name');
    assertEqual(buildJoinEnvelope({ room: 'r', tabId: 't', role: 'viewer', name: 'Ada' }).payload.name, 'Ada', 'name');
    const rename = buildNameEnvelope({ id: 'm-1', name: 'Bo' });
    assertEqual(rename.to, ADDR_SERVER, 'name to server');
    assertEqual(rename.type, 'name', 'name type');
    assertEqual(rename.id, 'm-1', 'name id');
    const message = buildChatEnvelope({ id: 'm-2', text: 'hi' });
    assertEqual(message.to, ADDR_ROOM, 'chat to room');
    assertEqual(message.type, 'chat', 'chat type');
    assertEqual(JSON.stringify(message.payload), '{"text":"hi"}', 'chat body holds text only');
  });
}
