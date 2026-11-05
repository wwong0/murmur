import { assert, assertEqual, check } from '../harness.mjs';
import { resyncAfter } from '../../figures/behind.mjs';
import { rosterEventReading } from '../../figures/roster-event.mjs';

const TAGS = ['c01', 'c02', 'c03', 'c04', 'c05'];
const TIMEBASE = { offsetMs: 5_000, wallOffsetMs: -3_000 };
const E = 10_000;
const joinCondition = { clients: 5, rosterEvent: { kind: 'join', client: 'c05' }, churn: {
  firstFrameMaxMs: 6_000, horizonMs: 60_000,
  resync: { windowMs: 1_000, medianMaxMs: 40, holdMs: 30_000, maxMs: 2_000 },
  fill: { overMs: 60_000, peerFractionMin: 0.6, hostBodiesMax: 3 }, runwayMinMs: 15_000,
  stall: { gapMs: 250, beforeMs: 60_000, afterMs: 60_000 },
} };
const leaveCondition = (kind, horizonMs = 60_000) => ({ clients: 5, rosterEvent: { kind, client: 'c03' }, churn: {
  horizonMs, runwayMinMs: 15_000, stall: { gapMs: 250, beforeMs: 60_000, afterMs: 60_000 },
} });

function member(tag, clientId = `${tag}-client`) { return { clientId, tabId: tag, role: 'viewer' }; }
function presenceFrame(event, seq, client, roster = TAGS.map((tag) => member(tag))) {
  return { cdpMs: 100, seq, recvSharedMs: E, event, tabId: client, clientId: `${client}-client`, roster };
}
function presence(kind, client = kind === 'join' ? 'c05' : 'c03', { includeTarget = true, rejoin = false } = {}) {
  const afterLeave = TAGS.filter((tag) => tag !== 'c03').map((tag) => member(tag));
  const streams = Object.fromEntries(TAGS.map((tag) => [tag, [presenceFrame(kind === 'join' ? 'join' : 'leave', 7, client,
    kind === 'join' ? TAGS.map((entry) => member(entry)) : afterLeave)]]));
  if (rejoin) {
    for (const tag of TAGS.filter((entry) => entry !== client)) streams[tag].push(
      presenceFrame('join', 9, client, [...afterLeave.filter((entry) => entry.tabId !== client), member(client, 'new-client')]));
  }
  if (!includeTarget) delete streams[client];
  return streams;
}
function event(kind, client = kind === 'join' ? 'c05' : 'c03', overrides = {}) {
  const presenceEvent = kind === 'join' ? 'join' : 'leave';
  return { kind, client, tabId: client, clientId: `${client}-old`, at: 'measure-window-start', issuedAtHarnessMs: E - TIMEBASE.offsetMs,
    readBack: { ok: true }, presence: { event: presenceEvent, seq: 7, recvSharedMs: E }, receipts: {}, observed: true, ...overrides };
}
function frames(startMs = E, count = 200, { gapAt = null, gapMs = 0, driftMs = 0 } = {}) {
  const records = [];
  let displaySharedMs = startMs;
  for (let index = 0; index < count; index += 1) {
    records.push({ displaySharedMs, driftMs, presentedFrames: index + 1, seq: index + 1 });
    displaySharedMs += index === gapAt ? gapMs : 500;
  }
  return records;
}
function denseFrames(startMs = E - 60_000, endMs = E + 60_000, gapAt = null) {
  const records = [];
  let displaySharedMs = startMs;
  let seq = 1;
  while (displaySharedMs <= endMs) {
    records.push({ displaySharedMs, driftMs: 0, presentedFrames: seq, seq });
    displaySharedMs += seq === gapAt ? 400 : 50;
    seq += 1;
  }
  return records;
}
function viewerPoll(sharedMs, ownPositionMs = 0, runway = 20_000) {
  const harnessMs = sharedMs - TIMEBASE.offsetMs;
  return { harnessBeforeMs: harnessMs - 1, harnessAfterMs: harnessMs + 1,
    heldAhead: { ownHeldAheadMs: runway, ownPositionMs } };
}
function runwayPolls(value = 20_000, ownPositionMs = 0, from = E, count = 121) {
  return Array.from({ length: count }, (_, index) => viewerPoll(from + index * 500, ownPositionMs, value));
}
function hostPolls(from = E - 60_000, to = E + 60_000) {
  return Array.from({ length: Math.floor((to - from) / 250) + 1 }, (_, index) => ({ sharedMs: from + index * 250,
    state: { playing: true, held: false } }));
}
function pagePoll(sharedMs, skips = 0) {
  return { atMs: sharedMs - 10, clock: { offsetMs: 10 }, playback: { opens: 1, begun: 1,
    retargets: 0, reparks: 0, skips } };
}
function joinInput(overrides = {}) {
  const drift = Object.fromEntries(TAGS.map((tag) => [tag, frames(E, 140, { driftMs: 0 })]));
  const polls = Object.fromEntries(TAGS.filter((tag) => tag !== 'c05').map((tag) => [tag, runwayPolls()]));
  const attempts = Array.from({ length: 25 }, (_, index) => ({ kind: 'attempt', attemptId: index,
    path: `/media/seg-${String(index).padStart(5, '0')}.m4s`, endMs: E - 8_000 + index * 2_000,
    bytes: 100, peerId: index < 22 ? 'c01-peer' : null }));
  return { condition: joinCondition, event: event('join'), presence: presence('join'), drift, polls,
    attempts: { c05: attempts }, segments: Object.fromEntries(TAGS.map((tag) => [tag, []])), asks: {},
    starts: { c05: [{ afterSeq: 0, reprojections: 0, coverElapsedMs: 1_000, reparks: 0 }] },
    timebase: TIMEBASE, content: { frameRate: 30 }, ...overrides };
}
function readJoin(overrides = {}) { return rosterEventReading(joinInput(overrides)); }
function rowOf(reading, name) { return reading.find((entry) => entry.row === name); }

