// What each NC row decides from the booleans and counts the driver read (12d D7, D9). Pure:
// no page, no clock. A row with no evidence, or with a field missing, reads EVIDENCE MISSING —
// never a pass, and never a fail that blames the product.

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_EXERCISED: 'NOT EXERCISED',
  MISSING: 'EVIDENCE MISSING',
});

const isCount = (value) => Number.isInteger(value) && value >= 0;

const ROWS = {
  NC0: {
    label: 'NC0 the served bundle is the build, in a recorded Chrome',
    keys: ['bundleMatches', 'pageIdInServed', 'chromeRecorded'],
    exercised: (e) => e.chromeRecorded === true,
    ok: (e) => e.bundleMatches === true && e.pageIdInServed === true,
  },
  NC1: {
    label: 'NC1 host and viewer each answer the prompt with a generated name, both lists show both, and the roster shows none',
    keys: ['hostAnswered', 'viewerAnswered', 'hostListNames', 'viewerListNames', 'rosterRows', 'rosterShaped', 'rosterNameHits'],
    exercised: (e) => e.hostAnswered === true && e.viewerAnswered === true,
    ok: (e) => e.hostListNames === 2 && e.viewerListNames === 2 && e.rosterRows === 2 && e.rosterShaped === e.rosterRows && e.rosterNameHits === 0,
  },
  NC2: {
    label: 'NC2 a rename through the own participants entry writes one rename line on both pages',
    keys: ['renameAnswered', 'hostRenameLines', 'viewerRenameLines'],
    exercised: (e) => e.renameAnswered === true,
    ok: (e) => e.hostRenameLines === 1 && e.viewerRenameLines === 1,
  },
  NC3: {
    label: 'NC3 a reload shows no prompt, keeps the stored name, and both lists show it',
    // The name it looks for is NC2's rename, so no rename means nothing to keep (d1-findings F10, post-result).
    keys: ['reloaded', 'renamed', 'promptSamplesShown', 'storagePresent', 'hostListHasName', 'viewerListHasName'],
    exercised: (e) => e.reloaded === true && e.renamed === true,
    ok: (e) => e.promptSamplesShown === 0 && e.storagePresent === true && e.hostListHasName === true && e.viewerListHasName === true,
  },
  NC4: {
    label: 'NC4 both pages show the host’s hello then the viewer’s hi, in that order',
    keys: ['sent', 'hostOrdered', 'viewerOrdered'],
    exercised: (e) => e.sent === true,
    ok: (e) => e.hostOrdered === true && e.viewerOrdered === true,
  },
  NC5: {
    label: 'NC5 markup shows as its characters, makes no element, and a 300-character word does not widen the activity region',
    keys: ['sent', 'literalOnHost', 'literalOnViewer', 'boldElements', 'fitsOnHost', 'fitsOnViewer'],
    exercised: (e) => e.sent === true,
    ok: (e) => e.literalOnHost === true && e.literalOnViewer === true && e.boldElements === 0 && e.fitsOnHost === true && e.fitsOnViewer === true,
  },
  NC6: {
    label: 'NC6 a sender over the burst sees the warning alone, and keeps the refused text in the input',
    keys: ['sends', 'burst', 'warnedViewer', 'warnedHost', 'inputHolds', 'hostHasRefused'],
    exercised: (e) => isCount(e.sends) && e.sends > 0,
    ok: (e) => e.warnedViewer >= 1 && e.warnedHost === 0 && e.sends <= e.burst + 1 && e.inputHolds === true && e.hostHasRefused === false,
  },
  NC7: {
    label: 'NC7 no name or text reaches the notices, the roster or the server output',
    keys: ['noticeHits', 'rosterHits', 'serverHits', 'serverLines'],
    exercised: (e) => isCount(e.serverLines) && e.serverLines > 0,
    ok: (e) => e.noticeHits === 0 && e.rosterHits === 0 && e.serverHits === 0,
  },
};

export const ROW_IDS = Object.keys(ROWS);

export function evaluateRow(id, evidence) {
  const row = ROWS[id];
  const absent = !row || evidence === null || typeof evidence !== 'object'
    || row.keys.some((key) => evidence[key] === undefined || evidence[key] === null);
  if (absent) return { id, label: row?.label ?? id, status: STATUS.MISSING };
  if (!row.exercised(evidence)) return { id, label: row.label, status: STATUS.NOT_EXERCISED };
  return { id, label: row.label, status: row.ok(evidence) ? STATUS.PASS : STATUS.FAIL };
}

export function evaluateAll(evidenceById) {
  return ROW_IDS.map((id) => evaluateRow(id, evidenceById[id]));
}

// Where a line sits in a page's activity lines, or -1.
export const lineIndex = (lines, marker) => lines.findIndex((line) => line.includes(marker));

// Both texts present, the first above the second.
export const inOrder = (lines, first, second) => {
  const a = lineIndex(lines, first);
  const b = lineIndex(lines, second);
  return a >= 0 && b >= 0 && a < b;
};
