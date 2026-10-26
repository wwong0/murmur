import { assert, assertEqual, check } from '../harness.mjs';
import { conditionForName, conditionValidationReason } from '../../harness-run.mjs';
import { expandQdiscs } from '../../../harness/apply-qdisc.mjs';

const json = (value) => JSON.stringify(value);

export default async function measureConditionsSuite() {
  await check('13c: diagnostic conditions validate and preserve the five-viewer base', async () => {
    const condition = conditionForName('shakedown/13c-g');
    const base = conditionForName('11a2-five-2s');
    assertEqual(conditionValidationReason(condition), null, '13c-g passes condition validation');
    const expanded = expandQdiscs(condition);
    const baseTbf = expandQdiscs(base);
    assertEqual(expanded.length, 7, '13c-g expands to six tbf rows and one netem row');
    assertEqual(json(expanded.slice(0, 6)), json(baseTbf), '13c-g retains the five-viewer tbf rows');
    assertEqual(expanded.at(-1).container, 'c05', 'the stacked delay targets c05');
    assertEqual(expanded.at(-1).discipline, 'netem', 'the stacked delay is netem');
    assertEqual(expanded.at(-1).order, 2, 'the stacked delay is second in the qdisc chain');
    assertEqual(expanded.at(-1).params.delay, '25ms', 'the stacked delay is 25ms');
    assertEqual(condition.positionOffsetMsByClient.c02, 500, 'c02 declares the diagnostic offset');
    assert(Object.entries(condition.positionOffsetMsByClient).filter(([, value]) => value === 0).length === 4,
      'the other four viewers declare zero offset');
    assertEqual(condition.content.identity, base.content.identity, '13c-g uses the five-viewer content identity');
    assertEqual(condition.disturbance.clients[0], 'c03', 'the disturbance targets c03');
    assertEqual(condition.disturbance.pauseMs, 500, 'the disturbance pauses for 500ms');
  });

  await check('13c: the eleven-viewer diagnostic carries capacity-ten machine settings', async () => {
    const condition = conditionForName('shakedown/13c-eleven');
    const capacity = conditionForName('capacity-ten');
    assertEqual(conditionValidationReason(condition), null, '13c-eleven passes condition validation');
    assertEqual(condition.clients, 10, '13c-eleven has ten viewers');
    assertEqual(json(condition.machineTest), json(capacity.machineTest), 'the machine test block is copied exactly');
    assertEqual(condition.qdiscs[0].params.rate, '10mbit', 'the origin tbf remains 10mbit');
    assertEqual(condition.qdiscs[1].params.rate, '10mbit', 'the client tbf remains 10mbit');
    assert(!Object.prototype.hasOwnProperty.call(condition, 'retainedBytesMax'), 'the diagnostic declares no evidence cap');
    assert(!Object.prototype.hasOwnProperty.call(condition, 'reading'), 'the diagnostic has no reading block');
  });
}
