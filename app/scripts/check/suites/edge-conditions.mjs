// The eleven edge conditions, read from the file.
// They land in a commit of their own, so before it none is present and after it all are.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { conditionValidationReason } from '../../harness-run.mjs';
import { validateControlReading } from '../../figures/control-reading.mjs';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'harness', 'conditions.json');

// Name → the condition it copies, the top-level fields it may differ in, and its accepted minimum / most attempts.
const ALWAYS = ['bars', 'excusals', 'name', 'reading'];
const ARMS = {
  'edge-five': { copies: 'control-five', differs: [], min: 2, max: 3 },
  'edge-ten': { copies: 'control-ten', differs: [], min: 2, max: 3 },
  'edge-seek': { copies: 'control-seek', differs: [], min: 2, max: 3 },
  'edge-control-ten': { copies: 'control-ten', differs: ['assignmentControl'], min: 2, max: 2 },
  'edge-control-seek': { copies: 'control-seek', differs: ['assignmentControl'], min: 2, max: 2 },
  'edge-drop': { copies: 'control-five', differs: ['capacitySchedule', 'measureWindowMs', 'runLengthMs'], min: 2, max: 3 },
  'edge-slow': { copies: 'control-five', differs: ['qdiscs'], min: 2, max: 2 },
  'edge-sweep-070': { copies: 'sweep-070', differs: [], min: 1, max: 2 },
  'edge-sweep-095': { copies: 'sweep-095', differs: [], min: 1, max: 2 },
  'edge-sweep-unpaced': { copies: 'sweep-unpaced', differs: [], min: 1, max: 2 },
};
const QUAL = { copies: 'control-seek', differs: ['capacitySchedule', 'publishes', 'qdiscs'] };
const CRITERIA = {
  'edge-five': '{"multiplier":{"max":1.5},"peerFraction":{"min":0.6},"startWait":{"maxMs":6000},"startRecovery":{"maxMs":120000},"prefetchWait":{"maxMs":15000,"of":"duration"}}',
  'edge-slow': '{"multiplier":{"max":1.5},"peerFraction":{"min":0.6},"startWait":{"maxMs":6000},"startRecovery":{"maxMs":120000}}',
  'edge-ten': '{"multiplier":{"max":2}}',
  'edge-seek': '{"seekWait":{"maxMs":6000},"seekRecovery":{"maxMs":120000}}',
  'edge-drop': '{"dropRecovery":{"maxMs":240000}}',
  'edge-sweep-070': '{}',
};
const criteriaOf = (name) => CRITERIA[name] ?? CRITERIA[{ 'edge-control-ten': 'edge-ten', 'edge-control-seek': 'edge-seek' }[name] ?? 'edge-sweep-070'];
const step = (rate) => `{"container":"origin","network":"wa-media","discipline":"tbf","params":{"rate":"${rate}","burst":"32kbit","latency":"400ms"}}`;
const schedule = (dropAfterReadyMs) => `{"dropAfterReadyMs":${dropAfterReadyMs},"drop":${step('2mbit')},"edgeHeldAheadMsBelow":15000,"ceilingMs":240000,"rise":${step('10mbit')},"recordAfterRiseMs":300000}`;
const rates = (condition) => condition.qdiscs.map((row) => `${row.container}=${row.params.rate}/${row.params.burst}/${row.params.latency}`).join(' ');
const SLOW = 'origin=10mbit/32kbit/400ms c01=10mbit/32kbit/400ms c02=10mbit/32kbit/400ms c03=10mbit/32kbit/400ms c04=10mbit/32kbit/400ms c05=1mbit/32kbit/400ms';

function differing(condition, source) {
  return [...new Set([...Object.keys(condition), ...Object.keys(source)])]
    .filter((key) => JSON.stringify(condition[key]) !== JSON.stringify(source[key])).sort();
}

