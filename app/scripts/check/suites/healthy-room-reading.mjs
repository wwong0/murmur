// 12c-2 D2/D3: one reading of the run set, refused unless every measured run is on build.json's build.

import { assert, assertEqual, check } from '../harness.mjs';
import { healthyRoomReading, placementReading } from '../../figures/healthy-room-reading.mjs';

const BUILD_ID = '2026-10-21T09:00:00.000Z-aaaaaa';
const build = { commit: 'abc1234', bundleBuildId: BUILD_ID, imageDigests: { origin: 'sha256:origin', client: 'sha256:client' } };
const identity = (buildId = BUILD_ID) => ({ host: buildId, viewers: { c01: buildId, c02: buildId }, disk: buildId });

function entry(condition, attempt, overrides = {}) {
  return { directory: `${condition}-${attempt}`, condition, attempt, outcome: 'complete', publishes: true, commit: build.commit,
    bundleBuildId: BUILD_ID, imageDigests: build.imageDigests, ...overrides };
}
const settled = (shown, extra = {}) => ({ row: 'settled-drift', status: 'published', shown, shownBy: shown ? [{ tag: 'c01', startSharedMs: 1 }] : [],
  byClient: { c01: { status: 'settled', settledAtSharedMs: 5 } }, ...extra });
const placement = (zeroThroughout = true) => ({ c01: { polls: 3, zero: 3, nonzero: 0, pending: 0, zeroThroughout } });
const measured = (attempt, shown, { entry: entryChange, ...overrides } = {}) => ({ entry: entry('12c2-healthy-2s', attempt, entryChange),
  identities: [identity(), identity()], publishedDrift: { pairwiseDriftAbsMsMedian: 0.1, criterionVerdict: { verdict: 'met' } },
  settledDrift: settled(shown), aheadForGood: { aheadForGoodAfterReadyMs: 4000 }, placement: placement(), roles: { c00: 'host', c01: 'viewer' },
  ...overrides });
const read = (runs, extra = {}) => healthyRoomReading({ runs, build, generatedFrom: 'results/RUNS-12c-2.json', ...extra });

