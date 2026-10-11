import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { readFragment, readInitSegment } from './check/fmp4-reader.mjs';
import { seedAudioOffset, seedEditList } from './check/remux-rig.mjs';

function optionValue(args, index) {
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`missing value for ${args[index]}`);
  return args[index + 1];
}

function parseArgs(args) {
  const mode = args[0];
  if (mode === 'layer2') {
    const options = { mode, maxRSS: null };
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--source') { options.source = optionValue(args, i); i += 1; }
      else if (args[i] === '--output') { options.output = optionValue(args, i); i += 1; }
      else if (args[i] === '--label') { options.label = optionValue(args, i); i += 1; }
      else if (args[i] === '--report') { options.report = optionValue(args, i); i += 1; }
      else if (args[i] === '--max-rss') { options.maxRSS = Number(optionValue(args, i)); i += 1; }
      else throw new Error(`unknown option ${args[i]}`);
    }
    if (!options.source || !options.output || !options.label || !options.report) throw new Error('layer2 needs source, output, label and report');
    if (options.maxRSS !== null && !Number.isFinite(options.maxRSS)) throw new Error('max-rss must be a number');
    return options;
  }
  if (mode === 'layer3') {
    const options = { mode };
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--reference') { options.reference = optionValue(args, i); i += 1; }
      else if (args[i] === '--output') { options.output = optionValue(args, i); i += 1; }
      else if (args[i] === '--report') { options.report = optionValue(args, i); i += 1; }
      else throw new Error(`unknown option ${args[i]}`);
    }
    if (!options.reference || !options.output || !options.report) throw new Error('layer3 needs reference, output and report');
    return options;
  }
  if (mode === '--seed') throw new Error('seed needs a layer2 source and destination');
  throw new Error('mode must be layer2 or layer3');
}

function parseSeedArgs(args) {
  const mode = args[1];
  if (!['audio-offset', 'edit-list'].includes(mode)) throw new Error('seed must be audio-offset or edit-list');
  const options = { mode };
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === '--from') { options.from = optionValue(args, i); i += 1; }
    else if (args[i] === '--to') { options.to = optionValue(args, i); i += 1; }
    else throw new Error(`unknown option ${args[i]}`);
  }
  if (!options.from || !options.to) throw new Error('seed needs from and to directories');
  return options;
}

function packetRow(line) {
  const fields = line.trim().split(',');
  if (fields.length < 5 || !fields[4].startsWith('SHA256:')) throw new Error('ffprobe returned a malformed packet row');
  const [pts, dts, size] = fields.slice(0, 3).map(Number);
  if (![pts, dts, size].every(Number.isSafeInteger)) throw new Error('ffprobe returned a non-integer packet field');
  return [pts, dts, size, fields[3].startsWith('K') ? 1 : 0, fields[4].slice(7).toLowerCase()];
}

async function runFfprobe(args, inputFiles = null, packets = false) {
  const child = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rows = [];
  const text = [];
  const errors = [];
  let parseError = null;
  let spawnError = null;
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });
  const readStdout = (async () => {
    for await (const line of stdout) {
      const value = line.trim();
      if (!value) continue;
      try {
        if (packets) rows.push(packetRow(value));
        else text.push(value);
      } catch (error) {
        parseError = error;
      }
    }
  })();
  const readStderr = (async () => {
    for await (const line of stderr) if (line.trim()) errors.push(line.trim());
  })();
  child.once('error', (error) => { spawnError = error; });
  const writeInput = async () => {
    if (!inputFiles) { child.stdin.end(); return; }
    try {
      for (const filename of inputFiles) {
        const stream = fs.createReadStream(filename, { highWaterMark: 1024 * 1024 });
        for await (const chunk of stream) {
          if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
        }
      }
      child.stdin.end();
    } catch {
      child.stdin.destroy();
    }
  };
  await writeInput();
  const code = await new Promise((resolve) => child.once('close', resolve));
  await Promise.all([readStdout, readStderr]);
  return { code, rows, text, errors, parseError, spawnError };
}

function validProbe(result) {
  return !result.spawnError && result.code === 0 && !result.errors.length && !result.parseError;
}

async function probePackets(filename, stream) {
  return runFfprobe(['-v', 'error', '-select_streams', stream, '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,size,flags,data_hash', '-of', 'csv=p=0', filename], null, true);
}

async function probeText(filename, entries, stream) {
  return runFfprobe(['-v', 'error', '-select_streams', stream, '-show_entries', `stream=${entries}`, '-of', 'default=nk=1:nw=1', filename]);
}

