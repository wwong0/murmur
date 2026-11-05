// scripts/check/suites/host-file-two-loads.mjs
//
// S7g's evaluator: two loads, one at 0 and one mid-title, report
// the same frame at the same media time. Every number is hand-computed on a
// 24 fps grid, a frame being 1000/24 = 41.667 ms.

import { check, assert, assertEqual, assertNear } from '../harness.mjs';
import { s7g } from '../../host-file-steps.mjs';

const FRAME_S = 1 / 24;
const FRAME_MS = 1000 / 24;

/** Frames k = first..last on the grid, each moved by `shiftMs`. */
const series = (first, last, shiftMs = 0) => Array.from({ length: last - first + 1 }, (_, i) => ({ mediaMs: (first + i) * FRAME_MS + shiftMs }));

const viewer = (records) => ({ records, placement: { placementMs: 21.333 }, opens: 1, notices: ['playback opened at 0.00s'] });
const second = (records) => ({ records, placement: { placementMs: 0 }, opens: 1, notices: ['playback opened at 3.00s'] });
const reading = (viewerRecords, v2Records, edit = {}) => ({ frame: FRAME_S, viewer: viewer(viewerRecords), v2: second(v2Records), ...edit });

// k = 96..134 is 4 000.0 to 5 583.3 ms: 39 records, and k = 125 is 5 208.333 ms.
const onGrid = () => series(96, 134);

export default async function hostFileTwoLoadsSuite() {
  await check('S7g: two on-grid series pass and report frame 125', async () => {
    const result = s7g(reading(onGrid(), onGrid()));
    assertEqual(result.status, 'pass', result.reasons.join('; '));
    assertEqual(result.observed.commonK, 125, 'the common frame is 125');
    assertNear(result.observed.commonFrameMediaMs.viewer, 5208.333, 0.002, 'at 5 208.333 ms on the viewer');
    assertNear(result.observed.commonFrameMediaMs.v2, 5208.333, 0.001, 'and on v2');
    assertEqual(result.observed.records.viewer, 39, 'every record in range is read');
    assertEqual(JSON.stringify(result.observed.placementMs), JSON.stringify({ viewer: 21.333, v2: 0 }), 'the placements are published');
  });

  await check('S7g: the viewer shifted by one placement fails, off by a frame less the shift', async () => {
    const result = s7g(reading(series(96, 134, 21.333), onGrid()));
    assertEqual(result.status, 'fail', 'a 21.333 ms shift is outside the grid');
    assertNear(result.observed.maxOffMs.viewer, 20.333, 0.001, 'off by 41.667 less 21.333');
    assertEqual(result.observed.maxOffMs.v2, 0, 'v2 is on it');
    assert(result.reasons.some((reason) => reason.startsWith('viewer has ')), 'and the reason names the viewer');
  });

  await check('S7g: 0.9 ms off the grid passes and 1.1 ms fails', async () => {
    assertEqual(s7g(reading(series(96, 134, 0.9), onGrid())).status, 'pass', '0.9 ms is inside the 1 ms bar');
    assertEqual(s7g(reading(series(96, 134, 1.1), onGrid())).status, 'fail', '1.1 ms is outside it');
  });

  await check('S7g: a wrong opening notice is evidence missing, with the notices quoted', async () => {
    const wrongViewer = s7g(reading(onGrid(), onGrid(), { viewer: { ...viewer(onGrid()), notices: ['playback opened at 5.00s'] } }));
    assertEqual(wrongViewer.status, 'evidence missing', 'a viewer that did not open at 0');
    assert(wrongViewer.reasons[0].includes('playback opened at 5.00s'), 'the notice is quoted');
    assertEqual(s7g(reading(onGrid(), onGrid(), { v2: { ...second(onGrid()), notices: ['playback opened at 1.99s'] } })).status, 'evidence missing', 'a v2 that opened before 2 s');
    assertEqual(s7g(reading(onGrid(), onGrid(), { viewer: { ...viewer(onGrid()), opens: 2 } })).status, 'evidence missing', 'a viewer that opened twice');
    assertEqual(s7g(reading(onGrid(), onGrid(), { v2: { ...second(onGrid()), notices: [] } })).status, 'evidence missing', 'a v2 with no opening notice');
  });

  await check('S7g: pages with no frame in common fail, and so do too few records', async () => {
    const apart = s7g(reading(series(96, 115), series(116, 134)));
    assertEqual(apart.status, 'fail', 'no common frame');
    assertEqual(apart.observed.commonK, null, 'and none is reported');
    assertEqual(s7g(reading(series(96, 106), onGrid())).status, 'fail', 'eleven records is fewer than twelve');
    assertEqual(s7g(reading(series(96, 107), onGrid())).status, 'pass', 'twelve is enough');
  });
}
