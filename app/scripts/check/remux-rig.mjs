import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { descendants, readFragment, readInitSegment, scan } from './fmp4-reader.mjs';

const fixtureDir = path.resolve(import.meta.dirname, 'remux-fixtures');
const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fixtures.json'), 'utf8'));

function tableEntry(name) {
  const entry = [...fixtureManifest.clips, ...fixtureManifest.refusals].find((item) => item.name === name);
  if (!entry) throw new Error(`unknown remux fixture: ${name}`);
  return entry;
}

export function loadFixture(name) {
  const table = tableEntry(name);
  const bytes = new Uint8Array(fs.readFileSync(path.join(fixtureDir, name)));
  if (bytes.byteLength !== table.bytes) throw new Error(`fixture bytes mismatch: ${name}`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== table.sha256) throw new Error(`fixture sha256 mismatch: ${name}`);
  return { name, bytes, table };
}

export function fixtureEntries({ refusals = false } = {}) {
  return (refusals ? fixtureManifest.refusals : fixtureManifest.clips).map(({ name }) => loadFixture(name));
}

export function memorySource(bytes) {
  const source = {
    size: bytes.byteLength,
    reads: [],
    async read(offset, length) {
      source.reads.push({ offset, length });
      if (offset < 0 || length < 0 || offset + length > source.size) throw new Error(`read outside memory source: ${offset}+${length}`);
      return bytes.slice(offset, offset + length);
    },
  };
  return source;
}

export function memorySink() {
  const sink = {
    files: new Map(),
    writes: [],
    async write(name, bytes) {
      const copy = new Uint8Array(bytes);
      sink.files.set(name, copy);
      sink.writes.push({ name, bytes: copy });
    },
  };
  return sink;
}

export function fixtureNames() {
  return fixtureManifest.clips.map(({ name }) => name);
}

export function refusalNames() {
  return fixtureManifest.refusals.map(({ name }) => name);
}

function sourceStsd(bytes, type) {
  const moov = scan(bytes).find((box) => box.type === 'moov');
  for (const trak of scan(bytes, moov.body, moov.end).filter((box) => box.type === 'trak')) {
    const all = descendants(bytes, trak);
    const hdlr = all.find((box) => box.type === 'hdlr');
    if (String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12)) !== (type === 'video' ? 'vide' : 'soun')) continue;
    const stsd = all.find((box) => box.type === 'stsd');
    return bytes.slice(stsd.start, stsd.end);
  }
  return null;
}

function outputSegments(files) {
  return [...files.entries()]
    .filter(([name]) => /^seg-\d+\.m4s$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, bytes]) => Object.assign(readFragment(bytes), { bytes }));
}

function samplesOf(segments, id) {
  return segments.map((fragment) => {
    const track = fragment.tracks.find((candidate) => candidate.id === id);
    if (!track) return { fragment, track: null, samples: [] };
    let dts = track.baseDecodeTime;
    const samples = track.samples.map((sample) => {
      const result = { ...sample, dts, pts: dts + sample.cto, bytes: fragment.bytes?.slice(sample.offset, sample.offset + sample.size) };
      dts += sample.duration;
      return result;
    });
    return { fragment, track, samples };
  });
}

function expectedCuts(table, outputVideo, targetMs) {
  const packets = table.streams.video.packets;
  const keyframes = packets.map((packet, i) => packet[3] === 1 ? i : -1).filter((i) => i >= 0);
  const shift = outputVideo[0].dts - packets[0][1];
  const ticks = keyframes.map((i) => packets[i][1] + shift);
  const last = outputVideo.at(-1);
  const endTick = last.dts + last.duration;
  const boundaries = [...ticks, endTick];
  const result = [];
  let from = 0;
  while (from < ticks.length) {
    const candidates = boundaries.map((tick, at) => ({ tick, at })).filter(({ at }) => at > from);
    const fitting = candidates.filter(({ tick }) => (tick - boundaries[from]) * 1000 <= targetMs * table.streams.video.timescale);
    const chosen = fitting.at(-1) ?? candidates[0];
    result.push(boundaries[from]);
    from = chosen.at;
  }
  return result;
}

