import { assert, assertEqual, check } from '../harness.mjs';
import {
  boundariesFromPlaylist,
  chooseSegments,
  exitCode,
  s0, s1, s2, s3, s4, s5, s6, s7a, s7f, s7b, s7c, s7d, s7e, s8, s9, s10, s11, s12, s13,
  showsFrameAt,
  stallTest,
} from '../../host-file-steps.mjs';

const frame = (mediaTime, wallTime) => ({ mediaTime, wallTime });
const listing = (name = 'seg-00000.m4s', size = 4, sha256 = 'a'.repeat(64)) => [{ name, size, sha256 }];
const twoListings = () => [{ name: 'init.mp4', size: 2, sha256: 'b'.repeat(64) }, ...listing()];
const goodPolls = [{ wallTime: 0, playing: true, frameCount: 1, bufferedLength: 1 }, { wallTime: 500, playing: true, frameCount: 2, bufferedLength: 1 }, { wallTime: 1000, playing: true, frameCount: 3, bufferedLength: 1 }];
const goodEvents = { waiting: 0 };
const baseCounters = (records = [], byClient = {}) => ({
  mediaBytesDelivered: 0, segmentBytesDelivered: 0, initBytesDelivered: 0,
  playlistBytesDelivered: 0, unattributedMediaBytesDelivered: 0, responseRecords: records, byClient,
});
const controlRecord = { urlPath: '/media/master.m3u8', kind: 'overhead', clientTag: 'pass-control' };

function clone(value) {
  return structuredClone(value);
}

async function verdictCases(name, fn, good, failures) {
  await check(`host-file-steps: ${name}`, async () => {
    assertEqual(fn(good).status, 'pass', `${name} pass fixture`);
    for (const [label, reading] of failures) assertEqual(fn(reading).status, 'fail', `${name} clause ${label}`);
    assertEqual(fn(undefined).status, 'evidence missing', `${name} absent reading`);
  });
}