export default async function harnessRosterEventSuite() {
  await check('10b H5: join resync uses resyncAfter and requires sustained windows', async () => {
    const samples = [0, 500, 1_000, 1_500, 2_000].map((atMs, index) => ({ atMs, driftMs: index % 2 ? 10 : 60 }));
    assertEqual(resyncAfter({ firstFrameSharedMs: 0, pairs: [samples, samples], windowMs: 1_000, medianMaxMs: 40, holdMs: 2_000 }), null,
      'a transient dip does not resync');
    assertEqual(rowOf(readJoin(), 'J2').status, 'met', 'matching pair streams resync');
    const late = readJoin({ drift: Object.fromEntries(TAGS.map((tag) => [tag, tag === 'c05'
      ? frames(E + 1_000, 2, { driftMs: 60 }) : frames(E, 140)])) });
    assertEqual(rowOf(late, 'J2').status, 'missed', 'a joiner with no sustained pair window misses');
    // Frames 50 ms apart, the joiner 100 ms out until `untilMs` after its first frame. A
    // 1 000 ms window holds 21 samples, so its median is in step once 11 of them are:
    // the first such window starts 500 ms before the joiner comes into step.
    const out = (untilMs) => rowOf(readJoin({ drift: Object.fromEntries(TAGS.map((tag) => [tag,
      denseFrames(E, E + 60_000).map((record) => (tag === 'c05' && record.displaySharedMs < E + untilMs
        ? { ...record, driftMs: 100 } : record))])) }), 'J2');
    assertEqual(JSON.stringify([out(1_500).status, out(1_500).resyncAfterMs]), '["met",1000]', '1 000 ms is inside the bar');
    assertEqual(JSON.stringify([out(3_000).status, out(3_000).resyncAfterMs]), '["missed",2500]', 'a later resync is measured and published, not capped');
  });

  await check('10b H6: first-frame bound is inclusive and a missing frame is missed', async () => {
    for (const [delay, expected] of [[5_999, 'met'], [6_001, 'missed']]) {
      const records = frames(E + delay, 1);
      assertEqual(rowOf(readJoin({ drift: { ...joinInput().drift, c05: records } }), 'J1').status, expected,
        `${delay}ms first frame is ${expected}`);
    }
    assertEqual(rowOf(readJoin({ drift: { ...joinInput().drift, c05: [] } }), 'J1').status, 'missed', 'no frame is missed');
  });

  await check('10b join B-1: a join reads the stall of the viewers already in the room, both windows', async () => {
    const read = (gapAt) => rowOf(readJoin({ polls: { ...joinInput().polls, host: hostPolls() },
      drift: Object.fromEntries(TAGS.map((tag) => [tag, tag === 'c05' ? denseFrames(E + 1_000, E + 60_000)
        : denseFrames(E - 60_000, E + 60_000, tag === 'c02' ? gapAt : null)])) }), 'K1');
    // Frames 50 ms apart from 60 s before the join: record 1 201 is displayed at it.
    assertEqual(read(null).status, 'met', 'no gap either side is met');
    const after = read(1_300);
    assertEqual(after.status, 'missed', 'a 400 ms gap after the join is a stall');
    assertEqual(after.intervals.c02.after.stalls.length, 1, 'the stall is the other viewer\'s');
    assert(!('c05' in after.intervals), 'the joiner is not read');
    assertEqual(read(600).status, 'unreadable', 'a gap before the join reads nothing');
    assertEqual(rowOf(readJoin(), 'K1').status, 'evidence-failure', 'no host polls is an evidence failure, not a pass');
  });

  await check('10b join B-2: J1 publishes the delay to the landing segment\'s first ask', async () => {
    const ask = (index, startMs) => ({ kind: 'attempt', attemptId: index, path: `/media/seg-${String(index).padStart(5, '0')}.m4s`,
      startMs, endMs: E + 1_000 + index, bytes: 100, peerId: 'c01-peer' });
    const segments = [1, 2, 3].map((index) => ({ kind: 'segment', path: `/media/seg-${String(index).padStart(5, '0')}.m4s`,
      mediaStartMs: index * 4_000, mediaEndMs: (index + 1) * 4_000 }));
    const start = (positionMs) => rowOf(readJoin({ segments: { c05: segments },
      attempts: { c05: [{ ...ask(0, 1), path: '/media/index.m3u8' }, ask(3, 500), ask(2, 2_900), ask(2, 3_400), ask(1, 700)] },
      starts: { c05: [{ afterSeq: 0, reprojections: 0, coverElapsedMs: 1_000, reparks: 0, positionMs }] } }), 'J1').start;
    assertEqual(start(9_000).landingAskDelayMs, 2_400, 'the first of two asks for the holding segment, from the first segment ask');
    assertEqual(start(12_000).landingAskDelayMs, 0, 'a position on a boundary is the later segment\'s, asked first');
    assertEqual(start(40_000).landingAskDelayMs, null, 'a position in no finished segment has no figure');
    assertEqual(rowOf(readJoin(), 'J1').start.landingAskDelayMs, null, 'a start with no position has no figure');
  });

  await check('10b H7: fill uses peerId bytes, segment paths and shared-converted page ends', async () => {
    const result = (entries) => rowOf(readJoin({ attempts: { c05: entries } }), 'J3');
    const peer = Array.from({ length: 22 }, (_, index) => ({ kind: 'attempt', attemptId: index,
      path: `/media/seg-${String(index).padStart(5, '0')}.m4s`, endMs: 2_000 + index, bytes: 100, peerId: 'peer' }));
    const host = (count) => Array.from({ length: count }, (_, index) => ({ kind: 'attempt', attemptId: 50 + index,
      path: `/media/seg-${String(50 + index).padStart(5, '0')}.m4s`, endMs: 2_000 + index, bytes: 100, peerId: null }));
    assertEqual(result([...peer, ...host(3)]).status, 'met', '22 peer bodies and 3 host bodies meet');
    assertEqual(result([...peer, ...host(4)]).status, 'missed', 'four host bodies miss');
    assertEqual(result([...peer.slice(0, 19).map((entry) => ({ ...entry, bytes: 59 / 19 })),
      ...host(3).map((entry) => ({ ...entry, bytes: 41 / 3 }))]).status, 'missed', '0.59 peer fraction misses');
    assertEqual(result(host(25)).status, 'missed', 'all bodies from the host miss');
    assertEqual(result(peer.map((entry) => ({ ...entry, path: '/media/index.m3u8', source: 'p2p' }))).status,
      'evidence-failure', 'playlist attempts are not segment bodies');
  });

  await check('10b H8: runway converts harness brackets, is own, and rejects a gap', async () => {
    const runways = (value, source = 'own') => Object.fromEntries(TAGS.slice(0, 4).map((tag) => [tag,
      source === 'own' ? runwayPolls(value) : [viewerPoll(E, 0, value), viewerPoll(E + 60_000, 0, value)]]));
    assertEqual(rowOf(readJoin({ polls: runways(41_000) }), 'J4').status, 'met', '41 seconds meets');
    const four = (lowest) => rowOf(readJoin({ polls: Object.fromEntries([41_000, 38_000, 44_000, lowest]
      .map((value, index) => [TAGS[index], [...runwayPolls(60_000, 0, E, 60), ...runwayPolls(value, 0, E + 30_000, 61)]])) }), 'J4');
    assertEqual(JSON.stringify(four(16_500).runwayMsByClient), JSON.stringify({ c01: 41_000, c02: 38_000, c03: 44_000, c04: 16_500 }), 'the lowest of each viewer is published');
    assertEqual(JSON.stringify([four(16_500).status, four(16_500).lowestRunwayMs]), '["met",16500]', '16 500 is over the bar');
    assertEqual(four(15_000).status, 'missed', 'one viewer at the bar misses the row');
    assertEqual(rowOf(readJoin({ polls: runways(15_000) }), 'J4').status, 'missed', 'exactly 15 seconds misses');
    assertEqual(rowOf(readJoin({ polls: Object.fromEntries(TAGS.slice(0, 4).map((tag) => [tag,
      [viewerPoll(E, 0, 41_000), viewerPoll(E + 2_001, 0, 41_000)]])) }), 'J4').status,
      'evidence-failure', 'a gap over 1 second is evidence failure');
    assertEqual(rowOf(readJoin({ polls: runways(41_000, 'room') }), 'J4').status, 'evidence-failure', 'room source is refused');
  });

  await check('10b H2: a before-window stall makes the leave row unreadable', async () => {
    const drift = Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, denseFrames(E - 60_000, E + 60_000, 5)]));
    const polls = { host: hostPolls(), ...Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, runwayPolls()])) };
    const reading = rosterEventReading({ condition: leaveCondition('leave-clean'), event: event('leave-clean'),
      presence: presence('leave-clean', 'c03', { includeTarget: false }), drift, polls, timebase: TIMEBASE });
    assertEqual(rowOf(reading, 'K1').status, 'unreadable', 'the before-window stall invalidates the room');
    assertEqual(rowOf(reading, 'K1').reason, 'before-window-not-clean', 'the refusal names the before window');
  });

  await check('10b: a silent leave is read from its issue, on past the presence frame', async () => {
    // Issued 8 000 ms before the room saw it. One viewer stalls 400 ms, 3 000 ms after the issue.
    const issued = E - 8_000;
    const stalled = denseFrames(E - 70_000, E + 60_000).filter((record) => record.displaySharedMs <= issued + 3_000 || record.displaySharedMs >= issued + 3_400)
      .map((record, index) => ({ ...record, seq: index + 1, presentedFrames: index + 1 }));
    const readRows = (kind) => rosterEventReading({ condition: leaveCondition(kind),
      event: event(kind, 'c03', { issuedAtHarnessMs: issued - TIMEBASE.offsetMs }), presence: presence(kind, 'c03', { includeTarget: false }),
      drift: Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, tag === 'c01' ? stalled : denseFrames(E - 70_000, E + 60_000)])),
      polls: { host: hostPolls(E - 70_000), ...Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, runwayPolls(20_000, 0, E - 8_000, 137)])) },
      segments: Object.fromEntries(TAGS.map((tag) => [tag, []])), timebase: TIMEBASE });
    const read = (kind) => rowOf(readRows(kind), 'K1');
    assertEqual(read('leave-silent').status, 'missed', 'a stall between the cut and the presence frame is after the event');
    assertEqual(read('leave-silent').intervals.c01.after.stalls[0].lengthMs, 400, 'and is published with its length');
    const supplierRows = readRows('leave-supplier-silent');
    assertEqual(rowOf(supplierRows, 'K1').status, 'missed', 'a supplier-silent leave uses the issue-time stall window');
    assertEqual(rowOf(supplierRows, 'K1').intervals.c01.after.stalls[0].lengthMs, 400,
      'a supplier-silent leave publishes the stall length');
    assert(!supplierRows.some((entry) => entry.reason === 'roster-event-kind-unsupported:leave-supplier-silent'),
      'a supplier-silent leave is a supported roster event kind');
    assertEqual(read('leave-clean').status, 'unreadable', 'the same stall before a clean leave is the before-window');
  });

  await check('10b H9: reassignment computes first fetchers through edgeRank and names the late segment', async () => {
    const condition = leaveCondition('leave-first', 15_000);
    const streams = Object.fromEntries(TAGS.map((tag) => [tag, []]));
    streams.c03 = [
      { path: '/media/seg-00002.m4s', mediaStartMs: 5_000 },
      { path: '/media/seg-00003.m4s', mediaStartMs: 6_000 },
      { path: '/media/seg-00007.m4s', mediaStartMs: 11_000 },
    ];
    streams.c01 = [
      { path: '/media/seg-00002.m4s', mediaStartMs: 5_000, completedAtMs: 6_800 },
      { path: '/media/seg-00007.m4s', mediaStartMs: 11_000, completedAtMs: 13_200 },
    ];
    const polls = { host: hostPolls(), ...Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag,
      runwayPolls(20_000, tag === 'c01' ? 0 : 20_000)])) };
    const asks = { c01: [{ index: 7, reason: 'fallback', rank: 1, atMs: 7_000 }] };
    const reading = rosterEventReading({ condition, event: event('leave-first'), presence: presence('leave-first', 'c03', { includeTarget: false }),
      drift: Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, frames(E, 140)])), polls, segments: streams, asks, timebase: TIMEBASE });
    assertEqual(rowOf(reading, 'K3').status, 'missed', 'the late segment misses');
    assertEqual(rowOf(reading, 'K3').missed[0].index, 7, 'the missed segment is named');
    assertEqual(rowOf(reading, 'K3').segments.filter((segment) => segment.viewer === 'c01').length, 2,
      'the leaver is first for exactly two segments in the horizon');
    // Wall 6 800 is shared 14 800 against a due instant of 15 000; wall 13 200 is 21 200 against 21 000.
    assertEqual(JSON.stringify(rowOf(reading, 'K3').segments.filter((segment) => segment.viewer === 'c01').map((segment) => segment.marginMs)),
      '[200,-200]', 'one finished 200 ms before the playhead and one 200 ms after');
    assertEqual(rowOf(reading, 'K3').missed.length, 1, 'only the late one is named');
    assertEqual(rowOf(reading, 'K3').segments[1].asks[0].reason, 'fallback', 'the host ask for it is published with its reason');
    const none = rosterEventReading({ condition, event: event('leave-first'), presence: presence('leave-first', 'c03', { includeTarget: false }),
      drift: Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, frames(E, 140)])),
      polls: { host: hostPolls(), ...Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, runwayPolls(20_000, 20_000)])) },
      segments: streams, asks, timebase: TIMEBASE });
    assertEqual(rowOf(none, 'K3').status, 'not-exercised', 'no segment of the leaver in any horizon is not exercised');
  });

  await check('10b H10: observed is re-derived from every other tag and emits no dependent row', async () => {
    const streams = presence('join');
    delete streams.c01;
    const reading = readJoin({ event: event('join', 'c05', { observed: false }), presence: streams });
    assertEqual(reading.length, 1, 'only the event refusal is emitted');
    assertEqual(reading[0].reason, 'roster-event-not-observed', 'the missing frame is not a miss of J1');
    assertEqual(reading[0].missingTags[0], 'c01', 'the missing tag is named');
    const claimed = readJoin({ event: event('join'), presence: { ...presence('join'), c01: [] } });
    assertEqual(JSON.stringify(claimed.map((entry) => entry.reason)), '["roster-event-not-observed"]',
      'an event the runner calls observed, with the receipt of one tab missing, is not observed and reads no row');
  });

  await check('10b H11: drop-socket publishes computed orders and equal identity/counters', async () => {
    const drop = event('drop-socket', 'c03', { leave: { seq: 7, recvSharedMs: E, clientId: 'old' },
      rejoin: { seq: 9, recvSharedMs: E + 5_000, clientId: 'new' } });
    const condition = leaveCondition('drop-socket');
    const polls = { host: hostPolls(), c03: [viewerPoll(E - 100, 0), viewerPoll(E + 5_100, 0)],
      ...Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, runwayPolls()])) };
    polls.c03[0].state = { lineage: 'lineage', version: 2 };
    polls.c03[1].state = { lineage: 'lineage', version: 2 };
    const pagePolls = { c03: [pagePoll(E - 100, 2), pagePoll(E + 5_100, 2)] };
    const reading = rosterEventReading({ condition, event: drop, presence: presence('drop-socket', 'c03', { includeTarget: false, rejoin: true }),
      drift: Object.fromEntries(TAGS.filter((tag) => tag !== 'c03').map((tag) => [tag, denseFrames()])), polls,
      pagePolls, timebase: TIMEBASE });
    assertEqual(rowOf(reading, 'S1').status, 'met', 'the same tab returns under a new client id');
    assertEqual(rowOf(reading, 'S1').orders.before.includes('c03-old'), true, 'the old member is in the before order');
    assertEqual(rowOf(reading, 'S1').orders.after.includes('new-client'), true, 'the new member is in the after order');
    assert(rowOf(reading, 'K1'), 'drop-socket also reads the other viewers\' stalls');
  });
}
