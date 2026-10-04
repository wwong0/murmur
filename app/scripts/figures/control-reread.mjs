import { accepted } from './regimes-reading.mjs';

const RESPONSE_CHECK = 'response-agreement';
const RESPONSE_REASON = `peer-check-failed:${RESPONSE_CHECK}`;
const FAILURE_FIELDS = ['type', 'tag', 'requestId', 'originResponseId'];
const LABEL_KEYS = ['build', 'reading', 'standing'];

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function checksOf(report) {
  const figures = report?.figures;
  if (Array.isArray(figures?.peerChecks)) return figures.peerChecks;
  if (Array.isArray(report?.peerChecks)) return report.peerChecks;
  return null;
}

function responseFailures(report) {
  const check = checksOf(report)?.find((entry) => entry?.check === RESPONSE_CHECK);
  return check && Array.isArray(check.failures) ? check.failures : null;
}

function failureKey(failure) {
  return JSON.stringify(FAILURE_FIELDS.map((field) => failure?.[field] ?? null));
}

function sameFailureSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftKeys = new Set(left.map(failureKey));
  const rightKeys = new Set(right.map(failureKey));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

// A recompute publishes its byte figure unless the publication gate refused it.
export function bytePublished(report) {
  return Boolean(report?.publishedByte) && report.publishedByte.published !== false;
}

// What a recompute still refuses on: each failing peer check's failures, and an
// unpublished byte figure. Empty means nothing is left.
export function remainingRefusals(report) {
  const checks = checksOf(report);
  if (checks === null) return [{ reason: 'peer-checks-unavailable' }];
  const failing = checks.filter((check) => check?.passed !== true).flatMap((check) => {
    const reason = `peer-check-failed:${check?.check ?? 'unknown'}`;
    return Array.isArray(check?.failures) && check.failures.length
      ? check.failures.map((failure) => ({ reason, ...failure })) : [{ reason }];
  });
  return [...failing, ...(bytePublished(report) ? [] : [{ reason: 'byte-figure-not-published' }])];
}

export function rulesOf(ruleSet) {
  const labels = ruleSet?.labels;
  if (!LABEL_KEYS.every((key) => typeof labels?.[key] === 'string' && labels[key].length > 0)) {
    throw new Error('rule-set-labels-invalid');
  }
  if (typeof ruleSet?.settled !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ruleSet.settled)
    || !Number.isFinite(Date.parse(`${ruleSet.settled}T00:00:00Z`))) {
    throw new Error('rule-set-settled-invalid');
  }
  if (!Array.isArray(ruleSet?.rules)) throw new Error('rule-set-rules-invalid');
  const bars = {};
  const removeBars = [];
  const excusals = {};
  for (const rule of ruleSet.rules) {
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0
      || typeof rule.rule !== 'string' || rule.rule.length === 0
      || typeof rule.replaces !== 'string' || rule.replaces.length === 0) {
      throw new Error('rule-set-rule-invalid');
    }
    if (rule.bars !== undefined) {
      if (!rule.bars || typeof rule.bars !== 'object' || Array.isArray(rule.bars)
        || Object.values(rule.bars).some((value) => !Number.isFinite(value))) throw new Error(`rule-bars-invalid:${rule.id}`);
      Object.assign(bars, rule.bars);
    }
    if (rule.removeBars !== undefined) {
      if (!Array.isArray(rule.removeBars) || rule.removeBars.some((key) => typeof key !== 'string')) {
        throw new Error(`rule-remove-bars-invalid:${rule.id}`);
      }
      for (const key of rule.removeBars) if (!removeBars.includes(key)) removeBars.push(key);
    }
    if (rule.excusals !== undefined) {
      if (!rule.excusals || typeof rule.excusals !== 'object' || Array.isArray(rule.excusals)) {
        throw new Error(`rule-excusals-invalid:${rule.id}`);
      }
      Object.assign(excusals, rule.excusals);
    }
  }
  return { bars, removeBars, excusals };
}

