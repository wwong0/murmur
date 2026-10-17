const VIDEO_COMMAND = 'ffmpeg -i input.mp4 -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 18 -c:a copy output.mp4';
const AUDIO_COMMAND = 'ffmpeg -i input.mp4 -c:v copy -c:a aac -b:a 192k output.mp4';
const CONTAINER_COMMAND = 'ffmpeg -i input.mkv -c copy -movflags +faststart output.mp4';
const KEYFRAME_COMMAND = 'ffmpeg -i input.mp4 -c:v libx264 -crf 18 -force_key_frames "expr:gte(t,n_forced*2)" -c:a copy output.mp4';

const REASONS = {
  'video-codec': 'the video codec is not H.264',
  'audio-codec': 'the audio codec is not AAC',
  'not-mp4': 'the file is not an unfragmented MP4',
  fragmented: 'the MP4 is fragmented',
  'no-video': 'the file has no video track',
  encrypted: 'the file is encrypted',
  'edit-list': 'the file has an unsupported edit list',
  'unsupported-structure': 'the file has an unsupported structure',
};

function publishedBytes(value) {
  return value === null || value === undefined ? 'unknown' : String(value);
}

function codecCommand(refusal) {
  return typeof refusal.codec === 'string' && refusal.codec.startsWith('mp4a.')
    ? AUDIO_COMMAND
    : VIDEO_COMMAND;
}

function reasonText(refusal) {
  if (refusal.reason === 'storage') {
    return `storage: neededBytes ${publishedBytes(refusal.neededBytes)}, freeBytes ${publishedBytes(refusal.freeBytes)}`;
  }
  if (refusal.reason === 'codec-unplayable') {
    return typeof refusal.codec === 'string' && refusal.codec.startsWith('mp4a.')
      ? `the audio codec ${refusal.codec} is not playable`
      : `the video codec ${refusal.codec ?? 'unknown'} is not playable`;
  }
  return REASONS[refusal.reason] ?? `the file was refused (${refusal.reason ?? 'unknown cause'})`;
}

export function refusalHelp(refusal = {}) {
  const normalized = refusal && typeof refusal === 'object' ? refusal : {};
  let command = null;
  if (normalized.reason === 'video-codec') command = VIDEO_COMMAND;
  else if (normalized.reason === 'audio-codec') command = AUDIO_COMMAND;
  else if (normalized.reason === 'codec-unplayable') command = codecCommand(normalized);
  else if (normalized.reason === 'not-mp4' || normalized.reason === 'fragmented') command = CONTAINER_COMMAND;
  return {
    reason: reasonText(normalized),
    command,
    note: command === null ? null : 'ffmpeg is free from ffmpeg.org',
  };
}

export function keyframeNotice(manifest) {
  const spacing = manifest?.keyframeSpacing;
  const p95 = spacing?.p95;
  const target = manifest?.targetSeconds;
  if (!Number.isFinite(p95) || !Number.isFinite(target) || !(p95 > target)) return null;
  const longestSeconds = spacing.max;
  return {
    longestSeconds,
    text: `starts and seeks may wait up to about ${longestSeconds} s`,
    command: KEYFRAME_COMMAND,
  };
}
