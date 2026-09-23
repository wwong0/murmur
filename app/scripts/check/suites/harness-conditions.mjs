import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, check } from '../harness.mjs';
import { conditions, runHarness } from '../../harness-run.mjs';
import { harnessChromeFlags } from '../../../harness/chrome-flags.mjs';

// P7 opportunity: delivery is read before preparation; mutation: remove the
// requireDeclaredDelivery call; named red assertion: "P7 missing delivery
// refuses before topology"; restoration: reverted by hand to staged tree;
// green rerun: npm run check.
// P8 opportunity: Chrome feature switches are assembled in one place; mutation:
// append a second disable-features switch; named red assertion: "P8 one feature
// switch has both names"; restoration: reverted by hand to staged tree; green
// rerun: npm run check.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function baseConditions() {
  try {
    return JSON.parse(execFileSync('git', ['show', 'HEAD:app/harness/conditions.json'], { cwd: ROOT, encoding: 'utf8' }));
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
    const added = [...currentEntries.keys()].filter((name) => !baseEntries.has(name));
    assertEqual(JSON.stringify(added.sort()), JSON.stringify(['hostorigin-nop2p', 'hostorigin-uncapped', 'shakedown/hostorigin-qual']), 'only §5.5 conditions are new');
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

  await check('harness conditions: P8 one feature switch has both names', async () => {
    const flags = harnessChromeFlags({ upstreamPort: 9333, windowSize: '1280,720' });
    const switches = flags.filter((flag) => flag.startsWith('--disable-features='));
    assertEqual(switches.length, 1, 'P8 one feature switch has both names');
    assert(switches[0].includes('CalculateNativeWinOcclusion') && switches[0].includes('WebRtcHideLocalIpsWithMdns'), 'P8 feature switch carries occlusion and mDNS names');
  });
}
