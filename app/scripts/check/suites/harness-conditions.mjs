import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, check } from '../harness.mjs';
import { clientReadyTimeoutMs, conditions, runHarness } from '../../harness-run.mjs';
import { harnessChromeFlags } from '../../../harness/chrome-flags.mjs';

// P7 opportunity: delivery is read before preparation; mutation: remove the
// requireDeclaredDelivery call; named red assertion: "P7 missing delivery
// refuses before topology"; restoration: reverted by hand to staged tree;
// green rerun: npm run check.
// P8 opportunity: Chrome feature switches are assembled in one place; mutation:
// append a second disable-features switch; named red assertion: "P8 one feature
// switch has both names"; restoration: reverted by hand to staged tree; green
// rerun: npm run check.
// F2 opportunity: a host run that stops after the ready merge, manifest read from
// disk; mutation: restore the old `topology: {status: 'ready', qdiscs}` merge;
// named red assertion: "F2 ready manifest keeps controlUdpDrop"; restoration:
// git checkout of the staged tree; green rerun: npm run check.
// F2 guard opportunity: the same run with one read-back omitted; mutations:
// delete readyTopology's controlUdpDrop throw, then separately its
// mediaDefaultRoute throw; named red assertions: "F2 missing controlUdpDrop
// aborts naming it", "F2 missing mediaDefaultRoute read-back for c01 aborts
// naming it"; restoration: git checkout of the staged tree; green rerun: npm run check.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RESULTS = path.join(ROOT, 'results');

