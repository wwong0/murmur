import { assert, assertEqual, check } from '../harness.mjs';
import {
  SPREAD_START_ANYWAY_MS,
  SPREAD_ANCHOR_SEGMENT_MS,
  spreadChoice,
  spreadStartAnywayMs,
} from '../../../public/lib/edge-assignment.mjs';
import {
  SLOW_MIN_AGE_MS,
  SLOW_RATE_BYTES_PER_S,
  SLOW_WINDOW_MS,
  edgeSource,
  transferIsSlow,
} from '../../../public/lib/urgent-source.mjs';

const ids = ['H', 'a', 'b', 'c', 'd'];

function peersFor(selfPeerId, loaded, busy = []) {
  return ids
    .filter((id) => id !== selfPeerId)
    .map((id) => ({ id, loaded: loaded.has(id), busy: busy.includes(id) }));
}

function choiceFor(selfPeerId, loaded, { nowMs = 0, holdersRoseMs = 0, segmentIndex = 0, segmentDurationMs, busy = [] } = {}) {
  return spreadChoice({
    selfPeerId,
    peers: peersFor(selfPeerId, loaded, busy),
    segmentIndex,
    segmentDurationMs,
    nowMs,
    holdersRoseMs,
  });
}

function relaySimulation() {
  const loadedAt = new Map([['H', 0]]);
  const servedBy = [];
  const assignments = [];
  const starts = [
    { atMs: 0, id: 'a', holder: 'H' },
    { atMs: 1_200, id: 'b', holder: 'H' },
    { atMs: 1_200, id: 'c', holder: 'a' },
    { atMs: 2_400, id: 'd', holder: 'H' },
  ];
  for (const start of starts) {
    const loaded = new Set([...loadedAt].filter(([_id, atMs]) => atMs <= start.atMs).map(([id]) => id));
    const choice = choiceFor(start.id, loaded, { nowMs: start.atMs, holdersRoseMs: start.atMs });
    assert('holderId' in choice || choice.none === true || 'waitUntilMs' in choice, `${start.id} choice shape`);
    assignments.push({ ...start, choice });
    servedBy.push(choice.holderId);
    loadedAt.set(start.id, start.atMs + 1_100);
  }
  const announcements = [...loadedAt].map(([id, atMs]) => ({ id, atMs: atMs + 100 }));
  const lastHolderAtMs = Math.max(...announcements.map(({ atMs }) => atMs));
  return { assignments, lastHolderAtMs, servedBy };
}

const slowSamples = [
  { atMs: 0, bytes: 100_000 },
  { atMs: 1_000, bytes: 200_000 },
  { atMs: 2_000, bytes: 300_000 },
  { atMs: 3_000, bytes: 400_000 },
];

const healthySamples = Array.from({ length: 6 }, (_unused, index) => ({
  atMs: index * 1_000,
  bytes: 100_000 + index * 280_000,
}));