function readOutputSampleBytes(samples) {
  const hash = crypto.createHash('sha256');
  for (const sample of samples) hash.update(sample.bytes);
  return hash.digest('hex');
}

export function verifyOutput({ fixture, table = fixture.table, files, targetMs }) {
  const failed = new Set();
  try {
    const initBytes = files.get('init.mp4');
    const init = readInitSegment(initBytes);
    const fragments = outputSegments(files);
    const videoRows = samplesOf(fragments, 1);
    const audioRows = samplesOf(fragments, 2);
    const video = videoRows.flatMap((row) => row.samples);
    const audio = audioRows.flatMap((row) => row.samples);
    const videoPackets = table.streams.video.packets;
    const audioPackets = table.streams.audio?.packets ?? [];
    const sourceVideo = table.streams.video;
    const sourceAudio = table.streams.audio;
    if (videoRows.some((row) => !row.samples[0] || !(row.samples[0].flags & 0x02000000))) failed.add('starts-with-keyframe');
    let position = 0;
    for (const row of videoRows) {
      const packet = videoPackets[position];
      if (!packet || packet[3] !== 1 || row.samples[0]?.size !== packet[2] || !(row.samples[0]?.flags & 0x02000000)) failed.add('starts-with-keyframe');
      position += row.samples.length;
    }
    const expectedCounts = [video.length === videoPackets.length, audio.length === audioPackets.length];
    const expectedSizes = [video, audio].every((samples, track) => samples.every((sample, i) => sample.size === (track ? audioPackets : videoPackets)[i]?.[2]));
    const hashes = [
      readOutputSampleBytes(video),
      sourceAudio ? readOutputSampleBytes(audio) : crypto.createHash('sha256').digest('hex'),
    ];
    if (!expectedCounts.every(Boolean) || !expectedSizes || hashes[0] !== sourceVideo.streamSha256 || (sourceAudio && hashes[1] !== sourceAudio.streamSha256)) failed.add('every-sample-once');
    for (const rows of [videoRows, audioRows]) {
      let previous = null;
      for (const row of rows) {
        if (row.track && row.samples.length && row.track.baseDecodeTime !== row.samples[0].dts) failed.add('decode-time-continuous');
        for (const sample of row.samples) {
          if (previous !== null && sample.dts !== previous) failed.add('decode-time-continuous');
          previous = sample.dts + sample.duration;
        }
      }
    }
    const constants = (samples, packets) => new Set(samples.map((sample, i) => `${sample.dts - packets[i][1]}:${sample.pts - packets[i][0]}`));
    const videoConstants = constants(video, videoPackets);
    const audioConstants = sourceAudio ? constants(audio, audioPackets) : new Set(['0:0']);
    if (videoConstants.size !== 1 || audioConstants.size !== 1) failed.add('timestamps-match-source');
    if (sourceAudio && video.length && audio.length) {
      const [videoDts] = [...videoConstants][0].split(':').map(Number);
      const [audioDts] = [...audioConstants][0].split(':').map(Number);
      if (videoDts * sourceAudio.timescale !== audioDts * sourceVideo.timescale) failed.add('timestamps-match-source');
    }
    const cuts = expectedCuts(table, video, targetMs);
    if (JSON.stringify(videoRows.map((row) => row.samples[0]?.dts)) !== JSON.stringify(cuts)) failed.add('cuts-follow-the-rule');
    if (sourceAudio) {
      const videoScale = sourceVideo.timescale;
      const audioScale = sourceAudio.timescale;
      const audioShift = audio[0].dts - audioPackets[0][1];
      let from = 0;
      for (let i = 0; i < videoRows.length; i += 1) {
        const start = videoRows[i].samples[0].dts;
        if (i > 0) while (from < audioPackets.length && (audioPackets[from][1] + audioShift) * videoScale < start * audioScale) from += 1;
        const nextStart = i + 1 < videoRows.length ? videoRows[i + 1].samples[0].dts : Infinity;
        let to = from;
        while (to < audioPackets.length && (audioPackets[to][1] + audioShift) * videoScale < nextStart * audioScale) to += 1;
        const row = audioRows[i];
        if (row.samples.length !== to - from || (row.samples.length && i > 0 && row.samples[0].dts * videoScale < start * audioScale)) failed.add('audio-follows-video');
        from = to;
      }
    }
    if (init.hasEditList) failed.add('no-edit-list');
    for (const type of ['video', ...(sourceAudio ? ['audio'] : [])]) {
      const out = init.tracks.find((track) => track.type === (type === 'video' ? 'vide' : 'soun'));
      if (!out || JSON.stringify([...out.stsd]) !== JSON.stringify([...sourceStsd(fixture.bytes, type)])) failed.add('sample-entry-copied');
    }
  } catch {
    failed.add('every-sample-once');
  }
  return [...failed];
}

