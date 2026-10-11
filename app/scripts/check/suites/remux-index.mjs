import crypto from 'node:crypto';
import { assert, assertEqual, check } from '../harness.mjs';
import { prepare } from '../../../public/lib/remux.mjs';
import { readSourceIndex } from '../../../public/lib/remux-index.mjs';
import { fixtureEntries, loadFixture, memorySink, memorySource, refusalNames } from '../remux-rig.mjs';

function digestSamples(bytes, track, table) {
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < track.sizes.length; i += 1) hash.update(bytes.subarray(track.offsets[i], track.offsets[i] + track.sizes[i]));
  return hash.digest('hex') === table.streamSha256;
}

function mdatPayloads(bytes) {
  const spans = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const header = size === 1 ? 16 : 8;
    const end = size === 0 ? bytes.length : offset + size;
    if (type === 'mdat') spans.push({ start: offset + header, end });
    if (end <= offset) break;
    offset = end;
  }
  return spans;
}

function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function overlap(read, span) {
  return read.offset < span.end && read.offset + read.length > span.start;
}

function patchU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

function typeOffset(bytes, type) {
  const marker = [...type].map((char) => char.charCodeAt(0));
  for (let i = 4; i < bytes.length - 4; i += 1) if (marker.every((value, n) => bytes[i + n] === value)) return i - 4;
  return -1;
}

function malformedCopy(name, mutation) {
  const fixture = loadFixture(name);
  const bytes = fixture.bytes.slice();
  mutation(bytes);
  return { bytes, table: fixture.table };
}

function sourceFor(bytes) {
  return memorySource(bytes);
}

