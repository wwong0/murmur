import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { conditionForName, conditionValidationReason, conditions } from '../../harness-run.mjs';
import { assert, assertEqual, assertNear, check } from '../harness.mjs';
import { ENGINE_WINDOW_DEFAULTS } from '../../../public/lib/engine-windows.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILE = path.join(APP_DIR, 'harness', 'conditions.json');
const source = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const BASE = source['p2p-naive'];
const REGIME_NAMES = ['regimes-limited-shaped', 'regimes-default-shaped', 'regimes-starved'];
const PEER_BARS = Object.freeze({ responseSettleGapMs: 3000, steadyUtilisationMax: 0.9, steadyDownloadRatioMin: 0.95,
  steadyDownloadRatioMax: 1.25, steadyRealtimeMin: 0.98 });
const tbf = (container, rate, burst) => ({ container, network: 'wa-media', interface: '<resolved at runtime>',
  direction: 'egress', discipline: 'tbf', order: 1, params: { rate, burst, latency: '400ms' } });
const VIEWER = tbf('client', '10mbit', '32kbit');

const sorted = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));

function stripped(value, ignored) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
}

function qdisc(condition, container) {
  return condition.qdiscs.find((entry) => entry.container === container);
}

function assertDerived(name, extra = []) {
  const condition = name.includes('/') ? source.shakedown[name.split('/')[1]] : source[name];
  const ignored = new Set(['name', 'capacityMbps', 'qdiscs', 'bars', 'figureKinds', 'feeds', 'reading', ...extra]);
  assertEqual(JSON.stringify(stripped(condition, ignored)), JSON.stringify(stripped(BASE, ignored)),
    `${name} keeps p2p-naive fields outside its declared overrides`);
}

