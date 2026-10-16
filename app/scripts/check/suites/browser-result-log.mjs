// scripts/check/suites/browser-result-log.mjs
//
// verify:browser's result log on constructed calls: the printed lines, the failure
// and NOT EXERCISED lists read from the one record, and the closing summary held to
// the template the verifier printed before the log existed. No server, no browser.

import { check, assert, assertEqual } from '../harness.mjs';
import { createResultLog } from '../../browser-result-log.mjs';

const json = (value) => JSON.stringify(value);
const STEM = 'retains a qualifying saturated stretch';

/** The closing line exactly as verify-browser.mjs built it from its own two arrays. */
function priorSummary(failures, notExercised) {
  const unexercisedText = notExercised.length === 0
    ? ''
    : `\n${notExercised.length} NOT EXERCISED: ${notExercised.map((entry) => `${entry.label} — ${entry.qualifier}`).join('; ')}`;
  return `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`}${unexercisedText}`;
}

function logged() {
  const lines = [];
  return { lines, log: createResultLog({ approvedStems: [STEM], print: (line) => lines.push(line) }) };
}

export default async function browserResultLogSuite() {
  await check('browser-result-log: one record gives the lines, the lists and the summary', async () => {
    const empty = logged();
    const full = logged();
    full.log.expect('T1 x', true, 'fine');
    full.log.expect('T2 y', false, 'boom');
    full.log.expectWhen(`T10 A ${STEM}`, false, false, '0 qualifying', 'A held nothing');
    full.log.expectWhen(`T10 B ${STEM}`, true, false, '');
    full.log.rowNotExercised('E5 a row', 'nothing finished');
    full.log.expect('T3 z', false);
    full.log.error('thrown');
    full.log.error('manifest finalization failed: disk');
    const unapproved = logged();
    let thrown = null;
    try { unapproved.log.expectWhen('T9 unlisted stem', false, false, '', 'q'); } catch (error) { thrown = error.message; }

    assertEqual(empty.log.summary(), '\nALL PASS', 'an empty pass');
    assertEqual(empty.log.summary(), priorSummary([], []), 'the empty summary keeps the old template');
    assertEqual(json(full.lines), json([
      'PASS  T1 x — fine',
      'FAIL  T2 y — boom',
      `NOT EXERCISED  T10 A ${STEM} — 0 qualifying`,
      '  A held nothing',
      `FAIL  T10 B ${STEM}`,
      'NOT EXERCISED  E5 a row',
      '  nothing finished',
      'FAIL  T3 z',
    ]), `printed lines: ${json(full.lines)}`);
    const failures = ['T2 y', `T10 B ${STEM}`, 'T3 z', 'thrown', 'manifest finalization failed: disk'];
    const notExercised = [{ label: `T10 A ${STEM}`, qualifier: 'A held nothing' }, { label: 'E5 a row', qualifier: 'nothing finished' }];
    assertEqual(json(full.log.failures()), json(failures), 'failed labels in call order, then errors');
    assertEqual(json(full.log.notExercised()), json(notExercised), 'NOT EXERCISED as { label, qualifier }, in call order');
    assertEqual(full.log.summary(), priorSummary(failures, notExercised), 'the summary keeps the old template');
    assertEqual(json(full.log.errors), json(['thrown', 'manifest finalization failed: disk']), 'errors kept apart for the exit rule');
    assertEqual(json(full.log.results.map((r) => [r.status, r.approvedStem])), json([
      ['pass', false], ['fail', false], ['not-exercised', true], ['fail', false], ['not-exercised', false], ['fail', false],
    ]), 'approvedStem only on an expectWhen NOT EXERCISED');
    assert(thrown?.startsWith('assertion is not approved for NOT EXERCISED: T9'), `an unapproved stem throws: ${thrown}`);
    assertEqual(unapproved.log.results.length, 0, 'and records nothing');
  });
}