export default async function remuxIndexSuite() {
  await check('remux-index: fixture tables match copied samples and timeline shifts', async () => {
    // Built whole before any assertion, so one clip's failure cannot hide another's.
    const rows = [];
    for (const fixture of fixtureEntries()) {
      const index = await readSourceIndex(sourceFor(fixture.bytes));
      const tracks = [['video', index.video, fixture.table.streams.video], ['audio', index.audio, fixture.table.streams.audio]].filter(([, track]) => track);
      const perTrack = tracks.map(([name, track, table]) => ({
        name,
        timescale: track.timescale,
        count: track.sizes.length,
        tableCount: table.packets.length,
        sizes: JSON.stringify([...track.sizes]),
        tableSizes: JSON.stringify(table.packets.map((packet) => packet[2])),
        sync: JSON.stringify([...track.sync]),
        tableSync: JSON.stringify(table.packets.map((packet) => packet[3])),
        dtsConstants: new Set([...track.dts].map((dts, i) => dts + track.shift - table.packets[i]?.[1])),
        ptsConstants: new Set([...track.dts].map((dts, i) => dts + track.cto[i] + track.shift - table.packets[i]?.[0])),
        digest: digestSamples(fixture.bytes, track, table),
        firstOutputDts: track.dts[0] + track.shift,
      }));
      rows.push({ name: fixture.name, perTrack, declaredAudio: Boolean(fixture.table.streams.audio), common: index.audio ? gcd(index.video.timescale, index.audio.timescale) : index.video.timescale });
    }
    assertEqual(rows.length, 6, 'all six clips are indexed');
    for (const row of rows) {
      assertEqual(row.perTrack.length, row.declaredAudio ? 2 : 1, `${row.name} indexes the tracks its table has`);
      for (const track of row.perTrack) {
        const label = `${row.name} ${track.name}`;
        assert(track.count > 0, `${label} has samples`);
        assertEqual(track.count, track.tableCount, `${label} count`);
        assertEqual(track.sizes, track.tableSizes, `${label} sizes`);
        assertEqual(track.sync, track.tableSync, `${label} keyframes`);
        assertEqual(track.dtsConstants.size, 1, `${label} dts has one shift`);
        assertEqual(track.ptsConstants.size, 1, `${label} pts has one shift`);
        assertEqual([...track.dtsConstants][0], [...track.ptsConstants][0], `${label} dts and pts shift agree`);
        assert(track.digest, `${label} stream digest`);
      }
      const [v, a] = row.perTrack;
      if (a) assertEqual([...v.dtsConstants][0] * a.timescale, [...a.dtsConstants][0] * v.timescale, `${row.name} cross-track shift is exact`);
      // The offset is pinned from both sides: no decode time below zero, and less than one common unit to spare.
      const least = Math.min(...row.perTrack.map((track) => track.firstOutputDts / track.timescale));
      assert(least >= 0, `${row.name} output starts at or after zero, got ${least}`);
      assert(least < 1 / row.common, `${row.name} output starts within one common unit of zero, got ${least}`);
    }
  });

  await check('remux-index: a file with no readable moov is not-mp4', async () => {
    const whole = loadFixture('even-1s.mp4').bytes;
    const ftypSize = new DataView(whole.buffer, whole.byteOffset, whole.byteLength).getUint32(0);
    const moovAt = typeOffset(whole, 'moov');
    const cases = [
      ['an empty file', new Uint8Array(0)],
      ['seven bytes', whole.slice(0, 7)],
      ['an ftyp and nothing else', whole.slice(0, ftypSize)],
      ['a moov cut short', whole.slice(0, moovAt + 100)],
    ];
    const results = [];
    for (const [label, bytes] of cases) {
      const source = sourceFor(bytes);
      const sink = memorySink();
      let error;
      try { await prepare({ source, sink }); } catch (caught) { error = caught; }
      results.push({ label, error, writes: sink.writes.length });
    }
    assert(moovAt >= ftypSize, 'the fixture has a moov after its ftyp');
    for (const result of results) {
      assertEqual(result.error?.reason, 'not-mp4', `${result.label} is refused not-mp4`);
      assertEqual(result.writes, 0, `${result.label} writes nothing`);
    }
  });

  await check('remux-index: moov-last reads no media payload', async () => {
    const fixture = loadFixture('moov-last.mp4');
    const source = sourceFor(fixture.bytes);
    await readSourceIndex(source);
    const payloads = mdatPayloads(fixture.bytes);
    assert(payloads.length > 0, 'moov-last has an mdat payload');
    assert(source.reads.every((read) => payloads.every((span) => !overlap(read, span))), 'no read overlaps mdat payload');
    const total = source.reads.reduce((sum, read) => sum + read.length, 0);
    assert(total <= fixture.bytes.length - payloads.reduce((sum, span) => sum + span.end - span.start, 0), 'read bytes exclude mdat payload');
  });

  await check('remux-index: refusal files reject before reading media or writing', async () => {
    const expected = new Map([
      ['refuse-fragmented.mp4', ['fragmented', 'fragmentation']],
      ['refuse-video-codec.mp4', ['video-codec', 'mp4v']],
      ['refuse-audio-codec.mp4', ['audio-codec', 'ac-3']],
      ['refuse-no-video.mp4', ['no-video', 'no video']],
      ['refuse-encrypted.mp4', ['encrypted', 'encryption']],
      ['refuse-not-mp4.mkv', ['not-mp4', 'begins with bytes 0x1a45dfa3']],
      ['refuse-mov.mov', ['not-mp4', 'QuickTime']],
    ]);
    const results = [];
    for (const name of refusalNames()) {
      const fixture = loadFixture(name);
      const source = sourceFor(fixture.bytes);
      const sink = memorySink();
      let error;
      try { await prepare({ source, sink }); } catch (caught) { error = caught; }
      results.push({ name, source, sink, error, spans: mdatPayloads(fixture.bytes) });
    }
    for (const result of results) {
      assert(result.error, `${result.name} refuses`);
      const [reason, phrase] = expected.get(result.name);
      assertEqual(result.error.reason, reason, `${result.name} refusal reason`);
      assert(result.error.message.includes(phrase), `${result.name} refusal names ${phrase}`);
      assertEqual(result.sink.writes.length, 0, `${result.name} refusal writes nothing`);
      assert(result.source.reads.every((read) => result.spans.every((span) => !overlap(read, span))), `${result.name} does not read media data`);
    }
  });

  await check('remux-index: constructed edit and structure refusals have named reasons', async () => {
    const cases = [
      ['edit-list', malformedCopy('even-1s.mp4', (bytes) => {
        const at = typeOffset(bytes, 'elst');
        patchU32(bytes, at + 24, 0x00020000);
      })],
      ['edit-list', malformedCopy('even-1s.mp4', (bytes) => {
        const at = typeOffset(bytes, 'elst');
        patchU32(bytes, at + 12, 2);
      })],
      ['unsupported-structure', malformedCopy('even-1s.mp4', (bytes) => {
        const at = typeOffset(bytes, 'stsd');
        patchU32(bytes, at + 12, 2);
      })],
      ['unsupported-structure', malformedCopy('even-1s.mp4', (bytes) => {
        const at = typeOffset(bytes, 'stss');
        patchU32(bytes, at + 16, 2);
      })],
    ];
    const results = [];
    for (const [reason, malformed] of cases) {
      let error;
      try { await readSourceIndex(sourceFor(malformed.bytes)); } catch (caught) { error = caught; }
      results.push({ reason, error });
    }
    for (const result of results) {
      assert(result.error, `${result.reason} mutation refuses`);
      assertEqual(result.error.reason, result.reason, `${result.reason} mutation reason`);
    }
  });
}