function copyFiles(files, doctor) {
  const out = new Map(files);
  for (const [name, bytes] of out) out.set(name, doctor(name, bytes.slice()));
  return out;
}

function firstSample(files, id) {
  const names = [...files.keys()].filter((name) => /^seg-\d+\.m4s$/.test(name)).sort();
  for (const name of names) {
    const sample = readFragment(files.get(name)).tracks.find((track) => track.id === id)?.samples[0];
    if (sample) return sample;
  }
  throw new Error(`no sample of track ${id} in the output`);
}

// Every audio tfdt raised by the first audio sample's duration: one frame against video.
export function seedAudioOffset(files) {
  const frame = firstSample(files, 2).duration;
  return copyFiles(files, (name, bytes) => {
    if (!/^seg-\d+\.m4s$/.test(name)) return bytes;
    const moof = scan(bytes).find((box) => box.type === 'moof');
    for (const traf of scan(bytes, moof.body, moof.end).filter((box) => box.type === 'traf')) {
      const tfhd = scan(bytes, traf.body, traf.end).find((box) => box.type === 'tfhd');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(tfhd.body + 4) !== 2) continue;
      const tfdt = scan(bytes, traf.body, traf.end).find((box) => box.type === 'tfdt');
      view.setBigUint64(tfdt.body + 4, view.getBigUint64(tfdt.body + 4) + BigInt(frame));
    }
    return bytes;
  });
}

function makeBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Uint8Array.from([...type].map((char) => char.charCodeAt(0))), 4);
  out.set(payload, 8);
  return out;
}

// An edit that skips the first video sample's composition offset plus one frame: a reader
// that applies edit lists then places every packet one frame from one that ignores them.
export function seedEditList(files) {
  const first = firstSample(files, 1);
  const elst = new Uint8Array(20);
  const fields = new DataView(elst.buffer);
  fields.setUint32(4, 1);
  fields.setUint32(12, first.cto + first.duration);
  fields.setUint32(16, 0x00010000);
  return copyFiles(files, (name, bytes) => {
    if (name !== 'init.mp4') return bytes;
    const top = scan(bytes);
    const moov = top.find((box) => box.type === 'moov');
    const traks = scan(bytes, moov.body, moov.end).filter((box) => box.type === 'trak');
    const video = traks.find((trak) => descendants(bytes, trak).find((box) => box.type === 'hdlr' && String.fromCharCode(...bytes.subarray(box.body + 8, box.body + 12)) === 'vide'));
    const children = scan(bytes, video.body, video.end);
    const edit = makeBox('edts', makeBox('elst', elst));
    const trakPayload = children.flatMap((box) => box.type === 'tkhd' ? [bytes.slice(box.start, box.end), edit] : [bytes.slice(box.start, box.end)]);
    const newTrak = makeBox('trak', Uint8Array.from(trakPayload.flatMap((part) => [...part])));
    const moovPayload = scan(bytes, moov.body, moov.end).map((box) => box.start === video.start ? newTrak : bytes.slice(box.start, box.end));
    const newMoov = makeBox('moov', Uint8Array.from(moovPayload.flatMap((part) => [...part])));
    return Uint8Array.from(top.map((box) => box.start === moov.start ? newMoov : bytes.slice(box.start, box.end)).flatMap((part) => [...part]));
  });
}