// design.md D4: a run refused only by D3's receipts becomes accepted under the
// re-read, never accepted as registered. The registered recompute must reproduce
// the live refusal first, or the excusal would be excusing something unseen.
export function rereadAcceptance({ entry, liveReasons = [], registeredReport, rereadReport } = {}) {
  const acceptedAsRegistered = accepted(entry);
  if (acceptedAsRegistered) return { acceptedAsRegistered, acceptedUnderReread: true, refusedUnderReread: [] };
  const refused = (refusedUnderReread) => ({ acceptedAsRegistered, acceptedUnderReread: false, refusedUnderReread });
  const live = Array.isArray(liveReasons) ? liveReasons : [];
  const remaining = remainingRefusals(rereadReport);
  if (entry?.outcome !== 'refused' || live.length === 0) {
    return refused([{ reason: 'no-live-refusal-recorded', outcome: entry?.outcome ?? null }, ...remaining]);
  }
  const otherLive = live.filter((reason) => reason?.reason !== RESPONSE_REASON);
  if (otherLive.length) return refused([...otherLive, ...remaining]);
  const liveFailures = live.flatMap((reason) => (Array.isArray(reason?.failures) ? reason.failures : []));
  if (!sameFailureSet(liveFailures, responseFailures(registeredReport))) {
    return refused([{ reason: 'live-refusal-not-reproduced' }]);
  }
  return remaining.length ? refused(remaining)
    : { acceptedAsRegistered, acceptedUnderReread: true, refusedUnderReread: [] };
}

// ---- The equality check (design.md D6, tasks.md 3.4) ----
// 8b2's file stays as published, so the registered side must still say what it
// says. `permitted` is the whole list of what may differ; anything else is returned.
const ABSENT = Symbol('absent');
const ADDED_KEYS = new Set(['pace', 'capUsed', 'matchedOn', 'buildMatch']);
const CANDIDATE_KEYS = new Set(['qualifies', 'sameBuildAsArm', 'rejected']);
const NEWLY_READ_KEYS = new Set(['reading', 'readingKey', 'reasons', 'criteria', 'criterion']);

function permitted(path, fileValue, recomputedValue, file) {
  const last = path.at(-1);
  const added = fileValue === ABSENT;
  // 1. Keys this change adds: both pace values (D2), the build match (D6), 8a's
  //    class on a seek run, 8a's reading and the sweep positions on the report.
  if (added && ADDED_KEYS.has(last)) return true;
  if (added && path[0] === 'runs' && path.length === 3 && last === 'trapClass') return true;
  if (added && path.length === 1 && (last === 'trapReading' || last === 'sweep')) return true;
  // 2. The failed steady leg's name and value (J12).
  if (path.includes('failedLeg')) return true;
  if (last === 'reason' && ['criteria', 'criterion'].includes(path.at(-3))
    && [fileValue, recomputedValue].every((value) => typeof value === 'string' && value.startsWith('steady:'))) return true;
  if (path[0] === 'arms') {
    // 3. What the build match decides about a control candidate.
    if (path[2] === 'control' && path[3] === 'candidates' && CANDIDATE_KEYS.has(path[5])) return true;
    // 4. An arm the file could not read for want of a matching control may read.
    const arm = file.arms?.[path[1]];
    const reasons = arm?.reasons ?? [];
    const unread = arm?.reading === 'No reading' && reasons.length > 0
      && reasons.every((reason) => String(reason).startsWith('control-unavailable:'));
    if (unread && (NEWLY_READ_KEYS.has(path[2]) || (path[2] === 'control' && path[3] === 'selected'))) return true;
  }
  // 5. The baseline cell the file could not match, and the two maps derived from it.
  if (path[0] === 'baseline' && path.at(-1) !== undefined
    && file.baseline?.[path[1]]?.cells?.sameBuildBaseline?.reason === 'baseline-build-mismatch') {
    if (path[2] === 'cells' && path[3] === 'sameBuildBaseline') return true;
    if ((path[2] === 'multiplier' || path[2] === 'peerFraction') && path[3] === 'sameBuildBaseline') return true;
  }
  return false;
}