// A host run stopped right after the ready merge: no origin URL, so it aborts
// there with the manifest on disk, before any client is acquired.
async function hostRunToReady(label, preparedTopology) {
  const condition = structuredClone(conditions.shakedown['hostorigin-qual']);
  const runDir = path.join(RESULTS, `check-${label}-${process.pid}-${Date.now()}`);
  let thrown = null;
  try {
    await runHarness({
      conditionName: condition.name,
      condition,
      runDir,
      topology: { prepare: async () => structuredClone(preparedTopology), applyQdiscs: async () => [], teardown: async () => {} },
    });
  } catch (error) {
    thrown = error;
  }
  try {
    return { thrown, manifest: JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function hostRigMeasures(condition = conditions.shakedown['hostorigin-qual']) {
  const names = ['origin', ...Array.from({ length: condition.clients }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)];
  return {
    containers: { origin: 'wa-origin' },
    controlUdpDrop: { ifName: 'eth1', subnet: '172.30.0.0/24', argv: [['tc']], readBack: { ingress: 'in', egress: 'out' } },
    mediaDefaultRoute: Object.fromEntries(names.map((name) => [name, { container: name, ifName: 'eth0', gateway: '172.31.0.1', readBack: [{ dst: 'default' }] }])),
  };
}

function baseConditions() {
  try {
    return JSON.parse(execFileSync('git', ['show', '3e1583b:app/harness/conditions.json'], { cwd: ROOT, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function withoutDelivery(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = structuredClone(value);
  delete copy.delivery;
  return copy;
}

function conditionEntries(matrix) {
  return Object.entries(matrix).flatMap(([key, value]) => key === 'shakedown'
    ? Object.entries(value).map(([arm, condition]) => [`shakedown/${arm}`, condition])
    : key === 'schemaVersion' ? [] : [[key, value]]);
}

function fieldEqual(left, right, field, label) {
  assertEqual(JSON.stringify(left[field]), JSON.stringify(right[field]), `${label} ${field}`);
}

export default async function harnessConditionsSuite() {
  await check('harness conditions: P7 missing delivery refuses before topology', async () => {
    const root = path.join(ROOT, '.tmp', `harness-conditions-${process.pid}-${Date.now()}`);
    let prepared = false;
    try {
      await runHarness({
        conditionName: 'constructed-no-delivery',
        condition: { name: 'constructed-no-delivery', clients: 1, backgroundLoadMbps: null },
        runDir: root,
        topology: { prepare: async () => { prepared = true; }, applyQdiscs: async () => {}, teardown: async () => {} },
      });
    } catch (error) {
      assert(error.message.includes('constructed-no-delivery'), 'P7 missing delivery refusal names the condition');
    }
    assertEqual(prepared, false, 'P7 missing delivery refuses before topology');
    assertEqual(fs.existsSync(root), false, 'P7 missing delivery creates no run directory');
  });

  await check('harness conditions: every existing condition only gains delivery http', async () => {
    const base = baseConditions();
    if (!base) {
      assert(true, 'not a git work tree â€” base condition history cannot be read');
      return;
    }
    const baseEntries = new Map(conditionEntries(base));
    const currentEntries = new Map(conditionEntries(conditions));
    for (const [name, condition] of baseEntries) {
      assert(currentEntries.has(name), `${name} remains in the condition matrix`);
      assertEqual(JSON.stringify(withoutDelivery(currentEntries.get(name))), JSON.stringify(condition), `${name} is unchanged apart from delivery`);
      assertEqual(currentEntries.get(name).delivery, 'http', `${name} declares http delivery`);
    }
    const absent = [...baseEntries.keys()].filter((name) => !currentEntries.has(name));
    assertEqual(JSON.stringify(absent), JSON.stringify([]), 'no base condition disappeared');
    // 8b2 registers its conditions in a commit of their own, so they may be absent here.
    const registeredBy8b2 = ['control-five', 'control-seek', 'control-ten', 'shakedown/control-qual', 'sweep-070', 'sweep-095', 'sweep-unpaced'];
    // 9b's eleven likewise; scripts/check/suites/edge-conditions.mjs holds them to all or none.
    const registeredBy9b = (name) => name.startsWith('edge-') || name === 'shakedown/edge-qual';
    const added = [...currentEntries.keys()].filter((name) => !baseEntries.has(name) && !registeredBy8b2.includes(name) && !registeredBy9b(name));
    assertEqual(JSON.stringify(added.sort()), JSON.stringify(['baseline-nop2p-steady', 'behind-inside', 'behind-past', 'capacity-ten', 'hostorigin-nop2p', 'hostorigin-uncapped', 'p2p-naive', 'p2p-scattered', 'regimes-default-shaped', 'regimes-limited-shaped', 'regimes-starved', 'shakedown/behind-qual', 'shakedown/cap20', 'shakedown/hostorigin-qual', 'shakedown/p2p-qual', 'shakedown/regimes-qual', 'shakedown/trap-qual', 'trap-seek', 'trap-seek-short']), 'only declared change conditions are new');
  });

  await check('harness conditions: host arms enumerate their frozen field equalities', async () => {
    const baseline = conditions['baseline-nop2p'];
    const capped = conditions['hostorigin-nop2p'];
    assertEqual(capped.name, 'hostorigin-nop2p', 'capped host name');
    assertEqual(capped.delivery, 'host', 'capped host delivery');
    assertEqual(capped.feeds.join(','), '7a2-d3-capped-arm', 'capped host feed');
    for (const field of ['clients', 'capacityMbps', 'qdiscs', 'backgroundLoadMbps', 'runLengthMs', 'excludedPrefixMs', 'measureWindowMs', 'content', 'bars']) fieldEqual(capped, baseline, field, 'capped host');

    const uncapped = conditions['hostorigin-uncapped'];
    assertEqual(uncapped.name, 'hostorigin-uncapped', 'uncapped host name');
    assertEqual(uncapped.delivery, 'host', 'uncapped host delivery');
    assertEqual(uncapped.publishes, false, 'uncapped host does not publish');
    assertEqual(uncapped.capacityMbps, null, 'uncapped host has no capacity');
    assertEqual(JSON.stringify(uncapped.qdiscs), '[]', 'uncapped host has no qdisc');
    for (const field of ['clients', 'backgroundLoadMbps', 'runLengthMs', 'excludedPrefixMs', 'measureWindowMs', 'content', 'bars']) fieldEqual(uncapped, baseline, field, 'uncapped host');

    const qual = conditions.shakedown['hostorigin-qual'];
    const filler = conditions.shakedown['filler-null'];
    assertEqual(qual.name, 'shakedown/hostorigin-qual', 'qualification host name');
    assertEqual(qual.delivery, 'host', 'qualification host delivery');
    assertEqual(qual.feeds.join(','), '7a2-runner-qualification', 'qualification host feed');
    for (const field of ['clients', 'capacityMbps', 'qdiscs', 'backgroundLoadMbps', 'runLengthMs', 'excludedPrefixMs', 'measureWindowMs', 'content', 'bars']) fieldEqual(qual, filler, field, 'qualification host');
  });

  await check('harness conditions: behind arms keep their settled literals', async () => {
    const qdisc = (container) => ({ container, network: 'wa-media', interface: '<resolved at runtime>', direction: 'egress', discipline: 'tbf', order: 1, params: { rate: '10mbit', burst: '32kbit', latency: '400ms' } });
    const bars = {
      recordCoverageMin: 0.95,
      droppedFrameFractionMax: 0.02,
      driftLogMissedMax: 0,
      responseCutShortMaxBytes: 1129000,
      responseSettleGapMs: 3000,
      conservationChannelBytes: 131071,
      conservationRelativeMax: 0.05,
      conservationDeliveryGapMs: 3000,
      steadyUtilisationMax: 0.9,
      steadyDownloadRatioMin: 0.95,
      steadyDownloadRatioMax: 1.25,
      steadyRealtimeMin: 0.98,
      steadyCapUsedMax: 0.9,
    };
    const common = (condition, pauseMs, observationMs, runLengthMs, excludedPrefixMs, measureWindowMs) => {
      assertEqual(condition.delivery, 'host', `${condition.name} host delivery`);
      assertEqual(condition.peerExchange, true, `${condition.name} peer exchange`);
      assertEqual(condition.clients, 5, `${condition.name} five viewers`);
      assertEqual(JSON.stringify(condition.qdiscs), JSON.stringify([qdisc('origin'), qdisc('client')]), `${condition.name} origin and client tbf`);
      assertEqual(JSON.stringify(condition.figureKinds), JSON.stringify(['behind']), `${condition.name} behind figure kind`);
      assertEqual(Object.hasOwn(condition, 'reading'), false, `${condition.name} has no reading`);
      assertEqual(JSON.stringify(condition.disturbance), JSON.stringify({ kind: 'local-pause-play', clients: ['c03'], pauseMs, at: 'measure-window-start', observationMs }), `${condition.name} disturbance`);
      assertEqual(condition.runLengthMs, runLengthMs, `${condition.name} run length`);
      assertEqual(condition.excludedPrefixMs, excludedPrefixMs, `${condition.name} excluded prefix`);
      assertEqual(condition.measureWindowMs, measureWindowMs, `${condition.name} measure window`);
      assertEqual(JSON.stringify(condition.bars), JSON.stringify(bars), `${condition.name} bars`);
      assertEqual(condition.positionOffsetMsByClient.c03, 0, `${condition.name} c03 offset`);
    };
    common(conditions['behind-inside'], 400, 90000, 240000, 120000, 120000);
    assertEqual(JSON.stringify(conditions['behind-inside'].behind), JSON.stringify({ case: 'inside', attemptsMax: 3, settleAllowanceMs: 11500, saturatedMinPolls: 80 }), 'behind-inside limits');
    common(conditions['behind-past'], 1500, 90000, 240000, 120000, 120000);
    assertEqual(JSON.stringify(conditions['behind-past'].behind), JSON.stringify({ case: 'past', attemptsMax: 3, skipDecisionMaxMs: 4000, abandonedToleranceMs: 300, startLatenessMaxMs: 600, resync: { windowMs: 1000, medianMaxMs: 40, holdMs: 30000, maxMs: 2000 } }), 'behind-past limits');
    const qual = conditions.shakedown['behind-qual'];
    common(qual, 1500, 50000, 120000, 60000, 60000);
    assertEqual(qual.publishes, false, 'behind qualification does not publish');
    assertEqual(JSON.stringify(qual.behind), JSON.stringify(conditions['behind-past'].behind), 'behind qualification keeps past limits');
  });

  await check('harness conditions: F2 ready manifest keeps the host rig measures', async () => {
    const measures = hostRigMeasures();
    const { thrown, manifest } = await hostRunToReady('f2-keep', measures);
    assert(thrown?.message.includes('origin URL is required'), 'F2 run stops after the ready merge');
    assertEqual(manifest.topology.status, 'ready', 'F2 manifest topology reached ready');
    assertEqual(JSON.stringify(manifest.topology.controlUdpDrop), JSON.stringify(measures.controlUdpDrop), 'F2 ready manifest keeps controlUdpDrop');
    assertEqual(JSON.stringify(manifest.topology.mediaDefaultRoute), JSON.stringify(measures.mediaDefaultRoute), 'F2 ready manifest keeps mediaDefaultRoute');
  });

  await check('harness conditions: F2 host topology without a read-back aborts before clients', async () => {
    const withoutDrop = hostRigMeasures();
    delete withoutDrop.controlUdpDrop;
    const withoutRoute = hostRigMeasures();
    delete withoutRoute.mediaDefaultRoute.c01;
    for (const [label, measures, named] of [['f2-drop', withoutDrop, 'controlUdpDrop'], ['f2-route', withoutRoute, 'mediaDefaultRoute read-back for c01']]) {
      const { thrown, manifest } = await hostRunToReady(label, measures);
      assert(thrown?.message.includes(named), `F2 missing ${named} aborts naming it`);
      assertEqual(manifest.status, 'aborted', `F2 missing ${named} leaves an aborted manifest`);
    }
  });

  await check('harness conditions: P8 one feature switch has both names', async () => {
    const flags = harnessChromeFlags({ upstreamPort: 9333, windowSize: '1280,720' });
    const switches = flags.filter((flag) => flag.startsWith('--disable-features='));
    assertEqual(switches.length, 1, 'P8 one feature switch has both names');
    assert(switches[0].includes('CalculateNativeWinOcclusion') && switches[0].includes('WebRtcHideLocalIpsWithMdns'), 'P8 feature switch carries occlusion and mDNS names');
  });

  await check('harness conditions: only a host condition widens the page-ready wait', async () => {
    const entries = conditionEntries(conditions);
    assert(entries.some(([, condition]) => condition.delivery === 'host') && entries.some(([, condition]) => condition.delivery === 'http'), 'the matrix holds both delivery paths');
    for (const [name, condition] of entries) {
      assertEqual(clientReadyTimeoutMs(condition), condition.delivery === 'host' ? 120_000 : 30_000, `${name} page-ready wait follows its delivery`);
    }
  });
}
