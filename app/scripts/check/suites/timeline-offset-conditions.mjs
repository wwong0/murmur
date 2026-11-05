// The measured condition is 11a-2's healthy arm with a criterion and two figure kinds.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertEqual, check } from '../harness.mjs';
import { validateCondition } from '../../harness-run.mjs';

const matrix = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../harness/conditions.json', import.meta.url)), 'utf8'));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function differences(left, right, prefix = '') {
  if (!isObject(left) || !isObject(right)) return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .flatMap((key) => differences(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

export default async function timelineOffsetConditionsSuite() {
  const healthy = matrix['12c2-healthy-2s'];
  const qualification = matrix.shakedown['12c2-qual-healthy'];

  await check('timeline-offset-conditions: the measured condition differs from 11a-2\'s five viewers in four keys', async () => {
    assertEqual(differences(matrix['11a2-five-2s'], healthy).join(), 'criterion,figureKinds,name,reading', 'only these differ');
    assertEqual(healthy.name, '12c2-healthy-2s', 'the name');
    assertEqual(healthy.figureKinds.join(), 'byte,drift,ahead-for-good,settled-drift', 'the figure kinds');
    assertEqual(JSON.stringify(healthy.criterion), JSON.stringify({ statistic: 'median', targetMs: 40 }), 'the criterion');
    assertEqual(JSON.stringify(healthy.criterion), JSON.stringify(matrix.healthy.criterion), 'the healthy condition\'s own');
    assertEqual('reading' in healthy, false, 'no control-arm reading');
  });

  await check('timeline-offset-conditions: the qualification differs from the measured condition in its name alone', async () => {
    assertEqual(differences(healthy, qualification).join(), 'name', 'only the name');
    assertEqual(qualification.name, 'shakedown/12c2-qual-healthy', 'the name');
  });

  await check('timeline-offset-conditions: both pass the runner\'s validation', async () => {
    assertEqual(validateCondition(healthy, 'healthy'), healthy, 'the measured condition validates');
    assertEqual(validateCondition(qualification, 'qualification'), qualification, 'the qualification validates');
  });
}
