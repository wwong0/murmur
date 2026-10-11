import { DEFAULT_TARGET_SEGMENT_SECONDS, targetMillis } from './remux-settings.mjs';
import { assignAudio, planCuts } from './remux-cut-plan.mjs';
import { fileIdentity } from './file-identity.mjs';
import { writeFragment, writeInitSegment } from './fmp4-writer.mjs';
import { writeManifest, writePlaylist } from './remux-publish.mjs';
import { readSourceIndex } from './remux-index.mjs';

function outputDts(track, sample) {
  return track.dts[sample] + track.shift;
}

// One forward walk over the video samples for the whole plan: a scan per segment is
// quadratic, and a two-hour file has 1 800 segments over 172 800 samples.
function videoRanges(video, segments) {
  const ranges = [];
  let at = 0;
  for (const segment of segments) {
    while (at < video.dts.length && outputDts(video, at) < segment.startTick) at += 1;
    const from = at;
    while (at < video.dts.length && outputDts(video, at) < segment.endTick) at += 1;
    if (from === at || outputDts(video, from) !== segment.startTick) throw new RangeError('segment does not begin on a sample boundary');
    ranges.push({ from, to: at });
  }
  return ranges;
}

// D2: samples that touch in the file are read as one run, and nothing between runs is
// read, so the bytes read for a segment are exactly its payload.
async function readSegmentBytes(source, parts) {
  const samples = [];
  for (const { track, range, data } of parts) {
    let destination = 0;
    for (let i = range.from; i < range.to; i += 1) {
      samples.push({ offset: track.offsets[i], size: track.sizes[i], destination, data });
      destination += track.sizes[i];
    }
  }
  samples.sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < samples.length;) {
    const start = samples[i].offset;
    let end = start;
    let j = i;
    while (j < samples.length && samples[j].offset === end) {
      end += samples[j].size;
      j += 1;
    }
    const bytes = await source.read(start, end - start);
    if (!(bytes instanceof Uint8Array) || bytes.length !== end - start) throw new Error('source returned the wrong segment range length');
    for (let k = i; k < j; k += 1) {
      const sample = samples[k];
      sample.data.set(bytes.subarray(sample.offset - start, sample.offset - start + sample.size), sample.destination);
    }
    i = j;
  }
}

function segmentPart(track, range) {
  let bytes = 0;
  for (let i = range.from; i < range.to; i += 1) bytes += track.sizes[i];
  return { track, range, data: new Uint8Array(bytes) };
}

function fragmentTrack({ track, range, data }, video) {
  return {
    baseDecodeTime: range.from < range.to ? outputDts(track, range.from) : 0,
    durations: track.durations.subarray(range.from, range.to),
    sizes: track.sizes.subarray(range.from, range.to),
    ...(video ? { cto: track.cto.subarray(range.from, range.to), sync: track.sync.subarray(range.from, range.to) } : {}),
    data,
  };
}

// Exported so a check can hand it a wrong plan; prepare is the only product caller. A
// segment may carry its own video sample range as videoFrom and videoTo.
export async function writePlanned({ index, segments, audioRanges, source, sink }) {
  const computed = segments.some((segment) => segment.videoFrom === undefined) ? videoRanges(index.video, segments) : null;
  const sizes = [];
  for (const [i, segment] of segments.entries()) {
    const video = segmentPart(index.video, computed ? computed[i] : { from: segment.videoFrom, to: segment.videoTo });
    const audio = index.audio && audioRanges?.[i] ? segmentPart(index.audio, audioRanges[i]) : null;
    await readSegmentBytes(source, audio ? [video, audio] : [video]);
    const bytes = writeFragment({ sequence: i + 1, video: fragmentTrack(video, true), audio: audio ? fragmentTrack(audio, false) : null });
    await sink.write(`seg-${String(i).padStart(5, '0')}.m4s`, bytes);
    sizes.push(bytes.length);
  }
  return sizes;
}

// The order is the contract: a bad target throws before any read, a refusal before any
// write, and the manifest is written last because change 11-2 reads its presence as
// "complete".
export async function prepare({ source, sink, targetSeconds = DEFAULT_TARGET_SEGMENT_SECONDS }) {
  const targetMs = targetMillis(targetSeconds);
  const index = await readSourceIndex(source);
  const { video } = index;
  const keyframeTicks = [];
  for (let i = 0; i < video.sync.length; i += 1) if (video.sync[i]) keyframeTicks.push(outputDts(video, i));
  const last = video.dts.length - 1;
  const endTick = outputDts(video, last) + video.durations[last];
  const segments = planCuts({ keyframeTicks, endTick, timescale: video.timescale, targetMs });
  const audioRanges = index.audio ? assignAudio({ segments, video, audio: index.audio }) : [];
  const identity = await fileIdentity(source);
  await sink.write('init.mp4', writeInitSegment(index));
  const segmentSizes = await writePlanned({ index, segments, audioRanges, source, sink });
  await sink.write('master.m3u8', new TextEncoder().encode(writePlaylist(segments, video.timescale)));
  const manifestText = writeManifest({ index, segments, segmentSizes, targetSeconds, identity, sourceBytes: source.size });
  await sink.write('content-manifest.json', new TextEncoder().encode(manifestText));
  return JSON.parse(manifestText);
}
