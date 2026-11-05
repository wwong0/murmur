// The three conditions are copies of 11a-2's, differing in the enumerated keys alone.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertEqual, check } from '../harness.mjs';
import { validateCondition } from '../../harness-run.mjs';
import { capacityScheduleReason } from '../../harness/capacity-schedule.mjs';

const matrix = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../harness/conditions.json', import.meta.url)), 'utf8'));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function differences(left, right, prefix = '') {
  if (!isObject(left) || !isObject(right)) return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .flatMap((key) => differences(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

export default async function leaveRecoveryConditionsSuite() {
  const comparand = matrix['12c1-drop-comparand-2s'];
  const leave = matrix['12c1-leave-first-2s'];
  const qualification = matrix.shakedown['12c1-qual-rise'];

  await check('leave-recovery-conditions: the comparand differs from 11a-2\'s in its name and figure kinds alone', async () => {
    assertEqual(differences(matrix['11a2-drop-comparand-2s'], comparand).join(), 'figureKinds,name', 'only the name and the figure kinds differ');
    assertEqual(comparand.name, '12c1-drop-comparand-2s', 'the name');
    assertEqual(comparand.figureKinds.join(), 'byte,ahead-for-good,rise-recovery', 'the figure kinds');
  });

  await check('leave-recovery-conditions: the leave-first condition differs from 11a-2\'s in its name and figure kinds alone', async () => {
    assertEqual(differences(matrix['11a2-leave-first-2s'], leave).join(), 'figureKinds,name', 'only the name and the figure kinds differ');
    assertEqual(leave.name, '12c1-leave-first-2s', 'the name');
    assertEqual(leave.figureKinds.join(), 'roster-event,rise-recovery', 'the figure kinds');
  });

  await check('leave-recovery-conditions: the qualification condition is the comparand with a shorter schedule', async () => {
    assertEqual(differences(comparand, qualification).join(),
      'capacitySchedule.ceilingMs,capacitySchedule.dropAfterReadyMs,capacitySchedule.recordAfterRiseMs,excludedPrefixMs,name,runLengthMs',
      'the five schedule keys and the name differ');
    assertEqual(qualification.name, 'shakedown/12c1-qual-rise', 'the name');
    assertEqual(qualification.excludedPrefixMs, 60_000, 'excluded prefix 60 000 ms');
    assertEqual(qualification.runLengthMs, 255_000, 'run length 255 000 ms');
    assertEqual(qualification.capacitySchedule.dropAfterReadyMs, 60_000, 'the drop 60 000 ms after ready');
    assertEqual(qualification.capacitySchedule.ceilingMs, 120_000, 'ceiling 120 000 ms');
    assertEqual(qualification.capacitySchedule.recordAfterRiseMs, 75_000, 'recording 75 000 ms after the rise');
  });

  await check('leave-recovery-conditions: each passes the runner\'s validation and a valid capacity schedule', async () => {
    for (const [name, condition] of [['comparand', comparand], ['leave-first', leave], ['qualification', qualification]]) {
      assertEqual(validateCondition(condition, name), condition, `${name} validates`);
      assertEqual(capacityScheduleReason(condition), null, `${name}: the drop is not before the excluded prefix`);
    }
  });
}
