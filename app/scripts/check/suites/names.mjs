// scripts/check/suites/names.mjs — names in join, roster and presence; the `name` message.

import { check, assert, assertEqual, memberOf } from '../harness.mjs';
import {
  TYPE_JOINED,
  TYPE_PRESENCE,
  TYPE_ERROR,
  ERROR_CODES,
  buildNameEnvelope,
  buildClientEnvelope,
  TYPE_NAME,
} from '../../../public/lib/envelope.mjs';

const isPresence = (event) => (e) => e.type === TYPE_PRESENCE && e.payload.event === event;
const isError = (e) => e.type === TYPE_ERROR;
const entryOf = (roster, clientId) => roster.find((m) => m.clientId === clientId);
const UNNAMED_KEYS = 'clientId,joinedAt,role,tabId';

export default async function namesSuite() {
  await check('names: an unnamed entry holds exactly clientId, tabId, role and joinedAt, in joined and in presence', async ({ room, peer }) => {
    const a = await peer('A');
    const joined = await a.join({ room, tabId: 'A', role: 'host' });
    assertEqual(Object.keys(entryOf(joined.payload.roster, joined.payload.clientId)).sort().join(), UNNAMED_KEYS, 'joined entry keys');
    const b = await peer('B');
    await b.join({ room, tabId: 'B', role: 'viewer' });
    const presence = await a.next(isPresence('join'));
    for (const entry of presence.payload.roster) {
      assertEqual(Object.keys(entry).sort().join(), UNNAMED_KEYS, `presence entry keys for ${entry.tabId}`);
    }
    assertEqual(Object.keys(presence.payload.member).sort().join(), UNNAMED_KEYS, 'the presence member keys');
  });

  await check('names: a named join appears, trimmed, in the joiner’s roster and in every other member’s presence', async ({ room, peer, member }) => {
    const a = await member('A', 'host');
    const c = await member('C');
    const b = await peer('B');
    const joined = await b.join({ room, tabId: 'B', role: 'viewer', name: ' Ada ' });
    assertEqual(entryOf(joined.payload.roster, joined.payload.clientId).name, 'Ada', 'the joiner’s roster');
    for (const [label, p] of [['A', a], ['C', c]]) {
      const seen = await p.next((e) => e.type === TYPE_PRESENCE && e.payload.member.tabId === 'B');
      assertEqual(entryOf(seen.payload.roster, joined.payload.clientId).name, 'Ada', `${label}'s presence`);
      assertEqual(seen.payload.member.name, 'Ada', `${label}'s presence member`);
    }
  });

  await check('names: a name over 32 code points and a name with U+202E are dropped, not refused', async ({ room, peer }) => {
    const long = await peer('long');
    const j1 = await long.join({ room, tabId: 'long', role: 'viewer', name: 'a'.repeat(33) });
    assertEqual(j1.type, TYPE_JOINED, 'a long name is admitted');
    assert(!('name' in entryOf(j1.payload.roster, j1.payload.clientId)), 'and carries no name');
    const bidi = await peer('bidi');
    const j2 = await bidi.join({ room, tabId: 'bidi', role: 'viewer', name: 'ab\u202Ecd' });
    assertEqual(j2.type, TYPE_JOINED, 'a direction override is admitted');
    assert(!('name' in entryOf(j2.payload.roster, j2.payload.clientId)), 'and carries no name');
    const edge = await peer('edge');
    const j3 = await edge.join({ room, tabId: 'edge', role: 'viewer', name: '𝒜'.repeat(32) });
    assertEqual(entryOf(j3.payload.roster, j3.payload.clientId).name, '𝒜'.repeat(32), '32 code points are kept');
  });

  await check('names: a rename reaches every member and changes no membership', async ({ room, peer, member }) => {
    const a = await member('A', 'host');
    const c = await member('C');
    const b = await peer('B');
    const joined = await b.join({ room, tabId: 'B', role: 'viewer' });
    b.send(buildNameEnvelope({ id: 'm-1', name: 'Bo' }));
    for (const [label, p] of [['A', a], ['B', b], ['C', c]]) {
      const seen = await p.next(isPresence('name'));
      assertEqual(entryOf(seen.payload.roster, joined.payload.clientId).name, 'Bo', `${label} sees the new name`);
      assertEqual(seen.payload.roster.length, 3, `${label} sees the same membership`);
    }
    await a.none(isPresence('name'));
    assertEqual(a.received.filter(isPresence('name')).length, 1, 'exactly one name presence');
    assertEqual(a.received.filter(isPresence('leave')).length, 0, 'and no leave');
    assertEqual(memberOf(room, joined.payload.clientId).name, 'Bo', 'the server holds it');
  });

  await check('names: a rename to the current name is accepted and announced', async ({ room, peer }) => {
    const a = await peer('A');
    await a.join({ room, tabId: 'A', role: 'viewer', name: 'Ada' });
    a.send(buildNameEnvelope({ id: 'm-1', name: 'Ada' }));
    const seen = await a.next(isPresence('name'));
    assertEqual(seen.payload.member.name, 'Ada', 'announced with the same name');
  });

  await check('names: a refused rename keeps the old name, answers with replyTo and broadcasts no presence', async ({ room, peer, member }) => {
    const watcher = await member('W', 'host');
    const a = await peer('A');
    const joined = await a.join({ room, tabId: 'A', role: 'viewer', name: 'Ada' });
    await watcher.next(isPresence('join'));
    a.send(buildNameEnvelope({ id: 'm-1', name: '' }));
    const refused = await a.next(isError);
    assertEqual(refused.payload.code, ERROR_CODES.BAD_ENVELOPE, 'refused as bad-envelope');
    assertEqual(refused.replyTo, 'm-1', 'it names the refused id');
    assert(!JSON.stringify(refused).includes('Ada'), 'its detail quotes no name');
    await watcher.none(isPresence('name'));
    await a.none(isPresence('name'));
    assertEqual(memberOf(room, joined.payload.clientId).name, 'Ada', 'the server keeps Ada');
    assert(!a.closed, 'the connection is kept');
  });

  await check('names: a name to "room" or to a member is refused with replyTo and relayed to no one', async ({ room, peer, member }) => {
    const other = await member('O', 'host');
    const a = await peer('A');
    await a.join({ room, tabId: 'A', role: 'viewer' });
    a.send({ ...buildNameEnvelope({ id: 'm-1', name: 'Bo' }), to: 'room' });
    const toRoom = await a.next(isError);
    assertEqual(toRoom.payload.code, ERROR_CODES.BAD_ENVELOPE, 'to room refused');
    assertEqual(toRoom.replyTo, 'm-1', 'to room carries replyTo');
    a.send({ ...buildNameEnvelope({ id: 'm-2', name: 'Bo' }), to: other.clientId });
    const toMember = await a.next(isError);
    assertEqual(toMember.payload.code, ERROR_CODES.BAD_ENVELOPE, 'to a member refused');
    assertEqual(toMember.replyTo, 'm-2', 'to a member carries replyTo');
    await other.none((e) => e.type === TYPE_NAME || (e.type === TYPE_PRESENCE && e.payload.event === 'name'));
  });

  await check('names: a refused name without an id carries no replyTo', async ({ room, peer }) => {
    const a = await peer('A');
    await a.join({ room, tabId: 'A', role: 'viewer' });
    a.send(buildClientEnvelope({ type: TYPE_NAME, to: 'server', payload: { name: '' } }));
    const refused = await a.next(isError);
    assertEqual(refused.replyTo, undefined, 'no replyTo');
  });

  await check('names: a reclaim keeps the held name and reads none from the join', async ({ room, peer, member }) => {
    const watcher = await member('W', 'host');
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'viewer', name: 'Ada' });
    const a2 = await peer('A2');
    const j2 = await a2.join({ room, tabId: 'A', role: 'viewer', secret: j1.payload.secret, name: 'Eve' });
    assertEqual(j2.type, TYPE_JOINED, 'the reclaim is admitted');
    assertEqual(entryOf(j2.payload.roster, j2.payload.clientId).name, 'Ada', 'the reclaimed roster shows Ada');
    const seen = await watcher.next((e) => e.type === TYPE_PRESENCE && e.payload.member.clientId === j2.payload.clientId);
    assertEqual(seen.payload.member.name, 'Ada', 'the others are told Ada');
    assert(!JSON.stringify(seen).includes('Eve'), 'Eve appears nowhere');
  });

  await check('names: a reclaim of an unnamed member does not take a name from the join', async ({ room, peer }) => {
    const a1 = await peer('A1');
    const j1 = await a1.join({ room, tabId: 'A', role: 'viewer' });
    const a2 = await peer('A2');
    const j2 = await a2.join({ room, tabId: 'A', role: 'viewer', secret: j1.payload.secret, name: 'Eve' });
    assert(!('name' in entryOf(j2.payload.roster, j2.payload.clientId)), 'still unnamed');
  });
}
