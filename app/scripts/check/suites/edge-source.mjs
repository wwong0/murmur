import { assert, assertEqual, check } from '../harness.mjs';
import {
  EDGE_RECHECK_MS,
  EDGE_STEP_MS,
  PEER_WAIT_HELD_LIMIT_MS,
  PEER_WAIT_LIMIT_MS,
  edgeSource,
  nextEdgeEpisode,
  urgentSource,
} from '../../../public/lib/urgent-source.mjs';

const next = (prev, values) => nextEdgeEpisode(prev, { withinRunway: true, ...values });

function runFiveViewers() {
  const viewers = 5;
  const starts = Array.from({ length: viewers }, (_unused, rank) => ({ rank, hostAt: null, p2pAt: null }));
  const episodes = Array(viewers).fill(null);
  const decisions = [];
  for (let nowMs = 0; nowMs <= 1_300; nowMs += 10) {
    const announcements = starts.map((start) => ({
      loading: start.hostAt !== null && nowMs >= start.hostAt + 100,
      loaded: start.hostAt !== null && nowMs >= start.hostAt + 1_300,
    }));
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      if (start.hostAt !== null || start.p2pAt !== null) continue;
      const others = announcements.filter((_announcement, other) => other !== index);
      const holders = others.filter((announcement) => announcement.loaded).length;
      const loaders = others.filter((announcement) => announcement.loading).length;
      episodes[index] = next(episodes[index], { nowMs, holders, loaders });
      const decision = edgeSource({
        nowMs,
        rank: index,
        viewers,
        held: false,
        p2pLoading: false,
        p2pFailed: false,
        slow: false,
        holders,
        otherHolders: holders,
        loaders,
        episode: episodes[index],
      });
      if (decision.source === 'http') {
        start.hostAt = nowMs;
        decisions.push({ rank: index, ...decision });
      } else if (decision.source === 'p2p' && holders > 0) {
        start.p2pAt = nowMs;
      }
    }
  }
  return { starts, decisions };
}

function announcementDisappears() {
  let episode = next(null, { nowMs: 0, loaders: 1 });
  episode = next(episode, { nowMs: 2_000, loaders: 0 });
  const values = { rank: 2, viewers: 4, held: false, holders: 0, loaders: 0, episode };
  return {
    before: edgeSource({ nowMs: 2_499, ...values }),
    at: edgeSource({ nowMs: 2_500, ...values }),
  };
}

