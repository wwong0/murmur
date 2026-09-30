// T8 (design.md D3; tasks.md 3.4): the resume rule, pure, then its host driver
// through the entry harness. `createHoldResume()` takes every instant as an
// argument — every scenario below drives it by hand, no timer anywhere.

import { assert, assertEqual, check } from '../harness.mjs';
import { createHoldResume } from '../../../public/lib/hold-resume.mjs';
import { TYPE_AHEAD } from '../../../public/lib/envelope.mjs';
import { bundleProductEntry, runEntry } from '../entry-harness.mjs';

function heldState({ atSharedMs = 0, lineage = 'L', version = 1 } = {}) {
  return { lineage, version, current: { playing: false, atSharedMs, mediaMs: 0, held: true } };
}

function viewer(clientId, tabId = clientId) {
  return { clientId, tabId, role: 'viewer' };
}

function host(clientId = 'host-1') {
  return { clientId, tabId: 'h', role: 'host' };
}

function report(lineage, version, heldAheadMs) {
  return { lineage, version, heldAheadMs };
}

async function drain() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export default async function holdResumeSuite() {
  await check('hold-resume: every viewer ready resumes, once the roster has settled', async () => {
    const hr = createHoldResume();
    const st = heldState({ atSharedMs: 1000, lineage: 'L', version: 5 });
    const roster = [viewer('v1'), viewer('v2')];
    const first = hr.evaluate({ nowSharedMs: 1000, state: st, roster, reports: {} });
    assertEqual(first, null, 'not ready before the roster settles');
    const result = hr.evaluate({
      nowSharedMs: 3000,
      state: st,
      roster,
      reports: { v1: report('L', 5, 4000), v2: report('L', 5, 5000) },
    });
    assert(result, 'ready once settled and every viewer reports enough held-ahead');
    assertEqual(result.cause, 'ready', 'cause is ready');
    assertEqual(JSON.stringify(result.identity), JSON.stringify({ lineage: 'L', version: 5 }), 'identity names the held state');
    assertEqual(JSON.stringify(result.viewers), JSON.stringify({
      v1: { tabId: 'v1', heldAheadMs: 4000 },
      v2: { tabId: 'v2', heldAheadMs: 5000 },
    }), 'viewers map carries each tabId and heldAheadMs');
  });

  await check('hold-resume: one viewer short of a report keeps the room held past the settle', async () => {
    const hr = createHoldResume();
    const st = heldState();
    const roster = [viewer('v1'), viewer('v2')];
    hr.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    const result = hr.evaluate({
      nowSharedMs: 5000,
      state: st,
      roster,
      reports: { v1: report('L', 1, 6000) },
    });
    assertEqual(result, null, 'one viewer short of a report is neither ready nor yet at the bound');
  });

  await check('hold-resume: a silent viewer still resumes at the 10s safety bound', async () => {
    const hr = createHoldResume();
    const st = heldState();
    const roster = [viewer('v1')];
    hr.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    const result = hr.evaluate({ nowSharedMs: 10_000, state: st, roster, reports: {} });
    assert(result, 'a silent viewer still resumes at the safety bound');
    assertEqual(result.cause, 'bound', 'cause is bound, not ready');
  });

  await check('hold-resume: a roster change restarts the settle window', async () => {
    const hr = createHoldResume();
    const st = heldState();
    hr.evaluate({ nowSharedMs: 0, state: st, roster: [viewer('v1')], reports: {} });
    const reports = { v1: report('L', 1, 9000), v2: report('L', 1, 9000) };
    hr.evaluate({ nowSharedMs: 1000, state: st, roster: [viewer('v1'), viewer('v2')], reports });
    const tooSoon = hr.evaluate({ nowSharedMs: 2999, state: st, roster: [viewer('v1'), viewer('v2')], reports });
    assertEqual(tooSoon, null, 'not settled 1,999ms after the roster changed, though every viewer already reports enough');
    const settled = hr.evaluate({ nowSharedMs: 3000, state: st, roster: [viewer('v1'), viewer('v2')], reports });
    assert(settled, 'settled 2,000ms after the roster changed');
    assertEqual(settled.cause, 'ready', 'cause is ready');
  });

  await check('hold-resume: a host alone, with no viewer ever, never resumes', async () => {
    const hr = createHoldResume();
    const st = heldState();
    const roster = [host()];
    for (const nowSharedMs of [0, 5000, 10_000, 20_000, 100_000]) {
      assertEqual(hr.evaluate({ nowSharedMs, state: st, roster, reports: {} }), null, `no viewers ever, at ${nowSharedMs}ms`);
    }
  });

  await check('hold-resume prevention claim: a stale report does not count', async () => {
    const hr = createHoldResume();
    const st = heldState({ atSharedMs: 0, lineage: 'L', version: 5 });
    const roster = [viewer('v1')];
    hr.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    const result = hr.evaluate({
      nowSharedMs: 5000, // past the 2s settle, short of the 10s bound
      state: st,
      roster,
      reports: { v1: report('L', 4, 30_000) }, // stale: version - 1, held-ahead well over the ready bar
    });
    assertEqual(result, null, 'a report for a stale version does not count toward readiness');
    // Mutation probe: staged, then the identity match in `evaluate`'s per-viewer
    // report lookup (`report.lineage === identity.lineage && report.version ===
    // identity.version`) narrowed to drop the version half, so a report for any
    // version of the same lineage counted. `npm run check` turned this check's
    // 'a report for a stale version does not count toward readiness' assertion
    // red (an object, not null — the stale report wrongly satisfied readiness).
    // Reverted; check green again.
  });

  await check('hold-resume: 4,000ms held-ahead is ready; 3,999ms is not', async () => {
    const st = heldState();
    const roster = [viewer('v1')];
    const notReady = createHoldResume();
    notReady.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    assertEqual(
      notReady.evaluate({ nowSharedMs: 2000, state: st, roster, reports: { v1: report('L', 1, 3999) } }),
      null,
      'the 3,999 case is not ready',
    );

    const ready = createHoldResume();
    ready.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    const result = ready.evaluate({ nowSharedMs: 2000, state: st, roster, reports: { v1: report('L', 1, 4000) } });
    assert(result, 'the 4,000 case is ready');
    // Mutation probe: staged, then the readiness comparison in `evaluate`
    // (`heldAheadMs !== null && heldAheadMs >= READY_HELD_AHEAD_MS`) changed
    // `>=` to `>`. `npm run check` turned 'the 4,000 case is ready' red (null,
    // not a truthy result). Reverted; check green again.
  });

  await check('hold-resume: a settle of 1,999ms is not ready; 2,000ms is', async () => {
    const st = heldState();
    const reports = { v1: report('L', 1, 9000), v2: report('L', 1, 9000) };
    const hr = createHoldResume();
    hr.evaluate({ nowSharedMs: 0, state: st, roster: [viewer('v1')], reports: {} });
    hr.evaluate({ nowSharedMs: 1000, state: st, roster: [viewer('v1'), viewer('v2')], reports }); // the roster changes here
    assertEqual(
      hr.evaluate({ nowSharedMs: 2999, state: st, roster: [viewer('v1'), viewer('v2')], reports }),
      null,
      'the 1,999 case (1,999ms after the roster changed) is not settled',
    );
    const result = hr.evaluate({ nowSharedMs: 3000, state: st, roster: [viewer('v1'), viewer('v2')], reports });
    assert(result, 'the 2,000 case is settled');
    // Mutation probe: staged, then the roster-settle comparison in `evaluate`
    // (`nowSharedMs - rosterChangedAtSharedMs >= ROSTER_SETTLE_MS`) had its
    // right-hand side replaced by the constant `1_000`. `npm run check` turned
    // 'the 1,999 case (1,999ms after the roster changed) is not settled' red
    // (an object, not null). Reverted; check green again.
  });

  await check('hold-resume: bound fires at base+10,000ms, not at base+9,999ms', async () => {
    const st = heldState();
    const roster = [viewer('v1')];
    const hr = createHoldResume();
    hr.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    assertEqual(hr.evaluate({ nowSharedMs: 9999, state: st, roster, reports: {} }), null, 'the 9,999 case has not bounded yet');
    const result = hr.evaluate({ nowSharedMs: 10_000, state: st, roster, reports: {} });
    assert(result, 'the 10,000 case bounds');
    assertEqual(result.cause, 'bound', 'cause is bound');
    // Mutation probe: staged, then the bound comparison in `evaluate`
    // (`nowSharedMs - boundBaseSharedMs >= BOUND_MS`) had its right-hand side
    // replaced by the constant `5_000`. `npm run check` turned 'the 9,999 case
    // has not bounded yet' red (an object, not null). Reverted; check green
    // again.
  });

  await check('hold-resume: the bound anchors to when the viewer joined, not only to when the hold took effect', async () => {
    const st = heldState({ atSharedMs: 0 });
    const hr = createHoldResume();
    hr.evaluate({ nowSharedMs: 0, state: st, roster: [], reports: {} }); // the hold takes effect with nobody watching
    hr.evaluate({ nowSharedMs: 4000, state: st, roster: [viewer('v1')], reports: {} }); // the viewer joins 4s later
    const atEffectivePlusBound = hr.evaluate({ nowSharedMs: 10_000, state: st, roster: [viewer('v1')], reports: {} });
    assertEqual(atEffectivePlusBound, null, 'not bound yet at effective+10,000ms — only 6,000ms since the viewer joined');
    const atJoinPlusBound = hr.evaluate({ nowSharedMs: 14_000, state: st, roster: [viewer('v1')], reports: {} });
    assert(atJoinPlusBound, 'bounds at join+10,000ms');
    // Mutation probe: staged, then `boundBaseSharedMs` in `evaluate` changed
    // from `Math.max(heldAtSharedMs, viewerSince ?? heldAtSharedMs)` to
    // `heldAtSharedMs` alone. `npm run check` turned 'not bound yet at
    // effective+10,000ms — only 6,000ms since the viewer joined' red (an
    // object, not null). Reverted; check green again.
  });

  await check('hold-resume: once per identity — a successful issue suppresses evaluation for 3,000ms', async () => {
    const st = heldState();
    const roster = [viewer('v1')];
    const reports = { v1: report('L', 1, 9000) };
    const hr = createHoldResume();
    hr.evaluate({ nowSharedMs: 0, state: st, roster, reports: {} });
    const first = hr.evaluate({ nowSharedMs: 2000, state: st, roster, reports });
    assert(first, 'first evaluation is ready');
    hr.issued(first.identity, true, 2000);
    const second = hr.evaluate({ nowSharedMs: 2250, state: st, roster, reports });
    assertEqual(second, null, 'a second evaluation at +250ms is suppressed');
    const third = hr.evaluate({ nowSharedMs: 5000, state: st, roster, reports });
    assert(third, 'evaluation resumes once 3,000ms have passed');
    // A failed issue leaves no memory: the very next evaluation may try again.
    hr.issued(third.identity, false, 5000);
    const fourth = hr.evaluate({ nowSharedMs: 5001, state: st, roster, reports });
    assert(fourth, 'a failed issue does not suppress the next evaluation');
    // Mutation probe: staged, then the `suppressedUntil` lookup at the top of
    // `evaluate` (`if (suppressUntil !== undefined && nowSharedMs < suppressUntil)
    // return null;`) dropped entirely. `npm run check` turned 'a second
    // evaluation at +250ms is suppressed' red (an object, not null). Reverted;
    // check green again.
  });

  const product = await bundleProductEntry();

  await check('hold-resume entry: a settled, ready viewer gets exactly one play, and the ring holds one ready record', async () => {
    const page = runEntry(product.code, { settings: { delivery: 'host', trackerUrl: 'ws://tracker.test:1', iceServers: [] } });
    await drain();
    const timeline = page.resolveSole({ clientId: 'host-1', nowMs: 10_000 });
    assert(timeline, 'the host resolves its own held creation');
    const created = page.app.playbackState();
    assertEqual(created.held, true, 'the sole host creates a held room');

    page.harness.sharedNowMs = 10_000;
    page.tick(); // establishes the roster baseline with no viewers yet

    page.harness.roster = [
      { clientId: 'host-1', tabId: 'h', role: 'host', joinedAt: 1 },
      { clientId: 'v1', tabId: 'v', role: 'viewer', joinedAt: 2 },
    ];
    page.deliver({ type: TYPE_AHEAD, from: 'v1', payload: { lineage: created.lineage, version: created.version, heldAheadMs: 4000 } });
    page.harness.sharedNowMs = 10_050;
    page.tick(); // the viewer's arrival restarts the settle window

    page.harness.sharedNowMs = 12_050;
    page.tick(); // 2,000ms later: settled, and the one viewer is ready

    const plays = page.sent().filter((entry) => entry.payload?.kind === 'play');
    assertEqual(plays.length, 1, 'exactly one play operation is sent');
    const resumes = page.app.resumes();
    assertEqual(resumes.records.length, 1, 'the resume ring holds exactly one record');
    assertEqual(resumes.records[0].cause, 'ready', 'the record names the ready cause');
    assertEqual(resumes.malformedReports, 0, 'the one delivered report was well-formed');
  });
}
