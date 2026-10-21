import { leaveArmReading } from './roster-event.mjs';

export const COMPARAND_CONDITION = '12c1-drop-comparand-2s';
export const LEAVE_CONDITION = '12c1-leave-first-2s';
const NOT_RUN = /^(refused|aborted|failed|not-)/;

const CONSEQUENCE = Object.freeze({
  met: 'gate met',
  causeRemains: 'D1 and D2 did not remove the cause; gate missed; design returns to the owner',
  leaveStall: 'the stall is the leave\'s; D3\'s rules owed; owner decides',
  notEstablished: 'change 13 quotes the limit, labelled not established',
  stopped: 'stopped before leave-first; gate missed; returns to the owner',
  leaveNotRun: 'leave-first not run; no reading of the gate',
  comparandUnreadable: 'a comparand attempt is unreadable; stop and ask the coordinator',
  repeatInterval: '10a\'s 60 s repeat interval is an Open Question for the owner',
});

const inSet = (entry) => (entry?.condition === COMPARAND_CONDITION || entry?.condition === LEAVE_CONDITION)
  && entry.publishes !== false;

function runBuildId(identities) {
  const ids = new Set(identities.filter(Boolean).flatMap((identity) => [identity.host, identity.disk,
    ...Object.values(identity.viewers ?? {})]));
  return ids.size === 1 ? [...ids][0] : ids.size === 0 ? null : `mixed:${[...ids].sort().join(',')}`;
}

function buildIdentity(runs) {
  const fieldsOf = ({ entry, identities }) => ({ commit: entry.commit ?? null, bundleBuildId: entry.bundleBuildId ?? null,
    imageOrigin: entry.imageDigests?.origin ?? null, imageClient: entry.imageDigests?.client ?? null,
    runDirectoryBuildId: runBuildId(identities ?? []) });
  const rows = runs.map((run) => ({ directory: run.entry.directory, ...fieldsOf(run) }));
  const names = Object.keys(rows[0] ?? {}).filter((name) => name !== 'directory');
  const differing = names.filter((name) => rows.some((row) => row[name] === null || row[name] !== rows[0][name]))
    .map((field) => ({ field, values: rows.map((row) => ({ directory: row.directory, value: row[field] })) }));
  return { status: differing.length ? 'differs' : 'equal', runs: rows, differing };
}

function comparandRun({ entry, riseRecovery }) {
  const refill = riseRecovery?.refill;
  const unreadable = NOT_RUN.test(entry.outcome ?? '') || riseRecovery?.status !== 'published'
    || riseRecovery.exercised !== true || !refill || refill.refilled === null || refill.refilled === undefined;
  const reason = NOT_RUN.test(entry.outcome ?? '') ? `outcome:${entry.outcome}` : riseRecovery?.status !== 'published'
    ? `rise-recovery:${riseRecovery?.reason ?? 'missing'}` : riseRecovery.exercised !== true ? 'not-exercised'
      : refill?.reason ?? (refill ? null : 'refill-missing');
  return { directory: entry.directory, attempt: entry.attempt ?? null, outcome: entry.outcome ?? null,
    exercised: riseRecovery?.exercised ?? null, refilled: unreadable ? null : refill.refilled, unreadable, reason: unreadable ? reason : null,
    stalls: Object.fromEntries(Object.entries(refill?.viewers ?? {}).map(([tag, viewer]) => [tag, viewer.stalls ?? null])) };
}

function comparandReading(runs) {
  const unreadable = runs.filter((run) => run.unreadable);
  if (unreadable.length) return 'unreadable';
  if (runs.length !== 2) return 'unreadable';
  const refilled = runs.filter((run) => run.refilled === true).length;
  return refilled === 2 ? 'refilled' : refilled === 1 ? 'refilled-in-one-of-two' : 'not-refilled';
}