export default async function edgeSourceSuite() {
  await check('edge-source: five viewers make one host ask', async () => {
    const result = runFiveViewers();
    const hostAsks = result.decisions.filter((decision) => decision.source === 'http');
    const peerViewers = result.starts.filter((start) => start.p2pAt !== null).map((start) => start.rank);
    assertEqual(hostAsks.length, 1, 'host asks = 1');
    assertEqual(hostAsks[0].rank, 0, 'rank 0 asks first');
    assertEqual(hostAsks[0].reason, 'first', 'first host ask reason');
    assertEqual(peerViewers.join(','), '1,2,3,4', 'other viewers finish on p2p');
    // Opportunity is five viewers sharing one segment; the boundary is the host
    // ask set. Mutation: rule 8 answers HTTP for every rank. Named red: `host
    // asks = 1` (five). Restoration with git checkout -- and rerun was green.
  });

  await check('edge-source: a progressing loader holds a playing waiter', async () => {
    const episode = next(null, { nowMs: 0, loaders: 1 });
    const decisions = [];
    for (let nowMs = 0; nowMs < PEER_WAIT_LIMIT_MS; nowMs += 10) {
      decisions.push(edgeSource({ nowMs, rank: 1, viewers: 5, holders: 0, loaders: 1, episode }));
    }
    assertEqual(decisions.every((decision) => decision.source === 'wait'), true, 'wait at every step before 3 000 ms');
    assertEqual(decisions.every((decision) => decision.untilMs === PEER_WAIT_LIMIT_MS), true, 'the wait boundary stays at 3 000 ms');
  });

  await check('edge-source: silent loader waiters fall back one rank at a time', async () => {
    const episode = next(null, { nowMs: 0, loaders: 1 });
    const atThree = [1, 2, 3, 4].map((rank) => edgeSource({
      nowMs: 3_000, rank, viewers: 5, holders: 0, loaders: 1, episode,
    }));
    const at5999 = [1, 2, 3, 4].map((rank) => edgeSource({
      nowMs: 5_999, rank, viewers: 5, holders: 0, loaders: 1, episode,
    }));
    const rankTwoAtSix = edgeSource({ nowMs: 6_000, rank: 2, viewers: 5, holders: 0, loaders: 1, episode });
    assertEqual(atThree[0].reason, 'fallback-no-holder', 'rank 1 asks at 3 000 ms');
    assertEqual(atThree.slice(1).every((decision) => decision.source === 'wait'), true, 'ranks 2 through 4 wait at 3 000 ms');
    assertEqual(at5999.slice(1).every((decision) => decision.source === 'wait'), true, 'ranks 2 through 4 wait at 5 999 ms');
    assertEqual(rankTwoAtSix.reason, 'fallback-no-holder', 'rank 2 asks at 6 000 ms');
  });

  await check('edge-source: an unannounced first fetcher is replaced at 250 ms', async () => {
    const episode = next(null, { nowMs: 0 });
    const firstReplacement = edgeSource({ nowMs: 250, rank: 1, viewers: 5, holders: 0, loaders: 0, episode });
    const later = [2, 3, 4].map((rank) => edgeSource({
      nowMs: 1_300, rank, viewers: 5, holders: 1, loaders: 0, episode,
    }));
    assertEqual(firstReplacement.reason, 'fallback-no-announcement', 'rank 1 asks at 250 ms');
    assertEqual(later.every((decision) => decision.source === 'p2p'), true, 'later ranks use the holder');
  });

  await check('edge-source: held waits are staggered by six seconds', async () => {
    const episode = next(null, { nowMs: 0, loaders: 1 });
    const instants = [1, 2, 3, 4].map((rank) => {
      const decision = edgeSource({ nowMs: 0, rank, viewers: 5, held: true, holders: 0, loaders: 1, episode });
      return decision.untilMs;
    });
    assertEqual(instants.join(','), '6000,12000,18000,24000', 'held wait instants');
    assertEqual(Math.min(...instants.slice(1).map((at, index) => at - instants[index])), PEER_WAIT_HELD_LIMIT_MS, 'held waits have no collision');
    // Opportunity is four held waiters on one never-finishing loader; the
    // boundary is their complete instant set. Mutation: use 1 × W for every
    // rank. Named red: `held wait instants` (6 000,6 000,6 000,6 000).
    // Restoration with git checkout -- and rerun was green.
  });

  await check('edge-source: stage two starts from the later runway instant', async () => {
    let episode = next(null, { nowMs: 0, withinRunway: false, loaders: 1 });
    episode = next(episode, { nowMs: 8_000, withinRunway: true, loaders: 1 });
    const rankOne = edgeSource({ nowMs: 8_000, rank: 1, viewers: 5, holders: 0, loaders: 1, episode });
    const rankOneAtLimit = edgeSource({ nowMs: 11_000, rank: 1, viewers: 5, holders: 0, loaders: 1, episode });
    const rankTwoAtLimit = edgeSource({ nowMs: 14_000, rank: 2, viewers: 5, holders: 0, loaders: 1, episode });
    assertEqual(rankOne.untilMs, 11_000, 'rank 1 asks at 11 000 ms');
    assertEqual(rankOneAtLimit.reason, 'fallback-no-holder', 'rank 1 host boundary');
    assertEqual(rankTwoAtLimit.reason, 'fallback-no-holder', 'rank 2 asks at 14 000 ms');
    // Opportunity is a loader seen at 0 whose segment enters the runway at
    // 8 000; the boundary is rank 1's wake. Mutation: use loaderSinceMs alone.
    // Named red: `rank 1 asks at 11 000 ms` (3 000). Restoration with git
    // checkout -- and rerun was green.
  });

  await check('edge-source: a late rank-zero fetcher waits as the last rank', async () => {
    const episode = next(null, { nowMs: 0, loaders: 1 });
    const decision = edgeSource({ nowMs: 0, rank: 0, viewers: 5, holders: 0, loaders: 1, episode });
    assertEqual(decision.untilMs, 15_000, 'late-first-fetcher wait');
    // Opportunity is rank 0 arriving after a loader announcement; the boundary
    // is its wait instant. Mutation: use rank unchanged for effective rank. Named
    // red: `late-first-fetcher wait` (host at 0). Restoration with git checkout --
    // and rerun was green.
  });

  await check('edge-source: a quiet episode restarts its stagger at disappearance', async () => {
    const decisions = announcementDisappears();
    assertEqual(decisions.before.untilMs, 2_500, 'rank 2 waits until 2 500 ms');
    assertEqual(decisions.at.reason, 'fallback-no-announcement', 'rank 2 asks at 2 500 ms');
    // Opportunity is an announcement disappearing at 2 000 ms; the boundary is
    // rank 2's host decision. Mutation: never update quietSinceMs. Named red:
    // `rank 2 asks at 2 500 ms` (HTTP at 500). Restoration with git checkout --
    // and rerun was green.
  });

  await check('edge-source: J1 keeps a progressing peer transfer', async () => {
    const decisions = [0, 3_000, 60_000].map((nowMs) => edgeSource({
      nowMs, rank: 2, viewers: 5, p2pLoading: true, slow: false,
    }));
    assertEqual(decisions.every((decision) => decision.source === 'p2p'), true, 'J1 stays p2p after 3 000 ms');
    assertEqual(decisions.every((decision) => decision.wakeMs === undefined), true, 'J1 does not arm a budget wake');
    // Opportunity is one progressing peer sampled before and after 3 000 ms; the
    // boundary is the source result. Mutation: answer HTTP after a 3 000 ms
    // budget. Named red: `J1 stays p2p after 3 000 ms` (HTTP at 60 000). Restoration
    // with git checkout -- and rerun was green.
  });

  await check('edge-source: failed peer transfers use the host', async () => {
    const decision = edgeSource({ nowMs: 0, rank: 1, viewers: 2, p2pFailed: true });
    assertEqual(decision.source, 'http', 'failed peer source');
    assertEqual(decision.reason, 'fallback-peer-failed', 'failed peer reason');
  });

  await check('edge-source: the earlier control sends every edge request to HTTP', async () => {
    const decisions = Array.from({ length: 5 }, () => urgentSource({
      nowMs: 0, waitStartMs: 0, delayMs: 0, budgetMs: 0,
    }));
    assertEqual(decisions.filter((decision) => decision.source === 'http').length, 5, '8b host asks at the edge');
  });

  await check('edge-source: no-runway episodes recheck instead of inventing a stage-two instant', async () => {
    const episode = next(null, { nowMs: 0, withinRunway: false, loaders: 1 });
    const decision = edgeSource({ nowMs: 0, rank: 1, viewers: 5, holders: 0, loaders: 1, episode });
    assertEqual(decision.untilMs, EDGE_RECHECK_MS, 'no-runway recheck');
    assertEqual(EDGE_STEP_MS, 250, 'edge step is 250 ms');
  });
}
