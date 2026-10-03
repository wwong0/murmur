import { assert, assertEqual, check } from '../harness.mjs';
import { attachClockJoinRecorder } from '../../harness/cdp-records.mjs';
import { createControlEvidence, evidenceRefusals } from '../../harness/control-evidence.mjs';

function fakeTab(evaluate) {
  const listeners = new Map();
  return {
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => listeners.set(name, list.filter((entry) => entry !== handler));
    },
    emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); },
    evaluate,
  };
}

function writer() {
  const files = {};
  return { files, append(name, records) { (files[name] ??= []).push(...records); } };
}

export default async function controlEvidenceSuite() {
  await check('control evidence: joined frames retain the server shared receive instant', async () => {
    const tab = fakeTab(async () => null);
    const recorder = attachClockJoinRecorder(tab);
    tab.emit('Network.webSocketFrameReceived', {
      timestamp: 12, response: { payloadData: JSON.stringify({ type: 'joined', ts: { recv: 42_600 } }) },
    });
    assertEqual(recorder.snapshot().joined[0].cdpMs, 12_000, 'joined CDP time is retained');
    assertEqual(recorder.snapshot().joined[0].recvSharedMs, 42_600, 'joined receive time is retained');
    recorder.dispose();
  });

  await check('control evidence: evictions and sequence gaps refuse the run', async () => {
    const evicted = evidenceRefusals({ hostPace: { evicted: 3, records: [] }, resumes: { evicted: 0, records: [] } });
    assert(evicted.some((entry) => entry.reason === 'pace-evidence-evicted'), 'pace eviction is refused');
    const gap = evidenceRefusals({ hostPace: { evicted: 0, records: [{ seq: 5 }, { seq: 7 }] }, resumes: { evicted: 0, records: [] } });
    assert(gap.some((entry) => entry.reason === 'pace-evidence-seq-gap'), 'pace sequence gap is refused');
    const recomputed = evidenceRefusals({ hostPace: { evicted: 0, intervals: [{ seq: 1 }, { seq: 3 }] } });
    assert(recomputed.some((entry) => entry.reason === 'pace-evidence-seq-gap'), 'a recomputed pace input is read by its intervals');
  });

  await check('control evidence: hold refusals bind only a room with peer exchange', async () => {
    const playing = { state: { held: false, lineage: 'l', version: 1 } };
    const hostPoll = [{ state: null }, playing];
    const seek = { host: { held: false } };
    const reasonsOf = (input) => evidenceRefusals(input).map((entry) => entry.reason);
    assertEqual(reasonsOf({ hostPoll, seek }).join(), 'start-hold-unobserved,seek-hold-unobserved', 'a peer room refuses both');
    assertEqual(reasonsOf({ hostPoll, seek, peerExchange: false }).length, 0, 'a room that never holds refuses neither');
    assertEqual(reasonsOf({ hostPoll, peerExchange: false, hostPace: { evicted: 1, intervals: [] } }).join(),
      'pace-evidence-evicted', 'and its drains still bind');
    const held = [{ state: null }, { state: { held: true, lineage: 'l', version: 1 } }];
    assertEqual(reasonsOf({ hostPoll: held }).length, 0, 'the first observed state skips polls with no state yet');
  });

  await check('control evidence: the resuming state is the first later version, read as a play', async () => {
    // Attempt 2's start: held at version 2, resumed at version 8 — versions are
    // envelope seqs, so seven was never a state of the room.
    const record = { seq: 1, identity: { lineage: 'l', version: 2 } };
    const poll = (version, playing, held) => ({ state: { lineage: 'l', version, playing, held } });
    const reasonsOf = (hostPoll) => evidenceRefusals({ hostPoll, resumes: { records: [record] } }).map((entry) => entry.reason);
    assertEqual(reasonsOf([poll(2, false, true), poll(8, true, false)]).length, 0, 'a play at a non-consecutive version is the resume');
    assertEqual(reasonsOf([poll(2, false, true), poll(8, false, false), poll(9, true, false)]).join(), 'resume-effective-unobserved', 'a pause seen first hides the resume');
    assertEqual(reasonsOf([poll(2, false, true), poll(8, false, true)]).join(), 'resume-effective-unobserved', 'a held state seen first is not the resume');
    assertEqual(reasonsOf([poll(2, false, true)]).length, 0, 'no later state: the hold is unresumed, not refused');
    // Mutation probe, staged: control-evidence.mjs's rule restored to "a later
    // state exists at the held version + 1". `npm run check` turned 'a play at a
    // non-consecutive version is the resume' red (refused, as attempt 2 was).
    // Reverted; check green again.
  });

  await check('control evidence: host drains and viewer polls use fake tabs and clocks', async () => {
    const files = writer();
    let tick = 1_000;
    const host = { tab: fakeTab(async (expression) => {
      if (expression.includes('hostPace')) return { fraction: 0.85, estimate: { bytesPerSecond: 1_200_000, intervalsBehind: 1, linkBoundTotal: 5 }, paceBytesPerSecond: 1_020_000, intervals: expression.includes('(0)') ? [{ seq: 1, endWallMs: 1_000, durationMs: 1_000, paceBoundMs: 0 }] : [], evicted: 0 };
      if (expression.includes('resumes')) return { records: [], evicted: 0, malformedReports: 0 };
      return { pageMs: tick, pageWallMs: tick + 10, clock: { offsetMs: 5, halfWidthMs: 2 }, sharedMs: tick + 5, state: { held: true, lineage: 'l', version: 1, atSharedMs: tick } };
    }) };
    const viewer = { tag: 'c01', tab: fakeTab(async () => ({ heldAhead: { heldAheadMs: 4_000 }, state: { held: true }, clock: { halfWidthMs: 2 } })) };
    const control = createControlEvidence({ hostSession: host, ndjson: files, now: () => tick });
    await control.pollHost();
    await control.pollHost();
    await control.pollViewer(viewer);
    assertEqual(files.files['host-control-poll.ndjson'].length, 2, 'host polls are written');
    // The fake returns the product's own shape: the ring under `intervals`, no latest seq.
    assertEqual(files.files['host-pace.ndjson'].length, 1, 'the cursor advances past a drained interval');
    assertEqual(files.files['host-pace.ndjson'][0].seq, 1, 'pace record is drained');
    assertEqual(control.finalize().hostPaceFinal.intervals.length, 1, 'the final pace carries the drained intervals');
    assertEqual(files.files['viewer-control-c01.ndjson'].length, 1, 'viewer poll is written');
  });
}