async function outputFiles(directory) {
  const playlistName = path.join(directory, 'master.m3u8');
  if (!fs.existsSync(playlistName)) throw new Error('output playlist is missing');
  const playlist = fs.readFileSync(playlistName, 'utf8');
  const names = playlist.split(/\r?\n/).filter((line) => /^seg-\d+\.m4s$/.test(line));
  if (!names.length || !fs.existsSync(path.join(directory, 'init.mp4'))) throw new Error('output segments are missing');
  return [path.join(directory, 'init.mp4'), ...names.map((name) => path.join(directory, name))];
}

function writeReport(filename, report) {
  fs.writeFileSync(path.resolve(filename), `${JSON.stringify(report, null, 2)}\n`);
}

function streamComparison(source, output, ignored, name) {
  const result = { count: output.length, constant: { pts: null, dts: null }, firstFailure: null };
  const fail = (index, reason) => {
    if (!result.firstFailure) result.firstFailure = { stream: name, index, reason };
  };
  for (let i = 0; i < Math.min(output.length, ignored.length); i += 1) {
    if (JSON.stringify(output[i]) !== JSON.stringify(ignored[i])) fail(i, 'the two readings differ');
  }
  if (output.length !== ignored.length) fail(Math.min(output.length, ignored.length), 'the two readings differ');
  if (source.length !== output.length) return { ...result, evidence: 'packet count differs' };
  let ptsConstant = null;
  let dtsConstant = null;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i][2] !== output[i][2] || source[i][3] !== output[i][3] || source[i][4] !== output[i][4]) fail(i, 'packet data differs');
    const pts = output[i][0] - source[i][0];
    const dts = output[i][1] - source[i][1];
    if (ptsConstant === null) ptsConstant = pts;
    if (dtsConstant === null) dtsConstant = dts;
    if (pts !== ptsConstant) fail(i, 'presentation offset differs');
    if (dts !== dtsConstant) fail(i, 'decode offset differs');
  }
  // One offset, not two: a shift of presentation against decode time is a moved frame.
  if (ptsConstant !== dtsConstant) fail(0, 'presentation and decode offsets differ');
  result.constant = { pts: ptsConstant, dts: dtsConstant };
  return result;
}

function layer2Report(label, version, audioProfile, audioCodec, video, audio, maxRSS) {
  return {
    label,
    streams: { video, audio },
    crossStreamSeconds: null,
    firstFailure: null,
    failure: null,
    verdict: 'fail',
    ffprobeVersion: version,
    audioProfile,
    audioCodec,
    ...(maxRSS === null ? {} : { maxRSS }),
  };
}

function evidenceReport(label, reason, version = null, audioProfile = null, audioCodec = null, maxRSS = null) {
  return {
    label,
    streams: { video: { count: 0, constant: { pts: null, dts: null }, firstFailure: null }, audio: null },
    crossStreamSeconds: null,
    firstFailure: null,
    failure: reason,
    verdict: 'evidence-failure',
    ffprobeVersion: version,
    audioProfile,
    audioCodec,
    ...(maxRSS === null ? {} : { maxRSS }),
  };
}

