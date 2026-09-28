import { assert, assertEqual, check } from '../harness.mjs';
import { appliedSeekEvidence } from '../../figures/seek-evidence.mjs';
import { evaluateRefusals } from '../../harness/refusals.mjs';
import { waitForAppliedSeek } from '../../harness-run.mjs';

const condition = {
  delivery: 'http', clients: 1, bars: { recordCoverageMin: 0.5, droppedFrameFractionMax: 1, driftLogMissedMax: 0 },
  seek: { issueAfterReadyMs: 120_000, deltaMs: 600_000, appliedTimeoutMs: 5000 },
};
const same = { lineage: 'lineage', version: 4, playing: true, positionMs: 40_000, atSharedMs: 500_000 };
const records = (path) => [{ kind: 'segment', path, completedAtMs: 400_000 }];

function evidence(overrides = {}) {
  return {
    condition,
    window: { startMs: 0, endMs: 1_000 },
    declaredClientTags: ['c01'],
    clients: overrides.clients ?? { c01: { finalPlayback: { begun: 1 }, records: [], polls: [], driftLogMissed: 0, maxDriftDrainGapMs: 0 } },
    originStart: { unattributedMediaBytesDelivered: 0 }, originEnd: { unattributedMediaBytesDelivered: 0 },
    seek: { host: same, viewers: { c01: { reading: same, restart: { restarted: true } } }, ...overrides.seek },
    peerRecords: overrides.peerRecords ?? { c01: records('/media/seg-10.m4s') },
  };
}

function reasons(input) {
  return evaluateRefusals(input).reasons;
}

export default async function seekEvidenceSuite() {
  await check('seek evidence: a viewer holding the landing segment refuses by name', async () => {
    const found = reasons(evidence()).find((entry) => entry.reason === 'seek-landed-on-held-media');
    assert(found, 'landing segment is refused');
    assertEqual(found.tag, 'c01', 'landing refusal names the viewer');
    assertEqual(found.kL, 10, 'landing refusal names kL');
    assertEqual(found.highestHeldSegment, 10, 'landing refusal names the highest held segment');
  });

  await check('seek evidence: only an earlier segment passes the landing check', async () => {
    const clean = appliedSeekEvidence({ host: same, viewers: { c01: { reading: same } }, peerRecords: { c01: records('/media/seg-9.m4s') }, declaredClientTags: ['c01'] });
    assertEqual(clean.landedOnHeldMedia.length, 0, 'kL minus one is outside the landing range');
    const result = reasons(evidence({ peerRecords: { c01: records('/media/seg-9.m4s') } }));
    assert(!result.some((entry) => entry.reason === 'seek-landed-on-held-media'), 'the earlier-only case passes');
  });

  await check('seek evidence: an unapplied viewer refuses and names its last reading', async () => {
    const found = reasons(evidence({ seek: { viewers: { c01: { reading: null } }, lastReadings: { c01: { version: 3 } } } })).find((entry) => entry.reason === 'seek-not-applied');
    assert(found, 'unapplied viewer is refused');
    assertEqual(found.lastReading.version, 3, 'refusal carries the last reading');
  });

  await check('seek evidence: applied but never restarted is listed and exempted narrowly', async () => {
    const result = reasons(evidence({ seek: {
      viewers: { c01: { reading: same, restart: { restarted: false } } },
      viewersNotRestarted: ['c01'],
    }, clients: { c01: {
      finalPlayback: { begun: 1 }, records: [],
      polls: [{ atMs: 100, quality: { droppedVideoFrames: 0, totalVideoFrames: 10 } }, { atMs: 200, quality: { droppedVideoFrames: 0, totalVideoFrames: 10 } }],
      driftLogMissed: 0, maxDriftDrainGapMs: 0,
    } } }));
    assert(!result.some((entry) => entry.reason === 'record-coverage-unavailable'), 'empty coverage is exempted after an applied seek without restart');
    assert(!result.some((entry) => entry.reason === 'dropped-frame-evidence-unavailable'), 'zero dropped-frame delta is exempted after an applied seek without restart');
  });

  await check('seek evidence: the exemption does not cover a viewer that never applied', async () => {
    const result = reasons(evidence({ seek: {
      viewers: { c01: { reading: null, restart: { restarted: false } } },
      viewersNotRestarted: ['c01'],
    } }));
    assert(result.some((entry) => entry.reason === 'seek-not-applied'), 'unapplied viewer remains refused');
    assert(result.some((entry) => entry.reason === 'record-coverage-unavailable'), 'unapplied viewer still has the coverage refusal');
  });

  await check('seek evidence: applied-state polling requires the same transition on every viewer', async () => {
    const host = { tag: 'host' };
    const viewer = { tag: 'c01' };
    const readings = new Map([[host, [
      { lineage: 'lineage', version: 2, playing: true, positionMs: 1, atSharedMs: 100 },
      same,
    ]], [viewer, [
      { lineage: 'lineage', version: 2, playing: true, positionMs: 1, atSharedMs: 100 },
      same,
    ]]]);
    const result = await waitForAppliedSeek({
      hostSession: host, sessions: [viewer], before: readings.get(host)[0], timeoutMs: 50,
      readState: async (session) => readings.get(session).shift(), drainAll: async () => {},
      now: (() => { let value = 0; return () => value += 10; })(), sleepFn: async () => {},
    });
    assertEqual(result.timedOut, false, 'polling ends when every viewer matches');
    assertEqual(result.host.version, 4, 'host transition is retained');
    assertEqual(result.viewers.c01.reading.positionMs, 40_000, 'viewer matching reading is retained');
  });
}