const container = (value) => value !== ABSENT && value !== null && typeof value === 'object';

function walk(path, fileValue, recomputedValue, visit) {
  if (fileValue !== ABSENT && recomputedValue !== ABSENT && equal(fileValue, recomputedValue)) return;
  if (container(fileValue) && container(recomputedValue) && Array.isArray(fileValue) === Array.isArray(recomputedValue)) {
    for (const key of new Set([...Object.keys(fileValue), ...Object.keys(recomputedValue)])) {
      walk([...path, key], own(fileValue, key) ? fileValue[key] : ABSENT,
        own(recomputedValue, key) ? recomputedValue[key] : ABSENT, visit);
    }
    return;
  }
  visit(path, fileValue, recomputedValue);
}

function pathText(path) {
  if (path[0] === 'runs' && path.length > 1) return `runs[${path[1]}]${path.slice(2).map((key) => `.${key}`).join('')}`;
  return path.join('.');
}

const runsByDirectory = (report) => ({ ...report,
  runs: Object.fromEntries((report?.runs ?? []).map((run) => [run.directory, run])) });

export function registeredDifferences(file, recomputed) {
  const differences = [];
  walk([], runsByDirectory(file), runsByDirectory(recomputed), (path, fileValue, recomputedValue) => {
    if (permitted(path, fileValue, recomputedValue, file)) return;
    differences.push({ path: pathText(path), file: fileValue === ABSENT ? '(absent)' : fileValue,
      recomputed: recomputedValue === ABSENT ? '(absent)' : recomputedValue });
  });
  return differences;
}

function labelledEntries(report) {
  const entries = [{ path: 'report', value: report }];
  for (const run of report?.runs ?? []) entries.push({ path: `runs[${run?.directory ?? 'unknown'}]`, value: run });
  for (const [name, arm] of Object.entries(report?.arms ?? {})) entries.push({ path: `arms.${name}`, value: arm });
  entries.push({ path: 'confirms', value: report?.confirms });
  for (const [index, position] of (report?.sweep?.positions ?? []).entries()) {
    entries.push({ path: `sweep.positions[${index}]`, value: position });
  }
  entries.push({ path: 'fullUplinkClock', value: report?.fullUplinkClock });
  for (const [index, run] of (report?.fullUplinkClock?.runs ?? []).entries()) {
    entries.push({ path: `fullUplinkClock.runs[${index}]`, value: run });
  }
  return entries;
}

// design.md D5. The expected labels are the rule set's, not the report's own copy:
// a report whose labels were all altered alike would otherwise agree with itself.
export function labelFaults(report) {
  const expected = report?.ruleSet?.labels;
  const entries = labelledEntries(report);
  return entries.filter(({ value }) => !LABEL_KEYS.every((key) => typeof expected?.[key] === 'string'
    && value?.labels?.[key] === expected[key])).map(({ path }) => path);
}

function armResult(arms, name, criterion) {
  const arm = arms?.[name];
  if (!arm || arm.reading === 'No reading') return 'no-reading';
  return arm.criteria?.[criterion]?.result ?? 'unestablished';
}

export function confirmation(arms) {
  const result = {
    criterion2Five: armResult(arms, 'control-five', 'multiplier'),
    criterion3Five: armResult(arms, 'control-five', 'peerFraction'),
    criterion2Ten: armResult(arms, 'control-ten', 'multiplier'),
  };
  const names = ['criterion2Five', 'criterion3Five', 'criterion2Ten'];
  return { ...result, confirmed: names.every((name) => result[name] === 'met'),
    reasons: names.filter((name) => result[name] !== 'met') };
}
