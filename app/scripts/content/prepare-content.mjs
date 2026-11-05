#!/usr/bin/env node
// scripts/content/prepare-content.mjs — `npm run content`
//
// Produces the HLS content the app serves, in app/content/ (14d design.md D1).
// Two modes:
//   --synth          synthesize a deterministic test video of CONTENT_SECONDS
//                    via ffmpeg lavfi sources and encode it. It must outlast the
//                    p2p library's prefetch window, or peers download the whole
//                    file at once and scarcity is never tested.
//   --input <file>   remux an existing file into fMP4 HLS with `-c copy`,
//                    never transcoding. Fails loudly on incompatible codecs.
//
// Output: master.m3u8, init.mp4, seg-XXXXX.m4s, content-manifest.json. The
// directory is cleaned and recreated each run, so the clean refuses a directory
// this generator did not write — the legacy content above all (D1).
// Needs ffmpeg and ffprobe on the path. APP_CONTENT_FONT names the burned-in
// timecode's font file (D2).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MEDIA_DIR } from '../../server/media-dir.mjs';

const CONTENT_DIR = DEFAULT_MEDIA_DIR;
const ROOT = path.dirname(CONTENT_DIR);
// The legacy content's segment and duration values, carried as constants.
export const SEGMENT_SECONDS = 4;
export const CONTENT_SECONDS = 7_200;
// What a fresh generation calls itself: new content, never the legacy identity,
// which is known by its numbers (D2).
export const CONTENT_IDENTITY = Object.freeze({ synth: 'app-content-synth-v1', input: 'app-content-remux-v1' });

const SYNTH_TARGET_BITRATE_KBPS = 2500; // ~2.5 Mbps -> ~4s segments ~1.2MB
const SYNTH_AUDIO_BITRATE_KBPS = 128;
const DURATION_TOLERANCE_FRACTION = 0.01; // measured duration must be within ~1% of contentSeconds
const SEGMENT_COUNT_TOLERANCE_FRACTION = 0.01; // segment count must be within ~1% of contentSeconds/segmentSeconds
const DISK_SPACE_SAFETY_FACTOR = 1.3; // margin over the estimated output size before we refuse to start

function log(...args) {
  console.log('[prepare-content]', ...args);
}

function fail(message) {
  console.error(`\n[prepare-content] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { mode: 'synth', input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--synth') {
      args.mode = 'synth';
    } else if (a === '--input') {
      args.mode = 'input';
      args.input = argv[++i];
      if (!args.input) fail('--input requires a file path argument');
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage:\n' +
          '  npm run content -- --synth          (default)\n' +
          '  npm run content -- --input <file.mp4>\n'
      );
      process.exit(0);
    } else {
      fail(`Unrecognized argument: ${a}`);
    }
  }
  return args;
}

function runCommand(cmd, args, { label } = {}) {
  return new Promise((resolve, reject) => {
    log(`running: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    const tailLimit = 8000;

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > tailLimit) {
        stderrTail = stderrTail.slice(stderrTail.length - tailLimit);
      }
      // ffmpeg writes progress (frame=, time=, etc.) to stderr; surface it so
      // the run doesn't look hung during the (slow) synth encode.
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stderrTail });
      } else {
        reject(
          new Error(
            `${label ?? cmd} exited with code ${code}.\n--- last stderr ---\n${stderrTail}`
          )
        );
      }
    });
  });
}

async function captureCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
  });
}

async function getFfmpegVersion() {
  try {
    const { stdout } = await captureCommand('ffmpeg', ['-version']);
    const firstLine = stdout.split('\n')[0].trim();
    return firstLine || 'unknown';
  } catch {
    return 'unknown';
  }
}

function estimateOutputBytes(mode, contentSeconds, inputSizeBytes) {
  if (mode === 'synth') {
    const totalKbps = SYNTH_TARGET_BITRATE_KBPS + SYNTH_AUDIO_BITRATE_KBPS;
    return (totalKbps * 1000 / 8) * contentSeconds;
  }
  // remux is -c copy, so output size is close to input size.
  return inputSizeBytes;
}

