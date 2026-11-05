// One reading of the run set, refused unless every run is on one build.

import { assert, assertEqual, check } from '../harness.mjs';
import { leaveRecoveryReading } from '../../figures/leave-recovery-reading.mjs';

const BUILD_ID = '2026-10-21T09:00:00.000Z-aaaaaa';
const ORIGIN_DIGEST = 'sha256:origin';
const CLIENT_DIGEST = 'sha256:client';

const identity = (buildId = BUILD_ID) => ({ host: buildId, viewers: { c01: buildId, c02: buildId }, disk: buildId });
function entry(condition, attempt, overrides = {}) {
  return { directory: `${condition}-${attempt}`, condition, attempt, outcome: 'complete', publishes: true, commit: 'abc1234',
    bundleBuildId: BUILD_ID, imageDigests: { origin: ORIGIN_DIGEST, client: CLIENT_DIGEST }, ...overrides };
}
const riseRecovery = (refilled, { pairs = [], exercised = true } = {}) => ({ status: 'published', reason: null, exercised,
  climb: { status: 'published', reason: null, paceAboveContentAfterMs: 16_000, paceAboveContent: 'reached',
    estimateAboveNinetyAfterMs: null, estimateAboveNinety: 'not-within-120000ms' },
  refill: { status: refilled === null ? 'evidence-failure' : 'published', reason: refilled === null ? 'viewer-evidence-failure' : null,
    refilled, viewers: { c01: { status: 'ok', stalls: refilled === false ? [{ startMs: 1, lengthMs: 400, afterRiseMs: 1 }] : [] } } },
  doubleStalls: { byClient: { c01: { status: 'ok', pairs } } } });
const run = (e, extra = {}) => ({ entry: e, identities: [identity(), identity()], riseRecovery: riseRecovery(true), rosterEvent: null, ...extra });
const comparand = (attempt, refilled, extra = {}) => run(entry('12c1-drop-comparand-2s', attempt), { riseRecovery: riseRecovery(refilled, extra) });
const rows = (k1, k3) => [{ row: 'K1', status: k1 }, { row: 'K3', status: k3 }];
const leaveRun = (attempt, k1 = 'met', k3 = 'met') => run(entry('12c1-leave-first-2s', attempt), { rosterEvent: rows(k1, k3) });
const read = (runs, extra = {}) => leaveRecoveryReading({ runs, generatedFrom: 'results/RUNS-12c-1.json', ...extra });
const refilledPair = () => [comparand(1, true), comparand(2, true)];