export default async function healthyRoomReadingSuite() {
  await check('healthy-room-reading: a run on another build refuses the reading, field by field', async () => {
    const changes = [['bundleBuildId', { bundleBuildId: 'other' }], ['commit', { commit: 'def5678' }],
      ['imageOrigin', { imageDigests: { origin: 'sha256:other', client: 'sha256:client' } }],
      ['imageClient', { imageDigests: { origin: 'sha256:origin', client: 'sha256:other' } }]];
    for (const [field, change] of changes) {
      const reading = read([measured(1, false), measured(2, false, { entry: change })]);
      assertEqual(reading.status, 'refused', `${field} differing refuses`);
      assertEqual(reading.reason, 'build-identity-differs', `${field}: the reason`);
      assert(reading.buildIdentity.differing[0].fields.includes(field), `${field} is named`);
      assertEqual(reading.shownAnswer, null, `${field}: nothing is concluded`);
    }
    const onDisk = read([measured(1, false), measured(2, false, { identities: [identity(), identity('another-build')] })]);
    assertEqual(onDisk.reason, 'build-identity-differs', 'a run directory\'s own ids differing refuses');
    assert(onDisk.buildIdentity.differing[0].fields.includes('runDirectoryBuildId'), 'and names that field');
    assertEqual(read([measured(1, false), measured(2, false)]).status, 'read', 'equal identities are read');
  });

  await check('healthy-room-reading: an unregistered directory and a third attempt are refused', async () => {
    assertEqual(read([measured(1, false)], { unregisteredDirectories: ['12c2-healthy-2s-2026-10-22'] }).reason, 'run-directory-unregistered',
      'a directory the registry does not list');
    assertEqual(read([measured(1, false), measured(2, false), measured(3, false)]).reason, 'too-many-attempts', 'more than two entries');
  });

  await check('healthy-room-reading: a run that shows drift makes the set shown, and two that do not make it not-shown', async () => {
    assertEqual(read([measured(1, false), measured(2, true)]).shownAnswer, 'shown', 'one shown run');
    assertEqual(read([measured(1, false), measured(2, false)]).shownAnswer, 'not-shown', 'two read runs, neither shown');
    const reading = read([measured(1, true), measured(2, false)]);
    assertEqual(reading.runs[0].settledDrift.shownBy[0].tag, 'c01', 'who showed it');
    assertEqual(reading.runs[0].aheadForGoodAfterReadyMs, 4000, 'ahead-for-good is carried');
    assertEqual(reading.runs[0].placementZeroThroughout, true, 'and the placement');
  });

  await check('healthy-room-reading: one unreadable run and one not shown is not established', async () => {
    const unreadable = measured(1, null, { settledDrift: settled(null, { shownReason: 'unreadable:c01' }) });
    const reading = read([unreadable, measured(2, false)]);
    assertEqual(reading.shownAnswer, 'not-established', 'not established');
    assertEqual(reading.runs[0].unreadable, false, 'a null shown is a reading');
    const aborted = read([measured(1, false, { entry: { outcome: 'aborted' } }), measured(2, false)]);
    assertEqual(aborted.runs[0].unreadable, true, 'an aborted run is unreadable');
    assertEqual(aborted.shownAnswer, 'not-established', 'and does not count as read');
    assertEqual(read([measured(1, false)]).shownAnswer, 'not-established', 'one run is not the registered two');
  });

  await check('healthy-room-reading: shakedown runs are listed and never read or compared', async () => {
    const shakedown = { entry: entry('shakedown/12c2-qual-healthy', 1, { publishes: false, bundleBuildId: 'another-build', evidenceOf: 'qualification' }),
      identities: [identity('another-build')], settledDrift: settled(true) };
    const reading = read([shakedown, measured(1, false), measured(2, false)]);
    assertEqual(reading.status, 'read', 'a shakedown on another build does not refuse');
    assertEqual(reading.shakedown.length, 1, 'it is listed');
    assertEqual(reading.runs.length, 2, 'only the measured runs are read');
    assertEqual(reading.shownAnswer, 'not-shown', 'and its shown drift is not counted');
  });

  await check('healthy-room-reading: placement is zero throughout only when every poll carrying one carries 0', async () => {
    const poll = (placementMs) => ({ playback: { placementMs } });
    assertEqual(placementReading([poll(null), poll(0), poll(0)]).zeroThroughout, true, 'pending then 0');
    assertEqual(placementReading([poll(0), poll(21.333)]).zeroThroughout, false, 'a 21.333 ms poll is outside');
    assertEqual(placementReading([poll(null)]).zeroThroughout, false, 'never known');
    assertEqual(placementReading([]).zeroThroughout, false, 'no polls');
  });

  await check('healthy-room-reading: placement is read over the viewers only, so the empty host poll stream does not count', async () => {
    const empty = { polls: 0, zero: 0, nonzero: 0, pending: 0, zeroThroughout: false };
    const withHost = { c00: empty, ...placement() };
    assertEqual(read([measured(1, false, { placement: withHost }), measured(2, false)]).runs[0].placementZeroThroughout, true,
      'the host c00 with no polls, every viewer at 0');
    assertEqual(read([measured(1, false, { placement: { c00: empty, ...placement(false) } })]).runs[0].placementZeroThroughout, false,
      'a viewer not at 0 throughout');
    assertEqual(read([measured(1, false, { placement: withHost, roles: { c00: 'viewer', c01: 'viewer' } })]).runs[0].placementZeroThroughout,
      false, 'an empty viewer stream is not zero throughout');
    assertEqual(read([measured(1, false, { placement: withHost, roles: {} })]).runs[0].placementZeroThroughout, false, 'no roles, no viewers read');
  });
}