export default async function regimesConditionsSuite() {
  await check('regimes conditions: each derived condition changes only the table keys', async () => {
    for (const name of REGIME_NAMES) assertDerived(name, name === 'regimes-limited-shaped' ? ['engineWindows'] : []);
    assertDerived('shakedown/regimes-qual', ['publishes', 'runLengthMs', 'excludedPrefixMs', 'measureWindowMs', 'engineWindows']);
    assertEqual(JSON.stringify(source['regimes-limited-shaped'].figureKinds), '["byte"]', 'limited condition publishes byte only');
    assertEqual(JSON.stringify(source['regimes-default-shaped'].figureKinds), '["byte"]', 'default condition publishes byte only');
    assertEqual(JSON.stringify(source['regimes-starved'].figureKinds), '["byte"]', 'starved condition publishes byte only');
    assertEqual(JSON.stringify(source.shakedown['regimes-qual'].figureKinds), '["byte"]', 'qualification publishes byte only');
    for (const name of REGIME_NAMES) assert(!Object.hasOwn(source[name], 'feeds'), `${name} declares no feeds`);
    assert(!Object.hasOwn(source.shakedown['regimes-qual'], 'feeds'), 'shakedown/regimes-qual declares no feeds');
  });

  await check('regimes conditions: the reading block has two-sided margin thresholds', async () => {
    const block = source['regimes-limited-shaped'].reading;
    assertNear(block.reading2.peerFractionBelow, block.reading1.peerFractionMin - block.marginPeerFraction, 1e-12,
      'reading 2 peer fraction subtracts its margin');
    assertNear(block.reading2.multiplierAbove, block.reading1.multiplierMax + block.marginMultiplier, 1e-12,
      'reading 2 multiplier adds its margin');
    assertEqual(block.eligibleRunsMin, 2, 'reading minimum is two');
    assertEqual(block.eligibleRunsMax, 3, 'reading maximum is three');
    assertEqual(block.control.condition, 'p2p-scattered', 'the reading names its control');
    assertEqual(block.control.peerFractionMin, 0.5, 'the reading keeps the control floor');
  });

  await check('regimes conditions: rates, windows and bars are declared exactly', async () => {
    const limited = source['regimes-limited-shaped'];
    const defaultShaped = source['regimes-default-shaped'];
    const starved = source['regimes-starved'];
    const qualification = source.shakedown['regimes-qual'];
    for (const condition of [limited, defaultShaped, starved, qualification]) {
      assertEqual(sorted(condition.bars), sorted({ ...BASE.bars, ...PEER_BARS }),
        `${condition.name} carries p2p-naive's bars plus exactly the settle and steady bars`);
    }
    const qdiscsOf = (condition) => JSON.stringify(condition.qdiscs);
    assertEqual(qdiscsOf(limited), JSON.stringify([tbf('origin', '20mbit', '64kbit'), VIEWER]), 'limited shapes origin 20mbit and every viewer 10mbit');
    assertEqual(qdiscsOf(qualification), qdiscsOf(limited), 'qualification shapes as limited');
    assertEqual(qdiscsOf(defaultShaped), JSON.stringify([tbf('origin', '10mbit', '32kbit'), VIEWER]), 'default shapes origin 10mbit and every viewer 10mbit');
    assertEqual(qdiscsOf(starved), JSON.stringify([tbf('origin', '5mbit', '16kbit')]), 'starved shapes the origin only, burst scaled');
    assertEqual(JSON.stringify([limited, defaultShaped, starved, qualification].map((condition) => condition.capacityMbps)),
      JSON.stringify([20, 10, 5, 20]), 'capacities are as declared');
    // T1 item 5: these ran at the library's defaults before the product declared its
    // own, so each now declares them explicitly — a future run of it still behaves as
    // it did before this change.
    for (const condition of [defaultShaped, starved]) {
      assertEqual(JSON.stringify(condition.engineWindows), JSON.stringify(ENGINE_WINDOW_DEFAULTS), `${condition.name} declares the library's windows`);
    }
    assert(['regimes-default-shaped', 'regimes-starved'].every((name) => !Object.hasOwn(source[name], 'reading'))
      && !Object.hasOwn(qualification, 'reading'), 'only the limited condition carries the reading block');
    assertEqual(limited.engineWindows.highDemandTimeWindow, 15, 'limited high-demand window is 15s');
    assertEqual(limited.engineWindows.httpDownloadTimeWindow, 60, 'limited HTTP window is 60s');
    assertEqual(limited.engineWindows.p2pDownloadTimeWindow, 60, 'limited P2P window is 60s');
    assertEqual(JSON.stringify(qualification.engineWindows), JSON.stringify(limited.engineWindows), 'qualification uses limited windows');
    assertEqual(qualification.runLengthMs, 120000, 'qualification run length is 120 seconds');
    assertEqual(qualification.excludedPrefixMs, 60000, 'qualification excluded prefix is 60 seconds');
    assertEqual(qualification.measureWindowMs, 60000, 'qualification measure window is 60 seconds');
  });

  await check('regimes conditions: shakedown cap20 is the separate goodput arm and peer bars stay separate', async () => {
    const cap20 = conditionForName('shakedown/cap20');
    assertEqual(cap20.capacityMbps, 20, 'cap20 capacity is 20 Mbps');
    assertEqual(qdisc(cap20, 'origin').params.rate, '20mbit', 'cap20 uses the 20mbit tbf');
    assertEqual(qdisc(cap20, 'origin').params.burst, '64kbit', 'cap20 scales the burst to 64kbit');
    assert(!Object.hasOwn(cap20.bars, 'responseSettleGapMs'), 'cap20 has no response settle bar');
    assert(!Object.hasOwn(cap20.bars, 'steadyUtilisationMax'), 'cap20 has no steady bars');
    assertEqual(conditions['p2p-scattered'].bars.responseSettleGapMs, 3000, 'scattered keeps its settle bar');
    assert(!Object.hasOwn(conditions['p2p-scattered'].bars, 'steadyUtilisationMax'), 'scattered has no steady bars');
    assertEqual(conditionValidationReason(cap20), null, 'condition validation accepts cap20');
    for (const condition of [conditions['regimes-limited-shaped'], conditions['regimes-default-shaped'],
      conditions['regimes-starved'], conditions.shakedown['regimes-qual']]) {
      assertEqual(conditionValidationReason(condition), null, `condition validation accepts ${condition.name}`);
    }
  });
}