async function checkDiskSpace({ mode, contentSeconds, inputPath }) {
  let inputSizeBytes = 0;
  if (mode === 'input') {
    try {
      const stat = await fs.stat(path.resolve(inputPath));
      inputSizeBytes = stat.size;
    } catch {
      // --input existence/validity is checked properly inside remux(); skip
      // the size-based estimate here rather than duplicating that error.
    }
  }

  const estimatedBytes = estimateOutputBytes(mode, contentSeconds, inputSizeBytes);
  const requiredBytes = estimatedBytes * DISK_SPACE_SAFETY_FACTOR;

  let freeBytes;
  try {
    const stats = await fs.statfs(ROOT);
    freeBytes = stats.bavail * stats.bsize;
  } catch (err) {
    log(`warning: could not determine free disk space (${err.message}); skipping disk space guard`);
    return;
  }

  const gb = (n) => (n / 1e9).toFixed(1);
  log(`disk space check: ${gb(freeBytes)} GB free on ${ROOT}, need ~${gb(requiredBytes)} GB (estimated output ~${gb(estimatedBytes)} GB + ${Math.round((DISK_SPACE_SAFETY_FACTOR - 1) * 100)}% margin)`);

  if (freeBytes < requiredBytes) {
    fail(
      `Insufficient free disk space on the drive containing ${ROOT}: ` +
        `${gb(freeBytes)} GB free, need ~${gb(requiredBytes)} GB ` +
        `(estimated output ~${gb(estimatedBytes)} GB for ${mode === 'synth' ? `${contentSeconds}s of synth content` : `remuxing ${inputPath}`}, ` +
        `plus ${Math.round((DISK_SPACE_SAFETY_FACTOR - 1) * 100)}% safety margin). Free up space and retry.`
    );
  }
}

// Why a directory may not be cleaned, or null. Only an empty directory or one
// whose manifest carries an identity this generator writes.
export function cleanRefusal(dir) {
  if (!fssync.existsSync(dir) || fssync.readdirSync(dir).length === 0) return null;
  let identity;
  try {
    identity = JSON.parse(fssync.readFileSync(path.join(dir, 'content-manifest.json'), 'utf8')).identity;
  } catch {
    return `${dir} holds files and no readable content-manifest.json`;
  }
  if (Object.values(CONTENT_IDENTITY).includes(identity)) return null;
  return `${dir} holds content this generator did not write (identity ${JSON.stringify(identity ?? null)})`;
}

async function cleanContentDir() {
  const refusal = cleanRefusal(CONTENT_DIR);
  if (refusal) fail(`refusing to delete it: ${refusal}. Move it aside or point APP_MEDIA_DIR at it instead.`);
  log(`cleaning ${CONTENT_DIR}`);
  await fs.rm(CONTENT_DIR, { recursive: true, force: true });
  await fs.mkdir(CONTENT_DIR, { recursive: true });
}

// The drawtext font option (D2). APP_CONTENT_FONT names a file; unset, Windows
// takes Arial from its font directory and elsewhere fontconfig resolves Sans.
// A drive-letter colon collides with the filter's option separator: quoting and
// backslash-escaping the colon together survive the filtergraph parser.
export function drawtextFont({ platform = process.platform, env = process.env } = {}) {
  const file = env.APP_CONTENT_FONT
    ?? (platform === 'win32' ? `${env.WINDIR ?? 'C:/Windows'}/Fonts/arial.ttf` : null);
  if (file === null) return 'font=Sans';
  return `fontfile='${toFfmpegPath(file).replace(/:/g, '\\:')}'`;
}

// The manifest a run writes: its identity beside its measured bytes (D2).
export function contentManifest({ mode, mediaDuration, segmentSeconds, sizes, startedAt, ffmpegVersion }) {
  return {
    identity: CONTENT_IDENTITY[mode],
    duration: mediaDuration,
    segmentSeconds,
    segmentCount: sizes.length,
    totalBytes: sizes.reduce((a, b) => a + b, 0),
    segmentSizes: sizes,
    generatedAt: startedAt,
    mode,
    ffmpegVersion,
  };
}

function toFfmpegPath(p) {
  // ffmpeg on Windows is fine with forward slashes; avoids backslash-escaping
  // headaches inside filter strings and drawtext fontfile args.
  return p.replace(/\\/g, '/');
}

function buildHlsOutputArgs(segmentSeconds) {
  const initPath = path.join(CONTENT_DIR, 'init.mp4');
  const segPattern = path.join(CONTENT_DIR, 'seg-%05d.m4s');
  const playlistPath = path.join(CONTENT_DIR, 'master.m3u8');
  return {
    initPath,
    segPattern,
    playlistPath,
    args: [
      '-f', 'hls',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_playlist_type', 'vod',
      '-hls_time', String(segmentSeconds),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', toFfmpegPath(segPattern),
      toFfmpegPath(playlistPath),
    ],
  };
}