function consequenceFor({ comparand, leaveRuns, leave }) {
  if (comparand === 'unreadable') return CONSEQUENCE.comparandUnreadable;
  if (!leaveRuns.length) return comparand === 'not-refilled' ? CONSEQUENCE.stopped : CONSEQUENCE.leaveNotRun;
  if (leave.status === 'pass') return CONSEQUENCE.met;
  if (leave.status === 'fail') return comparand === 'refilled' ? CONSEQUENCE.leaveStall : CONSEQUENCE.causeRemains;
  return CONSEQUENCE.notEstablished;
}

function repeatInterval(comparandRuns, riseByDirectory) {
  const pairs = comparandRuns.filter((run) => run.refilled === true).flatMap((run) => Object.entries(
    riseByDirectory[run.directory]?.doubleStalls?.byClient ?? {}).flatMap(([viewer, reading]) => (reading.pairs ?? [])
    .filter((pair) => pair.skippedBetween?.count > 0).map((pair) => ({ directory: run.directory, viewer,
      distanceMs: pair.distanceMs, skipCount: pair.skippedBetween.count }))));
  return { triggered: pairs.length > 0, consequence: pairs.length ? CONSEQUENCE.repeatInterval : null, pairs };
}

const climbSummary = ({ entry, riseRecovery }) => {
  const climb = riseRecovery?.climb;
  return { directory: entry.directory, condition: entry.condition, status: climb?.status ?? 'missing', reason: climb?.reason ?? null,
    paceAboveContentAfterMs: climb?.paceAboveContentAfterMs ?? null, paceAboveContent: climb?.paceAboveContent ?? null,
    estimateAboveNinetyAfterMs: climb?.estimateAboveNinetyAfterMs ?? null, estimateAboveNinety: climb?.estimateAboveNinety ?? null };
};

/**
 * One reading of the run set. `runs` is every registry entry with `identities` (the run
 * directory's build-ids, start and end), `riseRecovery` and `rosterEvent` as recomputed.
 */
export function leaveRecoveryReading({ runs = [], unregisteredDirectories = [], generatedFrom = null } = {}) {
  const set = runs.filter((run) => inSet(run.entry));
  const listed = runs.filter((run) => !inSet(run.entry)).map(({ entry }) => ({ directory: entry.directory, condition: entry.condition,
    evidenceOf: entry.evidenceOf ?? null }));
  const refused = (reason, extra = {}) => ({ status: 'refused', reason, buildIdentity: null, comparand: null, leave: null,
    consequence: null, repeatInterval: null, climb: null, shakedown: listed, generatedFrom, ...extra });
  if (unregisteredDirectories.length) return refused('run-directory-unregistered', { unregisteredDirectories });
  const comparandSet = set.filter((run) => run.entry.condition === COMPARAND_CONDITION);
  if (!comparandSet.length) return refused('comparand-missing');
  const identity = buildIdentity(set);
  if (identity.status === 'differs') return refused('build-identity-differs', { buildIdentity: identity });

  const comparandRuns = comparandSet.map(comparandRun);
  const comparand = comparandReading(comparandRuns);
  const leaveSet = set.filter((run) => run.entry.condition === LEAVE_CONDITION);
  const leave = leaveArmReading({ runs: leaveSet.map((run) => (Array.isArray(run.rosterEvent) ? run.rosterEvent : [])),
    comparands: comparandRuns.map((run) => ({ directory: run.directory, stalls: run.stalls })) });
  const riseByDirectory = Object.fromEntries(set.map((run) => [run.entry.directory, run.riseRecovery]));
  return { status: 'read', reason: null, buildIdentity: identity,
    comparand: { runs: comparandRuns.map(({ stalls, ...run }) => run), reading: comparand },
    leave: { ...leave, runs: leaveSet.map((run) => ({ directory: run.entry.directory, attempt: run.entry.attempt ?? null,
      outcome: run.entry.outcome ?? null })) },
    consequence: consequenceFor({ comparand, leaveRuns: leaveSet, leave }),
    repeatInterval: repeatInterval(comparandRuns, riseByDirectory), climb: set.map(climbSummary),
    shakedown: listed, generatedFrom };
}
