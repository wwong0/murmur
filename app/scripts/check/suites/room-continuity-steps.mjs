import { assertEqual, check } from '../harness.mjs';
import {
  exitCode, grace, rc0, rc1, rc2, rc3, rc4, rc5, rc6, rc7, rc8,
} from '../../room-continuity-steps.mjs';

const idA = `v1:${'a'.repeat(64)}`;
const idB = `v1:${'b'.repeat(64)}`;
const state = (patch = {}) => ({ lineage: 'lineage-a', version: 4, playing: false, positionMs: 0, held: false, atSharedMs: 0, ...patch });
const title = (identity = idA, name = 'title-a.mp4') => ({ title: identity, name });
const member = (identity = idA, name = 'title-a.mp4', patch = {}) => ({ title: title(identity, name), titleName: name, state: state(patch) });
const frame = (mediaTime, wallTime) => ({ mediaTime, wallTime });
const clone = (value) => structuredClone(value);

async function cases(name, fn, good, bad) {
  await check(`room-continuity-steps: ${name}`, async () => {
    assertEqual(fn(good).verdict, 'PASS', `${name} pass fixture`);
    assertEqual(fn(bad).verdict, 'FAIL', `${name} fail fixture`);
    assertEqual(fn(undefined).verdict, 'UNESTABLISHED', `${name} missing evidence`);
  });
}

const rc0Good = {
  f: { pageBuildId: 'f-build', bundle: { pageBuildId: 'f-build', servedSha256: 'a', diskSha256: 'a', pageIdInServed: true, pageIdInDisk: true } },
  d: { pageBuildId: 'd-build', bundle: { pageBuildId: 'd-build', servedSha256: 'b', diskSha256: 'b', pageIdInServed: true, pageIdInDisk: true } },
};
const rc1Good = { expectedDGraceMs: 10000, f: { settings: { hostGraceMs: 3000, mediaSource: 'file', delivery: 'host', autoStart: true } }, d: { settings: { hostGraceMs: 10000, delivery: 'http' } } };
const counters = { responseRecords: [] };
const rc2Good = {
  host: { hostFileStatus: 'refused: codec-unplayable' },
  viewers: [1, 2].map(() => ({ hostPreparing: { state: 'choosing', fraction: null, text: 'the host is choosing a video' }, bodyText: 'the host is choosing a video', playDisabled: true, requestsByPath: {} })),
  counters,
};
const rc3Good = { expected: { identity: idA, name: 'title-a.mp4' }, members: [member(), member(), member()], stableMs: 3000, stablePolls: [[member(), member(), member()]].map((members) => ({ members: members.map((entry) => ({ ...entry, videoPaused: true })) })) };
const rc4Good = { frames: [[frame(0, 0), frame(5.1, 5100)], [frame(0.2, 0), frame(5.4, 5100)]], swarmIds: ['room-a', 'room-a'], expectedSwarmId: 'room-a' };
const reload = () => ({
  preIdentity: { lineage: 'lineage-a', version: 4 },
  polls: [{ viewers: [{ state: state({ playing: true }) }, { state: state({ playing: true }) }] }],
  rejoined: { viewers: [{ rosterHasHost: true, reportReady: true }, { rosterHasHost: true, reportReady: true }] },
  hostFileState: 'ready',
  after: { viewers: [member(idA, 'title-a.mp4', { playing: true }), member(idA, 'title-a.mp4', { playing: true })] },
  reloadToRejoinMs: 400,
  reloadToReadyMs: 700,
  sawHostless: false,
});
const rc5Good = { expected: { identity: idA, name: 'title-a.mp4' }, reloads: Array.from({ length: 5 }, reload) };
const rc6Good = {
  graceMs: 3000,
  gracePauses: 1,
  viewers: [1, 2].map(() => ({
    versions: [4, 5],
    prev: state({ playing: true, positionMs: 20000, atSharedMs: 1000 }),
    grace: { startedAtSharedMs: 1000, endsAtSharedMs: 4000 },
    polls: [{ atSharedMs: 2000, state: state({ playing: true, positionMs: 21000, atSharedMs: 2000 }) }, { atSharedMs: 3000, state: state({ playing: true, positionMs: 22000, atSharedMs: 3000 }) }],
    paused: state({ version: 5, positionMs: 23000, atSharedMs: 4000 }),
    hostPreparing: { state: 'absent', text: 'the host has left' },
    playDisabled: true,
  })),
};
const rc7Good = {
  precondition: { noOldFrame: true },
  expected: { identity: idB, name: 'title-b.mp4', version: 6, swarmId: 'room-b' },
  previousSwarmId: 'room-a',
  members: [member(idB, 'title-b.mp4', { version: 6 }), member(idB, 'title-b.mp4', { version: 6 }), member(idB, 'title-b.mp4', { version: 6 })],
  oldFrames: [[frame(0.5, 0)], [frame(0.7, 0)]],
  playFrames: [[frame(0.2, 0), frame(5.4, 5100)], [frame(0.3, 0), frame(5.6, 5100)]],
  swarmIds: ['room-b', 'room-b'],
  stateChanges: [1, 2].map(() => [{ version: 5, title: idA }, { version: 6, title: idB }]),
  peerBytes: [{ peerId: 'peer-a', priorPeerIds: ['peer-a0'], records: [{ source: 'p2p', peerId: 'peer-b' }] }, { peerId: 'peer-b', priorPeerIds: ['peer-b0'], records: [{ source: 'p2p', peerId: 'peer-a' }] }],
};
const rc8Good = { created: state(), seeked: { ...state({ positionMs: 30000 }), controlMode: 'open' }, reloaded: { ...state({ positionMs: 30000 }), controlMode: 'open' }, noRoom: { sessionStorage: null } };

