// scripts/check/suites/browser-check-list.mjs
//
// The registered list's exit rule on constructed results (G1-G10). No server, no
// browser. Every case is built before any is asserted, and each pair of cases
// differs in the one field under test.

import { check, assert, assertEqual } from '../harness.mjs';
import { REGISTERED_LIST, evaluateRun, reportLines, t5Entries } from '../../browser-check-list.mjs';

const INSTALLED = { browser: 'Chrome/155.0.8059.80', override: null };
const ON_39 = { browser: 'Chrome/155.0.8059.39', override: null };
const OVERRIDDEN = { browser: 'Chrome/155.0.8059.80', override: '/cft/chrome.exe' };
const row = (label, status, detail = '', approvedStem = false) => ({ label, status, detail, approvedStem });
const run = (results, { errors = [], chrome = INSTALLED, list } = {}) => evaluateRun({ results, errors, chrome, list });

const T5_END_A = 'T5 A is settled at the end of the wait';
const T5_END_B = 'T5 B is settled at the end of the wait';
const INT_A = 'INT A followed the adopted refusal and dwell policy';
const NEVER = '["never-settled"]';
const NEVER_DWELL = '["hold-fresh-dwell-5000ms:unavailable","never-settled"]';
const SEG = 'T12 / E2 /media/seg-00412.m4s';
const E2_RISE = `${SEG}: the host's hits for the path rise by exactly 1`;
const E7 = 'E7 every ask under the earlier control has reason control-8b';
const L4_A = 'T10 A retains a qualifying saturated stretch';
const withT5 = (admission) => [...REGISTERED_LIST, ...t5Entries(admission)];
const t5Failed = (...labels) => labels.map((label) => row(label, 'fail'));