async function synthesize(segmentSeconds, contentSeconds) {
  const { args: hlsArgs } = buildHlsOutputArgs(segmentSeconds);

  // testsrc2: readable moving pattern; drawtext burns in a large timecode
  // (using the source's own pts) so tab-to-tab offsets are eyeballable.
  // GOP aligned to segment boundaries (keyint = segmentSeconds * fps) so each
  // HLS segment starts on a keyframe, as fmp4 HLS requires.
  const fps = 24;
  const width = 1280;
  const height = 720;
  const gop = segmentSeconds * fps;

  const drawtext =
    `drawtext=${drawtextFont()}:` +
    `text='%{pts\\:hms}':fontsize=96:fontcolor=white:` +
    `borderw=6:bordercolor=black@0.8:x=(w-text_w)/2:y=h-th-40`;

  const videoFilter = `testsrc2=size=${width}x${height}:rate=${fps}:duration=${contentSeconds},${drawtext},format=yuv420p`;

  const args = [
    '-y',
    '-hide_banner',
    '-progress', 'pipe:2',
    '-f', 'lavfi',
    '-i', `${videoFilter}`,
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=48000:duration=${contentSeconds}`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-b:v', `${SYNTH_TARGET_BITRATE_KBPS}k`,
    '-maxrate', `${Math.round(SYNTH_TARGET_BITRATE_KBPS * 1.2)}k`,
    '-bufsize', `${SYNTH_TARGET_BITRATE_KBPS * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-shortest',
    ...hlsArgs,
  ];

  log(`synthesizing ${contentSeconds}s test video (${width}x${height}@${fps}fps, ~${SYNTH_TARGET_BITRATE_KBPS}kbps) -- this will take a while, progress below`);
  await runCommand('ffmpeg', args, { label: 'ffmpeg (synth encode)' });
}

async function remux(inputPath, segmentSeconds) {
  const resolvedInput = path.resolve(inputPath);
  if (!fssync.existsSync(resolvedInput)) {
    fail(`--input file does not exist: ${resolvedInput}`);
  }

  // Probe codecs first so we can fail loudly and explain, rather than let
  // ffmpeg -c copy silently produce a broken/incompatible fmp4 HLS output.
  let probe;
  try {
    const { stdout } = await captureCommand('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      toFfmpegPath(resolvedInput),
    ]);
    probe = JSON.parse(stdout);
  } catch (err) {
    fail(`ffprobe failed to inspect --input file: ${err.message}`);
  }

  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) fail(`--input file has no video stream: ${resolvedInput}`);

  const FMP4_COMPATIBLE_VIDEO = new Set(['h264', 'hevc', 'vp9', 'av1']);
  const FMP4_COMPATIBLE_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac']);

  if (!FMP4_COMPATIBLE_VIDEO.has(videoStream.codec_name)) {
    fail(
      `--input video codec '${videoStream.codec_name}' is not compatible with fMP4 HLS remux ` +
        `(supported: ${[...FMP4_COMPATIBLE_VIDEO].join(', ')}). ` +
        `Refusing to silently transcode -- re-encode the source yourself first, or use --synth.`
    );
  }
  if (audioStream && !FMP4_COMPATIBLE_AUDIO.has(audioStream.codec_name)) {
    fail(
      `--input audio codec '${audioStream.codec_name}' is not compatible with fMP4 HLS remux ` +
        `(supported: ${[...FMP4_COMPATIBLE_AUDIO].join(', ')}). ` +
        `Refusing to silently transcode -- re-encode the source yourself first, or use --synth.`
    );
  }

  const { args: hlsArgs } = buildHlsOutputArgs(segmentSeconds);
  const args = [
    '-y',
    '-hide_banner',
    '-progress', 'pipe:2',
    '-i', toFfmpegPath(resolvedInput),
    '-map', '0:v:0',
    ...(audioStream ? ['-map', '0:a:0'] : []),
    '-c', 'copy',
    ...hlsArgs,
  ];

  log(`remuxing (no transcode, -c copy) ${resolvedInput}`);
  await runCommand('ffmpeg', args, { label: 'ffmpeg (remux)' });
}

async function probeOutputDuration() {
  const playlistPath = path.join(CONTENT_DIR, 'master.m3u8');
  try {
    const { stdout } = await captureCommand('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      toFfmpegPath(playlistPath),
    ]);
    const data = JSON.parse(stdout);
    const duration = parseFloat(data?.format?.duration ?? 'NaN');
    return duration;
  } catch (err) {
    fail(`ffprobe failed to inspect generated playlist: ${err.message}`);
  }
}

function median(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listSegmentFiles() {
  const files = await fs.readdir(CONTENT_DIR);
  return files.filter((f) => /^seg-\d+\.m4s$/.test(f)).sort();
}

async function collectSegmentSizes() {
  // ffmpeg's hls muxer opens/closes each segment file individually; on
  // Windows the directory listing has occasionally lagged one beat behind
  // the child process's 'close' event for the last few segments. Poll until
  // the listing is stable (unchanged across two reads) before trusting it.
  let segFiles = await listSegmentFiles();
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(300);
    const again = await listSegmentFiles();
    if (again.length === segFiles.length) {
      segFiles = again;
      break;
    }
    segFiles = again;
  }

  const sizes = [];
  for (const f of segFiles) {
    const stat = await fs.stat(path.join(CONTENT_DIR, f));
    sizes.push(stat.size);
  }
  return { segFiles, sizes };
}

