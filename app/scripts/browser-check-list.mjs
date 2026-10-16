// scripts/browser-check-list.mjs
//
// The registered list behind verify:browser's exit code, and the lines it prints.
// Pure: results in, verdict out. No fs, no process, no clock — the runner supplies
// the Chrome it ran. An unlisted failure, an unapproved NOT EXERCISED or any error
// exits 1; a listed one prints as FAIL with its entry, never as PASS.
// Why each entry is listed: openspec/changes/browser-check-repair (design.md D3).

const T5_END = (w) => `T5 ${w} is settled at the end of the wait`;
const INT_POLICY = (w) => `INT ${w} followed the adopted refusal and dwell policy`;
const windows = ['A', 'B'];

const L3 = Object.freeze({
  id: 'edge-intermittent',
  labels: [
    /^T12 \/ E2 \/media\/seg-\d{5}\.m4s: the host's hits for the path rise by exactly 1$/,
    /^T12 \/ E2 \/media\/seg-\d{5}\.m4s: exactly one viewer loads it from the host, with one ask, as the first fetcher or as a fallback with nothing announced$/,
    'E4 each path has at most one first',
  ],
  admits: ['fail', 'pass'],
  admission: 'always',
  evidence: '10a d1-findings A-8; survey S9',
});

const L4 = Object.freeze({
  id: 't10-saturated',
  labels: windows.map((w) => `T10 ${w} retains a qualifying saturated stretch`),
  admits: ['not-exercised', 'pass'],
  admission: 'always',
  evidence: '10a tasks A2; t7-verify-final-1.log',
});

export const REGISTERED_LIST = Object.freeze([L3, L4]);

/** L1 and L2 as registered: dormant while T5 settles, kept so the admission rules stay proved. */
export function t5Entries(admission) {
  const t5 = {
    id: 't5-not-settling',
    labels: windows.flatMap((w) => [
      T5_END(w),
      `T5 ${w} is inside the threshold at the end of the wait`,
      `T5 ${w} recorded a correction`,
      `T5 ${w} applied a rate write`,
      `T5 ${w} settled within 75000ms`,
    ]),
    admits: ['fail', 'pass'],
    admission,
    evidence: '11a d1-findings F2; tasks 1.2',
  };
  const int = windows.map((w) => ({
    id: 'int-after-t5',
    labels: [INT_POLICY(w)],
    admits: ['fail'],
    admission,
    details: ['["never-settled"]', '["hold-fresh-dwell-5000ms:unavailable","never-settled"]'],
    requires: { label: T5_END(w), entry: t5.id },
    evidence: 'survey S8; Q2',
  }));
  return Object.freeze([Object.freeze(t5), ...int.map((entry) => Object.freeze(entry))]);
}

export const L1_L2_REFERENCE = Object.freeze({
  unconditional: t5Entries('unconditional'),
  version: t5Entries('version'),
  flavour: t5Entries('flavour'),
});

const matches = (pattern, label) => (pattern instanceof RegExp ? pattern.test(label) : pattern === label);
const listed = (entry, label) => entry.labels.some((pattern) => matches(pattern, label));

function admissionHolds(admission, chrome) {
  if (admission === 'version') return chrome.browser !== 'Chrome/155.0.8059.39';
  if (admission === 'flavour') return chrome.override === null;
  return true;
}

function admits(entry, result, ctx) {
  if (!listed(entry, result.label) || !entry.admits.includes(result.status)) return false;
  if (!admissionHolds(entry.admission, ctx.chrome)) return false;
  if (entry.details && !entry.details.includes(result.detail)) return false;
  if (!entry.requires) return true;
  const { label, entry: entryId } = entry.requires;
  return ctx.results.some((other) => other.label === label && other.status === 'fail'
    && ctx.list.some((e) => e.id === entryId && admits(e, other, ctx)));
}

export function evaluateRun({ results, errors, chrome, list = REGISTERED_LIST }) {
  const ctx = { results, chrome, list };
  const admitted = [];
  const unadmitted = [];
  for (const result of results) {
    if (result.status === 'pass') continue;
    const entry = list.find((e) => admits(e, result, ctx));
    if (entry) admitted.push({ label: result.label, status: result.status, entryId: entry.id });
    else if (result.status === 'not-exercised' && result.approvedStem) continue;
    else {
      const named = list.find((e) => listed(e, result.label));
      unadmitted.push({
        label: result.label,
        status: result.status,
        detail: result.detail,
        reason: named ? `entry ${named.id} does not admit this result` : 'no entry lists it',
      });
    }
  }
  const unobservedEntries = [...new Set(list.map((e) => e.id))]
    .filter((id) => !results.some((r) => list.some((e) => e.id === id && listed(e, r.label))));
  const exitCode = errors.length === 0 && unadmitted.length === 0 ? 0 : 1;
  return { exitCode, admitted, unadmitted, errors: [...errors], unobservedEntries };
}

/** The evidence a row prints, by entry id, across the list the verdict was read against. */
export function reportLines(verdict, list = [...REGISTERED_LIST, ...L1_L2_REFERENCE.unconditional]) {
  const evidenceOf = (id) => list.find((e) => e.id === id)?.evidence ?? 'unregistered';
  const lines = verdict.admitted.map((row) => `${row.status === 'fail' ? 'FAIL' : 'NOT EXERCISED'}  ${row.label} — listed: ${row.entryId} (${evidenceOf(row.entryId)})`);
  if (verdict.unadmitted.length > 0) {
    lines.push(`UNADMITTED: ${verdict.unadmitted.map((row) => `${row.label} [${row.status}] — ${row.reason}`).join('; ')}`);
  }
  if (verdict.unobservedEntries.length > 0) lines.push(`UNOBSERVED: ${verdict.unobservedEntries.join(', ')}`);
  lines.push(`EXIT ${verdict.exitCode} — ${verdict.admitted.length} admitted, ${verdict.unadmitted.length} unadmitted, ${verdict.errors.length} error(s)`);
  return lines;
}