async function compareLayer2(options) {
  const versionProbe = await runFfprobe(['-version']);
  const version = validProbe(versionProbe) ? versionProbe.text[0] : null;
  let output;
  try {
    const files = await outputFiles(options.output);
    output = {
      files,
      manifest: JSON.parse(fs.readFileSync(path.join(options.output, 'content-manifest.json'), 'utf8')),
    };
  } catch {
    const report = evidenceReport(options.label, 'output is incomplete', version, null, null, options.maxRSS);
    writeReport(options.report, report);
    return { report, exit: 2 };
  }
  const piped = (stream, ignoreEditList) => runFfprobe(['-v', 'error', ...(ignoreEditList ? ['-ignore_editlist', '1'] : []), '-select_streams', stream, '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,size,flags,data_hash', '-of', 'csv=p=0', '-i', 'pipe:0'], output.files, true);
  // The eight readings share nothing and a 2.4 GB reading takes minutes, so they run together.
  const [sourceVideoMeta, sourceAudioMeta, sourceVideo, sourceAudio, outputVideo, outputAudio, outputVideoIgnored, outputAudioIgnored] = await Promise.all([
    probeText(options.source, 'time_base', 'v:0'),
    probeText(options.source, 'profile,time_base', 'a:0'),
    probePackets(options.source, 'v:0'),
    probePackets(options.source, 'a:0'),
    piped('v:0', false),
    piped('a:0', false),
    piped('v:0', true),
    piped('a:0', true),
  ]);
  const audioProfile = sourceAudioMeta.text.find((value) => !value.includes('/')) ?? null;
  const audioTimebase = sourceAudioMeta.text.find((value) => value.includes('/')) ?? null;
  const sourceAudioExists = Boolean(audioTimebase);
  const audioCodec = output.manifest.tracks?.audio?.codec ?? null;
  const commonEvidence = [versionProbe, sourceVideoMeta, sourceAudioMeta, sourceVideo, sourceAudio, outputVideo, outputAudio, outputVideoIgnored, outputAudioIgnored];
  if (!commonEvidence.every(validProbe) || !sourceVideoMeta.text[0]?.includes('/')) {
    const failed = commonEvidence.find((probe) => !validProbe(probe));
    const reason = failed?.spawnError ? 'ffprobe is unavailable' : failed?.errors?.length ? 'ffprobe wrote to standard error' : failed?.parseError ? 'ffprobe packet table is malformed' : 'ffprobe evidence is incomplete';
    const report = evidenceReport(options.label, reason, version, audioProfile, audioCodec, options.maxRSS);
    writeReport(options.report, report);
    return { report, exit: 2 };
  }
  if (!sourceVideo.rows.length || sourceVideo.rows.length !== outputVideo.rows.length || sourceVideo.rows.length !== outputVideoIgnored.rows.length) {
    const report = evidenceReport(options.label, 'packet count differs', version, audioProfile, audioCodec, options.maxRSS);
    writeReport(options.report, report);
    return { report, exit: 2 };
  }
  if (sourceAudioExists && (!sourceAudio.rows.length || sourceAudio.rows.length !== outputAudio.rows.length || sourceAudio.rows.length !== outputAudioIgnored.rows.length)) {
    const report = evidenceReport(options.label, 'packet count differs', version, audioProfile, audioCodec, options.maxRSS);
    writeReport(options.report, report);
    return { report, exit: 2 };
  }
  if (!sourceAudioExists && (sourceAudio.rows.length || outputAudio.rows.length || outputAudioIgnored.rows.length)) {
    const report = evidenceReport(options.label, 'packet count differs', version, audioProfile, audioCodec, options.maxRSS);
    writeReport(options.report, report);
    return { report, exit: 2 };
  }
  const videoScale = Number(sourceVideoMeta.text[0].split('/')[1]);
  const audioScale = audioTimebase ? Number(audioTimebase.split('/')[1]) : null;
  const video = streamComparison(sourceVideo.rows, outputVideo.rows, outputVideoIgnored.rows, 'video');
  const audio = sourceAudioExists ? streamComparison(sourceAudio.rows, outputAudio.rows, outputAudioIgnored.rows, 'audio') : null;
  const report = layer2Report(options.label, version, audioProfile, audioCodec, video, audio, options.maxRSS);
  const constants = [video, audio].filter(Boolean);
  const firstFailure = constants.map((stream) => stream.firstFailure).find(Boolean);
  if (firstFailure) { report.firstFailure = firstFailure; report.failure = firstFailure.reason; }
  if (audio) {
    const numerator = video.constant.dts * audioScale - audio.constant.dts * videoScale;
    report.crossStreamSeconds = numerator === 0 ? 0 : Math.abs(numerator) / (videoScale * audioScale);
    const tolerance = 1 / videoScale + 1 / audioScale;
    if (report.crossStreamSeconds > tolerance && !report.failure) {
      report.firstFailure = { stream: 'audio', index: null, reason: 'cross-stream offset' };
      report.failure = 'cross-stream offset';
    }
  } else report.crossStreamSeconds = 0;
  if (!report.failure) { report.verdict = 'pass'; return writeResult(options, report, 0); }
  return writeResult(options, report, 1);
}

function writeResult(options, report, exit) {
  writeReport(options.report, report);
  return { report, exit };
}

function copySeed(options) {
  const destination = path.resolve(options.to);
  if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)) throw new Error('seed destination already exists and is not empty');
  fs.mkdirSync(destination, { recursive: true });
  const files = new Map();
  for (const entry of fs.readdirSync(options.from, { withFileTypes: true })) if (entry.isFile()) files.set(entry.name, new Uint8Array(fs.readFileSync(path.join(options.from, entry.name))));
  const doctored = options.mode === 'audio-offset' ? seedAudioOffset(files) : seedEditList(files);
  for (const [name, bytes] of doctored) fs.writeFileSync(path.join(destination, name), bytes);
}

function playlistDurations(filename) {
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#EXTINF:'));
}

function sampleRows(fragment, id) {
  const track = fragment.tracks.find((candidate) => candidate.id === id);
  if (!track) return [];
  let dts = track.baseDecodeTime;
  return track.samples.map((sample) => {
    const bytes = fragment.bytes.slice(sample.offset, sample.offset + sample.size);
    const row = { size: sample.size, bytes, dts, pts: dts + sample.cto };
    dts += sample.duration;
    return row;
  });
}

function digestSamples(samples) {
  const hash = crypto.createHash('sha256');
  for (const sample of samples) hash.update(sample.bytes);
  return hash.digest('hex');
}

function segmentEvidence(segment, id) {
  const samples = sampleRows(segment, id);
  return { count: samples.length, bytes: samples.reduce((sum, sample) => sum + sample.size, 0), sha256: digestSamples(samples) };
}