export default async function hostFileStepsSuite() {
  await check('host-file-steps: playlist boundaries and segment choices are derived', async () => {
    assertEqual(JSON.stringify(boundariesFromPlaylist('#EXTINF:2.000000,\nseg-0.m4s\n#EXTINF:3,\nseg-1.m4s\n')), JSON.stringify([2, 5]), 'playlist cumulative boundaries');
    assertEqual(JSON.stringify(chooseSegments({ boundaries: [2, 5, 8], count: 3, position: 0 })), JSON.stringify({ longFile: false, j: 2, m: 1 }), 'short segment choice');
    assertEqual(JSON.stringify(chooseSegments({ boundaries: [301, 602, 903, 1204, 1505], count: 5, position: 0 })), JSON.stringify({ longFile: true, j: 1, m: 3 }), 'long segment choice');
    assertEqual(boundariesFromPlaylist('not a playlist'), null, 'malformed playlist is absent');
    assertEqual(showsFrameAt([frame(4, 10)], 4, 0.04), true, 'frame-at derivation');
    assertEqual(stallTest({ frames: [frame(0, 0), frame(1, 500)], events: goodEvents, polls: goodPolls, firstPlayingWallTime: 0 }), false, 'stall derivation');
  });

  const s0Good = {
    target: 2, pageBuildId: 'room-build', workerBuildId: 'room-build',
    settings: { mediaSource: 'file', delivery: 'host', targetSegmentSeconds: 2 },
    roomBundle: { servedSha256: 'a', diskSha256: 'a', pageIdInServed: true },
    workerBundle: { servedSha256: 'b', diskSha256: 'b' },
  };
  await verdictCases('S0', s0, s0Good, [
    ['settings', { ...clone(s0Good), settings: { ...s0Good.settings, delivery: 'http' } }],
    ['room hash', { ...clone(s0Good), roomBundle: { ...s0Good.roomBundle, servedSha256: 'x' } }],
    ['worker hash', { ...clone(s0Good), workerBundle: { ...s0Good.workerBundle, diskSha256: 'x' } }],
    ['page id', { ...clone(s0Good), roomBundle: { ...s0Good.roomBundle, pageIdInServed: false } }],
    ['worker id', { ...clone(s0Good), workerBuildId: 'old-worker' }],
  ]);

  const s1Good = { host: { state: 'awaiting-file' }, viewer: { state: 'absent' }, counters: baseCounters() };
  await verdictCases('S1', s1, s1Good, [
    ['host state', { ...clone(s1Good), host: { state: 'ready' } }],
    ['viewer state', { ...clone(s1Good), viewer: { state: 'open' } }],
    ['media record', { ...clone(s1Good), counters: baseCounters([{ urlPath: '/media/init.mp4' }]) }],
  ]);

  const s2Good = {
    target: 4, fileBytes: 50,
    host: { state: 'ready', origin: 'prepared', workerCalls: { inspect: 1, prepare: 1 }, manifest: { targetSeconds: 4, sourceBytes: 50 }, storage: { quota: 100, usage: 10 }, cleanup: 'next-host-page-start' },
  };
  await verdictCases('S2', s2, s2Good, [
    ['state', { ...clone(s2Good), host: { ...s2Good.host, state: 'failed' } }],
    ['origin', { ...clone(s2Good), host: { ...s2Good.host, origin: 'found' } }],
    ['worker calls', { ...clone(s2Good), host: { ...s2Good.host, workerCalls: { inspect: 1, prepare: 0 } } }],
    ['target', { ...clone(s2Good), host: { ...s2Good.host, manifest: { ...s2Good.host.manifest, targetSeconds: 2 } } }],
    ['source bytes', { ...clone(s2Good), host: { ...s2Good.host, manifest: { ...s2Good.host.manifest, sourceBytes: 49 } } }],
    ['storage', { ...clone(s2Good), host: { ...s2Good.host, storage: { quota: null, usage: 10 } } }],
    ['cleanup', { ...clone(s2Good), host: { ...s2Good.host, cleanup: 'next-reload' } }],
  ]);

  const s3Good = { tab: twoListings(), reference: twoListings(), key: 'v1-key', expectedKey: 'v1-key' };
  await verdictCases('S3', s3, s3Good, [
    ['names', { ...clone(s3Good), tab: [s3Good.tab[0]] }],
    ['size', { ...clone(s3Good), tab: [{ ...s3Good.tab[0], size: 3 }, s3Good.tab[1]] }],
    ['digest', { ...clone(s3Good), tab: [{ ...s3Good.tab[0], sha256: 'c'.repeat(64) }, s3Good.tab[1]] }],
    ['key', { ...clone(s3Good), key: 'other-key' }],
  ]);

  const s4Good = { boundaries: [2, 5], frame: 0.04, frames: [frame(1.5, 1), frame(2.01, 2)] };
  await verdictCases('S4', s4, s4Good, [
    ['before boundary', { ...clone(s4Good), frames: [frame(2.01, 2)] }],
    ['after boundary', { ...clone(s4Good), frames: [frame(1.5, 1)] }],
  ]);

  const s5Good = { boundaryIndexes: [0, 1], boundaries: [2, 5, 8], frame: 0.04, frames: [frame(1.5, 0), frame(2.01, 500), frame(4.9, 1000), frame(5.01, 1500)], polls: goodPolls, events: goodEvents, firstPlayingWallTime: 0 };
  await verdictCases('S5', s5, s5Good, [
    ['boundary frames', { ...clone(s5Good), frames: [frame(1.5, 0), frame(2.01, 500)] }],
    ['buffered length', { ...clone(s5Good), polls: [{ ...goodPolls[0], bufferedLength: 2 }, ...goodPolls.slice(1)].map((poll) => ({ ...poll, bufferedLength: poll.bufferedLength ?? 1 })) }],
    ['stall', { ...clone(s5Good), polls: [{ wallTime: 0, playing: true, frameCount: 1 }, { wallTime: 2001, playing: true, frameCount: 1 }] }],
  ]);

  const s6Good = { key: 'k', minimumAdvance: 5, mediaAdvance: 6, crossedBoundary: true, beforeListing: listing(), afterListing: listing(), host: { state: 'ready', origin: 'found', key: 'k', workerCalls: { inspect: 0, prepare: 0 } }, frames: [frame(1, 1)] , boundaries: [2, 5] };
  await verdictCases('S6', s6, s6Good, [
    ['state', { ...clone(s6Good), host: { ...s6Good.host, state: 'awaiting-file' } }],
    ['origin', { ...clone(s6Good), host: { ...s6Good.host, origin: 'prepared' } }],
    ['worker calls', { ...clone(s6Good), host: { ...s6Good.host, workerCalls: { inspect: 1, prepare: 0 } } }],
    ['key', { ...clone(s6Good), host: { ...s6Good.host, key: 'other' } }],
    ['listing', { ...clone(s6Good), afterListing: [{ ...s6Good.afterListing[0], size: 5 }] }],
    ['advance', { ...clone(s6Good), mediaAdvance: 4 }],
    ['boundary', { ...clone(s6Good), crossedBoundary: false }],
  ]);

  const s7aGood = { position: 0, target: 5, frame: 0.04, afterWallTime: 10, frames: [frame(5, 11)], longFile: true, targetPath: '/media/seg-00005.m4s', previousPath: '/media/seg-00004.m4s', requestsBefore: { '/media/seg-00005.m4s': 0 }, requestsAfter: { '/media/seg-00005.m4s': 1, '/media/seg-00004.m4s': 0 } };
  await verdictCases('S7a', s7a, s7aGood, [
    ['frame', { ...clone(s7aGood), frames: [frame(4, 11)] }],
    ['before request', { ...clone(s7aGood), requestsBefore: { [s7aGood.targetPath]: 1 } }],
    ['target request', { ...clone(s7aGood), requestsAfter: { [s7aGood.targetPath]: 0, [s7aGood.previousPath]: 0 } }],
    ['previous request', { ...clone(s7aGood), requestsAfter: { [s7aGood.targetPath]: 1, [s7aGood.previousPath]: 1 } }],
  ]);
  await check('host-file-steps: S7a short-file request clause is declared not exercised', async () => {
    assertEqual(s7a({ ...s7aGood, longFile: false }).status, 'pass', 'short seek still passes its frame clause');
  });

  const s7fGood = {
    delta: 0.148042, target: 150.148042, segment: 151, frame: 0.04, mediaTime: 150.148042,
    requestsBefore: { '/media/seg-00151.m4s': 0, '/media/seg-00150.m4s': 0 },
    requestsAfter: { '/media/seg-00151.m4s': 1, '/media/seg-00150.m4s': 0 },
  };
  await verdictCases('S7f', s7f, s7fGood, [
    ['before', { ...clone(s7fGood), requestsBefore: { ...s7fGood.requestsBefore, '/media/seg-00151.m4s': 1 } }],
    ['target', { ...clone(s7fGood), requestsAfter: { ...s7fGood.requestsAfter, '/media/seg-00151.m4s': 0 } }],
    ['earlier', { ...clone(s7fGood), requestsAfter: { ...s7fGood.requestsAfter, '/media/seg-00150.m4s': 1 } }],
    ['frame', { ...clone(s7fGood), mediaTime: s7fGood.target + s7fGood.frame }],
  ]);

  const s7bGood = { target: 5, frame: 0.04, afterWallTime: 10, frames: [frame(4.94, 11)] };
  await verdictCases('S7b', s7b, s7bGood, [['frame', { ...clone(s7bGood), frames: [frame(4, 11)] }]]);
  const s7cGood = { target: 5, duration: 6, frame: 0.04, afterWallTime: 10, frames: [frame(5, 11), frame(5.95, 12)], events: { ended: 1 } };
  await verdictCases('S7c', s7c, s7cGood, [
    ['frame', { ...clone(s7cGood), frames: [frame(4, 11), frame(5.95, 12)] }],
    ['ended', { ...clone(s7cGood), events: { ended: 0 } }],
    ['duration', { ...clone(s7cGood), frames: [frame(5, 11), frame(5.8, 12)] }],
  ]);
  const s7eGood = { target: 8.08, offset: 0.08, frame: 0.04, afterWallTime: 10, frames: [frame(8.08, 11)], targetPath: '/media/seg-00002.m4s', previousPath: '/media/seg-00001.m4s', requestsBefore: {}, requestsAfter: { '/media/seg-00002.m4s': 1 } };
  await verdictCases('S7e', s7e, s7eGood, [
    ['frame', { ...clone(s7eGood), frames: [frame(7, 11)] }],
    ['before', { ...clone(s7eGood), requestsBefore: { '/media/seg-00002.m4s': 1 } }],
    ['target', { ...clone(s7eGood), requestsAfter: {} }],
    ['previous', { ...clone(s7eGood), requestsAfter: { '/media/seg-00001.m4s': 1, '/media/seg-00002.m4s': 1 } }],
  ]);
  const s7dGood = { target: 2, duration: 6, frame: 0.04, afterWallTime: 10, frames: [frame(2, 11), frame(5.95, 12)], events: { ended: 1 } };
  await verdictCases('S7d', s7d, s7dGood, [
    ['distance', { ...clone(s7dGood), target: 2.5, frames: [frame(2.5, 11), frame(5.95, 12)] }],
    ['frame', { ...clone(s7dGood), frames: [frame(1, 11), frame(5.95, 12)] }],
    ['ended', { ...clone(s7dGood), events: { ended: 0 } }],
    ['duration', { ...clone(s7dGood), frames: [frame(2, 11), frame(5.8, 12)] }],
  ]);
  await check('host-file-steps: S7c without a reference duration is evidence missing, not a pass', async () => {
    assertEqual(s7c({ ...clone(s7cGood), duration: undefined }).status, 'evidence missing', 'an absent duration cannot pass');
  });

  const s8Good = { before: baseCounters(), after: baseCounters([controlRecord], { 'pass-control': {} }), control: { status: 404 }, network: { bodyCount: 0, nonGetCount: 0 } };
  await verdictCases('S8', s8, s8Good, [
    ['before bytes', { ...clone(s8Good), before: { ...s8Good.before, mediaBytesDelivered: 1 } }],
    ['before unattributed bytes', { ...clone(s8Good), before: { ...s8Good.before, unattributedMediaBytesDelivered: 1 } }],
    ['before client', { ...clone(s8Good), before: baseCounters([], { viewer: {} }) }],
    ['before record', { ...clone(s8Good), before: baseCounters([{ urlPath: '/media/x.m4s' }]) }],
    ['control record', { ...clone(s8Good), after: baseCounters([{ ...controlRecord, clientTag: 'wrong' }], { wrong: {} }) }],
    ['control status', { ...clone(s8Good), control: { status: 200 } }],
    ['body', { ...clone(s8Good), network: { bodyCount: 1, nonGetCount: 0 } }],
    ['method', { ...clone(s8Good), network: { bodyCount: 0, nonGetCount: 1 } }],
  ]);

  const healthyPage = { notices: ['connected'], videoError: null, quality: { corruptedVideoFrames: 0, totalVideoFrames: 1 }, webkitAudioDecodedByteCount: 1 };
  const s9Good = { host: clone(healthyPage), viewer: clone(healthyPage), expectHeAac: true };
  await verdictCases('S9', s9, s9Good, [
    ['notice', { ...clone(s9Good), host: { ...healthyPage, notices: ['player error: boom'] } }],
    ['video error', { ...clone(s9Good), viewer: { ...healthyPage, videoError: { code: 3 } } }],
    ['corruption', { ...clone(s9Good), host: { ...healthyPage, quality: { corruptedVideoFrames: 1, totalVideoFrames: 1 } } }],
    ['frame count', { ...clone(s9Good), viewer: { ...healthyPage, quality: { corruptedVideoFrames: 0, totalVideoFrames: 0 } } }],
    ['audio', { ...clone(s9Good), viewer: { ...healthyPage, webkitAudioDecodedByteCount: 0 } }],
  ]);

  const s10Good = { key: 'k', h2: { swept: { kept: ['k'], removed: [] }, beforeListing: listing(), listing: listing() }, h3: { swept: { kept: [], removed: ['k'] }, prepared: [] } };
  await verdictCases('S10', s10, s10Good, [
    ['kept', { ...clone(s10Good), h2: { ...s10Good.h2, swept: { kept: [], removed: [] } } }],
    ['kept listing', { ...clone(s10Good), h2: { ...s10Good.h2, listing: [] } }],
    ['removed', { ...clone(s10Good), h3: { ...s10Good.h3, swept: { kept: [], removed: [] } } }],
    ['removed listing', { ...clone(s10Good), h3: { ...s10Good.h3, prepared: ['k'] } }],
  ]);

  const refusal = { host: { refusal: { reason: 'video-codec', message: 'video-codec: found mp4v.20.1' }, }, viewer: { state: 'absent' }, prepared: [] };
  await verdictCases('S11', s11, refusal, [
    ['reason', { ...clone(refusal), host: { refusal: { ...refusal.host.refusal, reason: 'storage' } } }],
    ['codec', { ...clone(refusal), host: { refusal: { ...refusal.host.refusal, message: 'video-codec' } } }],
    ['prepared', { ...clone(refusal), prepared: listing() }],
    ['viewer', { ...clone(refusal), viewer: { state: 'open' } }],
  ]);
  const s12Good = { host: { refusal: { reason: 'codec-unplayable', message: 'codec-unplayable: browser cannot play avc1.640028' } }, reference: { videoCodec: 'avc1.640028' }, prepared: [] };
  await verdictCases('S12', s12, s12Good, [
    ['reason', { ...clone(s12Good), host: { refusal: { ...s12Good.host.refusal, reason: 'storage' } } }],
    ['codec', { ...clone(s12Good), host: { refusal: { ...s12Good.host.refusal, message: 'codec-unplayable' } } }],
    ['prepared', { ...clone(s12Good), prepared: listing() }],
  ]);
  const s13Good = { fileBytes: 50, host: { refusal: { reason: 'storage', neededBytes: 50, freeBytes: 1000 } }, prepared: [] };
  await verdictCases('S13', s13, s13Good, [
    ['reason', { ...clone(s13Good), host: { refusal: { ...s13Good.host.refusal, reason: 'codec-unplayable' } } }],
    ['needed', { ...clone(s13Good), host: { refusal: { ...s13Good.host.refusal, neededBytes: 49 } } }],
    ['free', { ...clone(s13Good), host: { refusal: { ...s13Good.host.refusal, freeBytes: 999 } } }],
    ['prepared', { ...clone(s13Good), prepared: listing() }],
  ]);

  await check('host-file-steps: exit code honors evidence, not-exercised and mutation inversion', async () => {
    assertEqual(exitCode([{ id: 'S0', status: 'pass' }, { id: 'S8', status: 'pass' }]), 0, 'all pass exits zero');
    assertEqual(exitCode([{ id: 'S0', status: 'fail' }]), 1, 'failure exits one');
    assertEqual(exitCode([{ id: 'S0', status: 'pass' }, { id: 'S7d', status: 'fail', diagnostic: true }]), 0, 'a diagnostic does not fail the run');
    assertEqual(exitCode([{ id: 'S7c', status: 'fail' }, { id: 'S7d', status: 'pass', diagnostic: true }]), 1, 'a diagnostic does not pass it either');
    assertEqual(exitCode([{ id: 'S7a', status: 'not exercised' }]), 1, 'not exercised exits one');
    assertEqual(exitCode([{ id: 'S8', status: 'fail' }], { mutationControl: true }), 0, 'mutation failure is inverted');
    assertEqual(exitCode([{ id: 'S8', status: 'pass' }], { mutationControl: true }), 1, 'mutation pass is inverted');
    assertEqual(exitCode([{ id: 'S8', status: 'evidence missing' }], { mutationControl: true }), 2, 'evidence remains fatal');
  });
}
