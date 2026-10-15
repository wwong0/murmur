import { assert, assertEqual, check } from '../harness.mjs';
import fs from 'node:fs';
import { hostAskDecidedAtMs, hostSlotVictim, noteHostAsk, readHostAsks } from '../../../public/lib/urgent-source.mjs';
import { PATCHED_HYBRID_LOADER } from '../../engine-patch.mjs';

const common = Object.freeze({
  index: 17,
  path: '/media/17.ts',
  startMs: 68_000,
  rank: 2,
  decidedAtMs: 1_700_000_000_000,
  atMs: 1_700_000_000_000,
});

function thrown(action) {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

export default async function edgeAsksSuite() {
  await check('edge-asks: records round-trip and filter by sequence', async () => {
    const before = readHostAsks();
    noteHostAsk({ ...common, reason: 'first' });
    const after = readHostAsks(before.latestSeq);
    assertEqual(after.records.length, 1, 'one record round-trips');
    assertEqual(JSON.stringify(after.records[0]), JSON.stringify({ seq: before.latestSeq + 1, index: common.index, path: common.path, startMs: common.startMs, reason: 'first', rank: common.rank, decidedAtMs: common.decidedAtMs, atMs: common.atMs }), 'every record field round-trips');
    const filtered = readHostAsks(after.records[0].seq);
    assertEqual(filtered.records.length, 0, 'afterSeq excludes the matching record');
    after.records[0].path = '/mutated';
    assertEqual(readHostAsks(before.latestSeq).records[0].path, common.path, 'records are copied');
  });

  await check('edge-asks: the ring evicts the oldest record and reports the count', async () => {
    const before = readHostAsks();
    for (let index = 0; index < 1_024; index += 1) {
      noteHostAsk({ ...common, index, reason: 'first', atMs: common.atMs + index });
    }
    const result = readHostAsks(before.latestSeq);
    assertEqual(result.records.length, 1_024, 'ring retains its capacity');
    assertEqual(result.records[0].index, 0, 'ring evicts the first record');
    // Prevention proof: opportunity is 1,025 valid records crossing the ring's
    // 1,024-record boundary; action boundary is `readHostAsks`. Mutation:
    // drop `evicted` from the returned object. Named red: `ring eviction count`
    // (undefined, not 1). Restore with git checkout -- and rerun green.
    assertEqual(result.evicted - before.evicted, 1, 'ring eviction count');
  });

  await check('edge-asks: invalid reason and missing reason are refused', async () => {
    const missing = thrown(() => noteHostAsk({ ...common }));
    const invalid = thrown(() => noteHostAsk({ ...common, reason: 'other' }));
    // Prevention proof: opportunity is a host-ask boundary receiving a missing
    // or unknown reason; action boundary is `noteHostAsk`. Mutation: accept every
    // reason without the six-value guard. Named red: `missing reason is refused`
    // and `unknown reason is refused`. Restore with git checkout -- and rerun green.
    assert(missing instanceof TypeError, 'missing reason is refused');
    assert(invalid instanceof TypeError, 'unknown reason is refused');
    assert(thrown(() => noteHostAsk({ ...common, decidedAtMs: undefined })) instanceof TypeError, 'missing decided instant is refused');
    assert(thrown(() => noteHostAsk({ ...common, decidedAtMs: common.atMs + 1 })) instanceof TypeError, 'a decision after the ask is refused');
  });

  await check('edge-asks: a waited decision keeps its earlier instant', async () => {
    const atMs = 1_700_000_002_800;
    assertEqual(hostAskDecidedAtMs({ timeOriginMs: 1_700_000_000_000, decisionMs: 2_000, passMs: 2_800, atMs }), 1_700_000_002_000, 'an ask that waited keeps its 800 ms earlier decision');
    assertEqual(hostAskDecidedAtMs({ timeOriginMs: 1_700_000_000_000, decisionMs: 2_800, passMs: 2_800, atMs }), atMs, 'a same-pass decision uses its start instant');
    assertEqual(hostAskDecidedAtMs({ timeOriginMs: 1_700_000_000_000, passMs: 2_800, atMs }), atMs, 'a control ask without an episode uses its start instant');
    // Prevention proof: opportunity is an ask after an 800 ms wait; action
    // boundary is `hostAskDecidedAtMs`. Mutation: always return atMs. Named red:
    // `an ask that waited keeps its 800 ms earlier decision`.
  });

  await check('edge-asks: an 8b ask, with no pass instant, publishes its start instant', async () => {
    const atMs = 1_700_000_002_800;
    assertEqual(hostAskDecidedAtMs({ timeOriginMs: 1_700_000_000_000, atMs }), atMs, 'an archived 8b ask is not refused');
    const loader = fs.readFileSync(PATCHED_HYBRID_LOADER, 'utf8');
    assert(loader.includes('this.noteHostAsk(segment, urgent); // wa-patch: record the 8b urgent host load'), 'the 8b call site passes no pass instant');
    // Joint D1 F1: the 8b call sites pass no passMs. Mutation: validate passMs
    // before the decisionMs test. Named red: `an archived 8b ask is not refused`.
  });

  await check('edge-asks: the product branch takes a decision instant only outside a host load', async () => {
    const loader = fs.readFileSync(PATCHED_HYBRID_LOADER, 'utf8');
    const from = loader.indexOf('if (this.edgeControl !== "8b") { // wa-patch: product control assigns high-demand peers');
    const branch = loader.slice(from, loader.indexOf('// wa-patch: finish product-control assignment', from));
    const skip = branch.indexOf('if (loading && !loadingFromP2P) continue;');
    const set = branch.indexOf('wait.hostDecisionMs ??= now;');
    assert(from > 0 && skip > 0, 'the product branch and its host-load skip are found');
    assert(set > skip, 'the decision instant is set after a loading host request is skipped');
    assert(branch.includes('delete wait.hostDecisionMs;'), 'another source ends the decision run');
    assert(branch.includes('this.noteHostAsk(segment, step, now);'), 'the ask carries its decision pass');
    assert(/noteHostAsk\(segment, decision, passMs\)[\s\S]*?delete wait\.hostDecisionMs;/.test(loader), 'publishing an ask ends the decision run');
    // Prevention proof: opportunity is a pass while a host load is in flight;
    // mutation: set the instant before the skip. Named red: `the decision
    // instant is set after a loading host request is skipped`.
  });

  await check('edge-asks: fallback reasons distinguish the three fallback paths', async () => {
    const before = readHostAsks();
    const reasons = ['fallback-no-announcement', 'fallback-no-holder', 'fallback-slow-holder'];
    for (const reason of reasons) noteHostAsk({ ...common, reason });
    const records = readHostAsks(before.latestSeq).records;
    const shared = ['index', 'path', 'startMs', 'rank', 'decidedAtMs', 'atMs'];
    const projected = records.map((record) => Object.fromEntries(shared.map((key) => [key, record[key]])));
    assertEqual(records.map((record) => record.reason).join(','), reasons.join(','), 'fallback reasons are published');
    assertEqual(new Set(projected.map((record) => JSON.stringify(record))).size, 1, 'fallback records agree in every other field');
  });

  // The 2026-10-05 browser pass: a viewer's near-zone host load was cancelled for
  // its own urgent fallback and asked for again, two host copies of one segment.
  await check('edge-asks: an earlier segment never takes the host slot of a high-demand host load', async () => {
    const far = { loadingFromHost: true, highDemand: false };
    const near = { loadingFromHost: true, highDemand: true };
    const idle = { loadingFromHost: false, highDemand: false };
    assertEqual(hostSlotVictim([near, near]), -1, 'two high-demand host loads leave no victim');
    assertEqual(hostSlotVictim([near, far, near]), 1, 'the far host load is the victim, past a later high-demand one');
    assertEqual(hostSlotVictim([far, idle, far]), 2, 'the last far host load goes first, as the stock scan');
    assertEqual(hostSlotVictim([idle, { loadingFromHost: false, highDemand: true }]), -1, 'nothing loading from the host leaves no victim');
    assertEqual(hostSlotVictim(), -1, 'an empty tail leaves no victim');
    const loader = fs.readFileSync(PATCHED_HYBRID_LOADER, 'utf8');
    const from = loader.indexOf('if (this.edgeControl !== "8b") { // wa-patch: product control assigns high-demand peers');
    const to = loader.indexOf('// wa-patch: finish product-control assignment');
    assert(from > 0 && to > from, 'the product-control branch is found in the carried loader');
    const branch = loader.slice(from, to);
    assert(!branch.includes('abortLastHttpLoadingInQueueAfterItem'), 'the product-control branch never frees a host slot by the stock scan');
    assertEqual(branch.split('this.edgeFreeHostSlot(queue, segment)').length - 1, 2, 'both of its host answers free a slot through the rule');
    // Mutation probes, each staged, mutated, red, restored, green: dropping
    // the rule's `highDemand` test turns 'two high-demand host loads leave no
    // victim' red (1 against -1); putting the stock scan back at the product host
    // answer turns the two loader assertions red.
  });
}
