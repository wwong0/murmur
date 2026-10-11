import fs from 'node:fs';
import { assert, assertEqual, check } from '../harness.mjs';
import { PATCHED_HYBRID_LOADER } from '../../engine-patch.mjs';
import { spreadChoice } from '../../../public/lib/edge-assignment.mjs';
import {
  edgeSource,
  nextEdgeEpisode,
  urgentSource,
} from '../../../public/lib/urgent-source.mjs';
import { edgeRequestStep } from '../../../public/lib/edge-request.mjs';

const engineRequest = (flag, overrides = {}) => ({
  engineStarted: flag,
  status: 'not-started',
  ...overrides,
});

function e1Input(flag) {
  const spread = spreadChoice({
    selfPeerId: 'joiner',
    peers: [
      { id: 'z-holder', loaded: true, busy: false },
      { id: 'a-holder', loaded: true, busy: false },
    ],
    segmentIndex: 0,
    nowMs: 0,
    holdersRoseMs: 0,
  });
  return {
    edgeSource: { source: 'p2p', rank: 0 },
    spreadChoice: spread,
    request: engineRequest(flag),
    peerAvailable: true,
    canLoadThroughP2P: true,
  };
}

function e2Input(flag, atMs) {
  let episode = nextEdgeEpisode(null, { nowMs: 0, withinRunway: true, loaders: 1 });
  episode = nextEdgeEpisode(episode, { nowMs: 500, withinRunway: true, loaders: 0 });
  const decision = {
    ...edgeSource({
      nowMs: atMs,
      rank: 2,
      viewers: 3,
      holders: 0,
      loaders: 0,
      episode,
    }),
    rank: 2,
  };
  return {
    edgeSource: decision,
    request: engineRequest(flag),
    nowMs: atMs,
    canLoadThroughHttp: true,
    hostSlotFree: atMs >= 1_000,
  };
}

function e3Input(flag, busy) {
  const spread = spreadChoice({
    selfPeerId: 'joiner',
    peers: [{ id: 'holder', loaded: true, busy }],
    segmentIndex: 0,
    nowMs: 0,
    holdersRoseMs: 0,
  });
  return {
    edgeSource: { source: 'p2p', rank: 1 },
    spreadChoice: spread,
    request: engineRequest(flag),
    nowMs: 0,
    peerAvailable: !busy,
    canLoadThroughP2P: true,
    hostSlotFree: false,
  };
}

function action(input) {
  return edgeRequestStep(input);
}

function processQueueSource() {
  const source = fs.readFileSync(PATCHED_HYBRID_LOADER, 'utf8');
  const start = source.indexOf('const { engineRequest }');
  const end = source.indexOf('for (const item of queue)', start);
  return { source, engineBlock: source.slice(start, end) };
}

