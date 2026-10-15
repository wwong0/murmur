import { REMUX_FORMAT_VERSION, targetMillis } from './remux-settings.mjs';

export function segmentName(index) {
  return `seg-${String(index).padStart(5, '0')}.m4s`;
}

function seconds(segment, timescale) {
  return (segment.endTick - segment.startTick) / timescale;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function spacing(values) {
  if (values.length === 0) return { min: null, median: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (quantile) => sorted[Math.ceil(quantile * sorted.length) - 1];
  return { min: rounded(sorted[0]), median: rounded(rank(0.5)), p95: rounded(rank(0.95)), max: rounded(sorted.at(-1)) };
}

export function writePlaylist(segments, timescale) {
  const durations = segments.map((segment) => seconds(segment, timescale));
  const target = Math.ceil(Math.max(...durations));
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (const [i, duration] of durations.entries()) lines.push(`#EXTINF:${duration.toFixed(6)},`, segmentName(i));
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export function writeManifest({ index, segments, segmentSizes, targetSeconds, identity, sourceBytes = index.size }) {
  const timescale = index.video.timescale;
  const durations = segments.map((segment) => seconds(segment, timescale));
  const ticks = segments.map((segment) => segment.endTick - segment.startTick);
  const keyframeTicks = [...index.video.sync].flatMap((sync, i) => sync ? [index.video.dts[i] + index.video.shift - (index.video.dts[0] + index.video.shift)] : []);
  const keyframeTimes = keyframeTicks.map((tick) => rounded(tick / timescale));
  // The cut plan's intervals: between keyframes, and from the last keyframe to the end.
  const boundaries = [...keyframeTicks, segments.at(-1).endTick - segments[0].startTick];
  const gaps = boundaries.slice(1).map((tick, i) => (tick - boundaries[i]) / timescale);
  const targetMs = targetMillis(targetSeconds);
  const overTarget = durations.reduce((result, duration, i) => {
    if (ticks[i] * 1000 > targetMs * timescale) {
      result.count += 1;
      result.longestSeconds = Math.max(result.longestSeconds ?? 0, rounded(duration));
    }
    return result;
  }, { count: 0, longestSeconds: null });
  const sameBeforeLast = ticks.length === 1 || ticks.slice(0, -1).every((tick) => tick === ticks[0]);
  const manifest = {
    formatVersion: REMUX_FORMAT_VERSION,
    duration: rounded((segments.at(-1).endTick - segments[0].startTick) / timescale),
    segmentSeconds: sameBeforeLast ? rounded(durations[0]) : null,
    segmentCount: segments.length,
    totalBytes: segmentSizes.reduce((sum, size) => sum + size, 0),
    segmentSizes,
    segmentDurations: durations.map(rounded),
    targetSeconds,
    overTarget,
    videoTimescale: timescale,
    keyframeTicks,
    keyframeTimes,
    keyframeSpacing: spacing(gaps),
    identity,
    sourceBytes,
    tracks: { video: { codec: index.video.codec }, audio: index.audio ? { codec: index.audio.codec } : null },
    droppedTracks: index.dropped,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
