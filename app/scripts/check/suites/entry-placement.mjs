// scripts/check/suites/entry-placement.mjs
//
// Every place the entry turns the element's time into a member's media time
// goes through the load's placement (change 12c-2 D1). Reads the entry's source
// text, and runs its own `mediaDurationS` against F9's numbers.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, assert, assertEqual } from '../harness.mjs';
import { endPauseMs } from '../../../public/lib/title-end.mjs';

const ENTRY = fs.readFileSync(fileURLToPath(new URL('../../../public/room.entry.js', import.meta.url)), 'utf8');

const codeLines = (source) => source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
const TELEMETRY_READ = /^\s*const elementCurrentTimeMs = video\.currentTime \* 1000;$/;

/** Lines that read the element's clock other than as telemetry or through the mapping. */
function unmappedCurrentTime(source) {
  return codeLines(source).filter((line) => line.includes('video.currentTime')
    && !TELEMETRY_READ.test(line) && !line.includes('mediaFromElementMs(video.currentTime'));
}

const DURATION_FUNCTION = /function mediaDurationS\(\) \{[\s\S]*?\n\}/;

export default async function entryPlacementSuite() {
  await check('entry placement: video.currentTime is read raw only as telemetry, everywhere else through the mapping', async () => {
    const lines = codeLines(ENTRY);
    assertEqual(lines.filter((line) => TELEMETRY_READ.test(line)).length, 2, 'two telemetry reads keep the element name');
    assertEqual(lines.filter((line) => line.includes('mediaFromElementMs(video.currentTime')).length, 2, 'the urgent context and the timeupdate step map');
    assertEqual(JSON.stringify(unmappedCurrentTime(ENTRY)), '[]', 'and nothing else reads it');
    const raw = ENTRY.replace('elementMediaMs = mediaFromElementMs(video.currentTime * 1000);', 'elementMediaMs = video.currentTime * 1000;');
    assert(raw !== ENTRY && unmappedCurrentTime(raw).length === 1, 'a raw read at the timeupdate step is caught');
  });

  await check('entry placement: video.duration is read only in mediaDurationS', async () => {
    const match = DURATION_FUNCTION.exec(ENTRY);
    assert(match !== null && match[0].includes('video.duration'), 'mediaDurationS reads the element duration');
    assertEqual(codeLines(ENTRY.replace(DURATION_FUNCTION, '')).filter((line) => line.includes('video.duration')).length, 0, 'nowhere else does');
    assert(ENTRY.includes('endPauseMs(titleEndMs(), mediaDurationS())'), 'and the end pause is given the media duration');
  });

  await check('entry placement: __app.playback carries placementMs', async () => {
    const start = ENTRY.indexOf('  playback: () => ({');
    assert(start !== -1, 'the playback reading is found');
    assert(ENTRY.slice(start, ENTRY.indexOf('\n  }),', start)).includes('placementMs: placementMs(),'), 'with the placement in it');
    assert(ENTRY.includes('placement: () => player.placement(),'), 'and __app.placement() returns the tracker snapshot');
  });

  await check('entry placement: F9, members at placement 0 and 21.333 get one end pause and both ends fire', async () => {
    const match = DURATION_FUNCTION.exec(ENTRY);
    assert(match !== null, 'mediaDurationS exists');
    const body = match[0].replace(/^function mediaDurationS\(\) \{/, '').replace(/\}$/, '');
    const mediaDurationS = (placement, video) => new Function('placementMs', 'video', body)(() => placement, video);
    const PLAYLIST_END_MS = 14000;
    const members = [{ placementMs: 0, durationS: 14.016 }, { placementMs: 21.333, durationS: 14.037333 }];
    for (const { placementMs, durationS } of members) {
      const pauseMs = endPauseMs(PLAYLIST_END_MS, mediaDurationS(placementMs, { duration: durationS }));
      assertEqual(pauseMs, 14017, `the pause at placement ${placementMs} is 14 017 ms`);
      assert(pauseMs + placementMs >= durationS * 1000, `its park ${pauseMs + placementMs} ms is at or past the element's end, so the element clamps and ends`);
    }
    assertEqual(endPauseMs(PLAYLIST_END_MS, members[1].durationS), 14038, 'the raw element duration would put the second member at 14 038');
    assert(Number.isNaN(mediaDurationS(null, { duration: 14.016 })), 'with the placement pending there is no media duration');
    assert(Number.isNaN(mediaDurationS(0, { duration: NaN })), 'and none without an element duration');
  });
}
