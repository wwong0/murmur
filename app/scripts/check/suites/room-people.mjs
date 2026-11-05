// Member labels, activity lines and the media-time format, pure.

import { assert, assertEqual, check } from '../harness.mjs';
import { formatMediaTime } from '../../../public/lib/media-time.mjs';
import { activityText, labelMap, memberLabels } from '../../../public/lib/room-people.mjs';

const HOST = { tabId: 'tab-h', role: 'host', clientId: 'cid-host' };
const G1 = { tabId: 'tab-g1', role: 'viewer', clientId: 'cid-g1' };
const G2 = { tabId: 'tab-g2', role: 'viewer', clientId: 'cid-g2' };
const G3 = { tabId: 'tab-g3', role: 'viewer', clientId: 'cid-g3' };

const labels = (roster) => labelMap(memberLabels(roster));

export default async function roomPeopleSuite() {
  await check('room-people: the host is Host and the guests count from 1 in roster order, host skipped', async () => {
    assertEqual(JSON.stringify(memberLabels([HOST, G1, G2])), JSON.stringify([
      { clientId: 'cid-host', label: 'Host', initial: 'H', host: true, tone: 'host' },
      { clientId: 'cid-g1', label: 'Guest 1', initial: '1', host: false, tone: 1 },
      { clientId: 'cid-g2', label: 'Guest 2', initial: '2', host: false, tone: 2 },
    ]), 'host first');
    assertEqual(JSON.stringify(memberLabels([G1, HOST, G2]).map((p) => p.label)), JSON.stringify(['Host', 'Guest 1', 'Guest 2']), 'the host in the middle comes first and is skipped in the count');
    assertEqual(JSON.stringify(memberLabels([G1, G2])), JSON.stringify([
      { clientId: 'cid-g1', label: 'Guest 1', initial: '1', host: false, tone: 1 },
      { clientId: 'cid-g2', label: 'Guest 2', initial: '2', host: false, tone: 2 },
    ]), 'no host: guests only');
  });

  await check('room-people: a host who is not first in the roster comes back first, and the guests keep roster order', async () => {
    const people = memberLabels([G2, HOST, G1, G3]);
    assertEqual(JSON.stringify(people.map((p) => [p.clientId, p.label])), JSON.stringify([
      ['cid-host', 'Host'], ['cid-g2', 'Guest 1'], ['cid-g1', 'Guest 2'], ['cid-g3', 'Guest 3'],
    ]), 'host first, guests in roster order');
    assertEqual(JSON.stringify(memberLabels([G1, G2, HOST]).map((p) => p.clientId)), JSON.stringify(['cid-host', 'cid-g1', 'cid-g2']), 'a last-placed host');
  });

  await check('room-people: the tones are host, then 1 to 5 in guest order, and the sixth guest wraps to 1', async () => {
    const guests = Array.from({ length: 6 }, (_, i) => ({ tabId: `tab-${i}`, role: 'viewer', clientId: `cid-${i}` }));
    assertEqual(JSON.stringify(memberLabels([HOST, ...guests]).map((p) => p.tone)), JSON.stringify(['host', 1, 2, 3, 4, 5, 1]), 'host and six guests');
    assertEqual(JSON.stringify(memberLabels([guests[0], HOST, guests[1]]).map((p) => p.tone)), JSON.stringify(['host', 1, 2]), 'the host out of place still takes the host tone');
  });

  await check('room-people: no roster, or a roster with a null entry, gives only the real members', async () => {
    assertEqual(JSON.stringify(memberLabels(undefined)), '[]', 'undefined roster');
    assertEqual(JSON.stringify(memberLabels([])), '[]', 'empty roster');
    assertEqual(JSON.stringify(memberLabels([null, HOST]).map((p) => p.label)), JSON.stringify(['Host']), 'a null entry is skipped');
  });

  await check('room-people: after a guest leaves, the later guests take the lower numbers', async () => {
    const before = memberLabels([HOST, G1, G2, G3]);
    const after = memberLabels([HOST, G2, G3]);
    assertEqual(JSON.stringify(before.map((p) => p.label)), JSON.stringify(['Host', 'Guest 1', 'Guest 2', 'Guest 3']), 'before the leave');
    assertEqual(JSON.stringify(after.map((p) => [p.clientId, p.label, p.initial])), JSON.stringify([
      ['cid-host', 'Host', 'H'], ['cid-g2', 'Guest 1', '1'], ['cid-g3', 'Guest 2', '2'],
    ]), 'the numbers shift (D12, accepted)');
  });

  await check('room-people: a leaver is labelled from the roster before the leave, not after', async () => {
    const before = labels([HOST, G1, G2]);
    const after = labels([HOST, G1]);
    assertEqual(activityText({ kind: 'leave', clientId: 'cid-g2' }, before), 'Guest 2 left', 'labelled from the roster before');
    assertEqual(activityText({ kind: 'leave', clientId: 'cid-g2' }, after), 'Someone left', 'the roster after no longer holds them');
    assertEqual(activityText({ kind: 'leave', clientId: 'cid-host' }, labels([HOST, G1])), 'Host left', 'the host leaves');
  });

  await check('room-people: every activity row has its exact text', async () => {
    const names = labels([HOST, G1, G2]);
    const rows = [
      [{ kind: 'join', clientId: 'cid-g1' }, 'Guest 1 joined'],
      [{ kind: 'leave', clientId: 'cid-g2' }, 'Guest 2 left'],
      [{ kind: 'play', from: 'cid-g1' }, 'Guest 1 played'],
      [{ kind: 'pause', from: 'cid-host', positionMs: 6_485_000 }, 'Host paused at 1:48:05'],
      [{ kind: 'seek', from: 'cid-g2', positionMs: 41_000 }, 'Guest 2 skipped to 0:41'],
      [{ kind: 'ended' }, 'The film ended'],
      [{ kind: 'refused', op: 'pause' }, 'Your pause was refused — host only'],
      [{ kind: 'refused', op: 'play' }, 'Your play was refused — host only'],
      [{ kind: 'refused', op: 'seek' }, 'Your skip was refused — host only'],
      [{ kind: 'reconnecting' }, 'Reconnecting…'],
      [{ kind: 'reconnected' }, 'Reconnected'],
    ];
    for (const [event, text] of rows) assertEqual(activityText(event, names), text, `${event.kind} ${event.op ?? ''}`);
  });

  await check('room-people: a stale refusal and an unknown kind say nothing, and an unknown sender is Someone', async () => {
    const names = labels([HOST]);
    assertEqual(activityText({ kind: 'stale' }, names), null, 'stale');
    assertEqual(activityText({ kind: 'title' }, names), null, 'a kind with no row');
    assertEqual(activityText({ kind: 'play', from: 'cid-gone' }, names), 'Someone played', 'unknown sender of a play');
    assertEqual(activityText({ kind: 'pause', from: 'cid-gone', positionMs: 1000 }, names), 'Someone paused at 0:01', 'unknown sender of a pause');
    assertEqual(activityText({ kind: 'join', clientId: undefined }, names), 'Someone joined', 'a join without an id');
  });

  await check('room-people: no line carries a tab id, a client id, a bracket or a clock stamp', async () => {
    const roster = [HOST, G1, G2];
    const names = labels(roster);
    const events = [
      { kind: 'join', clientId: 'cid-g1' }, { kind: 'leave', clientId: 'cid-g2' }, { kind: 'play', from: 'cid-host' },
      { kind: 'pause', from: 'cid-g1', positionMs: 3_600_000 }, { kind: 'seek', from: 'cid-g2', positionMs: 59_999 },
      { kind: 'ended' }, { kind: 'refused', op: 'seek' }, { kind: 'reconnecting' }, { kind: 'reconnected' },
    ];
    const ids = roster.flatMap((member) => [member.tabId, member.clientId]);
    for (const event of events) {
      const text = activityText(event, names);
      assert(!text.includes('['), `${text}: no bracket`);
      assert(!/\b(?:AM|PM)\b/.test(text), `${text}: no clock stamp`);
      for (const id of ids) assert(!text.includes(id), `${text}: no ${id}`);
    }
    for (const person of memberLabels(roster)) {
      for (const id of ids) assert(!person.label.includes(id) && !person.initial.includes(id), `${person.label}: no ${id}`);
    }
  });

  await check('room-people: formatMediaTime is m:ss below an hour and h:mm:ss from it', async () => {
    const points = [
      [0, '0:00'], [59_999, '0:59'], [60_000, '1:00'], [3_599_999, '59:59'], [3_600_000, '1:00:00'], [7_200_000, '2:00:00'],
      [6_485_000, '1:48:05'], [-1, '0:00'], [Number.NaN, '0:00'], [Number.POSITIVE_INFINITY, '0:00'], [null, '0:00'], [undefined, '0:00'],
    ];
    for (const [ms, text] of points) assertEqual(formatMediaTime(ms), text, `${ms}`);
  });
}
