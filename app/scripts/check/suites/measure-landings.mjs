import { assertEqual, check } from '../harness.mjs';
import { landings, landingPairs } from '../../measure/landings.mjs';

function evidence(control = '8b') {
  const tags = ['c01', 'c02'];
  const client = (tag) => ({
    polls: [{ atMs: 900, playback: { startAtSharedMs: 1_000 } }],
    peerBytes: tag === 'c01'
      ? [{ kind: 'attempt', source: 'http', path: '/media/seg-00000.m4s', bytes: 100, endMs: 1_100 },
        { kind: 'segment', path: '/media/seg-00000.m4s', completedAtMs: 700, keptAttemptIds: [1] }]
      : [{ kind: 'attempt', source: 'http', path: '/media/seg-00000.m4s', bytes: 100, endMs: 1_200 },
        { kind: 'attempt', source: 'p2p', path: '/media/seg-00000.m4s', bytes: 50, endMs: 2_000 }],
    drift: [], viewerControl: [
      { harnessBeforeMs: 1_000, harnessAfterMs: 1_000, heldAhead: { heldAheadMs: 16_000 }, state: { playing: false, held: true } },
      { harnessBeforeMs: 2_000, harnessAfterMs: 2_000, heldAhead: { heldAheadMs: 16_000 }, state: { playing: false, held: true } },
    ],
  });
  return { run: 'landing', timebase: { offsetMs: 0, wallOffsetMs: 0 }, tags,
    condition: { assignmentControl: control }, content: { segmentSeconds: 2, segmentDurations: [2, 2], segmentCount: 2, segmentSizes: [100, 200] },
    hostPoll: [{ state: { positionMs: 0 }, harnessBeforeMs: 900, harnessAfterMs: 900 }],
    assignmentControl: { readings: [{ byPage: { c00: { control }, c01: { control }, c02: { control } } }] },
    publishedFigures: { control: { holds: { start: { waitMs: 10 } } } },
    clients: Object.fromEntries(tags.map((tag) => [tag, client(tag)])) };
}

export default async function measureLandingsSuite() {
  await check('measurement landings: host copies, first holder and pairing', async () => {
    const result = landings(evidence());
    assertEqual(result.start.segments[0].hostCopies, 2, 'host copies include both full host attempts');
    assertEqual(result.start.segments[0].firstHolderMs, -300, 'first holder is relative to landing');
    assertEqual(result.start.peerShare30s, 50 / 250, 'peer share uses the post-landing attempt window');
    assertEqual(result.start.waitMs, 10, 'start wait is published');
    const pair = landingPairs([[result, { ...result, start: { ...result.start, hostCopiesSum: 1 } }]]);
    assertEqual(pair.pairs[0].start.difference.hostCopiesSum, 1, 'pair difference is product minus control');
  });

  await check('measurement landings: control mismatch refuses', async () => {
    const fixture = evidence();
    fixture.assignmentControl.readings[0].byPage.c00.control = 'product';
    const result = landings(fixture);
    assertEqual(result.reason, 'control-mismatch', 'control mismatch is a refusal');
    assertEqual(result.detail, 'c00', 'refusal names the mismatching page');
  });
}