export default async function edgeRequestSuite() {
  await check('edge-request E1: an engine-started join request takes the spread choice', async () => {
    const input = e1Input(true);
    assertEqual(input.spreadChoice.holderId, 'a-holder', 'spread chooses the sorted holder');
    const result = action(input);
    assertEqual(result.do, 'peer', 'join request uses peer action');
    assertEqual(result.holderId, 'a-holder', 'join request uses spread holder');
    assert(result.holderId !== 'z-holder', 'join request does not use the first listed holder');
    // Prevention proof under CONSTRAINTS.md → Verification: opportunity is the
    // flagged request at the product decision boundary. Mutation: restore stock
    // loadThroughP2P in the block → the engine-patch assertion is red; return
    // the first holder → this E1 assertion is red. Restoration and green check
    // run are recorded in the worker report.
  });

  await check('edge-request E2: a kept seek waits for quiet rank order', async () => {
    const before = action(e2Input(true, 999));
    const at = action(e2Input(true, 1_000));
    assertEqual(before.do, 'wait', 'seek waits before the quiet wake');
    assertEqual(before.untilMs, 1_000, 'seek wakes at quiet instant plus 500 ms');
    assertEqual(at.do, 'host', 'seek asks host at the wake');
    assertEqual(at.reason, 'fallback-no-announcement', 'seek host reason');
    assertEqual(at.rank, 2, 'seek host rank');
  });

  await check('edge-request E3: a busy holder is rechecked, not skipped', async () => {
    const busy = action(e3Input(true, true));
    const free = action(e3Input(true, false));
    assertEqual(busy.do, 'recheck', 'busy holder rechecks');
    assertEqual(busy.untilMs, 500, 'busy holder recheck wake');
    assertEqual(free.do, 'peer', 'free holder is selected');
    assertEqual(free.holderId, 'holder', 'free holder id');
  });

  await check('edge-request E4: the engine-started flag does not change source rules', async () => {
    const cases = [
      e1Input,
      (flag) => e2Input(flag, 999),
      (flag) => e3Input(flag, true),
    ];
    for (const make of cases) {
      assertEqual(JSON.stringify(action(make(true))), JSON.stringify(action(make(false))), 'flagged and ordinary actions match');
    }
  });

  await check('edge-request E5: one product pass makes one decision', async () => {
    const { source, engineBlock } = processQueueSource();
    const productStart = source.indexOf('const urgent = this.edgeControl === "8b"');
    const productEnd = source.indexOf('} // wa-patch: finish product-control assignment', productStart);
    const productPass = source.slice(productStart, productEnd);
    assertEqual((engineBlock.match(/this\.edgeDecision\(/g) ?? []).length, 0, 'engine block does not decide product requests');
    assertEqual((productPass.match(/this\.edgeDecision\(/g) ?? []).length, 1, 'product pass decides once');
    // Prevention proof under CONSTRAINTS.md → Verification: opportunity is the
    // flagged segment's single processQueue pass. Mutation: leave the block's own
    // edgeDecision evaluation in → the engine-block count is 1 and E5 is red;
    // restoration and green check run are recorded in the worker report.
  });

  await check('edge-request: a peer transfer in flight keeps its arms', async () => {
    const loading = { status: 'loading', downloadSource: 'p2p' };
    const slow = { source: 'http', reason: 'fallback-slow-holder', rank: 1 };
    const switched = action({ edgeSource: slow, request: loading, canLoadThroughHttp: true, hostSlotFree: true });
    assertEqual(switched.do, 'host', 'a slow sole holder past its wake goes to the host');
    assertEqual(switched.cancel, true, 'the peer transfer is cancelled before the host re-issue');
    assertEqual(switched.reason, 'fallback-slow-holder', 'slow-holder reason');
    const fresh = action({ edgeSource: slow, request: engineRequest(false), canLoadThroughHttp: true, hostSlotFree: true });
    assertEqual(fresh.cancel, false, 'a request not in flight has nothing to cancel');
    assertEqual(action({ edgeSource: slow, request: loading, canLoadThroughHttp: true, hostSlotFree: false }).do, 'none', 'no host slot keeps the transfer');
    const move = { edgeSource: { source: 'move' }, spreadChoice: { holderId: 'spare' }, request: loading };
    assertEqual(action({ ...move, peerAvailable: true }).do, 'move', 'a slow transfer moves to a free spare holder');
    assertEqual(action({ ...move, peerAvailable: true }).holderId, 'spare', 'the move names the spare holder');
    assertEqual(action({ ...move, peerAvailable: false }).do, 'none', 'a busy spare holder cancels nothing');
    assertEqual(action({ edgeSource: { source: 'p2p' }, request: loading }).do, 'none', 'a healthy transfer is left alone');
    const waking = action({ edgeSource: { source: 'p2p', wakeMs: 4_200 }, request: loading });
    assertEqual(waking.do, 'wait', 'a slow sole holder arms its wake');
    assertEqual(waking.untilMs, 4_200, 'at the source rule\'s instant');
    assertEqual(action({ edgeSource: slow, request: { status: 'loading', downloadSource: 'http' }, canLoadThroughHttp: true, hostSlotFree: true }).do, 'none', 'a host transfer in flight is not re-decided');
  });

  await check('edge-request E6: the 8b engine-started control stays on its old source', async () => {
    const source = urgentSource({ nowMs: 0, waitStartMs: 0, delayMs: 0, budgetMs: 0 });
    const result = action({
      edgeSource: source,
      request: engineRequest(true),
      canLoadThroughHttp: true,
      hostSlotFree: true,
    });
    assertEqual(source.source, 'http', '8b source remains host');
    assertEqual(result.do, 'host', '8b engine request remains host');
  });
}
