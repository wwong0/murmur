// Named labels, initials, the repeat suffix, the rename and rate lines, and chat lines (12d D6, D8), pure.

import { assert, assertEqual, check } from '../harness.mjs';
import { activityText, chatLine, labelMap, memberLabels } from '../../../public/lib/room-people.mjs';

const member = (clientId, role, name) => ({ clientId, tabId: `tab-${clientId}`, role, joinedAt: 1, ...(name === undefined ? {} : { name }) });
const labelsOf = (roster) => memberLabels(roster).map((p) => p.label);

export default async function roomPeopleNamesSuite() {
  await check('room-people names: a named host and guest show their names, and the unnamed guest keeps its position number', async () => {
    const people = memberLabels([member('h', 'host', 'Ada'), member('g1', 'viewer', 'bo'), member('g2', 'viewer')]);
    assertEqual(JSON.stringify(people.map((p) => [p.label, p.initial, p.host])), JSON.stringify([
      ['Ada', 'A', true], ['bo', 'B', false], ['Guest 2', '2', false],
    ]), 'labels, initials and the host mark');
    assertEqual(JSON.stringify(people.map((p) => p.tone)), JSON.stringify(['host', 1, 2]), 'tones follow the position, not the name');
  });

  await check('room-people names: two members with one name — every later one takes " (2)", " (3)" in list order', async () => {
    assertEqual(JSON.stringify(labelsOf([member('h', 'host'), member('a', 'viewer', 'Ada'), member('b', 'viewer', 'Ada')])), JSON.stringify(['Host', 'Ada', 'Ada (2)']), 'two');
    assertEqual(JSON.stringify(labelsOf([member('h', 'host', 'Ada'), member('a', 'viewer', 'Ada'), member('b', 'viewer', 'Ada')])), JSON.stringify(['Ada', 'Ada (2)', 'Ada (3)']), 'the host counts in list order');
    assertEqual(JSON.stringify(labelsOf([member('h', 'host'), member('a', 'viewer', 'ada'), member('b', 'viewer', 'Ada')])), JSON.stringify(['Host', 'ada', 'Ada']), 'compared exactly, not by case');
  });

  await check('room-people names: a host and two viewers, none named, read as before', async () => {
    assertEqual(JSON.stringify(labelsOf([member('h', 'host'), member('a', 'viewer'), member('b', 'viewer')])), JSON.stringify(['Host', 'Guest 1', 'Guest 2']), 'unnamed');
  });

  await check('room-people names: the initial is the first code point, upper-cased, never half a surrogate pair', async () => {
    const [astral, lower] = memberLabels([member('a', 'viewer', '𝒜da'), member('b', 'viewer', 'élan')]);
    assertEqual(astral.initial, '𝒜', 'an astral first character');
    assertEqual(astral.initial.length, 2, 'both units of the pair');
    assertEqual(lower.initial, 'É', 'upper-cased');
  });

  await check('room-people names: a rename line puts the old label first, and nothing where the label did not change', async () => {
    const names = labelMap(memberLabels([member('h', 'host')]));
    assertEqual(activityText({ kind: 'rename', before: 'Guest 1', after: 'Ada' }, names), 'Guest 1 is now Ada', 'old then new');
    assertEqual(activityText({ kind: 'rename', before: 'Ada', after: 'Ada' }, names), null, 'equal labels');
    assertEqual(activityText({ kind: 'rename', before: undefined, after: 'Ada' }, names), 'Someone is now Ada', 'an unknown member');
  });

  await check('room-people names: the rate warning is plain words with no code', async () => {
    const text = activityText({ kind: 'rate' }, new Map());
    assertEqual(text, "You're sending too fast — wait a moment", 'the line');
    assert(!/rate-limited|bad-envelope|\bm-\d/.test(text), 'no code in it');
  });

  await check('room-people names: a chat line carries the sender’s label and tone, and Someone for an absent sender', async () => {
    const people = memberLabels([member('h', 'host', 'Ada'), member('g', 'viewer')]);
    assertEqual(JSON.stringify(chatLine({ from: 'h', payload: { text: 'hello' } }, people)), JSON.stringify({ kind: 'chat', label: 'Ada', tone: 'host', text: 'hello' }), 'host');
    assertEqual(JSON.stringify(chatLine({ from: 'g', payload: { text: '<b>x</b>' } }, people)), JSON.stringify({ kind: 'chat', label: 'Guest 1', tone: 1, text: '<b>x</b>' }), 'guest, markup kept as characters');
    assertEqual(chatLine({ from: 'gone', payload: { text: 'hi' } }, people).label, 'Someone', 'absent sender');
  });

  await check('room-people names: a chat whose body is not one text string is no line', async () => {
    const people = memberLabels([member('h', 'host')]);
    for (const payload of [{ text: 7 }, { text: 'hi', x: 1 }, {}, null, 'hi', { text: 'a\nb' }, { text: 'x'.repeat(501) }]) {
      assertEqual(chatLine({ from: 'h', payload }, people), null, JSON.stringify(payload)?.slice(0, 30));
    }
  });
}