async function validateAndSummarize({ segmentSeconds, contentSeconds, mode, startedAt }) {
  const playlistPath = path.join(CONTENT_DIR, 'master.m3u8');
  const initPath = path.join(CONTENT_DIR, 'init.mp4');

  if (!fssync.existsSync(playlistPath)) {
    fail(`Expected playlist not found: ${playlistPath}`);
  }
  if (!fssync.existsSync(initPath)) {
    fail(`Expected fmp4 init segment not found: ${initPath}`);
  }

  const playlistText = await fs.readFile(playlistPath, 'utf8');
  const trimmed = playlistText.trimEnd();
  if (!trimmed.endsWith('#EXT-X-ENDLIST')) {
    fail(`Playlist does not end with #EXT-X-ENDLIST -- generation likely incomplete: ${playlistPath}`);
  }

  const { segFiles, sizes } = await collectSegmentSizes();
  if (segFiles.length === 0) {
    fail(`No media segments (seg-*.m4s) found in ${CONTENT_DIR}`);
  }

  const expectedSegmentCount = contentSeconds / segmentSeconds;
  const segmentCountDelta = Math.abs(segFiles.length - expectedSegmentCount) / expectedSegmentCount;
  if (segmentCountDelta > SEGMENT_COUNT_TOLERANCE_FRACTION) {
    fail(
      `Segment count ${segFiles.length} deviates from expected ${expectedSegmentCount} ` +
        `(contentSeconds=${contentSeconds} / segmentSeconds=${segmentSeconds}) by ` +
        `${(segmentCountDelta * 100).toFixed(2)}%, outside the ${(SEGMENT_COUNT_TOLERANCE_FRACTION * 100).toFixed(0)}% tolerance. ` +
        `Content must cover the full configured duration -- short/miscounted content would ` +
        `silently invalidate the scarcity model (peers could hold the whole timeline) and corrupt results.`
    );
  }

  const mediaDuration = await probeOutputDuration();
  const durationDelta = Number.isFinite(mediaDuration)
    ? Math.abs(mediaDuration - contentSeconds) / contentSeconds
    : Infinity;
  if (durationDelta > DURATION_TOLERANCE_FRACTION) {
    fail(
      `Actual media duration ${mediaDuration}s deviates from configured contentSeconds=${contentSeconds}s by ` +
        `${Number.isFinite(durationDelta) ? (durationDelta * 100).toFixed(2) + '%' : 'N/A'}, outside the ` +
        `${(DURATION_TOLERANCE_FRACTION * 100).toFixed(0)}% tolerance.`
    );
  }

  const sortedSizes = [...sizes].sort((a, b) => a - b);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const minSize = sortedSizes[0];
  const maxSize = sortedSizes[sortedSizes.length - 1];
  const medSize = median(sortedSizes);

  const playlistLines = playlistText.split('\n');
  const first15 = playlistLines.slice(0, 15);

  const ffmpegVersion = await getFfmpegVersion();

  const manifest = contentManifest({ mode, mediaDuration, segmentSeconds, sizes, startedAt, ffmpegVersion });

  await fs.writeFile(
    path.join(CONTENT_DIR, 'content-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  log('=== SUMMARY ===');
  log(`mode:            ${mode}`);
  log(`duration:        ${mediaDuration.toFixed(3)}s`);
  log(`segment count:   ${segFiles.length}`);
  log(`segment size:    min=${minSize} median=${medSize} max=${maxSize} bytes`);
  log(`total bytes:     ${totalBytes}`);
  log(`playlist (first 15 lines):`);
  for (const line of first15) log(`  ${line}`);
  log('=== END SUMMARY ===');

  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const segmentSeconds = SEGMENT_SECONDS;
  const contentSeconds = CONTENT_SECONDS;
  log(`segmentSeconds = ${segmentSeconds}, contentSeconds = ${contentSeconds}`);

  await checkDiskSpace({ mode: args.mode, contentSeconds, inputPath: args.input });

  await cleanContentDir();

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (args.mode === 'synth') {
    await synthesize(segmentSeconds, contentSeconds);
  } else {
    await remux(args.input, segmentSeconds);
  }

  const elapsedSeconds = (Date.now() - t0) / 1000;
  log(`ffmpeg finished in ${elapsedSeconds.toFixed(1)}s`);

  await validateAndSummarize({ segmentSeconds, contentSeconds, mode: args.mode, startedAt });

  log(`done. content written to ${CONTENT_DIR}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    fail(err.stack || err.message || String(err));
  });
}
