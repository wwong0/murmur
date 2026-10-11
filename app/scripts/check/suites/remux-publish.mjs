import fs from 'node:fs';
import path from 'node:path';
import { assert, assertEqual, check } from '../harness.mjs';
import { armFor } from '../../harness/arms.mjs';
import { createFakeClock, createFakeLink } from '../fake-channel.mjs';
import { createHostOrigin } from '../../../public/lib/host-origin.mjs';
import { decodeFrame, encodeControl, parseControl } from '../../../public/lib/segment-protocol.mjs';
import { prepare } from '../../../public/lib/remux.mjs';
import { writeManifest, writePlaylist } from '../../../public/lib/remux-publish.mjs';
import { fixtureEntries, memorySink, memorySource } from '../remux-rig.mjs';

const decoder = new TextDecoder();

function minimalIndex(dts, sync = dts.map(() => 1), timescale = 1000) {
  return {
    size: 100,
    video: { codec: 'avc1.test', timescale, dts: new Float64Array(dts), shift: 0, sync: new Uint8Array(sync), durations: new Uint32Array([...(dts.slice(1).map((tick, i) => tick - dts[i])), 1000]) },
    audio: null,
    dropped: [],
  };
}

function manifestFor(index, segments, targetSeconds, sizes = segments.map(() => 10)) {
  return JSON.parse(writeManifest({ index, segments, segmentSizes: sizes, targetSeconds, identity: 'v1:test' }));
}

