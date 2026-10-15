import { createFile, MP4BoxBuffer } from 'mp4box';

const MAX_BOX = 256 * 1024 * 1024;

export class RemuxRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RemuxRefusal';
    this.reason = reason;
  }
}

function refusal(reason, message) {
  throw new RemuxRefusal(reason, message);
}

function u32(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function u64(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refusal('not-mp4', 'not-mp4: box size exceeds safe integer range');
  return Number(value);
}

function typeOf(bytes, offset = 4) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

// A file that is not MP4 has no box type to print: its first bytes are named in hex.
function found(bytes) {
  const type = typeOf(bytes);
  return /^[\x20-\x7e]{4}$/.test(type) ? `'${type}'` : `bytes 0x${[...bytes.subarray(0, 8)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function asArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function readExact(source, offset, length) {
  if (offset < 0 || length < 0 || offset + length > source.size) throw new Error(`source read outside file: ${offset}+${length}`);
  const bytes = await source.read(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error(`source returned ${bytes?.byteLength ?? 'non-byte'} bytes for ${length}`);
  return bytes;
}

function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function entriesFor(track) {
  return track.edts?.elst?.entries ?? [];
}

function editShape(track) {
  const entries = entriesFor(track);
  if (entries.length === 0) return { skip: 0, empty: 0, shape: 'none' };
  const ratesOk = entries.every((entry) => entry.media_rate_integer === 1 && entry.media_rate_fraction === 0);
  if (!ratesOk) return { invalid: `track ${track.id} edit list has a non-1 rate` };
  if (entries.length === 1 && entries[0].media_time >= 0) return { skip: entries[0].media_time, empty: 0, shape: 'one media edit' };
  if (entries.length === 2 && entries[0].media_time === -1 && entries[1].media_time >= 0) {
    return { skip: entries[1].media_time, empty: entries[0].segment_duration, shape: 'empty edit then media edit' };
  }
  return { invalid: `track ${track.id} edit list shape is ${JSON.stringify(entries)}` };
}

function trackFrom(infoTrack, sourceTrack, sourceSize, moovBytes, moovOffset, edit) {
  const samples = sourceTrack.samples ?? [];
  const stsd = sourceTrack.mdia?.minf?.stbl?.stsd;
  if (!stsd || !Number.isInteger(stsd.start) || !Number.isInteger(stsd.size)) refusal('unsupported-structure', `unsupported structure: track ${infoTrack.id} has no stsd`);
  const relative = stsd.start - moovOffset;
  if (relative < 0 || relative + stsd.size > moovBytes.length) refusal('unsupported-structure', `unsupported structure: track ${infoTrack.id} stsd is outside moov`);
  const offsets = new Float64Array(samples.length);
  const sizes = new Uint32Array(samples.length);
  const dts = new Float64Array(samples.length);
  const cto = new Int32Array(samples.length);
  const durations = new Uint32Array(samples.length);
  const sync = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    offsets[i] = sample.offset;
    sizes[i] = sample.size;
    dts[i] = sample.dts;
    cto[i] = sample.cts - sample.dts;
    durations[i] = sample.duration;
    sync[i] = sample.is_sync ? 1 : 0;
    if (!Number.isSafeInteger(sample.offset) || !Number.isSafeInteger(sample.size) || sample.offset < 0 || sample.offset + sample.size > sourceSize) {
      refusal('unsupported-structure', `unsupported structure: track ${infoTrack.id} sample ${i} exceeds the source`);
    }
  }
  return {
    id: infoTrack.id,
    type: infoTrack.type,
    codec: infoTrack.codec,
    timescale: infoTrack.timescale,
    movieTimescale: infoTrack.movie_timescale,
    offsets,
    sizes,
    dts,
    cto,
    durations,
    sync,
    stsd: new Uint8Array(moovBytes.slice(relative, relative + stsd.size)),
    language: sourceTrack.mdia.mdhd.language,
    matrix: [...sourceTrack.tkhd.matrix],
    width: sourceTrack.tkhd.width,
    height: sourceTrack.tkhd.height,
    volume: sourceTrack.tkhd.volume,
    edits: entriesFor(sourceTrack).map((entry) => ({ ...entry })),
    skip: edit.skip,
    delay: edit.empty === 0 ? 0 : Math.round(edit.empty * infoTrack.timescale / infoTrack.movie_timescale),
  };
}

function structureIssue(track, sourceTrack, sourceSize) {
  if (!sourceTrack.samples?.length) return 'has no samples';
  if (sourceTrack.mdia?.minf?.stbl?.stsd?.entries?.length !== 1) return 'has multiple sample descriptions';
  if (sourceTrack.samples.some((sample) => sample.offset + sample.size > sourceSize)) return 'has a sample outside the file';
  if (track.type === 'video' && !sourceTrack.samples[0].is_sync) return 'does not start with a sync sample';
  return null;
}

function findBox(box, name) {
  if (!box) return false;
  if (box.box_name === name) return true;
  return (box.boxes ?? []).some((child) => findBox(child, name));
}

// D13: each track's skip goes into its timestamps, plus one offset that is a whole number of
// ticks in both timescales, so no decode time is negative and neither track moves on the other.
function applyTimeline(video, audio) {
  const tracks = [video, audio].filter(Boolean);
  const common = audio ? gcd(video.timescale, audio.timescale) : video.timescale;
  let units = 0;
  for (const track of tracks) {
    const need = track.skip - track.delay - track.dts[0];
    units = Math.max(units, Math.ceil(Math.max(0, need) / (track.timescale / common)));
  }
  for (const track of tracks) track.shift = -track.skip + track.delay + units * (track.timescale / common);
  return { commonTimescale: common, timelineUnits: units };
}

// The walk is ours (OQ8): the library parses only contiguous buffers, so it is handed every
// box whole except mdat, of which it gets the header. Reading 16 bytes for an 8-byte header
// reads media data, and D11 decides every refusal before a media byte is read.
export async function readSourceIndex(source) {
  if (!source || !Number.isSafeInteger(source.size) || source.size < 0) throw new Error('source size must be a non-negative safe integer');
  if (source.size < 8) refusal('not-mp4', 'not-mp4: file is shorter than an MP4 box header');
  const mp4 = createFile();
  const top = [];
  let moovBytes = null;
  let moovOffset = 0;
  let parserError = null;
  let info = null;
  mp4.onReady = (value) => { info = value; };
  mp4.onError = (...args) => { parserError = args.filter(Boolean).join(': '); };
  let offset = 0;
  while (offset < source.size) {
    const initial = await readExact(source, offset, 8);
    let header = initial;
    const sizeField = u32(initial);
    const type = typeOf(initial);
    let headerLength = 8;
    let boxSize = sizeField;
    if (sizeField === 1) {
      const extended = await readExact(source, offset + 8, 8);
      header = new Uint8Array(16);
      header.set(initial);
      header.set(extended, 8);
      boxSize = u64(extended);
      headerLength = 16;
    } else if (sizeField === 0) {
      boxSize = source.size - offset;
    }
    if (top.length === 0 && type !== 'ftyp') refusal('not-mp4', `not-mp4: the file begins with ${found(initial)}, not an ftyp box`);
    if (boxSize < headerLength || boxSize > source.size - offset) refusal('not-mp4', `not-mp4: the box ${found(initial)} at ${offset} has an invalid size`);
    if (type !== 'mdat' && boxSize > MAX_BOX) refusal('not-mp4', `not-mp4: the box ${found(initial)} exceeds the index size limit`);
    let bytes = header;
    if (type !== 'mdat' && boxSize > headerLength) {
      const body = await readExact(source, offset + headerLength, boxSize - headerLength);
      bytes = new Uint8Array(boxSize);
      bytes.set(header);
      bytes.set(body, headerLength);
    }
    if (type === 'ftyp' && boxSize >= 12 && typeOf(bytes, 8) === 'qt  ') refusal('not-mp4', 'not-mp4: QuickTime major brand');
    try {
      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(asArrayBuffer(bytes), offset));
    } catch (error) {
      refusal('not-mp4', `not-mp4: parser rejected ${type}: ${error.message}`);
    }
    top.push({ type, offset, size: boxSize, headerLength });
    if (type === 'moov') {
      moovBytes = bytes.slice();
      moovOffset = offset;
    }
    offset += boxSize;
  }
  mp4.flush();
  if (parserError) refusal('not-mp4', `not-mp4: parser error ${parserError}`);
  if (!moovBytes || !info || !info.hasMoov) refusal('not-mp4', 'not-mp4: no moov box or movie information');
  const fragmented = top.some((box) => box.type === 'moof') || info.isFragmented || findBox(mp4.moov, 'MovieExtendsBox');
  if (fragmented) refusal('fragmented', 'fragmented: movie contains fragmentation');
  const videoInfo = info.tracks.find((track) => track.type === 'video');
  const audioInfo = info.tracks.find((track) => track.type === 'audio');
  if (!videoInfo) refusal('no-video', 'no-video: movie has no video track');
  const selected = [videoInfo, audioInfo].filter(Boolean);
  if (selected.some((track) => track.codec === 'encv' || track.codec === 'enca')) refusal('encrypted', 'encrypted: encryption is present in the media');
  if (!videoInfo.codec.startsWith('avc1.')) refusal('video-codec', `video-codec: found ${videoInfo.codec}`);
  if (audioInfo && !['mp4a.40.2', 'mp4a.40.5', 'mp4a.40.29'].includes(audioInfo.codec)) refusal('audio-codec', `audio-codec: found ${audioInfo.codec}`);
  // Only the two tracks that are written are judged: D11 drops the rest, it does not refuse them.
  const sourceTracks = selected.map((track) => {
    try {
      return { info: track, source: mp4.getTrackById(track.id) };
    } catch (error) {
      refusal('not-mp4', `not-mp4: could not read track ${track.id}: ${error.message}`);
    }
  });
  const editChecks = sourceTracks.map(({ info: track, source }) => ({ track, source, edit: editShape(source) }));
  const badEdit = editChecks.find((item) => item.edit.invalid);
  if (badEdit) refusal('edit-list', `edit-list: ${badEdit.edit.invalid}`);
  for (const { track, source: sourceTrack } of editChecks) {
    const issue = structureIssue(track, sourceTrack, source.size);
    if (issue) refusal('unsupported-structure', `unsupported structure: track ${track.id} ${issue}`);
  }
  const byId = new Map(editChecks.map((item) => [item.track.id, item]));
  const video = trackFrom(videoInfo, byId.get(videoInfo.id).source, source.size, moovBytes, moovOffset, byId.get(videoInfo.id).edit);
  const audio = audioInfo ? trackFrom(audioInfo, byId.get(audioInfo.id).source, source.size, moovBytes, moovOffset, byId.get(audioInfo.id).edit) : null;
  const dropped = info.tracks.filter((track) => !selected.includes(track)).map((track) => ({ id: track.id, type: track.type, codec: track.codec }));
  const timeline = applyTimeline(video, audio);
  return {
    size: source.size,
    movieTimescale: info.timescale,
    video,
    audio,
    tracks: [video, audio].filter(Boolean),
    dropped,
    topLevel: top,
    ...timeline,
  };
}