export default async function roomContinuityStepsSuite() {
  await cases('RC0 freshness', rc0, rc0Good, { ...clone(rc0Good), f: { ...rc0Good.f, bundle: { ...rc0Good.f.bundle, servedSha256: 'old' } } });
  await cases('RC1 settings', rc1, rc1Good, { ...clone(rc1Good), f: { settings: { ...rc1Good.f.settings, autoStart: false } } });
  await cases('RC2 refused file', rc2, rc2Good, { ...clone(rc2Good), viewers: rc2Good.viewers.map((viewer) => ({ ...viewer, playDisabled: false })) });
  await cases('RC3 title A', rc3, rc3Good, { ...clone(rc3Good), members: [member(idA, 'title-a.mp4', { playing: true }), ...rc3Good.members.slice(1)] });
  await cases('RC4 play and swarm', rc4, rc4Good, { ...clone(rc4Good), frames: [[frame(0, 0), frame(4, 4000)], rc4Good.frames[1]] });
  await cases('RC5 host reload', rc5, rc5Good, { ...clone(rc5Good), reloads: rc5Good.reloads.map((entry, index) => index ? entry : { ...entry, polls: [{ viewers: [{ state: state() }, { state: state({ playing: true }) }] }] }) });
  await cases('RC6 grace pause', rc6, rc6Good, { ...clone(rc6Good), viewers: rc6Good.viewers.map((viewer, index) => index ? viewer : { ...viewer, paused: { ...viewer.paused, playing: true } }) });
  await cases('RC7 title B', rc7, rc7Good, { ...clone(rc7Good), members: [member(idB, 'title-b.mp4', { version: 6, positionMs: 1 }), ...rc7Good.members.slice(1)] });
  // 12a D1 F4, F5: the element's name, and peer bytes from the other viewer's new engine.
  await check('room-continuity-steps: RC3 and RC7 read #title-name; RC7 peer bytes name the new engine', async () => {
    const wrongElement = (good) => ({ ...clone(good), members: good.members.map((entry, index) => (index === 1 ? { ...entry, titleName: '' } : entry)) });
    assertEqual(rc3(wrongElement(rc3Good)).verdict, 'FAIL', 'RC3 fails when #title-name is not the name');
    assertEqual(rc7(wrongElement(rc7Good)).verdict, 'FAIL', 'RC7 fails when #title-name is not the name');
    const oldId = clone(rc7Good);
    oldId.peerBytes[0].records = [{ source: 'p2p', peerId: 'peer-b0' }];
    assertEqual(rc7(oldId).detail.includes('peer-bytes FAIL'), true, 'a record naming the old engine fails');
    const notNew = clone(rc7Good);
    notNew.peerBytes[1].priorPeerIds = ['peer-b'];
    assertEqual(rc7(notNew).detail.includes('peer-bytes FAIL'), true, 'a current id present before RC7 fails');
    assertEqual(rc7(rc7Good).detail.includes('peer-bytes PASS'), true, 'records naming the other viewer\'s new engine pass');
  });
  await cases('RC8 stored seek', rc8, rc8Good, { ...clone(rc8Good), reloaded: { ...rc8Good.reloaded, controlMode: 'host' } });
  await check('room-continuity-steps: RC2 viewer media request and RC6 pause instant fail', async () => {
    const requested = { ...clone(rc2Good), viewers: rc2Good.viewers.map((viewer, index) => index ? viewer : { ...viewer, requestsByPath: { '/media/seg.m4s': 1 } }) };
    assertEqual(rc2(requested).verdict, 'FAIL', 'a viewer request to a choosing host fails RC2');
    const late = { ...clone(rc6Good), viewers: rc6Good.viewers.map((viewer) => ({ ...viewer, paused: { ...viewer.paused, atSharedMs: 4001 } })) };
    assertEqual(rc6(late).verdict, 'FAIL', 'a pause off every grace end fails RC6');
    const split = { ...clone(rc6Good), viewers: rc6Good.viewers.map((viewer, index) => index ? { ...viewer, paused: { ...viewer.paused, version: 6 } } : viewer) };
    assertEqual(rc6(split).verdict, 'FAIL', 'viewers holding different pauses fail RC6');
  });
  await check('room-continuity-steps: version +1 clause and post-result one-operation reading are reported apart', async () => {
    const seqJump = { ...clone(rc6Good), viewers: rc6Good.viewers.map((viewer) => ({ ...viewer, versions: [4, 35], paused: { ...viewer.paused, version: 35 } })) };
    assertEqual(rc6(seqJump).verdict, 'FAIL', 'an envelope-seq jump still fails the kept +1 clause');
    assertEqual(rc6(seqJump).detail.endsWith('+1 clause FAIL; post-result one-operation PASS'), true, 'RC6 reports both clauses');
    const twoOps = { ...clone(rc6Good), viewers: rc6Good.viewers.map((viewer) => ({ ...viewer, versions: [4, 5, 7], paused: { ...viewer.paused, version: 7 } })) };
    assertEqual(rc6(twoOps).detail.includes('post-result one-operation FAIL'), true, 'two observed changes fail the one-operation reading');
    assertEqual(rc6({ ...clone(rc6Good), gracePauses: 2 }).detail.includes('post-result one-operation FAIL'), true, 'two grace pauses fail it');
    assertEqual(rc6(rc6Good).detail.endsWith('+1 clause PASS; post-result one-operation PASS'), true, 'RC6 pass names both clauses');
    const bJump = { ...clone(rc7Good), members: rc7Good.members.map((entry) => ({ ...entry, state: { ...entry.state, version: 40 } })), stateChanges: [1, 2].map(() => [{ version: 5, title: idA }, { version: 40, title: idB }]) };
    assertEqual(rc7(bJump).detail.endsWith('+1 clause FAIL; post-result one-operation PASS'), true, 'RC7 reports both clauses');
    const extra = { ...clone(rc7Good), stateChanges: [1, 2].map(() => [{ version: 5, title: idA }, { version: 6, title: idB }, { version: 7, title: idB }]) };
    assertEqual(rc7(extra).detail.includes('post-result one-operation FAIL'), true, 'an extra operation before play fails RC7');
  });
  await check('room-continuity-steps: R-Grace outcomes and boundary', async () => {
    assertEqual(JSON.stringify(grace(rc5Good.reloads)), JSON.stringify({ outcome: 'confirmed', maxReady: 700, maxRejoin: 400, replacementMs: null }), 'confirmed grace');
    assertEqual(JSON.stringify(grace(rc5Good.reloads.slice(0, 4))), JSON.stringify({ outcome: 'provisional', maxReady: 700, maxRejoin: 400, replacementMs: null }), 'provisional grace');
    const replaced = rc5Good.reloads.map((entry) => ({ ...entry, reloadToReadyMs: 6000 }));
    assertEqual(JSON.stringify(grace(replaced)), JSON.stringify({ outcome: 'replaced', maxReady: 6000, maxRejoin: 400, replacementMs: 12000 }), 'replaced grace');
    const boundary = rc5Good.reloads.map((entry) => ({ ...entry, reloadToReadyMs: 5000 }));
    assertEqual(grace(boundary).outcome, 'confirmed', '2 x maxReady boundary');
  });
  await check('room-continuity-steps: exit code', async () => {
    const results = [rc0(rc0Good), rc1(rc1Good), rc2(rc2Good), rc3(rc3Good), rc4(rc4Good), rc5(rc5Good), rc6(rc6Good), rc7(rc7Good), rc8(rc8Good)];
    assertEqual(exitCode(results), 0, 'all pass exit');
    assertEqual(exitCode(results.map((entry, index) => index === 4 ? { ...entry, verdict: 'UNESTABLISHED' } : entry)), 1, 'failed exit');
  });
}