export default async function browserCheckListSuite() {
  await check('browser-check-list: the exit rule discriminates (G1-G10)', async () => {
    const cases = {
      empty: run([]),
      allPass: run([row('T1 x', 'pass'), row(E2_RISE, 'pass')]),
      unlisted: run([row('T1 x', 'pass'), row('T2 y', 'fail', 'boom')]),
      l4Fail: run([row(L4_A, 'fail')]),
      l4NotExercised: run([row(L4_A, 'not-exercised')]),
      edgeListed: run([row(E2_RISE, 'fail')]),
      edgeChanged: run([row(`${SEG}: the host's hits for the path rise by exactly 2`, 'fail')]),
      edgeFixed: run([row('E4 each path has at most one first', 'fail')]),
      edgeFixedChanged: run([row('E4 each path has at most two first', 'fail')]),
      edgeSuffix: run([row(`${E2_RISE} again`, 'fail')]),
      edgePrefix: run([row(`x ${E2_RISE}`, 'fail')]),
      socketSkip: run([row('10b socket recovery', 'not-exercised')]),
      errored: run([row(L4_A, 'not-exercised')], { errors: ['ERROR: thrown'] }),
      e7Unapproved: run([row(E7, 'not-exercised', '', false)]),
      approvedStem: run([row(E7, 'not-exercised', '', true)]),
      noEntry: run([row(L4_A, 'pass')]),
      unobserved: run([row('T1 x', 'pass')], { list: withT5('unconditional') }),
    };
    for (const admission of ['version', 'flavour', 'unconditional']) {
      const chrome = admission === 'flavour' ? INSTALLED : { browser: 'Chrome/155.0.8059.80', override: '/p' };
      const results = [...t5Failed(T5_END_A, T5_END_B), row('T5 A recorded a correction', 'fail')];
      cases[`g3-${admission}`] = run(results, { chrome, list: withT5(admission) });
    }
    const gate = (results, chrome = INSTALLED, admission = 'unconditional') => run(results, { chrome, list: withT5(admission) });
    const int = (detail) => row(INT_A, 'fail', detail);
    cases.l2a = gate([...t5Failed(T5_END_A), int(NEVER)]);
    cases.l2b = gate([...t5Failed(T5_END_A), int(NEVER_DWELL)]);
    cases.l2c = gate([...t5Failed(T5_END_A), int('["hold-after-first-settling:failed"]')]);
    cases.l2d = gate([row(T5_END_A, 'pass'), int(NEVER)]);
    cases.l2e = gate([...t5Failed(T5_END_B), int(NEVER)]);
    cases.versionOn39 = gate(t5Failed(T5_END_A), ON_39, 'version');
    cases.versionOnInstalled = gate(t5Failed(T5_END_A), INSTALLED, 'version');
    cases.flavourOverride = gate(t5Failed(T5_END_A), OVERRIDDEN, 'flavour');
    cases.flavourNone = gate(t5Failed(T5_END_A), INSTALLED, 'flavour');
    cases.observed = gate([row(T5_END_A, 'pass')]);
    const lines = reportLines(cases['g3-unconditional'], withT5('unconditional'));
    const reportL4 = reportLines(run([row(L4_A, 'not-exercised')]));

    assertEqual(cases.empty.exitCode, 0, 'G1 empty');
    assertEqual(cases.allPass.exitCode, 0, 'G1 all pass');
    assertEqual(cases.unlisted.exitCode, 1, 'G2 exit');
    assertEqual(cases.unlisted.unadmitted.map((r) => r.label).join(), 'T2 y', 'G2 names the failure');
    for (const admission of ['version', 'flavour', 'unconditional']) assertEqual(cases[`g3-${admission}`].exitCode, 0, `G3 ${admission}`);
    assert(lines.some((l) => l.startsWith('FAIL  T5 A is settled at the end of the wait — listed: t5-not-settling')), `G3 listed line: ${lines.join(' | ')}`);
    assert(!lines.some((l) => l.startsWith('PASS  T5')), 'G3 no PASS line for T5');
    assert(reportL4.some((l) => l.startsWith('NOT EXERCISED  T10 A') && l.includes('listed: t10-saturated')), `G3 NOT EXERCISED line: ${reportL4.join(' | ')}`);
    assertEqual(cases.l4NotExercised.exitCode, 0, 'G4 L4 admits not-exercised');
    assertEqual(cases.l4Fail.exitCode, 1, 'G4 L4 does not admit fail');
    assertEqual(cases.edgeListed.exitCode, 0, 'G5 L3 pattern with seg-00412');
    assertEqual(cases.edgeChanged.exitCode, 1, 'G5 one word changed');
    assertEqual(cases.edgeFixed.exitCode, 0, 'G5 E4 exact');
    assertEqual(cases.edgeFixedChanged.exitCode, 1, 'G5 E4 changed');
    assertEqual(cases.edgeSuffix.exitCode, 1, 'G5 the $ anchor: a suffix is another label');
    assertEqual(cases.edgePrefix.exitCode, 1, 'G5 the ^ anchor: a prefix is another label');
    assertEqual(cases.l2a.exitCode, 0, 'G6a');
    assertEqual(cases.l2b.exitCode, 0, 'G6b');
    assertEqual(cases.l2c.exitCode, 1, 'G6c wrong detail');
    assertEqual(cases.l2d.exitCode, 1, 'G6d T5 A passed');
    assertEqual(cases.l2e.exitCode, 1, 'G6e T5 B failed, INT A');
    assertEqual(cases.errored.exitCode, 1, 'G7 error with an admitted row');
    assertEqual(cases.errored.admitted.length, 1, 'G7 the row itself was admitted');
    assertEqual(cases.e7Unapproved.exitCode, 1, 'G8 unapproved not-exercised');
    assertEqual(cases.approvedStem.exitCode, 0, 'G8 approved stem');
    assertEqual(cases.socketSkip.exitCode, 1, 'G8 a 10b socket recovery asked for and not delivered (d1-findings F10)');
    assertEqual(cases.versionOn39.exitCode, 1, 'G9 version on .39');
    assertEqual(cases.versionOnInstalled.exitCode, 0, 'G9 version on installed');
    assertEqual(cases.flavourOverride.exitCode, 1, 'G9 flavour with override');
    assertEqual(cases.flavourNone.exitCode, 0, 'G9 flavour without override');
    assertEqual(cases.unobserved.exitCode, 0, 'G10 exit unchanged');
    assertEqual(cases.unobserved.unobservedEntries.join(), 'edge-intermittent,t10-saturated,t5-not-settling,int-after-t5', 'G10 lists every unobserved entry');
    assertEqual(cases.observed.unobservedEntries.join(), 'edge-intermittent,t10-saturated,int-after-t5', 'G10 an observed entry is not listed');
    assertEqual(cases.noEntry.exitCode, 0, 'a passing row on a listed label is a pass');
  });
}
