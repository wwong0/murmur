import { assert, assertEqual, check } from '../harness.mjs';
import { attemptLedger } from '../../measure/attempt-ledger.mjs';

export default async function measureLedgerSuite() {
  await check('measurement ledger: outcomes and omitted registered prefixes', async () => {
    const registry = { runs: [
      { directory: '11a-ok-1', condition: '11a-ok' }, { directory: '11a-timeout-1', condition: '11a-timeout' },
      { directory: '11a-abort-1', condition: '11a-abort' }, { directory: '11a-refuse-1', condition: '11a-refuse' },
      { directory: 'shakedown-g-1', condition: 'shakedown/g' },
    ] };
    const manifests = {
      '11a-ok-1': { status: 'complete' }, '11a-timeout-1': { status: 'aborted', failures: [{ message: 'deadline exceeded' }] },
      '11a-abort-1': { status: 'aborted' }, '11a-refuse-1': { status: 'refused' }, 'shakedown-g-1': { status: 'complete' },
    };
    const finalizations = { 'shakedown-g-1': { reason: 'publication-refusal' } };
    const result = attemptLedger({ registry, manifests, finalizations, resultNames: ['11a-ok-1', '11a-ok-extra-1', 'shakedown-g-1', 'shakedown-g-extra-1'] });
    assertEqual(result.entries.map((entry) => entry.outcome).join(','), 'published,timed-out,aborted,refused,refused', 'all outcome classes are named');
    assert(result.unregistered.some((entry) => entry.directory === '11a-ok-extra-1'), 'registered condition prefix finds omitted result');
    assert(result.unregistered.some((entry) => entry.directory === 'shakedown-g-extra-1'), 'shakedown prefix is normalized');
  });
}
