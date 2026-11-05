import { assert, assertEqual, check } from '../harness.mjs';
import {
  PEER_WAIT_HELD_LIMIT_MS,
  PEER_WAIT_LIMIT_MS,
  drawUrgentDelay,
  setUrgentContext,
  setUrgentRandom,
  urgentBudgetMs,
  urgentPeerWaitMs,
  urgentSource,
} from '../../../public/lib/urgent-source.mjs';

const base = Object.freeze({ nowMs: 0, waitStartMs: 0, delayMs: 0, budgetMs: 3_000 });
const result = (overrides) => urgentSource({ ...base, ...overrides });

function simulate(draws, { latencyMs = 50, loadedAtMs = 1_300 } = {}) {
  const starts = draws.map((delayMs) => ({ delayMs, host: false, p2p: false }));
  let hostLoads = 0;
  for (let nowMs = 0; nowMs <= loadedAtMs; nowMs += 10) {
    const announcements = starts.map((start) => ({
      loading: start.host && nowMs >= latencyMs,
      loaded: start.host && nowMs >= loadedAtMs,
    }));
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      if (start.host || start.p2p) continue;
      const others = announcements.filter((_announcement, other) => other !== index);
      const decision = result({
        nowMs,
        delayMs: start.delayMs,
        holders: others.filter((announcement) => announcement.loaded).length,
        loaders: others.filter((announcement) => announcement.loading).length,
      });
      if (decision.source === 'http') {
        start.host = true;
        hostLoads += 1;
      } else if (decision.source === 'p2p' && others.some((announcement) => announcement.loaded)) {
        start.p2p = true;
      }
    }
  }
  return { hostLoads, starts };
}

