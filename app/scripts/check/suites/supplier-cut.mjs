import vm from 'node:vm';

import { assert, assertEqual, check } from '../harness.mjs';
import { issueRosterEvent as issueRunnerRosterEvent, finalizeRosterEvent } from '../../harness/roster-event.mjs';
import { removesMember } from '../../harness/roster-kinds.mjs';
import { issueRosterEvent as issueSessionRosterEvent } from '../../harness/run-sessions.mjs';
import { chooseSupplier, supplierReadingExpression, waitForSupplier } from '../../harness/supplier-cut.mjs';

const http = (index, extra = {}) => ({ attemptId: index, path: `/media/seg-${String(index).padStart(5, '0')}.m4s`,
  startMs: 80_000, endMs: 90_000, end: 'loaded', bytes: 100, source: 'http', ...extra });
const reading = (wallMs, playheadSegment, attempts) => ({ wallMs, playheadSegment, attempts });

export default async function supplierCutSuite() {
  await check('13c: supplier selection chooses the highest eligible segment and tie-breaks by tag', async () => {
    const readings = {
      c01: reading(100_000, 35, [http(40)]),
      c02: reading(100_000, 35, [http(42)]),
      c03: reading(100_000, 35, []),
      c04: reading(100_000, 35, []),
      c05: reading(100_000, 35, []),
    };
    const choice = chooseSupplier(readings);
    assertEqual(choice.victim, 'c02', 'the highest eligible segment supplies the cut');
    assertEqual(choice.segment.index, 42, 'the selected segment index is retained');
    assertEqual(choice.segment.path, readings.c02.attempts[0].path, 'the selected segment path is retained');

    const notAhead = chooseSupplier({ c01: reading(100_000, 40, [http(40)]), c02: reading(100_000, 40, []) });
    assertEqual(notAhead.victim, null, 'an attempt at another viewer\'s playhead is not a candidate');

    const ended = chooseSupplier({ c01: reading(100_000, null, [http(42, { endMs: 89_999 })]) });
    assertEqual(ended.victim, null, 'an attempt ended 10,001 ms ago is not active');
    const open = chooseSupplier({ c01: reading(100_000, null, [http(42, { endMs: null, open: true })]) });
    assertEqual(open.victim, 'c01', 'an open attempt remains active');

    const tie = chooseSupplier({ c02: reading(100_000, null, [http(42)]), c01: reading(100_000, null, [http(42)]) });
    assertEqual(tie.victim, 'c01', 'equal segment indexes choose the lowest tag');
  });

  await check('13c: supplier reading expression carries page wall time, playhead and HTTP attempts', async () => {
    const value = vm.runInNewContext(supplierReadingExpression(2), {
      Date: { now: () => 100_004 },
      document: { querySelector: () => ({ currentTime: 84 }) },
      __app: { peerBytes: () => ({ open: [{ attemptId: 1, path: '/media/seg-00042.m4s', source: 'http', startMs: 99_000, bytesSoFar: 7 },
        { attemptId: 2, path: '/media/seg-00043.m4s', source: 'p2p', startMs: 99_000 }], records: [
          { kind: 'attempt', attemptId: 3, path: '/media/seg-00041.m4s', source: 'http', startMs: 88_000, endMs: 95_000, end: 'loaded', bytes: 9 },
          { kind: 'attempt', attemptId: 4, path: '/media/seg-00040.m4s', source: 'http', startMs: 80_000, endMs: 89_999, end: 'loaded', bytes: 8 },
        ] }) },
    });
    assertEqual(value.wallMs, 100_004, 'the expression reads Date.now once');
    assertEqual(value.playheadSegment, 42, 'the playhead is converted to a segment for selection');
    assertEqual(value.attempts.length, 2, 'only open or recent HTTP attempts are retained');
    assertEqual(value.attempts[0].open, true, 'open attempts are marked open');
    assertEqual(value.attempts[1].attemptId, 3, 'the recent completed attempt is retained');
  });

  await check('13c: supplier polling retries through 30 seconds and preserves the final choice', async () => {
    let nowMs = 0;
    let reads = 0;
    const result = await waitForSupplier({
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
      read: async () => { reads += 1; return { c01: reading(nowMs, 100, []) }; },
    });
    assertEqual(reads, 31, 'the initial read plus one read per second covers 30 seconds');
    assertEqual(result.victim, null, 'no candidate has no victim');
    assertEqual(result.reason, 'no-active-supplier', 'the refusal names the absent supplier');
    assertEqual(result.reads.length, 31, 'all supplier readings are retained');
  });

  await check('13c: a supplier cut is a leave and never cuts without a victim', async () => {
    let cuts = 0;
    const condition = { clients: 2, rosterEvent: { kind: 'leave-supplier-silent' } };
    const noVictim = await issueRunnerRosterEvent({ condition, targetSession: null, selection: {
      victim: null, candidates: [], playheads: {}, reads: [],
    }, cutNetwork: async () => { cuts += 1; } });
    assertEqual(cuts, 0, 'no supplier means no interface cut');
    assertEqual(noVictim.victim, null, 'the event records no victim');
    assertEqual(noVictim.reason, 'no-active-supplier', 'the event records the refusal reason');
    assertEqual(finalizeRosterEvent(noVictim, [], null), noVictim, 'a null victim is finalized unchanged');

    const selection = { victim: 'c02', segment: { index: 42, path: '/media/seg-00042.m4s' }, candidates: [], playheads: {} };
    const victim = await issueRunnerRosterEvent({ condition, targetSession: { tag: 'c02' }, client: 'c02', selection,
      cutNetwork: async ({ tag }) => { cuts += 1; return { tag }; } });
    assertEqual(cuts, 1, 'a selected supplier is cut once');
    assertEqual(victim.victim, 'c02', 'the selected client is recorded as victim');
    assert(removesMember('leave-supplier-silent'), 'the supplier cut removes the member');
  });

  await check('13c: the session driver passes a no-supplier selection to the event writer', async () => {
    let cuts = 0;
    const state = { rosterEvent: null };
    const result = await issueSessionRosterEvent({
      condition: { content: { segmentSeconds: 2 }, rosterEvent: { kind: 'leave-supplier-silent' } },
      topology: {}, room: 'room', sessions: [{ tag: 'c01', role: 'viewer', active: true, tab: { evaluate: async () => ({}) } }],
      runDir: null, state, waitForSupplierImpl: async () => ({ victim: null, candidates: [], playheads: {}, reads: [] }),
      segmentSeconds: 2,
      stopSessionLoops: async () => {},
    });
    assertEqual(cuts, 0, 'the driver does not cut while the selection has no victim');
    assertEqual(result.victim, null, 'the driver returns the unreadable event');
  });
}
