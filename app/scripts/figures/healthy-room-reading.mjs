import { runBuildIds } from '../harness/build-identity.mjs';

export const MEASURED_CONDITION = '12c2-healthy-2s';
export const ATTEMPTS_MAX = 2;
const NOT_RUN = /^(refused|aborted|failed|not-)/;

const DRIFT_FIELDS = ['pairwiseDriftAbsMsMedian', 'pairwiseDriftAbsMsMedianLowerEnd', 'pairwiseDriftAbsMsMedianUpperEnd',
  'pairwiseDriftAbsMsP99', 'pairwiseDriftAbsMsP99LowerEnd', 'pairwiseDriftAbsMsP99UpperEnd', 'criterionVerdict',
  'instrumentFloorMsP50', 'instrumentFloorMsP99', 'clockDelayTermMsP50ByClient', 'clockDelayTermMsP99ByClient',
  'clockAgeTermMsP50ByClient', 'clockAgeTermMsP99ByClient', 'presentIntervalMsByClient', 'cadenceClassificationByClient',
  'uplinkUtilisationMean', 'uplinkUtilisationPeak'];

const isMeasured = (entry) => entry?.condition === MEASURED_CONDITION && entry.publishes !== false;
const isShakedown = (entry) => String(entry?.condition ?? '').startsWith('shakedown/12c2-');

/** Whether a viewer's polls carried a placement of 0 throughout: every poll that carried one. */
export function placementReading(polls) {
  const values = (polls ?? []).map((poll) => poll?.playback?.placementMs);
  const zero = values.filter((value) => value === 0).length;
  const nonzero = values.filter((value) => Number.isFinite(value) && value !== 0).length;
  return { polls: values.length, zero, nonzero, pending: values.length - zero - nonzero,
    zeroThroughout: values.length > 0 && zero > 0 && nonzero === 0 };
}

/** The fields on which a run's identity differs from `build.json`. */
export function identityDifferences(run, build) {
  const ids = runBuildIds(run.identities ?? []);
  const fields = { commit: [run.entry.commit, build.commit], bundleBuildId: [run.entry.bundleBuildId, build.bundleBuildId],
    imageOrigin: [run.entry.imageDigests?.origin, build.imageDigests?.origin],
    imageClient: [run.entry.imageDigests?.client, build.imageDigests?.client] };
  const differing = Object.entries(fields).filter(([, [actual, expected]]) => actual == null || actual !== expected).map(([field]) => field);
  if (ids.length !== 1 || ids[0] !== build.bundleBuildId) differing.push('runDirectoryBuildId');
  return differing;
}

function runReading({ entry, publishedDrift, settledDrift, aheadForGood, placement, roles, recomputeError }) {
  // The host tab polls nothing, so only viewers are read (D1 F2).
  const viewers = Object.entries(placement ?? {}).filter(([tag]) => roles?.[tag] === 'viewer');
  const settled = settledDrift?.status === 'published' && typeof settledDrift.shown !== 'undefined' ? settledDrift : null;
  const reason = NOT_RUN.test(entry.outcome ?? '') ? `outcome:${entry.outcome}` : recomputeError ? `recompute:${recomputeError}`
    : !publishedDrift || publishedDrift.published === false ? 'published-drift-missing' : !settled ? 'settled-drift-missing' : null;
  return { directory: entry.directory, attempt: entry.attempt ?? null, outcome: entry.outcome ?? null, unreadable: reason !== null,
    reason, drift: Object.fromEntries(DRIFT_FIELDS.map((field) => [field, publishedDrift?.[field] ?? null])),
    aheadForGoodAfterReadyMs: aheadForGood?.aheadForGoodAfterReadyMs ?? null,
    settledDrift: { status: settledDrift?.status ?? 'missing', shown: settled?.shown ?? null, shownReason: settled?.shownReason ?? null,
      shownBy: settled?.shownBy ?? null, settledAtSharedMsByClient: settled ? Object.fromEntries(Object.entries(settled.byClient)
        .map(([tag, client]) => [tag, client.settledAtSharedMs ?? null])) : null },
    placement, placementZeroThroughout: viewers.length > 0 && viewers.every(([, viewer]) => viewer.zeroThroughout) };
}

function answer(readings) {
  if (readings.some((run) => !run.unreadable && run.settledDrift.shown === true)) return 'shown';
  const read = readings.filter((run) => !run.unreadable && run.settledDrift.shown === false);
  return readings.length === ATTEMPTS_MAX && read.length === ATTEMPTS_MAX ? 'not-shown' : 'not-established';
}

/** One reading of the run set; `runs` are registry entries with what each run directory retained. */
export function healthyRoomReading({ runs = [], build, unregisteredDirectories = [], generatedFrom = null } = {}) {
  const listed = runs.filter((run) => isShakedown(run.entry)).map(({ entry }) => ({ directory: entry.directory,
    condition: entry.condition, outcome: entry.outcome ?? null, evidenceOf: entry.evidenceOf ?? null }));
  const set = runs.filter((run) => isMeasured(run.entry));
  const refused = (reason, extra = {}) => ({ status: 'refused', reason, buildIdentity: null, runs: [], shownAnswer: null,
    shakedown: listed, generatedFrom, ...extra });
  if (unregisteredDirectories.length) return refused('run-directory-unregistered', { unregisteredDirectories });
  if (set.length > ATTEMPTS_MAX) return refused('too-many-attempts', { attempts: set.length });
  const differing = set.map((run) => ({ directory: run.entry.directory, fields: identityDifferences(run, build) }))
    .filter((row) => row.fields.length);
  const buildIdentity = { status: differing.length ? 'differs' : 'equal', expected: build, differing };
  if (differing.length) return refused('build-identity-differs', { buildIdentity });
  const readings = set.map(runReading);
  return { status: 'read', reason: null, buildIdentity, runs: readings, shownAnswer: answer(readings),
    shakedown: listed, generatedFrom };
}
