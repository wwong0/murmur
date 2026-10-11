import crypto from 'node:crypto';
import { assert, assertEqual, check } from '../harness.mjs';
import { assignAudio, planCuts } from '../../../public/lib/remux-cut-plan.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';
import { prepare, writePlanned } from '../../../public/lib/remux.mjs';
import { writeInitSegment } from '../../../public/lib/fmp4-writer.mjs';
import { readFragments } from '../fmp4-reader.mjs';
import { fixtureEntries, loadFixture, memorySink, memorySource, verifyOutput, seedAudioOffset, seedEditList } from '../remux-rig.mjs';

function outputPlan(index, targetSeconds) {
  const keyframeTicks = [...index.video.sync].flatMap((sync, i) => sync ? [index.video.dts[i] + index.video.shift] : []);
  const last = index.video.dts.length - 1;
  const endTick = index.video.dts[last] + index.video.shift + index.video.durations[last];
  const segments = planCuts({ keyframeTicks, endTick, timescale: index.video.timescale, targetMs: targetSeconds * 1000 });
  const planned = segments.map((segment) => {
    const from = index.video.dts.findIndex((dts, i) => dts + index.video.shift === segment.startTick);
    let to = from;
    while (to < index.video.dts.length && index.video.dts[to] + index.video.shift < segment.endTick) to += 1;
    return { ...segment, videoFrom: from, videoTo: to };
  });
  return { segments: planned, audioRanges: index.audio ? assignAudio({ segments: planned, video: index.video, audio: index.audio }) : [] };
}

async function plannedOutput(fixture, targetSeconds, mutate = () => {}) {
  const source = memorySource(fixture.bytes);
  const index = await readSourceIndex(source);
  const { segments, audioRanges } = outputPlan(index, targetSeconds);
  mutate(segments);
  const sink = memorySink();
  await sink.write('init.mp4', writeInitSegment(index));
  await writePlanned({ index, segments, audioRanges, source, sink });
  return sink.files;
}

function patchVideoTfdt(files, name, ticks) {
  const bytes = files.get(name).slice();
  for (let i = 4; i + 4 < bytes.length; i += 1) {
    if (bytes[i] !== 116 || bytes[i + 1] !== 102 || bytes[i + 2] !== 100 || bytes[i + 3] !== 116) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setBigUint64(i + 8, view.getBigUint64(i + 8) + BigInt(ticks));
    files.set(name, bytes);
    return;
  }
  throw new Error(`no tfdt in ${name}`);
}

function externalRows(fixture) {
  const fragments = readFragments(fixture.bytes);
  return ['video', 'audio'].map((type, trackIndex) => {
    const id = trackIndex + 1;
    const packets = [];
    const hash = crypto.createHash('sha256');
    for (const fragment of fragments) {
      const track = fragment.tracks.find((candidate) => candidate.id === id);
      if (!track) continue;
      let dts = track.baseDecodeTime;
      for (const sample of track.samples) {
        packets.push([dts + sample.cto, dts, sample.size, (sample.flags & 0x02000000) ? 1 : 0]);
        hash.update(fragment.bytes.slice(sample.offset, sample.offset + sample.size));
        dts += sample.duration;
      }
    }
    return { type, packets, digest: hash.digest('hex') };
  });
}

export default async function remuxWriterSuite() {
  await check('remux-writer: every fixture satisfies all eight output invariants at both targets', async () => {
    const results = [];
    for (const fixture of fixtureEntries()) {
      for (const target of [1, 4]) {
        const sink = memorySink();
        await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: target });
        results.push({ name: `${fixture.name} at ${target}s`, failed: verifyOutput({ fixture, files: sink.files, targetMs: target * 1000 }) });
      }
    }
    assertEqual(results.length, 12, 'all fixture-target pairs ran');
    for (const result of results) assertEqual(JSON.stringify(result.failed), '[]', `${result.name} has no failed invariant`);
  });

  await check('remux-writer: independent reader matches ffmpeg fragmented fixture', async () => {
    const fixture = loadFixture('refuse-fragmented.mp4');
    const rows = externalRows(fixture);
    for (const row of rows) {
      const expected = fixture.table.streams[row.type];
      assertEqual(JSON.stringify(row.packets), JSON.stringify(expected.packets), `${row.type} fragmented packets`);
      assertEqual(row.digest, expected.streamSha256, `${row.type} fragmented digest`);
    }
  });

  await check('remux-writer: permanent seeded defects name the invariant they break', async () => {
    const fixture = loadFixture('varying.mp4');
    const defects = [];
    defects.push({ name: 'cut one sample early', expected: 'starts-with-keyframe', files: await plannedOutput(fixture, 2, (segments) => {
      segments[0].videoTo -= 1;
      segments[1].videoFrom -= 1;
    }) });
    defects.push({ name: 'dropped sample', expected: 'every-sample-once', files: await plannedOutput(fixture, 2, (segments) => { segments[0].videoTo -= 1; }) });
    const shifted = await (async () => {
      const sink = memorySink();
      await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 2 });
      patchVideoTfdt(sink.files, 'seg-00002.m4s', 1);
      return sink.files;
    })();
    defects.push({ name: 'decode time shifted at one boundary', expected: 'decode-time-continuous', files: shifted });
    const correct = await (async () => {
      const sink = memorySink();
      await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 2 });
      return sink.files;
    })();
    defects.push({ name: 'audio offset by one frame', expected: 'timestamps-match-source', files: seedAudioOffset(correct) });
    defects.push({ name: 'edit list left in', expected: 'no-edit-list', files: seedEditList(correct) });
    const results = defects.map((defect) => ({ defect, failed: verifyOutput({ fixture, files: defect.files, targetMs: 2000 }) }));
    assertEqual(JSON.stringify(verifyOutput({ fixture, files: correct, targetMs: 2000 })), '[]', 'the undoctored output fails nothing');
    for (const result of results) assert(result.failed.includes(result.defect.expected), `${result.defect.name} includes ${result.defect.expected}, got ${JSON.stringify(result.failed)}`);
  });

  await check('remux-writer: a segment\'s bytes are the most read between two writes', async () => {
    const fixture = loadFixture('varying.mp4');
    const source = memorySource(fixture.bytes);
    const stored = memorySink();
    const marks = [];
    const sink = { async write(name, bytes) { marks.push({ name, reads: source.reads.length }); await stored.write(name, bytes); } };
    await prepare({ source, sink, targetSeconds: 4 });
    // Expected payloads come from the reader's view of each written fragment, not from the plan.
    const rows = marks.map((mark, at) => ({ ...mark, from: at === 0 ? 0 : marks[at - 1].reads })).filter((mark) => /^seg-/.test(mark.name)).map((mark) => {
      const reads = source.reads.slice(mark.from, mark.reads);
      const fragment = readFragments(stored.files.get(mark.name))[0];
      const payload = fragment.tracks.reduce((sum, track) => sum + track.samples.reduce((total, sample) => total + sample.size, 0), 0);
      return { name: mark.name, read: reads.reduce((sum, read) => sum + read.length, 0), largest: Math.max(...reads.map((read) => read.length)), payload };
    });
    assert(rows.length > 2, `varying at 4s has several segments, got ${rows.length}`);
    const largestPayload = Math.max(...rows.map((row) => row.payload));
    for (const row of rows) {
      assert(row.payload > 0, `${row.name} has a payload`);
      assertEqual(row.read, row.payload, `${row.name}: bytes read before its write equal its sample bytes`);
      assert(row.largest <= largestPayload, `${row.name}: no single read exceeds the largest segment`);
    }
  });
}
