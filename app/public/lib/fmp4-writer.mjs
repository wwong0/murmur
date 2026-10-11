function fourcc(value) {
  return Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
}

function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(fourcc(type), 4);
  out.set(payload, 8);
  return out;
}

function fullBox(type, version, flags, payload) {
  const body = new Uint8Array(4 + payload.length);
  const view = new DataView(body.buffer);
  view.setUint32(0, (version << 24) | flags);
  body.set(payload, 4);
  return box(type, body);
}

function join(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function i32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function matrixBytes(matrix) {
  return join(...matrix.map((value) => i32(value)));
}

function mvhd(trackCount) {
  return fullBox('mvhd', 0, 0, join(
    u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), new Uint8Array([1, 0]),
    new Uint8Array(10), matrixBytes([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]),
    new Uint8Array(24), u32(trackCount + 1)
  ));
}

function tkhd(track, id) {
  const volume = track.type === 'audio' ? Math.round((track.volume ?? 1) * 256) : 0;
  return fullBox('tkhd', 0, 3, join(
    u32(0), u32(0), u32(id), u32(0), u32(0), new Uint8Array(8),
    new Uint8Array([0, 0, 0, 0]), new Uint8Array([volume >> 8, volume & 255]),
    new Uint8Array(2), matrixBytes(track.matrix), u32(track.width ?? 0), u32(track.height ?? 0)
  ));
}

function mdhd(track) {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint32(8, track.timescale);
  view.setUint32(12, 0);
  view.setUint16(16, track.language ?? 0);
  return fullBox('mdhd', 0, 0, payload);
}

function hdlr(track) {
  const name = `${track.type === 'video' ? 'VideoHandler' : 'SoundHandler'}\0`;
  const nameBytes = new TextEncoder().encode(name);
  return fullBox('hdlr', 0, 0, join(new Uint8Array(4), fourcc(track.type === 'video' ? 'vide' : 'soun'), new Uint8Array(12), nameBytes));
}

function mediaHeader(track) {
  return track.type === 'video'
    ? fullBox('vmhd', 0, 1, new Uint8Array(8))
    : fullBox('smhd', 0, 0, new Uint8Array(4));
}

function dinf() {
  const url = fullBox('url ', 0, 1, new Uint8Array());
  const dref = fullBox('dref', 0, 0, join(u32(1), url));
  return box('dinf', dref);
}

function emptyTable(type, payload = new Uint8Array(4)) {
  return fullBox(type, 0, 0, payload);
}

function stbl(track) {
  return box('stbl', join(
    track.stsd,
    emptyTable('stts'),
    emptyTable('stsc'),
    emptyTable('stsz', new Uint8Array(8)),
    emptyTable('stco')
  ));
}

function trak(track, id) {
  const minf = box('minf', join(mediaHeader(track), dinf(), stbl(track)));
  const mdia = box('mdia', join(mdhd(track), hdlr(track), minf));
  return box('trak', join(tkhd(track, id), mdia));
}

function trex(id) {
  return fullBox('trex', 0, 0, join(u32(id), u32(1), u32(0), u32(0), u32(0)));
}

export function writeInitSegment(index) {
  const tracks = [index.video, index.audio].filter(Boolean);
  const ftyp = box('ftyp', join(fourcc('iso5'), u32(512), fourcc('iso5'), fourcc('iso6'), fourcc('mp41')));
  const mvex = box('mvex', join(...tracks.map((_, i) => trex(i + 1))));
  const moov = box('moov', join(mvhd(tracks.length), ...tracks.map((track, i) => trak(track, i + 1)), mvex));
  return join(ftyp, moov);
}

function validateTrack(track, audio = false) {
  if (!track || !Number.isSafeInteger(track.baseDecodeTime) || !(track.data instanceof Uint8Array)) throw new RangeError('invalid fragment track');
  const lengths = [track.durations?.length, track.sizes?.length, track.cto?.length ?? (audio ? 0 : track.sizes?.length), track.sync?.length ?? (audio ? 0 : track.sizes?.length)];
  if (lengths[0] !== lengths[1] || (!audio && (lengths[2] !== lengths[0] || lengths[3] !== lengths[0]))) throw new RangeError('fragment arrays have different lengths');
  if (track.data.length !== track.sizes.reduce((sum, size) => sum + size, 0)) throw new RangeError('fragment data does not match sample sizes');
}

function tfhd(id, audio) {
  return fullBox('tfhd', 0, audio ? 0x020020 : 0x020000, audio ? join(u32(id), u32(0x02000000)) : u32(id));
}

function tfdt(baseDecodeTime) {
  return fullBox('tfdt', 1, 0, u64(baseDecodeTime));
}

function trun(track, offset, audio) {
  const count = track.sizes.length;
  const version = !audio && track.cto.some((value) => value < 0) ? 1 : 0;
  const flags = audio ? 0x000301 : 0x000F01;
  const fields = [u32(count), i32(offset)];
  for (let i = 0; i < count; i += 1) {
    fields.push(u32(track.durations[i]), u32(track.sizes[i]));
    if (!audio) fields.push(u32(track.sync[i] ? 0x02000000 : 0x01010000), i32(track.cto[i]));
  }
  return fullBox('trun', version, flags, join(...fields));
}

function traf(track, id, offset, audio) {
  return box('traf', join(tfhd(id, audio), tfdt(track.baseDecodeTime), trun(track, offset, audio)));
}

export function writeFragment({ sequence, video, audio }) {
  validateTrack(video);
  if (audio && audio.sizes.length > 0) validateTrack(audio, true);
  const audioTrack = audio && audio.sizes.length > 0 ? audio : null;
  const videoData = video.data;
  const audioData = audioTrack?.data ?? new Uint8Array();
  // The moof's length does not depend on the offsets written into it, so it is built
  // once to be measured and once with them.
  const moofWith = (videoOffset, audioOffset) => box('moof', join(
    fullBox('mfhd', 0, 0, u32(sequence)),
    traf(video, 1, videoOffset, false),
    ...(audioTrack ? [traf(audioTrack, 2, audioOffset, true)] : [])
  ));
  const videoOffset = moofWith(0, 0).length + 8;
  const moof = moofWith(videoOffset, videoOffset + videoData.length);
  const mdatSize = 8 + videoData.length + audioData.length;
  if (mdatSize > 0xFFFFFFFF) throw new RangeError('fragment mdat exceeds 2^32 - 1 bytes');
  // Written straight into the fragment: a joined mdat would hold the segment twice more.
  const out = new Uint8Array(moof.length + mdatSize);
  out.set(moof);
  new DataView(out.buffer).setUint32(moof.length, mdatSize);
  out.set(fourcc('mdat'), moof.length + 4);
  out.set(videoData, videoOffset);
  out.set(audioData, videoOffset + videoData.length);
  return out;
}