async function loadDirectory(directory) {
  const files = await outputFiles(directory);
  const names = fs.readFileSync(path.join(directory, 'master.m3u8'), 'utf8').split(/\r?\n/).filter((line) => /^seg-\d+\.m4s$/.test(line));
  return {
    init: readInitSegment(new Uint8Array(fs.readFileSync(files[0]))),
    segmentPaths: files.slice(1),
    durations: playlistDurations(path.join(directory, 'master.m3u8')),
    names,
    manifest: JSON.parse(fs.readFileSync(path.join(directory, 'content-manifest.json'), 'utf8')),
  };
}

async function compareLayer3Data(ours, reference) {
  const report = { label: 'layer3', segments: [], constants: { video: { dts: null, pts: null }, audio: { dts: null, pts: null } }, firstMismatch: null, failure: null, verdict: 'fail' };
  const fail = (segment, track, index, reason) => {
    if (!report.firstMismatch) report.firstMismatch = { segment, track, index, reason };
    report.failure ??= reason;
  };
  for (let i = 0; i < Math.max(ours.segmentPaths.length, reference.segmentPaths.length); i += 1) {
    const oursFragment = i < ours.segmentPaths.length ? readFragment(new Uint8Array(fs.readFileSync(ours.segmentPaths[i]))) : null;
    const referenceFragment = i < reference.segmentPaths.length ? readFragment(new Uint8Array(fs.readFileSync(reference.segmentPaths[i]))) : null;
    const segment = { index: i, video: null, audio: null };
    for (const [id, name] of [[1, 'video'], [2, 'audio']]) {
      const left = oursFragment ? sampleRows(oursFragment, id) : [];
      const right = referenceFragment ? sampleRows(referenceFragment, id) : [];
      segment[name] = { ours: segmentEvidence(oursFragment ?? { tracks: [], bytes: new Uint8Array() }, id), reference: segmentEvidence(referenceFragment ?? { tracks: [], bytes: new Uint8Array() }, id) };
      if (left.length !== right.length) fail(i, name, Math.min(left.length, right.length), 'sample count differs');
      for (let j = 0; j < Math.min(left.length, right.length); j += 1) {
        if (left[j].size !== right[j].size || Buffer.compare(left[j].bytes, right[j].bytes) !== 0) fail(i, name, j, 'sample bytes differ');
        const dts = left[j].dts - right[j].dts;
        const pts = left[j].pts - right[j].pts;
        if (report.constants[name].dts === null) report.constants[name].dts = dts;
        if (report.constants[name].pts === null) report.constants[name].pts = pts;
        if (dts !== report.constants[name].dts || pts !== report.constants[name].pts) fail(i, name, j, 'timestamp offset differs');
      }
    }
    report.segments.push(segment);
  }
  if (ours.segmentPaths.length !== 1800) fail(null, null, null, `output holds ${ours.segmentPaths.length} segments, not 1800`);
  if (ours.durations.length !== reference.durations.length) fail(null, null, null, 'playlist durations differ');
  else for (let i = 0; i < ours.durations.length; i += 1) if (ours.durations[i] !== reference.durations[i]) fail(i, null, null, 'playlist durations differ');
  for (const key of ['duration', 'segmentSeconds', 'segmentCount']) if (ours.manifest[key] !== reference.manifest[key]) fail(null, null, null, `manifest ${key} differs`);
  if (!report.failure) report.verdict = 'pass';
  return report;
}

async function compareLayer3(options) {
  let ours;
  let reference;
  try {
    ours = await loadDirectory(options.output);
    reference = await loadDirectory(options.reference);
  } catch {
    const report = { label: 'layer3', segments: [], firstMismatch: null, failure: 'output is incomplete', verdict: 'evidence-failure' };
    writeReport(options.report, report);
    return 2;
  }
  if (reference.segmentPaths.length !== 1800) {
    const report = { label: 'layer3', segments: [], firstMismatch: null, failure: 'reference segment count is not 1800', verdict: 'evidence-failure' };
    writeReport(options.report, report);
    return 2;
  }
  const report = await compareLayer3Data(ours, reference);
  writeReport(options.report, report);
  return report.verdict === 'pass' ? 0 : 1;
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--seed') { copySeed(parseSeedArgs(args)); return; }
    if (args[0] === 'layer2' && args[1] === '--seed') {
      copySeed(parseSeedArgs(['--seed', ...args.slice(2)]));
      return;
    }
    const options = parseArgs(args);
    const exit = options.mode === 'layer2' ? (await compareLayer2(options)).exit : await compareLayer3(options);
    if (exit) {
      const report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf8'));
      console.error(report.failure || 'comparison failed');
      process.exitCode = exit;
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

await main();
