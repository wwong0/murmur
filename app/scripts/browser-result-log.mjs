// scripts/browser-result-log.mjs
//
// verify:browser's one record of a pass: every result in call order, and every error
// that ends or taints it. The failure list and the NOT EXERCISED list are read from
// that record, never kept beside it, so nothing can reach one and miss the other.
// Errors arrive only once the pass's steps have ended, so a failure list read as
// failed labels then errors is the order they happened in. The exit rule that reads
// this record is browser-check-list.mjs.

export function createResultLog({ approvedStems, print = console.log }) {
  const results = [];
  const errors = [];

  function expect(label, cond, detail) {
    print(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    results.push({ label, status: cond ? 'pass' : 'fail', detail, approvedStem: false });
  }

  // A THIRD OUTCOME. An assertion whose precondition never occurred has not passed
  // and has not failed — it made no claim. Kept out of the failures so the command's
  // status stays honest, and out of PASS so nothing unearned is banked. Each carries
  // what its absence leaves unverified.
  function expectWhen(label, exercised, cond, detail, qualifier) {
    if (exercised) return expect(label, cond, detail);
    if (!approvedStems.some((stem) => label.endsWith(` ${stem}`))) throw new Error(`assertion is not approved for NOT EXERCISED: ${label}`);
    print(`NOT EXERCISED  ${label}${detail ? ` — ${detail}` : ''}`);
    print(`  ${qualifier}`);
    results.push({ label, status: 'not-exercised', detail, approvedStem: true, qualifier });
  }

  /** An edge row (E5, E7) whose event did not occur in its window: no pass is banked. */
  function rowNotExercised(label, qualifier) {
    print(`NOT EXERCISED  ${label}`);
    print(`  ${qualifier}`);
    results.push({ label, status: 'not-exercised', detail: undefined, approvedStem: false, qualifier });
  }

  const failures = () => [...results.filter((r) => r.status === 'fail').map((r) => r.label), ...errors];
  const notExercised = () => results.filter((r) => r.status === 'not-exercised').map(({ label, qualifier }) => ({ label, qualifier }));

  /** The pass's closing line, before the registered list's report. */
  function summary() {
    const failed = failures();
    const skipped = notExercised();
    const unexercisedText = skipped.length === 0
      ? ''
      : `\n${skipped.length} NOT EXERCISED: ${skipped.map((entry) => `${entry.label} — ${entry.qualifier}`).join('; ')}`;
    return `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILURE(S): ${failed.join('; ')}`}${unexercisedText}`;
  }

  return { results, errors, expect, expectWhen, rowNotExercised, error: (message) => errors.push(message), failures, notExercised, summary };
}