export default async function edgeSpreadSuite() {
  await check('edge-spread: start-anyway scales with segment duration', async () => {
    assertEqual(spreadStartAnywayMs(1_000), 375, 'one second waits 375 ms');
    assertEqual(spreadStartAnywayMs(2_000), 750, 'two seconds waits 750 ms');
    assertEqual(spreadStartAnywayMs(3_000), 1_125, 'three seconds waits 1 125 ms');
    assertEqual(spreadStartAnywayMs(SPREAD_ANCHOR_SEGMENT_MS), SPREAD_START_ANYWAY_MS, 'four seconds uses the full wait');
    assertEqual(spreadStartAnywayMs(7_000), SPREAD_START_ANYWAY_MS, 'longer segments stay at the cap');
    assertEqual(spreadStartAnywayMs(0), SPREAD_START_ANYWAY_MS, 'zero duration uses the default');
    assertEqual(spreadStartAnywayMs(Number.NaN), SPREAD_START_ANYWAY_MS, 'non-finite duration uses the default');
    const short = choiceFor('d', new Set(['H']), { nowMs: 374, holdersRoseMs: 0, segmentDurationMs: 1_000 });
    const due = choiceFor('d', new Set(['H']), { nowMs: 375, holdersRoseMs: 0, segmentDurationMs: 1_000 });
    assert('holderId' in due, 'one second starts at 375 ms');
    assertEqual(short.waitUntilMs, 375, 'one second waits until 375 ms');
    // Prevention proof: opportunity is a one-second segment's waiter at 375 ms;
    // action boundary is `spreadChoice`. Mutation: compare elapsed with the
    // constant. Named red: `one second starts at 375 ms`.
  });

  await check('edge-spread: a second holder serves a waiter', async () => {
    const result = relaySimulation();
    const hostServedCount = result.servedBy.filter((holderId) => holderId === 'H').length;
    assert(hostServedCount >= 1, 'the original holder serves at least one waiter');
    // Opportunity is one holder relaying to four waiters with 1 100 ms transfers
    // and 100 ms announcements; the boundary is the complete served-by-H count.
    // Mutation: spreadChoice always answers holders[0]. Named red: `served by H`
    // (four, above the two-sided 1..3 boundary). Restoration with git checkout --
    // and rerun was green.
    assert(hostServedCount <= 3, 'served by H is at most three');
    const nonHostAssignments = result.assignments.filter(({ choice }) => choice.holderId !== 'H');
    assert(nonHostAssignments.length >= 1, 'at least one waiter uses a non-host holder');
    assert(result.lastHolderAtMs <= 3_700, 'last waiter holds by 3 700 ms');
  });

  await check('edge-spread: two holders divide three waiters', async () => {
    const first = spreadChoice({
      selfPeerId: 'a',
      peers: [{ id: 'H', loaded: true, busy: false }, { id: 'Z', loaded: true, busy: false }, { id: 'b', loaded: false, busy: false }, { id: 'c', loaded: false, busy: false }],
      segmentIndex: 0,
      nowMs: 0,
      holdersRoseMs: 0,
    });
    const second = spreadChoice({
      selfPeerId: 'b',
      peers: [{ id: 'H', loaded: true, busy: false }, { id: 'Z', loaded: true, busy: false }, { id: 'a', loaded: false, busy: false }, { id: 'c', loaded: false, busy: false }],
      segmentIndex: 0,
      nowMs: 0,
      holdersRoseMs: 0,
    });
    const third = spreadChoice({
      selfPeerId: 'c',
      peers: [{ id: 'H', loaded: true, busy: false }, { id: 'Z', loaded: true, busy: false }, { id: 'a', loaded: false, busy: false }, { id: 'b', loaded: false, busy: false }],
      segmentIndex: 0,
      nowMs: 0,
      holdersRoseMs: 0,
    });
    assertEqual(first.holderId !== second.holderId, true, 'places zero and one use different holders');
    assertEqual(third.waitUntilMs, SPREAD_START_ANYWAY_MS, 'place two waits');
  });

  await check('edge-spread: start-anyway waits and restarts after a rise', async () => {
    const initial = choiceFor('d', new Set(['H']), { nowMs: 0, holdersRoseMs: 0 });
    const restarted = choiceFor('d', new Set(['H']), { nowMs: 1_000, holdersRoseMs: 0 });
    const atRise = choiceFor('d', new Set(['H', 'a']), { nowMs: 1_500, holdersRoseMs: 1_100 });
    const afterRestart = choiceFor('d', new Set(['H', 'a']), { nowMs: 2_600, holdersRoseMs: 1_100 });
    assertEqual(initial.waitUntilMs, 1_500, 'one holder wait ends at 1 500 ms');
    assertEqual(restarted.waitUntilMs, 1_500, 'wait remains anchored before the rise');
    assertEqual(atRise.waitUntilMs, 2_600, 'wait restarts from 1 100 ms');
    assert('holderId' in afterRestart, 'a holder is selected at the restarted instant');
    assertEqual(afterRestart.holderId, 'H', 'restarted wait selects a holder');
    // Opportunity is place three waiting behind one holder whose count rises at
    // 1 100 ms; the boundary is the new 2 600 ms instant. Mutation: count from
    // the first holder only. Named red: `wait restarts from 1 100 ms` (selects
    // too early). Restoration with git checkout -- and rerun was green.
  });

  await check('edge-spread: busy holders are skipped', async () => {
    const peers = [
      { id: 'H', loaded: true, busy: true },
      { id: 'Z', loaded: true, busy: false },
      { id: 'b', loaded: false, busy: false },
      { id: 'c', loaded: false, busy: false },
    ];
    const skipped = spreadChoice({ selfPeerId: 'a', peers, segmentIndex: 0, nowMs: 0, holdersRoseMs: 0 });
    const none = spreadChoice({
      selfPeerId: 'a',
      peers: peers.map((peer) => peer.id === 'Z' ? { ...peer, busy: true } : peer),
      segmentIndex: 0,
      nowMs: 0,
      holdersRoseMs: 0,
    });
    assertEqual(skipped.holderId, 'Z', 'busy first holder is skipped');
    assertEqual(none.none, true, 'all busy holders return none');
  });

  await check('edge-spread: slow transfers leave only when a peer can take over', async () => {
    const slow = transferIsSlow({ nowMs: 2_500, startedMs: 0, samples: slowSamples });
    const healthy = transferIsSlow({ nowMs: 5_000, startedMs: 0, samples: healthySamples });
    const moved = edgeSource({
      nowMs: 500,
      rank: 2,
      viewers: 4,
      p2pLoading: true,
      slow,
      otherHolders: 1,
      episode: { slowSinceMs: 0 },
    });
    assertEqual(slow, true, '100 000 bytes per second for 2 000 ms is slow');
    assertEqual(moved.source, 'move', 'a slow holder with another holder moves');
    assertEqual(healthy, false, '280 000 bytes per second is healthy');
    // Opportunity is a slow transfer with a second holder, versus the lowest
    // healthy 8b rate; the boundary is the rate result and `move`. Mutation:
    // transferIsSlow returns true once age reaches 2 000 ms regardless of rate.
    // Named red: `280 000 bytes per second is healthy`. Restoration with git
    // checkout -- and rerun was green.
  });

  await check('edge-spread: minimum age gates slow detection', async () => {
    const before = transferIsSlow({ nowMs: 4_499, startedMs: 2_500, samples: slowSamples });
    const atLimit = transferIsSlow({ nowMs: 4_500, startedMs: 2_500, samples: slowSamples });
    assertEqual(atLimit, true, 'age 2 000 ms is slow');
    // The pair differs only in nowMs and startedMs inputs; the opportunity is a
    // sampled trickle with a valid 2 000 ms window, and the boundary is age. Mutation:
    // remove the minimum-age test. Named red: `age 1 999 ms is not slow`. Restoration
    // with git checkout -- and rerun was green.
    assertEqual(before, false, 'age 1 999 ms is not slow');
  });

  await check('edge-spread: a slow sole holder keeps playing before fallback', async () => {
    const common = {
      rank: 2,
      viewers: 4,
      p2pLoading: true,
      slow: true,
      otherHolders: 0,
      episode: { slowSinceMs: 0 },
    };
    const beforeWake = edgeSource({ ...common, nowMs: 400 });
    const atWake = edgeSource({ ...common, nowMs: 500 });
    const held = edgeSource({ ...common, nowMs: 500, held: true });
    const progressing = edgeSource({ ...common, nowMs: 60_000, slow: false });
    assertEqual(beforeWake.source, 'p2p', 'slow playing holder stays p2p before wake');
    assertEqual(beforeWake.wakeMs, 500, 'slow playing holder wakes at slowSince plus 500 ms');
    assertEqual(atWake.reason, 'fallback-slow-holder', 'slow playing holder falls back at wake');
    assertEqual(held.source, 'p2p', 'held slow holder stays p2p');
    assertEqual(progressing.source, 'p2p', 'a healthy progressing transfer stays p2p');
    // Opportunity is the same slow sole-holder input in playing and held states;
    // the boundary is the held decision. Mutation: remove T3.4 rule 3's held guard.
    // Named red: `held slow holder stays p2p`. Restoration with git checkout -- and
    // rerun was green.
  });

  await check('edge-spread: transfer windows need an old sample and progress', async () => {
    const noOldSample = transferIsSlow({
      nowMs: 2_500,
      startedMs: 0,
      samples: [{ atMs: 1_000, bytes: 100_000 }, { atMs: 2_000, bytes: 200_000 }],
    });
    const noProgress = transferIsSlow({
      nowMs: 2_500,
      startedMs: 0,
      samples: [{ atMs: 0, bytes: 100_000 }, { atMs: 2_000, bytes: 100_000 }],
    });
    assertEqual(noOldSample, false, 'no sample 2 000 ms old is not slow');
    assertEqual(noProgress, true, 'a trickle below the rate is slow');
    assertEqual(SLOW_RATE_BYTES_PER_S, 160_000, 'slow rate is 160 000 bytes per second');
    assertEqual(SLOW_WINDOW_MS, 2_000, 'slow window is 2 000 ms');
    assertEqual(SLOW_MIN_AGE_MS, 2_000, 'slow minimum age is 2 000 ms');
  });
}
