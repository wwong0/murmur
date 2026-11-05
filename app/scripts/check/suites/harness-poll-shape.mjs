// What the per-poll expression actually returns once CDP has serialised it.
//
// The expression runs in a browser, but it is a string, so it can be evaluated
// here against a stubbed page and the result put through the same lossy step
// CDP applies: `Runtime.evaluate` with `returnByValue` keeps OWN ENUMERABLE
// properties and drops everything else. That step is the subject. A real run
// polled 1440 times per client, recorded `"quality": {}` every time, refused on
// missing dropped-frame evidence, and threw nothing — the counters are
// prototype accessors on `VideoPlaybackQuality` and had never crossed.
//
// No browser and no server: the stub is the point.

import vm from 'node:vm';

import { pollExpression } from '../../harness/cdp-records.mjs';
import { check, assert, assertEqual } from '../harness.mjs';

// The counters live on the prototype, exactly as the browser's own class puts
// them. Defining them as own properties here would make the stub pass a test
// the browser fails.
class FakePlaybackQuality {
  constructor(values) {
    Object.defineProperty(this, '_values', { value: values, enumerable: false });
  }
}
for (const name of ['droppedVideoFrames', 'totalVideoFrames', 'corruptedVideoFrames', 'creationTime']) {
  Object.defineProperty(FakePlaybackQuality.prototype, name, {
    get() { return this._values[name]; },
  });
}

/** What the driver receives: the page's value after returnByValue's own-enumerable copy. */
const throughReturnByValue = (value) => JSON.parse(JSON.stringify(value));

function evaluatePoll({ video = {}, stalls = null, segmentStore } = {}) {
  const context = {
    document: { querySelector: (selector) => (selector === 'video' ? video : null) },
    performance: { timeOrigin: 1_000_000, now: () => 5 },
    Date: { now: () => 1_000_004 },
    window: { __harnessStalls: stalls },
    __app: {
      playback: () => ({ playing: true, callbacks: 7, starts: [{ at: 1 }], seams: [{ at: 2 }] }),
      clock: () => ({ offsetMs: 3 }),
      controller: () => ({ rate: 1 }),
      ...(segmentStore ? { segmentStore } : {}),
    },
  };
  return vm.runInNewContext(pollExpression(), context);
}

export default async function harnessPollShapeSuite() {
  await check('harness poll shape: store crosses returnByValue or is null', async () => {
    assertEqual(throughReturnByValue(evaluatePoll({ segmentStore: () => ({ bytes: 6000 }) })).store.bytes, 6000, 'store bytes cross');
    assertEqual(throughReturnByValue(evaluatePoll()).store, null, 'missing publisher is null');
  });
  await check('harness poll shape: the playback-quality counters survive returnByValue', async () => {
    const quality = new FakePlaybackQuality({ droppedVideoFrames: 4, totalVideoFrames: 900, corruptedVideoFrames: 0, creationTime: 12.5 });
    assertEqual(Object.keys(quality).length, 0, 'the stub carries no own enumerable counters, as the browser class does not');

    const value = throughReturnByValue(evaluatePoll({ video: { getVideoPlaybackQuality: () => quality } }));
    assertEqual(value.quality.droppedVideoFrames, 4, 'dropped frames cross the boundary');
    assertEqual(value.quality.totalVideoFrames, 900, 'total frames cross the boundary');
    assertEqual(value.quality.corruptedVideoFrames, 0, 'a zero counter crosses as zero and not as absent');
    assertEqual(value.quality.creationTime, 12.5, 'creation time crosses the boundary');
  });

  await check('harness poll shape: a page with no video and a video with no counters both report null', async () => {
    assertEqual(throughReturnByValue(evaluatePoll({ video: null })).quality, null, 'no video element reports null');
    assertEqual(throughReturnByValue(evaluatePoll({ video: {} })).quality, null, 'a video without the method reports null');
  });

  await check('harness poll shape: the scalar playback view drops the unbounded arrays and keeps the rest', async () => {
    const value = throughReturnByValue(evaluatePoll({ video: { getVideoPlaybackQuality: () => new FakePlaybackQuality({ droppedVideoFrames: 0, totalVideoFrames: 1, corruptedVideoFrames: 0, creationTime: 0 }) } }));
    assertEqual(value.playback.starts, undefined, 'starts is not carried in a 125ms poll');
    assertEqual(value.playback.seams, undefined, 'seams is not carried in a 125ms poll');
    assertEqual(value.playback.callbacks, 7, 'the scalar fields are carried');
    assertEqual(value.clock.offsetMs, 3, 'the clock reading is carried');
    assertEqual(value.atMs, 1_000_005, 'the poll carries the page timebase stamp');
    assertEqual(value.wallMs, 1_000_004, 'the poll carries the page wall-clock stamp');
    assert(typeof value.atMs === 'number' && typeof value.wallMs === 'number', 'both poll clocks are numbers');
  });
}