export default async function leaveRecoveryReadingSuite() {
  await check('leave-recovery-reading: equal identities are read and shakedown runs are listed, never read', async () => {
    const shakedown = run(entry('shakedown/12c1-qual-rise', 1, { publishes: false, evidenceOf: 'qualification', bundleBuildId: 'another-build' }));
    const reading = read([shakedown, ...refilledPair(), leaveRun(1), leaveRun(2), leaveRun(3)]);
    assertEqual(reading.status, 'read', 'an equal set is read');
    assertEqual(reading.buildIdentity.status, 'equal', 'the identities agree');
    assertEqual(reading.shakedown.length, 1, 'the shakedown run is listed');
    assertEqual(reading.shakedown[0].evidenceOf, 'qualification', 'with its purpose');
    assertEqual(reading.climb.length, 5, 'only the five set runs are read for the climb');
    assertEqual(reading.generatedFrom, 'results/RUNS-12c-1.json', 'the source is named');
    assertEqual(Object.keys(reading).join(), 'status,reason,buildIdentity,comparand,leave,consequence,repeatInterval,climb,shakedown,generatedFrom', 'the shape');
  });

  await check('leave-recovery-reading: a run on another build refuses the whole reading', async () => {
    const fields = [['bundleBuildId', { bundleBuildId: 'other' }], ['commit', { commit: 'def5678' }],
      ['imageOrigin', { imageDigests: { origin: 'sha256:other', client: CLIENT_DIGEST } }],
      ['imageClient', { imageDigests: { origin: ORIGIN_DIGEST, client: 'sha256:other' } }]];
    for (const [field, change] of fields) {
      const reading = read([comparand(1, true), run(entry('12c1-drop-comparand-2s', 2, change), { riseRecovery: riseRecovery(true) })]);
      assertEqual(reading.status, 'refused', `${field} differing refuses`);
      assertEqual(reading.reason, 'build-identity-differs', `${field}: the reason`);
      assertEqual(reading.buildIdentity.differing[0].field, field, `${field} is the differing field`);
      assertEqual(reading.consequence, null, `${field}: nothing is concluded`);
    }
    const onDisk = read([comparand(1, true), run(entry('12c1-drop-comparand-2s', 2), { identities: [identity(), identity('another-build')],
      riseRecovery: riseRecovery(true) })]);
    assertEqual(onDisk.reason, 'build-identity-differs', 'a run directory\'s own build ids differing refuses');
    assertEqual(onDisk.buildIdentity.differing[0].field, 'runDirectoryBuildId', 'and names that field');
  });

  await check('leave-recovery-reading: no comparand and an unregistered directory both refuse', async () => {
    assertEqual(read([leaveRun(1)]).reason, 'comparand-missing', 'an empty comparand list refuses');
    const reading = read(refilledPair(), { unregisteredDirectories: ['12c1-leave-first-2s-2026-10-22'] });
    assertEqual(reading.reason, 'run-directory-unregistered', 'a directory the registry does not list refuses');
  });

  await check('leave-recovery-reading: the comparand reads refilled, one of two, or not refilled', async () => {
    assertEqual(read([comparand(1, true), comparand(2, true), leaveRun(1)]).comparand.reading, 'refilled', 'both refilled');
    assertEqual(read([comparand(1, true), comparand(2, false), leaveRun(1)]).comparand.reading, 'refilled-in-one-of-two', 'one refilled');
    assertEqual(read([comparand(1, false), comparand(2, false)]).comparand.reading, 'not-refilled', 'neither refilled');
    const unreadable = read([comparand(1, true), comparand(2, null)]);
    assertEqual(unreadable.comparand.reading, 'unreadable', 'a refill that is null is unreadable');
    assertEqual(unreadable.comparand.runs[1].unreadable, true, 'and the run is named');
    assertEqual(read([comparand(1, true), comparand(2, true, { exercised: false })]).comparand.reading, 'unreadable', 'a run not exercised is unreadable');
    assertEqual(read([comparand(1, true), run(entry('12c1-drop-comparand-2s', 2, { outcome: 'aborted' }), { riseRecovery: riseRecovery(true) })]).comparand.reading,
      'unreadable', 'an aborted run is unreadable');
    assertEqual(read([comparand(1, true)]).comparand.reading, 'unreadable', 'one comparand attempt is not the registered two');
    assert(unreadable.consequence.startsWith('a comparand attempt is unreadable'), 'which stops and asks');
  });

  await check('leave-recovery-reading: each registered consequence once', async () => {
    const met = read([...refilledPair(), leaveRun(1), leaveRun(2), leaveRun(3)]);
    assertEqual(met.consequence, 'gate met', 'three shown leaves: gate met');
    const remains = read([comparand(1, true), comparand(2, false), leaveRun(1, 'met', 'missed')]);
    assertEqual(remains.consequence, 'the two repairs did not remove the cause; gate missed; the design needs revisiting', 'a miss beside a comparand that did not refill twice');
    assertEqual(read([comparand(1, false), comparand(2, false), leaveRun(1, 'missed', 'met')]).consequence, remains.consequence, 'and beside one that never refilled');
    assertEqual(read([...refilledPair(), leaveRun(1, 'missed', 'met')]).consequence, 'the stall is the leave\'s; the leave rules are still owed; a decision is needed',
      'a miss beside a refilled comparand is the leave\'s');
    const unread = read([...refilledPair(), leaveRun(1), leaveRun(2), leaveRun(3, 'unreadable', 'met')]);
    assertEqual(unread.consequence, 'the write-up quotes the limit, labelled not established', 'two shown and one unread is not established');
    assertEqual(unread.leave.unread, 1, 'the unread run is counted');
    assertEqual(read([comparand(1, false), comparand(2, false)]).consequence, 'stopped before leave-first; gate missed; the design needs revisiting',
      'a comparand that never refilled with no leave run stops');
    assertEqual(read(refilledPair()).consequence, 'leave-first not run; no reading of the gate', 'a refilled comparand with no leave run has no reading');
  });

  await check('leave-recovery-reading: a double stall with a skip in a refilled comparand run is the repeat interval\'s consequence', async () => {
    const pair = { first: {}, second: {}, distanceMs: 16_000, skippedBetween: { count: 1, evidence: 'measured' } };
    const triggered = read([comparand(1, true, { pairs: [pair] }), comparand(2, true), leaveRun(1)]);
    assertEqual(triggered.repeatInterval.triggered, true, 'one pair with a skip triggers');
    assertEqual(triggered.repeatInterval.consequence, 'the 60 s repeat interval is an open question', 'the registered consequence');
    assertEqual(triggered.repeatInterval.pairs[0].distanceMs, 16_000, 'the pair is named');
    const noSkip = { ...pair, skippedBetween: { count: 0, evidence: 'measured' } };
    assertEqual(read([comparand(1, true, { pairs: [noSkip] }), comparand(2, true)]).repeatInterval.triggered, false, 'a pair without a skip does not');
    assertEqual(read([comparand(1, false, { pairs: [pair] }), comparand(2, false)]).repeatInterval.triggered, false, 'a run that did not refill does not');
    const unavailable = { ...pair, skippedBetween: { count: null, evidence: 'unavailable' } };
    assertEqual(read([comparand(1, true, { pairs: [unavailable] }), comparand(2, true)]).repeatInterval.triggered, false, 'an unavailable skip count does not');
  });

  await check('leave-recovery-reading: the climb summary is carried for every run in the set', async () => {
    const reading = read([...refilledPair(), leaveRun(1)]);
    assertEqual(reading.climb[0].paceAboveContentAfterMs, 16_000, 'when the pace passed the content rate');
    assertEqual(reading.climb[0].estimateAboveNinety, 'not-within-120000ms', 'and the label where the estimate never reached 0.9');
  });
}
