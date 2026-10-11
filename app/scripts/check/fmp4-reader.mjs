function text(bytes, offset) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function scan(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  let offset = start;
  for (; offset < end;) {
    if (offset + 8 > end) throw new Error('truncated box header');
    const view = viewOf(bytes);
    const sizeField = view.getUint32(offset);
    const header = sizeField === 1 ? 16 : 8;
    const size = sizeField === 1 ? Number(view.getBigUint64(offset + 8)) : sizeField || end - offset;
    if (size < header || offset + size > end) throw new Error('invalid box size');
    boxes.push({ type: text(bytes, offset + 4), start: offset, size, header, body: offset + header, end: offset + size });
    offset += size;
  }
  if (offset !== end) throw new Error('box walk did not reach its end');
  return boxes;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref', 'stbl', 'mvex', 'moof', 'traf', 'edts']);

function descendants(bytes, root) {
  const children = scan(bytes, root.body, root.end);
  return children.flatMap((child) => [child, ...(CONTAINERS.has(child.type) ? descendants(bytes, child) : [])]);
}

function child(bytes, root, type) {
  return scan(bytes, root.body, root.end).find((box) => box.type === type);
}

function parseTfhd(bytes, box) {
  const view = viewOf(bytes);
  const flags = view.getUint32(box.body) & 0xFFFFFF;
  let offset = box.body + 4;
  const id = view.getUint32(offset);
  offset += 4;
  if (flags & 1) offset += 8;
  if (flags & 2) offset += 4;
  const defaults = {};
  if (flags & 8) { defaults.duration = view.getUint32(offset); offset += 4; }
  if (flags & 16) { defaults.size = view.getUint32(offset); offset += 4; }
  if (flags & 32) defaults.flags = view.getUint32(offset);
  return { id, flags, defaults };
}

function parseTfdt(bytes, box) {
  const view = viewOf(bytes);
  const version = view.getUint8(box.body);
  return version === 1 ? Number(view.getBigUint64(box.body + 4)) : view.getUint32(box.body + 4);
}

function parseTrun(bytes, box, defaults) {
  const view = viewOf(bytes);
  const version = view.getUint8(box.body);
  const flags = view.getUint32(box.body) & 0xFFFFFF;
  let offset = box.body + 4;
  const count = view.getUint32(offset);
  offset += 4;
  let dataOffset = 0;
  if (flags & 1) { dataOffset = view.getInt32(offset); offset += 4; }
  let firstFlags = defaults.flags;
  if (flags & 4) { firstFlags = view.getUint32(offset); offset += 4; }
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const duration = flags & 0x100 ? view.getUint32(offset) : defaults.duration;
    if (flags & 0x100) offset += 4;
    const size = flags & 0x200 ? view.getUint32(offset) : defaults.size;
    if (flags & 0x200) offset += 4;
    const sampleFlags = flags & 0x400 ? view.getUint32(offset) : (i === 0 ? firstFlags : defaults.flags);
    if (flags & 0x400) offset += 4;
    const cto = flags & 0x800 ? (version ? view.getInt32(offset) : view.getUint32(offset)) : 0;
    if (flags & 0x800) offset += 4;
    samples.push({ duration, size, flags: sampleFlags, cto });
  }
  return { dataOffset, samples, version, flags };
}

export function readInitSegment(bytes) {
  const boxes = scan(bytes);
  const moov = boxes.find((box) => box.type === 'moov');
  if (!moov) throw new Error('init segment has no moov');
  const tracks = [];
  for (const trak of scan(bytes, moov.body, moov.end).filter((box) => box.type === 'trak')) {
    const nested = descendants(bytes, trak);
    const tkhd = nested.find((box) => box.type === 'tkhd');
    const mdhd = nested.find((box) => box.type === 'mdhd');
    const hdlr = nested.find((box) => box.type === 'hdlr');
    const stsd = nested.find((box) => box.type === 'stsd');
    const view = viewOf(bytes);
    tracks.push({
      id: view.getUint32(tkhd.body + 12),
      type: text(bytes, hdlr.body + 8),
      timescale: view.getUint32(mdhd.body + 12),
      stsd: bytes.slice(stsd.start, stsd.end),
    });
  }
  return { boxes, moov, tracks, hasEditList: descendants(bytes, moov).some((box) => box.type === 'edts'), trex: descendants(bytes, moov).filter((box) => box.type === 'trex') };
}

export function readFragment(bytes) {
  const boxes = scan(bytes);
  const moof = boxes.find((box) => box.type === 'moof');
  const mdat = boxes.find((box) => box.type === 'mdat');
  if (!moof || !mdat) throw new Error('fragment needs moof and mdat');
  const mfhd = child(bytes, moof, 'mfhd');
  const sequence = viewOf(bytes).getUint32(mfhd.body + 4);
  const tracks = [];
  for (const traf of scan(bytes, moof.body, moof.end).filter((box) => box.type === 'traf')) {
    const tfhdBox = child(bytes, traf, 'tfhd');
    const tfdtBox = child(bytes, traf, 'tfdt');
    const trunBox = child(bytes, traf, 'trun');
    const header = parseTfhd(bytes, tfhdBox);
    const trun = parseTrun(bytes, trunBox, header.defaults);
    const first = moof.start + trun.dataOffset;
    let position = first;
    const samples = trun.samples.map((sample) => {
      const out = { ...sample, offset: position };
      position += sample.size;
      return out;
    });
    tracks.push({ id: header.id, baseDecodeTime: parseTfdt(bytes, tfdtBox), dataOffset: trun.dataOffset, samples, data: bytes.slice(mdat.body, mdat.end) });
  }
  return { bytes, boxes, moof, mdat, sequence, tracks };
}

export function readFragments(bytes) {
  const boxes = scan(bytes);
  const fragments = [];
  for (let i = 0; i < boxes.length; i += 1) {
    if (boxes[i].type !== 'moof') continue;
    const mdat = boxes.slice(i + 1).find((box) => box.type === 'mdat');
    if (!mdat) throw new Error('fragment has no mdat');
    const fragment = bytes.slice(boxes[i].start, mdat.end);
    fragments.push(readFragment(fragment));
  }
  return fragments;
}

export const readInit = readInitSegment;
export const readFragmentBoxes = readFragment;
