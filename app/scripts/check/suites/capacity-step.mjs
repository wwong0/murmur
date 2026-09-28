import { assert, assertEqual, check } from '../harness.mjs';
import { changeArgv, changeQdisc } from '../../../harness/apply-qdisc.mjs';
import { conditionValidationReason, stepThenSeek } from '../../harness-run.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';

const step = (rate, burst) => ({ container: 'origin', network: 'wa-media', discipline: 'tbf', params: { rate, burst, latency: '400ms' } });
const seekCondition = { delivery: 'http', clients: 0, excludedPrefixMs: 120_000, seek: { issueAfterReadyMs: 120_000, deltaMs: 600_000, appliedTimeoutMs: 5000 } };

export default async function capacityStepSuite() {
  await check('capacity step (a): changeArgv preserves qdisc token order for both trap rates', async () => {
    assertEqual(changeArgv({ ifName: 'eth0', discipline: 'tbf', params: step('5mbit', '16kbit').params }).join(' '),
      'tc qdisc change dev eth0 root handle 10: tbf rate 5mbit burst 16kbit latency 400ms', '5 Mbit step argv');
    assertEqual(changeArgv({ ifName: 'eth0', discipline: 'tbf', params: step('10mbit', '32kbit').params }).join(' '),
      'tc qdisc change dev eth0 root handle 10: tbf rate 10mbit burst 32kbit latency 400ms', '10 Mbit step argv');
  });

  await check('capacity step (a): changeQdisc reads the origin interface and does not throw a mismatch', async () => {
    const calls = [];
    const result = changeQdisc({
      state: { containers: { origin: 'origin-container' }, origin: { ifName: 'eth0' } },
      capacityStep: step('5mbit', '16kbit'),
      exec: (argv) => {
        calls.push(argv);
        return argv.includes('show') ? 'qdisc tbf 10: root refcnt 2 rate 5Mbit burst 2Kb latency 400ms' : '';
      },
    });
    assert(calls.some((argv) => argv.includes('change')), 'the change reaches the origin container');
    assert(calls.some((argv) => argv.includes('show') && argv.at(-1) === 'eth0'), 'read-back uses the resolved origin interface');
    assertEqual(result.matches, true, 'matching read-back is in force');
    assertEqual(result.readings.rate.got, 5_000_000, 'rate is numerically read back');
  });

  await check('capacity step (b): a pre-step read-back refuses and issues no seek', async () => {
    let issued = false;
    const result = await stepThenSeek({
      condition: { ...seekCondition, capacityStep: step('5mbit', '16kbit') },
      preSeekState: { lineage: 'lineage', version: 2, playing: true, positionMs: 10, atSharedMs: 100 },
      stepQdisc: async () => ({ matches: false, readings: { rate: { wanted: '5mbit', got: 20_000_000 } } }),
      seek: async () => { issued = true; return { issued: true, atPageMs: 150 }; },
      now: (() => { let value = 120; return () => value += 10; })(),
    });
    assertEqual(result.capacityStep.inForce, false, 'pre-step read-back is not in force');
    assertEqual(issued, false, 'mismatch does not issue a seek');
  });

  await check('capacity step (c): a matching read-back precedes the seek', async () => {
    const events = [];
    const result = await stepThenSeek({
      condition: { ...seekCondition, capacityStep: step('10mbit', '32kbit') },
      preSeekState: { lineage: 'lineage', version: 2, playing: true, positionMs: 10, atSharedMs: 100 },
      stepQdisc: async () => { events.push('readback'); return { matches: true, readings: { rate: { got: 10_000_000 } } }; },
      seek: async () => { events.push('seek'); return { issued: true, atPageMs: 150 }; },
      now: (() => { let value = 120; return () => value += 10; })(),
    });
    assertEqual(events.join(','), 'readback,seek', 'read-back is observed before the seek');
    assert(result.capacityStep.readBackAtMs <= result.seek.seekIssuedAtMs, 'read-back instant is no later than seek issue');
  });

  await check('capacity step (d): a seek issued before read-back is a hard refusal-input error', async () => {
    let thrown = null;
    try {
      evaluateRefusals({ condition: seekCondition, declaredClientTags: [], capacityStep: {
        declared: step('5mbit', '16kbit'), readBack: {}, readBackAtMs: 200, seekIssuedAtMs: 150, inForce: true,
      }, seek: { seekIssuedAtMs: 150 }, originStart: {}, originEnd: {} });
    } catch (error) { thrown = error; }
    assert(thrown?.message.includes('capacity-step-readback-after-seek'), 'late read-back is not treated as a passing mismatch');
  });

  await check('capacity step validation: malformed seek and step blocks refuse at load', async () => {
    assertEqual(conditionValidationReason({ ...seekCondition, seek: { ...seekCondition.seek, issueAfterReadyMs: 119_999 } }), 'seek-invalid', 'seek instant must equal excluded prefix');
    const { seek: _seek, ...withoutSeek } = seekCondition;
    assertEqual(conditionValidationReason({ ...withoutSeek, capacityStep: step('5mbit', '16kbit') }), 'capacity-step-invalid', 'step without seek is malformed');
  });
}