export default async function urgentSourceSuite() {
  await check('urgent-source: a holder wins over the host', async () => {
    assertEqual(result({ holders: 1 }).source, 'p2p', 'holder source');
    // Prevention proof: opportunity is an urgent segment with a loaded peer and
    // no local request; action boundary is the source result. Mutation: remove
    // the `if (holders > 0)` branch. Named red: `holder source`. Restored and
    // rerun green before this suite was handed off.
  });

  await check('urgent-source: no holder waits for its draw then uses HTTP', async () => {
    assertEqual(result({ delayMs: 400, nowMs: 399 }).source, 'wait', 'draw is still pending');
    assertEqual(result({ delayMs: 400, nowMs: 400 }).source, 'http', 'draw boundary uses HTTP');
  });

  await check('urgent-source: a failed peer transfer falls back to HTTP', async () => {
    assertEqual(result({ holders: 1, p2pFailed: true }).source, 'http', 'failed transfer source');
    // Prevention proof: opportunity is a failed peer attempt while a holder is
    // still announced; action boundary is the fallback source. Mutation: remove
    // the `p2pFailed` branch. Named red: `failed transfer source`. Restored and
    // rerun green before this suite was handed off.
  });

  await check('urgent-source: a loading peer waits through the budget, 6 s in a held room', async () => {
    assertEqual(result({ loaders: 1, nowMs: PEER_WAIT_LIMIT_MS - 1 }).source, 'wait', 'loader waits before limit');
    assertEqual(result({ loaders: 1, nowMs: PEER_WAIT_LIMIT_MS - 1 }).untilMs, PEER_WAIT_LIMIT_MS, 'loader wait boundary');
    assertEqual(result({ loaders: 1, nowMs: PEER_WAIT_LIMIT_MS }).source, 'http', 'loader uses HTTP at limit');
    // 38ac6c6: the held room's budget, through the call the queue makes.
    assertEqual(PEER_WAIT_HELD_LIMIT_MS, 6_000, 'the held limit is 6 s');
    assertEqual(PEER_WAIT_LIMIT_MS, 3_000, 'the playing limit stays 3 s');
    setUrgentContext({ held: true, roomMediaMs: 0 });
    const heldRoom = { held: true, loaders: 1, budgetMs: urgentBudgetMs(0) };
    setUrgentContext();
    assertEqual(result({ ...heldRoom, nowMs: 5_999 }).source, 'wait', 'a held room still waits on a loader at 5 999 ms');
    assertEqual(result({ ...heldRoom, nowMs: 5_999 }).untilMs, 6_000, 'and wakes at 6 000 ms');
    assertEqual(result({ ...heldRoom, nowMs: 6_000 }).source, 'http', 'a held room goes to the host at 6 000 ms');
    // Mutation probe, staged: urgentPeerWaitMs returning PEER_WAIT_LIMIT_MS when
    // held, as before 38ac6c6. `npm run check` turned 'a held room still waits on a
    // loader at 5 999 ms' red (http). Reverted; check green again.
  });

  await check('urgent-source: delay never exceeds a zero budget', async () => {
    assertEqual(result({ delayMs: 400, budgetMs: 0 }).source, 'http', 'zero budget uses HTTP immediately');
    assertEqual(result({ delayMs: 400, budgetMs: 3_000, nowMs: 399 }).source, 'wait', 'bounded draw waits');
    // Prevention proof: opportunity is a 400ms draw with a zero budget; action
    // boundary is the first source decision. Mutation: replace
    // `Math.min(delayMs, budgetMs)` with `delayMs`. Named red: `zero budget uses
    // HTTP immediately`. Restored and rerun green before this suite was handed off.
  });

  await check('urgent-source: a progressing peer is switched in a playing room only, a budget after its transfer began', async () => {
    assertEqual(result({ p2pLoading: true, nowMs: PEER_WAIT_LIMIT_MS - 1 }).source, 'p2p', 'progressing peer before budget');
    assertEqual(result({ p2pLoading: true, nowMs: PEER_WAIT_LIMIT_MS }).source, 'http', 'progressing peer at budget');
    // Prevention proof: opportunity is a progressing peer at both sides of its
    // budget; action boundary is the source switch. Mutation: make the
    // `p2pLoading` branch always return `p2p`. Named red: `progressing peer at
    // budget`. Restored and rerun green before this suite was handed off.
    // Second protection proof: opportunity is the same peer one millisecond
    // early; action boundary is the pre-budget result. Mutation: gate the stock
    // switch without the budget (`nowMs >= spentAt`). Named red: `progressing
    // peer before budget`. Restored and rerun green before this suite was handed off.

    // 38ac6c6. Attempt 3's seek: the viewer waited 2 890 ms on a
    // loader, its peer transfer began, and the budget cut it 110 ms later.
    const late = { p2pLoading: true, waitStartMs: 0, p2pStartMs: 2_890 };
    assertEqual(result({ ...late, nowMs: 3_000 }).source, 'p2p', 'a playing room does not charge the transfer for the wait before it');
    assertEqual(result({ ...late, nowMs: 5_889 }).source, 'p2p', 'the transfer has its budget from its own start');
    assertEqual(result({ ...late, nowMs: 5_890 }).source, 'http', 'and is switched when that is spent');
    const heldLate = { ...late, held: true, budgetMs: PEER_WAIT_HELD_LIMIT_MS };
    assertEqual(result({ ...heldLate, nowMs: 3_000 }).source, 'p2p', 'a held room keeps a progressing transfer past 3 s');
    assertEqual(result({ ...heldLate, nowMs: 2_890 + PEER_WAIT_HELD_LIMIT_MS }).source, 'p2p', 'and past its 6 s wait budget');
    assertEqual(result({ ...heldLate, nowMs: 60_000 }).source, 'p2p', 'it ends on completion or the engine\'s timeout, not here');
    assertEqual(result({ ...heldLate, p2pLoading: false, p2pFailed: true, nowMs: 60_000 }).source, 'http', 'a transfer the engine timed out goes to the host');
    // Mutation probe, staged: the `held === true ||` term removed. `npm run check`
    // turned 'and past its 6 s wait budget' red (http). Reverted; green. Second
    // probe, staged: `p2pStartMs + budgetMs` put back to `spentAt`. Turned 'a
    // playing room does not charge the transfer for the wait before it' red
    // (http). Reverted; check green again.
  });

  await check('urgent-source: a transfer from a peer that holds the segment is never switched to the host', async () => {
    // A playing viewer at or behind the room has no budget; the rule
    // started its transfer from a holder and the next pass cut it for the host.
    const behind = { p2pLoading: true, holders: 1, budgetMs: 0, p2pStartMs: 10 };
    assertEqual(result({ ...behind, nowMs: 10 }).source, 'p2p', 'a holder is kept with no budget');
    assertEqual(result({ p2pLoading: true, holders: 1, nowMs: 60_000 }).source, 'p2p', 'a holder is kept past a spent budget');
    assertEqual(result({ p2pLoading: true, holders: 0, loaders: 1, nowMs: PEER_WAIT_LIMIT_MS }).source, 'http', 'a transfer with no holder left keeps the budget');
    assertEqual(result({ holders: 1, p2pFailed: true, nowMs: 60_000 }).source, 'http', 'a transfer the engine timed out still goes to the host');
    // The patched queue arms its wake from `wakeMs`. A wake already past would
    // re-enter the queue on every pass for as long as the transfer runs.
    assertEqual(result({ ...behind, nowMs: 10 }).wakeMs, undefined, 'no wake once the budget is spent');
    assertEqual(result({ p2pLoading: true, nowMs: 100 }).wakeMs, PEER_WAIT_LIMIT_MS, 'a wake at the budget\'s end while it runs');
    assertEqual(result({ p2pLoading: true, held: true, nowMs: 100 }).wakeMs, undefined, 'a held room arms no wake');
    // Red before the repair: 'a holder is kept with no budget' (http).
  });

  await check('urgent-source: one host copy serves a later waiting viewer', async () => {
    const shared = simulate([0, 400]);
    assertEqual(shared.hostLoads, 1, 'one host load for staggered viewers');
    assert(shared.starts[1].p2p, 'later viewer loads from the first viewer');
    const collision = simulate([0, 30]);
    assertEqual(collision.hostLoads, 2, 'draws inside announcement latency make two host loads');
    // Prevention proof: opportunity is the same landing segment with one load
    // announcement delayed by 50ms and the loaded transition at 1300ms; action
    // boundary is the host-load count. Mutation: ignore `loaders`. Named red:
    // `one host load for staggered viewers`. Restored and rerun green before this
    // suite was handed off. The paired [0, 30] fixture agrees on segment, budget,
    // latency and loaded time, differing only in the second draw.
  });

  await check('urgent-source: held-ahead supplies the peer wait budget', async () => {
    assertEqual(urgentPeerWaitMs({ held: false, segmentStartMs: 6_000, roomMediaMs: 2_000 }), 2_500, '4000ms held-ahead leaves 2500ms');
    assertEqual(urgentPeerWaitMs({ held: false, segmentStartMs: 3_500, roomMediaMs: 2_500 }), 0, '1000ms held-ahead leaves no wait');
    assertEqual(urgentPeerWaitMs({ held: true, segmentStartMs: 0, roomMediaMs: 0 }), PEER_WAIT_HELD_LIMIT_MS, 'held room uses its fixed limit');
    assertEqual(urgentPeerWaitMs({ held: false, segmentStartMs: 60_000, roomMediaMs: 0 }), PEER_WAIT_LIMIT_MS, 'a playing room never waits past 3 s');
    // Prevention proof: opportunity is a playing room with 4000ms held-ahead;
    // action boundary is the computed budget. Mutation: return the fixed limit
    // for every non-held room. Named red: `4000ms held-ahead leaves 2500ms`.
    // Restored and rerun green before this suite was handed off.
  });

  await check('urgent-source: the budget uses the harness-adjusted room position', async () => {
    const baseBudget = urgentPeerWaitMs({ held: false, segmentStartMs: 64_000, roomMediaMs: 60_000 });
    const offsetBudget = urgentPeerWaitMs({ held: false, segmentStartMs: 64_000, roomMediaMs: 120_000 });
    assertEqual(baseBudget, 2_500, 'unoffset room position');
    assertEqual(offsetBudget, 0, 'offset room position');
    // Prevention proof: opportunity is the same segment and state with a
    // 60,000ms harness offset; action boundary is budget arithmetic. Mutation:
    // drop `roomMediaMs` from the subtraction. Named red: `offset room position`.
    // Restored and rerun green before this suite was handed off.
  });

  await check('urgent-source: the patched queue budgets each segment from the page context', async () => {
    setUrgentContext({ held: false, roomMediaMs: 2_000 });
    assertEqual(urgentBudgetMs(6_000), 2_500, 'playing room budgets from the segment start');
    assertEqual(urgentBudgetMs(Number.NaN), 0, 'a segment without a start time goes to the host');
    setUrgentContext({ held: true, roomMediaMs: 2_000 });
    assertEqual(urgentBudgetMs(6_000), PEER_WAIT_HELD_LIMIT_MS, 'held room uses its fixed limit');
    setUrgentContext();
    // Prevention proof: opportunity is the patched queue's call, which
    // passes only the segment's start. Action boundary: urgentBudgetMs. Mutation:
    // budget from the context alone, as first written. Named red: `playing room
    // budgets from the segment start` (it threw). Restored and read green.
  });

  await check('urgent-source: random draws are fixed only when the page supplies one', async () => {
    setUrgentRandom(() => 0.8);
    assertEqual(drawUrgentDelay(), 400, 'supplied random draw');
    setUrgentRandom();
  });
}