export default async function remuxPublishSuite() {
  await check('remux-publish: playlist lists every prepared segment with bounded durations', async () => {
    const rows = [];
    for (const fixture of fixtureEntries()) {
      const sink = memorySink();
      const manifest = await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 4 });
      const text = decoder.decode(sink.files.get('master.m3u8'));
      const names = [...text.matchAll(/^(seg-\d+\.m4s)$/gm)].map((match) => match[1]);
      const durations = [...text.matchAll(/^#EXTINF:([0-9.]+),$/gm)].map((match) => Number(match[1]));
      rows.push({ fixture, manifest, text, names, durations, sink });
    }
    for (const row of rows) {
      assertEqual(JSON.stringify(row.names), JSON.stringify(row.manifest.segmentDurations.map((_, i) => `seg-${String(i).padStart(5, '0')}.m4s`)), `${row.fixture.name} segment names are ordered`);
      assertEqual(row.durations.length, row.manifest.segmentCount, `${row.fixture.name} has one EXTINF per segment`);
      for (const [i, duration] of row.durations.entries()) assert(Math.abs(duration - row.manifest.segmentDurations[i]) <= 0.000001, `${row.fixture.name} duration ${i} is six-place rounded`);
      const target = Number(row.text.match(/TARGETDURATION:(\d+)/)[1]);
      assert(target >= Math.max(...row.durations) && target < Math.max(...row.durations) + 1, `${row.fixture.name} target duration bounds longest EXTINF`);
      assert(row.text.endsWith('\n'), `${row.fixture.name} playlist ends with newline`);
      // Against the table's own length in ticks, two-sided, one tick of rounding per segment.
      const video = row.fixture.table.streams.video;
      const frame = video.packets[1][1] - video.packets[0][1];
      const tableTicks = video.packets.at(-1)[1] + frame - video.packets[0][1];
      const listed = row.durations.reduce((sum, duration) => sum + Math.round(duration * video.timescale), 0);
      assert(Math.abs(listed - tableTicks) <= row.durations.length, `${row.fixture.name} EXTINF sums to ${listed} ticks against ${tableTicks}`);
      const written = [...row.sink.files.keys()].filter((name) => name.startsWith('seg-')).sort();
      assertEqual(JSON.stringify(row.names), JSON.stringify(written), `${row.fixture.name} lists every written segment once`);
      const keys = video.packets.filter((packet) => packet[3] === 1).map((packet) => packet[1] - video.packets[0][1]);
      assertEqual(JSON.stringify(row.manifest.keyframeTicks), JSON.stringify(keys), `${row.fixture.name} keyframe ticks are the table's key packets`);
      assertEqual(JSON.stringify(row.manifest.keyframeTimes), JSON.stringify(keys.map((tick) => Number((tick / video.timescale).toFixed(6)))), `${row.fixture.name} keyframe times are the ticks in seconds`);
      assertEqual(row.manifest.videoTimescale, video.timescale, `${row.fixture.name} publishes the video timescale`);
      assertEqual(row.manifest.totalBytes, written.reduce((sum, name) => sum + row.sink.files.get(name).length, 0), `${row.fixture.name} totalBytes is the segments' bytes`);
      assertEqual([...row.sink.files.keys()].at(-1), 'content-manifest.json', `${row.fixture.name} writes the manifest last`);
    }
    const byName = new Map(rows.map((row) => [row.fixture.name, row.manifest]));
    assertEqual(byName.get('varying.mp4').segmentSeconds, null, 'varying at 4s has no single length');
    assertEqual(JSON.stringify(byName.get('varying.mp4').segmentDurations), JSON.stringify([2, 4, 5, 3]), 'varying at 4s publishes each length');
    assertEqual(JSON.stringify(byName.get('varying.mp4').overTarget), JSON.stringify({ count: 1, longestSeconds: 5 }), 'varying at 4s has one segment over the target');
    assertEqual(JSON.stringify(byName.get('varying.mp4').keyframeSpacing), JSON.stringify({ min: 0.5, median: 1.5, p95: 5, max: 5 }), 'varying spacing by nearest rank over six intervals');
    assertEqual(byName.get('even-1s.mp4').segmentSeconds, 4, 'even-1s at 4s has one length');
    assertEqual(byName.get('even-1s.mp4').overTarget.count, 0, 'even-1s at 4s has nothing over the target');
    assertEqual(byName.get('video-only.mp4').tracks.audio, null, 'a video-only file publishes no audio track');
    assertEqual(byName.get('even-1s.mp4').tracks.audio.codec, 'mp4a.40.2', 'the audio codec string is published');
  });

  await check('remux-publish: the host origin inlines the written playlist', async () => {
    const fixture = fixtureEntries().find((entry) => entry.name === 'even-1s.mp4');
    const sink = memorySink();
    await prepare({ source: memorySource(fixture.bytes), sink, targetSeconds: 4 });
    const clock = createFakeClock();
    const link = createFakeLink({ clock, hostDrainBytesPerMs: 1000, viewerDrainBytesPerMs: 1000 });
    const messages = [];
    link.viewer.addEventListener('message', (event) => messages.push(event.data));
    const readSource = async (path) => {
      const bytes = sink.files.get(path.replace('/media/', ''));
      return bytes ? { status: 200, bytes: bytes.slice() } : { status: 404, bytes: new Uint8Array() };
    };
    const detach = createHostOrigin({ readSource, clock }).attach(link.host);
    try {
      link.viewer.send(encodeControl({ t: 'req', id: 1, path: '/media/master.m3u8', range: null }));
      clock.advance(1000);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      clock.advance(1000);
      const lines = messages.map((value) => typeof value === 'string' ? parseControl(value) : null).filter((value) => value?.id === 1);
      const frames = messages.map((value) => typeof value === 'string' ? null : decodeFrame(value)).filter((value) => value?.id === 1);
      const body = decoder.decode(new Uint8Array(frames.flatMap((frame) => [...new Uint8Array(frame.payload)])));
      assertEqual(lines[0]?.t, 'head', 'the playlist is answered with a head');
      assertEqual(lines[0]?.status, 200, 'the playlist is answered 200');
      assertEqual(lines.at(-1)?.t, 'end', 'the playlist ends cleanly');
      assertEqual([...body.matchAll(/URI="data:video\/mp4;base64,/g)].length, 1, 'the playlist carries one data URI');
      assertEqual([...body.matchAll(/^seg-\d+\.m4s$/gm)].length, 3, 'every segment line survives the inlining');
    } finally {
      detach();
      link.closeBoth();
    }
  });

  await check('remux-publish: manifest publishes sparse spacing and variable lengths', async () => {
    const index = minimalIndex([0, 1000, 2000, 3000, 4000, 14000, 15000, 16000]);
    const segments = [{ startTick: 0, endTick: 4000 }, { startTick: 4000, endTick: 14000 }, { startTick: 14000, endTick: 16000 }];
    const manifest = manifestFor(index, segments, 4, [11, 22, 33]);
    assertEqual(manifest.overTarget.count, 1, 'one sparse segment is over target');
    assertEqual(manifest.overTarget.longestSeconds, 10, 'sparse segment reports its duration');
    assertEqual(manifest.keyframeSpacing.max, 10, 'spacing reports the ten-second interval');
    assertEqual(manifest.segmentSeconds, null, 'variable segments publish null common length');
    assertEqual(JSON.stringify(manifest.segmentDurations), JSON.stringify([4, 10, 2]), 'segment durations are published');
    const even = manifestFor(minimalIndex([0, 4000, 8000, 12000, 16000]), [{ startTick: 0, endTick: 16000 }], 4);
    assertEqual(even.segmentSeconds, 16, 'one segment publishes its own length');
  });

  await check('remux-publish: a null common length makes one-viewing recompute refuse', async () => {
    const root = path.resolve('.tmp/remux-11');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'publish-null-manifest.json');
    const index = minimalIndex([0, 1000, 2000, 3000, 4000, 14000, 15000, 16000]);
    fs.writeFileSync(file, writeManifest({ index, segments: [{ startTick: 0, endTick: 4000 }, { startTick: 4000, endTick: 14000 }, { startTick: 14000, endTick: 16000 }], segmentSizes: [1, 1, 1], targetSeconds: 4, identity: 'v1:test' }));
    const host = armFor({ delivery: 'host' });
    let error;
    try { host.recomputeSegmentSeconds({ multiplierDenominator: 'one-viewing', content: { manifestPath: file } }); } catch (caught) { error = caught; } finally { fs.rmSync(file, { force: true }); }
    assert(error?.message.includes('content segment seconds are unavailable'), 'null segment length is refused by host recompute');
  });
}
