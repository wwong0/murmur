// scripts/check/suites/fmp4-placement.mjs
//
// The placement module and its tracker. Pure: every box is
// built here by hand, so no fixture file and no hls.js.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { createPlacementTracker, trackTimescales, videoDecodeSeconds } from '../../../public/lib/fmp4-placement.mjs';

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function box(type, ...parts) {
  const body = parts.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

const trak = (id, handler, timescale) => box('trak',
  box('tkhd', u32(0), u32(0), u32(0), u32(id)),
  box('mdia', box('mdhd', u32(0), u32(0), u32(0), u32(timescale)), box('hdlr', u32(0), u32(0), ascii(handler))));

const VIDEO = 1;
const AUDIO = 2;
const initSegment = () => Uint8Array.from([
  ...box('ftyp', ascii('isom'), u32(0)),
  ...box('moov', trak(VIDEO, 'vide', 12288), trak(AUDIO, 'soun', 48000)),
]);

const traf = (id, tfdt, version = 0) => box('traf',
  box('tfhd', u32(0), u32(id)),
  box('tfdt', [version, 0, 0, 0], version === 1 ? u64(tfdt) : u32(tfdt)));
const mediaSegment = (...trafs) => Uint8Array.from([...box('moof', ...trafs), ...box('mdat', [1, 2, 3])]);

// Audio first in the file, so "first video traf" is not "first traf".
const audioFirstSegment = (videoTfdt, audioTfdt, version = 0) => mediaSegment(traf(AUDIO, audioTfdt), traf(VIDEO, videoTfdt, version));

const FRAME_OFFSET_S = -101 / 48000;
const append = (tracker, data, extra = {}) => tracker.onAppend({ data, parent: 'main', ...extra });

function trackerAfterInit() {
  const tracker = createPlacementTracker();
  append(tracker, initSegment());
  return tracker;
}

export default async function fmp4PlacementSuite() {
  await check('fmp4 placement: R9 segment 0, audio ahead of video, is placed one AAC frame late', async () => {
    const tracker = trackerAfterInit();
    append(tracker, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    assertNear(tracker.snapshot().placementMs, 21.333, 0.001, 'placement is video 23.438 ms less audio 2.104 ms');
    assertEqual(tracker.snapshot().source, 'hls-append', 'and says where it came from');
    assert(Math.abs(tracker.snapshot().placementMs) > 1, 'a placement of 0 is outside the answer');
  });

  await check('fmp4 placement: a video-first fragment at playlist offset 2 is placed at 0', async () => {
    const tracker = trackerAfterInit();
    append(tracker, mediaSegment(traf(VIDEO, 24864)), { offset: 2 - 24864 / 12288, playlistOffsetS: 2 });
    assertNear(tracker.snapshot().placementMs, 0, 0.001, 'video less offset less playlist start is 0');
  });

  await check('fmp4 placement: a later append of the same load agrees, one 1 ms away is counted once', async () => {
    const tracker = trackerAfterInit();
    append(tracker, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    append(tracker, mediaSegment(traf(VIDEO, 24864)), { offset: FRAME_OFFSET_S, playlistOffsetS: 2 });
    assertEqual(tracker.snapshot().disagreements, 0, 'segment 1 of the load gives the same placement');
    append(tracker, mediaSegment(traf(VIDEO, 24864)), { offset: FRAME_OFFSET_S + 0.001, playlistOffsetS: 2 });
    const after = tracker.snapshot();
    assertEqual(after.disagreements, 1, 'a placement 1 ms off is one disagreement');
    assertNear(after.lastDisagreementMs, 22.333, 0.001, 'and is kept');
    assertNear(after.placementMs, 21.333, 0.001, 'the placement does not move');
  });

  await check('fmp4 placement: the init is told by its moov, and a media append before it leaves the placement pending', async () => {
    const early = createPlacementTracker();
    append(early, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    assertEqual(early.snapshot().placementMs, null, 'no tracks yet, no placement');
    assertEqual(early.mediaMs(1000), null, 'and no media time');
    assert(trackTimescales(initSegment()) !== null, 'the init has a moov');
    assertEqual(trackTimescales(audioFirstSegment(288, 101)), null, 'a media segment has none');
    const tracks = trackTimescales(initSegment());
    assertEqual(JSON.stringify([...tracks]), JSON.stringify([[1, { id: 1, handler: 'vide', timescale: 12288 }], [2, { id: 2, handler: 'soun', timescale: 48000 }]]), 'both tracks, handler and timescale');
    assertNear(videoDecodeSeconds(audioFirstSegment(288, 101), tracks), 288 / 12288, 1e-9, 'the video traf is chosen, not the first');
    assertEqual(videoDecodeSeconds(mediaSegment(traf(AUDIO, 5)), tracks), null, 'an audio-only segment has no video decode time');
  });

  await check('fmp4 placement: a pending write comes back once, in element seconds', async () => {
    const tracker = createPlacementTracker();
    tracker.reset();
    tracker.noteWrite(3000);
    assertEqual(tracker.takePendingWrite(), null, 'nothing to apply while the placement is unknown');
    append(tracker, initSegment());
    append(tracker, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    const write = tracker.takePendingWrite();
    assertNear(write.elementSeconds, 3.021333, 1e-6, 'media 3000 ms plus 21.333 ms');
    assertEqual(tracker.takePendingWrite(), null, 'and not returned again');
    const zero = trackerAfterInit();
    zero.noteWrite(3000);
    append(zero, mediaSegment(traf(VIDEO, 24864)), { offset: 2 - 24864 / 12288, playlistOffsetS: 2 });
    assertEqual(zero.takePendingWrite(), null, 'at placement 0 the pending write is dropped, hls.js already placed it');
    assertEqual(zero.takePendingWrite(), null, 'and stays dropped');
  });

  await check('fmp4 placement: a non-main parent is ignored', async () => {
    const tracker = createPlacementTracker();
    tracker.onAppend({ data: initSegment(), parent: 'audio' });
    append(tracker, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    assertEqual(tracker.snapshot().placementMs, null, 'an init from another parent set no tracks');
    const main = trackerAfterInit();
    main.onAppend({ data: audioFirstSegment(288, 101), parent: 'audio', offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    assertEqual(main.snapshot().placementMs, null, 'a media append from another parent set no placement');
  });

  await check('fmp4 placement: a version 1 tfdt reads 64 bits', async () => {
    const tracks = trackTimescales(initSegment());
    const big = 2 ** 33 + 12288;
    assertNear(videoDecodeSeconds(audioFirstSegment(big, 0, 1), tracks), big / 12288, 1e-6, 'a decode time past 32 bits');
  });

  await check('fmp4 placement: media to element and back is the identity', async () => {
    const tracker = trackerAfterInit();
    append(tracker, audioFirstSegment(288, 101), { offset: FRAME_OFFSET_S, playlistOffsetS: 0 });
    for (const m of [0, 3000, 14017.5]) assertNear(tracker.mediaMs(tracker.elementSeconds(m) * 1000), m, 1e-6, `round trip at ${m} ms`);
    assertNear(tracker.elementSeconds(3000), 3.021333, 1e-6, 'and the element is 21.333 ms later');
    assertEqual(tracker.mediaMs(NaN), null, 'a non-finite element time has no media time');
    tracker.none();
    assertEqual(tracker.snapshot().source, 'none', 'native HLS says none');
    assertEqual(tracker.elementSeconds(3000), 3, 'and maps by 0');
  });
}
