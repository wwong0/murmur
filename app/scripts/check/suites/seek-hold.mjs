import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEqual, check } from '../harness.mjs';
import { readRunDirectory } from '../../harness-figures.mjs';
import { computeControlFigures } from '../../figures/control-figures.mjs';
import { appliedSeekEvidence } from '../../figures/seek-evidence.mjs';
import { seekWithPolledHold } from '../../figures/seek-hold.mjs';

const SCRATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp');
const before = { lineage: 'line', version: 8, playing: true, positionMs: 0, atSharedMs: 100, held: false };
const held = { lineage: 'line', version: 9, playing: true, positionMs: 720500, atSharedMs: 200, held: true };
const loop = { lineage: 'line', version: 10, playing: true, positionMs: 720500, atSharedMs: 300, held: false };

function seek() {
  return {
    before, declared: { positionMs: 720500 }, declaredPositionMs: 720500, host: loop,
    landingSegment: 360, notApplied: [], landedOnHeldMedia: [{ tag: 'c01' }],
    landingMs: 720500, landedPositionMs: 720500, effectiveSharedMs: loop.atSharedMs,
    viewers: { c01: { reading: loop, highestSegmentBeforeE: 367, heldSegments: [360], kL: 360 } },
    viewersNotRestarted: [], lastReadings: { c01: loop },
  };
}

function polls() {
  return [
    { harnessBeforeMs: 10, harnessAfterMs: 20, sharedMs: 100, clock: { halfWidthMs: 1 }, state: before },
    { harnessBeforeMs: 110, harnessAfterMs: 120, sharedMs: 200, clock: { halfWidthMs: 1 }, state: held },
    { harnessBeforeMs: 210, harnessAfterMs: 220, sharedMs: 300, clock: { halfWidthMs: 1 }, state: loop },
  ];
}

function repaired() {
  return seekWithPolledHold(seek(), { hostPoll: polls(), viewerPolls: { c01: [
    { harnessBeforeMs: 115, state: held }, { harnessBeforeMs: 215, state: loop },
  ] } });
}

export default async function seekHoldSuite() {
  await check('seek hold: unrepairable readings retain identity', async () => {
    const heldLoop = { ...seek(), host: { ...loop, held: true } };
    const sameVersion = { ...seek(), host: { ...loop, version: before.version } };
    const original = seek();
    const noMatch = seekWithPolledHold(original, { hostPoll: [{ state: { ...held, positionMs: 1 } }] });
    assert(seekWithPolledHold(heldLoop) === heldLoop, 'a loop that saw held is unchanged');
    assert(seekWithPolledHold(sameVersion) === sameVersion, 'an equal version is unchanged');
    assert(noMatch === original, 'a mismatched position is unchanged');
    assert(seekWithPolledHold(original, { hostPoll: [] }) === original, 'no matching poll is unchanged');
  });

  await check('seek hold: first polled hold repairs host and viewer readings', async () => {
    const original = seek();
    const result = repaired();
    assert(result !== original, 'a matching hold creates a new seek object');
    assertEqual(result.host.version, 9, 'held version wins');
    assertEqual(result.hostAtMs, 110, 'host poll boundary is retained');
    assertEqual(result.effectiveSharedMs, 200, 'held shared instant wins');
    assert(result.viewers.c01.reading === held, 'viewer poll supplies its held reading');
    assertEqual(result.viewers.c01.appliedAtMs, 115, 'viewer poll boundary is retained');
    assert(result.loopHost === loop, 'loop host is retained for provenance');
    for (const key of ['landingSegment', 'notApplied', 'landedOnHeldMedia', 'viewersNotRestarted']) {
      assert(!(key in result), `${key} is recomputed`);
    }
    for (const key of ['highestSegmentBeforeE', 'heldSegments', 'kL']) {
      assert(!(key in result.viewers.c01), `viewer ${key} is recomputed`);
    }
  });

  await check('seek hold: repaired landing uses the held instant', async () => {
    const records = [{ kind: 'segment', path: '/media/seg-360.m4s', completedAtMs: 250 }];
    const fixed = repaired();
    const repairedEvidence = appliedSeekEvidence({ host: fixed.host, viewers: fixed.viewers,
      peerRecords: { c01: records }, declaredClientTags: ['c01'], segmentSeconds: 2 });
    const oldEvidence = appliedSeekEvidence({ host: loop, viewers: seek().viewers,
      peerRecords: { c01: records }, declaredClientTags: ['c01'], segmentSeconds: 2 });
    assertEqual(repairedEvidence.notApplied.length, 0, 'held viewer applied');
    assertEqual(repairedEvidence.landedOnHeldMedia.length, 0, 'post-hold segment is not held media');
    assertEqual(oldEvidence.landedOnHeldMedia.length, 1, 'loop instant pins the defect');
  });

  await check('seek hold: control figure no longer refuses the repaired hold', async () => {
    const input = {
      condition: { peerExchange: true }, declaredClientTags: ['c01'], clients: { c01: {
        records: [{ displaySharedMs: 0, mediaMs: 0, presentedFrames: 1, seq: 1 }], polls: [],
        peerRecords: [{ kind: 'attempt', startMs: 0 }],
      } },
      hostPoll: polls(), viewerPolls: { c01: [] }, resumes: { records: [] }, clockJoin: { c01: { joined: [{ recvSharedMs: 0 }] } },
      window: { startMs: 0, endMs: 1_000, clientsReadyAtMs: 0 }, segmentSeconds: 2, contentManifest: { segmentSizes: [1] },
      capacityBitsPerSecond: 10_000_000, linkSamples: [], seek: seek(),
    };
    const old = computeControlFigures(input);
    const next = computeControlFigures({ ...input, seek: repaired() });
    assert(old.refusals.some((entry) => entry.reason === 'seek-hold-unobserved'), 'old loop reading is refused');
    assert(!next.refusals.some((entry) => entry.reason === 'seek-hold-unobserved'), 'repaired reading is accepted');
  });

  // Mutation: read manifest.seek unrepaired in readRunDirectory; red here.
  await check('seek hold: a retained run hands the polled hold to the recompute', async () => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    const dir = fs.mkdtempSync(path.join(SCRATCH, '11a2-seek-hold-'));
    try {
      const ndjson = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        condition: { delivery: 'host', peerExchange: true, clients: 1 },
        content: { identity: 'step0-content-media-v1' }, declaredClientTags: ['c01'], seek: seek() }));
      fs.writeFileSync(path.join(dir, 'host-control-poll.ndjson'), ndjson(polls()));
      fs.writeFileSync(path.join(dir, 'viewer-control-c01.ndjson'), ndjson([
        { harnessBeforeMs: 115, state: held }, { harnessBeforeMs: 215, state: loop }]));
      const { seek: read } = readRunDirectory(dir).input;
      assertEqual(read?.host?.version, 9, 'the recompute reads the polled hold');
      assertEqual(read?.loopHost?.version, 10, 'and keeps the loop reading beside it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
