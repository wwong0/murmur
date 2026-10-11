import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, 'check', 'remux-fixtures');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE ?? 'ffprobe';
const X = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '60k', '-bf', '0', '-sc_threshold', '0'];
const video = (duration) => ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=24:duration=${duration}`];
const audio = (duration, rate = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${duration}`];

const clips = [
  ['even-1s.mp4', [...video(12), ...audio(12), ...X, '-g', '24', '-keyint_min', '24', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']],
  ['varying.mp4', [...video(14), ...audio(14), ...X, '-g', '600', '-keyint_min', '600', '-force_key_frames', '0,1.5,2,5.25,6,11', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']],
  ['bframes.mp4', [...video(12), ...audio(12), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '60k', '-bf', '2', '-sc_threshold', '0', '-g', '48', '-keyint_min', '48', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']],
  ['moov-last.mp4', [...video(12), ...audio(12), ...X, '-g', '48', '-keyint_min', '48', '-c:a', 'aac', '-b:a', '32k']],
  ['video-only.mp4', [...video(12), ...X, '-g', '48', '-keyint_min', '48', '-an', '-movflags', '+faststart']],
  ['long-audio-frame.mp4', [...video(12), ...audio(12, 24000), ...X, '-g', '48', '-keyint_min', '48', '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart']],
];

const refusals = [
  ['refuse-fragmented.mp4', [...video(2), ...audio(2), ...X, '-g', '24', '-c:a', 'aac', '-b:a', '32k', '-movflags', 'frag_keyframe+empty_moov']],
  ['refuse-video-codec.mp4', [...video(2), ...audio(2), '-c:v', 'mpeg4', '-b:v', '60k', '-g', '24', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']],
  ['refuse-audio-codec.mp4', [...video(2), ...audio(2), ...X, '-g', '24', '-c:a', 'ac3', '-b:a', '64k', '-movflags', '+faststart']],
  ['refuse-no-video.mp4', [...audio(2), '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart']],
  ['refuse-encrypted.mp4', [...video(2), ...audio(2), ...X, '-g', '24', '-c:a', 'aac', '-b:a', '32k', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', '00112233445566778899aabbccddeeff', '-encryption_kid', '0123456789abcdef0123456789abcdef', '-movflags', '+faststart']],
  ['refuse-not-mp4.mkv', [...video(2), ...audio(2), ...X, '-g', '24', '-c:a', 'aac', '-b:a', '32k', '-f', 'matroska']],
  ['refuse-mov.mov', [...video(2), ...audio(2), ...X, '-g', '24', '-c:a', 'aac', '-b:a', '32k', '-f', 'mov']],
];

async function ffmpegFile(name, args) {
  const output = path.join(root, name);
  const full = ['-hide_banner', '-loglevel', 'error', '-y', ...args, output];
  await run(ffmpeg, full, { maxBuffer: 2 * 1024 * 1024 });
  return { output, command: [...full.slice(0, -1), name] };
}

async function probe(file, stream, ignoreEditList = false) {
  const args = ['-v', 'error'];
  if (ignoreEditList) args.push('-ignore_editlist', '1');
  args.push('-select_streams', stream, '-show_entries', 'stream=time_base,codec_name:packet=pts,dts,size,flags', '-of', 'json', file);
  const { stdout } = await run(ffprobe, args, { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const streamInfo = parsed.streams?.[0];
  const packets = (parsed.packets ?? []).map((packet) => [Number(packet.pts), Number(packet.dts), Number(packet.size), String(packet.flags ?? '').startsWith('K') ? 1 : 0]);
  return {
    timescale: Number(String(streamInfo?.time_base ?? '').split('/')[1]),
    codec: streamInfo?.codec_name ?? null,
    packets,
    rawFirstDts: packets[0]?.[1] ?? null,
    rawFirstPts: packets[0]?.[0] ?? null,
  };
}

async function streamHash(file, stream) {
  const args = ['-v', 'error', '-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'];
  const { stdout } = await run(ffmpeg, args, { maxBuffer: 1024 * 1024 });
  return stdout.trim().replace(/^SHA256=/, '');
}

async function table(file) {
  const streams = {};
  for (const [name, selector] of [['video', 'v:0'], ['audio', 'a:0']]) {
    try {
      const applied = await probe(file, selector);
      const raw = await probe(file, selector, true);
      streams[name] = { ...applied, rawFirstDts: raw.rawFirstDts, rawFirstPts: raw.rawFirstPts, streamSha256: await streamHash(file, selector) };
    } catch (error) {
      if (!/matches no streams|Invalid argument|does not contain any stream/i.test(error.stderr ?? error.message)) throw error;
    }
  }
  return streams;
}

async function describe(name, command) {
  const file = path.join(root, name);
  const bytes = fs.readFileSync(file);
  const streams = await table(file);
  return {
    command,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    streams,
  };
}

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const entries = [];
for (const [name, args] of [...clips, ...refusals]) {
  const result = await ffmpegFile(name, args);
  const entry = await describe(name, result.command);
  if (name === 'refuse-mov.mov' && !entry.command.includes('-f')) throw new Error('refuse-mov command missing format');
  entries.push({ name, ...entry, refusal: refusals.some(([file]) => file === name) });
}

const movProbe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:format_tags=major_brand', '-of', 'json', path.join(root, 'refuse-mov.mov')]);
const movData = JSON.parse(movProbe.stdout);
if (movData.format?.tags?.major_brand !== 'qt  ') throw new Error(`refuse-mov.mov major brand is ${JSON.stringify(movData.format?.tags?.major_brand)}`);

const manifest = { version: 1, clips: entries.filter((entry) => !entry.refusal), refusals: entries.filter((entry) => entry.refusal) };
fs.writeFileSync(path.join(root, 'fixtures.json'), `${JSON.stringify(manifest)}\n`);
console.log(`wrote ${entries.length} fixtures to ${root}`);
for (const entry of entries) console.log(`${entry.name}: ${entry.bytes} bytes`);
