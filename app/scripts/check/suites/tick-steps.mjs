// scripts/check/suites/tick-steps.mjs
//
// The tick's step isolation. Pure: no server, no timer.

import { check, assertEqual } from '../harness.mjs';
import { runTickSteps } from '../../../public/lib/tick-steps.mjs';

export default async function tickStepsSuite() {
  await check('tick-steps: a throwing step does not skip the next and is reported under its own name', async () => {
    const ran = [];
    const reports = [];
    const failure = new Error('a failed');
    runTickSteps([
      ['a', () => { ran.push('a'); throw failure; }],
      ['b', () => ran.push('b')],
      ['c', () => ran.push('c')],
    ], (name, error) => reports.push([name, error]));
    assertEqual(ran.join(','), 'a,b,c', 'every step ran, in order');
    assertEqual(reports.length, 1, 'one report');
    assertEqual(reports[0][0], 'a', 'named after the throwing step');
    assertEqual(reports[0][1], failure, 'carrying its error');
  });

  await check('tick-steps: a throwing reporter does not stop the next step', async () => {
    const ran = [];
    runTickSteps([
      ['a', () => { throw new Error('a failed'); }],
      ['b', () => ran.push('b')],
    ], () => { throw new Error('report failed'); });
    assertEqual(ran.join(','), 'b', 'the step after the failure still ran');
  });
}