export default async function edgeConditionsSuite() {
  const conditions = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // The whole set first, then every assertion over it.
  const registered = Object.fromEntries([...Object.keys(ARMS).map((name) => [name, conditions[name]]),
    ['shakedown/edge-qual', conditions.shakedown['edge-qual']]].filter(([, condition]) => condition));
  const names = Object.keys(registered);

  await check('edge conditions: 9b registers all eleven or none', async () => {
    assert(names.length === 0 || names.length === 11, `the file holds ${names.length} of the eleven: ${names.join(',')}`);
  });
  if (names.length !== 11) return;

  await check('edge conditions: every one carries the cap leg, the excusal and the edge reading fields', async () => {
    for (const [name, condition] of Object.entries(registered)) {
      assertEqual(condition.name, name, `${name} is named as it is keyed`);
      assertEqual('steadyPaceBoundMax' in condition.bars, false, `${name} declares no pace-bound bar`);
      assertEqual(condition.bars.steadyCapUsedMax, 0.9, `${name} declares the cap used bar`);
      assertEqual(JSON.stringify(condition.excusals), '{"bytelessCancelledReceipt":true}', `${name} declares the excusal`);
      const read = condition.reading;
      assertEqual(`${read.hostPollCoverage}/${read.aheadMsMin}/${read.scatteredSpreadMsAbove}/${read.behindHeldAheadMsBelow}`, 'true/15000/4000/15000', `${name} declares the four edge fields`);
      assertEqual(conditionValidationReason(condition), null, `${name} validates`);
    }
  });

  await check('edge conditions: each copies its 8b2 condition whole but for the declared fields', async () => {
    for (const [name, { copies, differs }] of [...Object.entries(ARMS), ['shakedown/edge-qual', QUAL]]) {
      const source = conditions[copies];
      assertEqual(differing(registered[name], source).join(','), [...ALWAYS, ...differs].sort().join(','), `${name} against ${copies}`);
      const { steadyPaceBoundMax, ...bars } = source.bars;
      assertEqual(JSON.stringify(registered[name].bars), JSON.stringify({ ...bars, steadyCapUsedMax: 0.9 }), `${name} keeps every other bar of ${copies}`);
    }
    assertEqual(`${registered['edge-control-ten'].assignmentControl}/${registered['edge-control-seek'].assignmentControl}`, '8b/8b', 'the two control arms declare the 8b control');
    assertEqual(names.filter((name) => 'assignmentControl' in registered[name]).length, 2, 'and no other condition declares one');
    const drop = registered['edge-drop'];
    assertEqual(`${drop.runLengthMs}/${drop.measureWindowMs}/${JSON.stringify(drop.figureKinds)}`, '660000/300000/["byte"]', 'the drop arm\'s lengths and figure kinds');
    assertEqual(JSON.stringify(drop.capacitySchedule), schedule(120000), 'the drop arm\'s schedule');
    assertEqual(JSON.stringify(registered['shakedown/edge-qual'].capacitySchedule), schedule(240000), 'qualification\'s schedule drops 120 000 ms after its seek');
    assertEqual(rates(registered['edge-slow']), SLOW, 'the slow arm shapes c05 at 1 Mbit/s and the others at 10');
    assertEqual(rates(registered['shakedown/edge-qual']), SLOW, 'as qualification does');
    assertEqual(registered['shakedown/edge-qual'].publishes, false, 'qualification does not publish');
    assertEqual('kind' in registered['shakedown/edge-qual'].reading, false, 'and is not an arm of the reading');
  });

  await check('edge conditions: the registered readings, and attempt maxima that sum to 32', async () => {
    let attempts = 0;
    for (const [name, { min, max }] of Object.entries(ARMS)) {
      const read = validateControlReading(registered[name].reading);
      assertEqual(JSON.stringify(read.criteria), criteriaOf(name), `${name} criteria`);
      assertEqual(`${read.acceptedRunsMin}/${read.attemptsMax}`, `${min}/${max}`, `${name} accepted minimum and most attempts`);
      assertEqual(JSON.stringify(read.control), '{"condition":"p2p-scattered","peerFractionMin":0.5}', `${name} control`);
      assertEqual(read.productInputs, !name.startsWith('edge-sweep-'), `${name} product inputs`);
      assertEqual(read.sweep === true, name.startsWith('edge-sweep-'), `${name} sweep`);
      // No copies bar is set; the prefetch limit is edge-five's alone, on the whole duration.
      assertEqual('hostCopies' in read.criteria, false, `${name} registers no copies bar`);
      assertEqual('prefetchWait' in read.criteria, name === 'edge-five', `${name} and the prefetch limit`);
      attempts += read.attemptsMax;
    }
    assertEqual(`${registered['edge-ten'].reading.controlArm}/${registered['edge-seek'].reading.controlArm}`, 'edge-control-ten/edge-control-seek', 'the two arms that name a control arm');
    assertEqual(JSON.stringify(registered['edge-drop'].reading.published), '["startWait","startRecovery"]', 'the drop arm publishes the start wait and recovery');
    // Goodput, the no-P2P baseline and the scattered control at 2 each, and qualification at 2.
    assertEqual(attempts, 24, 'the ten arms\' maxima');
    assertEqual(attempts + 3 * 2 + 2, 32, 'with the three unedited arms and qualification, 32');
  });
}
