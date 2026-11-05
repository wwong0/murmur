import { assertEqual, check } from '../harness.mjs';
import { attemptLedger } from '../../measure/attempt-ledger.mjs';

// Directory names as the runner writes them: `<arm>-<condition slug>-<ISO stamp>`.
const at = (name, stamp = '2026-10-26T15-06-31.580Z') => `${name}-${stamp}`;

export default async function measureLedgerSuite() {
  await check('measurement ledger: outcomes and omitted registered prefixes', async () => {
    const registry = { runs: [
      { directory: at('11a-ok'), condition: 'ok' }, { directory: at('11a-timeout'), condition: 'timeout' },
      { directory: at('11a-abort'), condition: 'abort' }, { directory: at('11a-refuse'), condition: 'refuse' },
      { directory: at('9b-shakedown-13c-g'), condition: 'shakedown/13c-g' }, { directory: at('9b-edge'), condition: 'edge' },
    ] };
    const manifests = {
      [at('11a-ok')]: { status: 'complete' }, [at('11a-timeout')]: { status: 'aborted', failures: [{ message: 'deadline exceeded' }] },
      [at('11a-abort')]: { status: 'aborted' }, [at('11a-refuse')]: { status: 'refused' },
      [at('9b-shakedown-13c-g')]: { status: 'complete' }, [at('9b-edge')]: { status: 'complete' },
    };
    const finalizations = { [at('9b-shakedown-13c-g')]: { reason: 'publication-refusal' } };
    const omittedOk = at('11a-ok', '2026-10-26T16-00-00.000Z');
    const omittedG = at('9b-shakedown-13c-g', '2026-10-26T14-00-00.000Z');
    const result = attemptLedger({ registry, manifests, finalizations, resultNames: [
      at('11a-ok'), omittedOk, at('9b-shakedown-13c-g'), omittedG,
      at('9b-edge-drop'), at('9b-shakedown-13c-eleven'), 'clock-check'] });
    assertEqual(result.entries.map((entry) => entry.outcome).join(','), 'published,timed-out,aborted,refused,refused,published', 'all outcome classes are named');
    assertEqual(result.unregistered.map((entry) => entry.directory).sort().join(','), [omittedOk, omittedG].sort().join(','),
      'an arm-prefixed run of a registered condition is found; edge-drop is not edge, and other conditions are not claimed');
  });
}
