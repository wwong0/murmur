import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_TARGET_SEGMENT_SECONDS, targetMillis } from '../public/lib/remux-settings.mjs';
import { planCuts } from '../public/lib/remux-cut-plan.mjs';
import { RemuxRefusal, readSourceIndex } from '../public/lib/remux-index.mjs';
import { prepare } from '../public/lib/remux.mjs';

const execFileAsync = promisify(execFile);
const FIXTURE_TABLE = 'fixtures.json';
const DEFAULT_TARGETS = [1, 2, 4, 6, 10];

function round(value, places = 6) {
  return Number(value.toFixed(places));
}

function valueAfter(args, index) {
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`missing value for ${args[index]}`);
  return args[index + 1];
}

function parseTargets(value) {
  const targets = value.split(',').map(Number);
  if (!targets.length || targets.some((target) => !Number.isFinite(target))) throw new Error('targets must be comma-separated numbers');
  for (const target of targets) targetMillis(target);
  return targets;
}

function parseArgs(args) {
  if (args[0] === '--report') {
    const targets = [];
    let json = null;
    const inputs = [];
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--targets') { targets.push(...parseTargets(valueAfter(args, i))); i += 1; }
      else if (args[i] === '--json') { json = valueAfter(args, i); i += 1; }
      else if (args[i].startsWith('--')) throw new Error(`unknown option ${args[i]}`);
      else inputs.push(args[i]);
    }
    if (!inputs.length) throw new Error('report needs a file or directory');
    return { mode: 'report', targets: targets.length ? targets : DEFAULT_TARGETS, json, inputs };
  }
  if (!args.length) throw new Error('runner needs an input file');
  const input = args[0];
  let out = null;
  let targetSeconds = DEFAULT_TARGET_SEGMENT_SECONDS;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--out') { out = valueAfter(args, i); i += 1; }
    else if (args[i] === '--target') { targetSeconds = Number(valueAfter(args, i)); i += 1; }
    else throw new Error(`unknown option ${args[i]}`);
  }
  if (!out) throw new Error('runner needs --out');
  targetMillis(targetSeconds);
  return { mode: 'run', input, out, targetSeconds };
}

async function withFileSource(filename, body) {
  const handle = await fs.promises.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const source = {
      size: stat.size,
      async read(offset, length) {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead !== length) throw new Error(`source read ended after ${result.bytesRead} bytes`);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, length).slice();
      },
    };
    return await body(source);
  } finally {
    await handle.close();
  }
}

async function runFile(input, out, targetSeconds) {
  const destination = path.resolve(out);
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length) throw new Error('output directory already exists and is not empty');
  } else fs.mkdirSync(destination, { recursive: true });
  const sink = {
    async write(name, bytes) {
      await fs.promises.writeFile(path.join(destination, name), bytes);
    },
  };
  const manifest = await withFileSource(path.resolve(input), (source) => prepare({ source, sink, targetSeconds }));
  const usage = process.resourceUsage();
  console.log(`segments ${manifest.segmentCount}`);
  console.log(`overTarget ${JSON.stringify(manifest.overTarget)}`);
  console.log(`maxRSS ${usage.maxRSS}`);
}

async function encoderTag(filename) {
  try {
    const result = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=encoder', '-of', 'default=nk=1:nw=1', filename], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.stderr.trim()) return 'unknown';
    const line = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    return line?.replace(/[\r\n]/g, ' ') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function outputTimeline(track, sample) {
  return track.dts[sample] + track.shift;
}

function spacingStats(values) {
  if (!values.length) return { min: null, median: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (quantile) => sorted[Math.ceil(quantile * sorted.length) - 1];
  return {
    min: round(sorted[0]),
    median: round(rank(0.5)),
    p95: round(rank(0.95)),
    max: round(sorted.at(-1)),
  };
}

function reportRow(label, index, encoder, targets) {
  const video = index.video;
  const first = outputTimeline(video, 0);
  const last = video.dts.length - 1;
  const end = outputTimeline(video, last) + video.durations[last];
  const duration = (end - first) / video.timescale;
  const keyframes = [...video.sync].flatMap((sync, i) => sync ? [outputTimeline(video, i)] : []);
  const boundaries = [...keyframes, end];
  const intervals = boundaries.slice(1).map((tick, i) => (tick - boundaries[i]) / video.timescale);
  const targetRows = {};
  for (const target of targets) {
    const segments = planCuts({
      keyframeTicks: keyframes,
      endTick: end,
      timescale: video.timescale,
      targetMs: targetMillis(target),
    });
    const over = segments.filter((segment) => (segment.endTick - segment.startTick) * 1000 > targetMillis(target) * video.timescale);
    targetRows[String(target)] = {
      segmentCount: segments.length,
      overTarget: over.length,
      longestSeconds: over.length ? round(Math.max(...over.map((segment) => (segment.endTick - segment.startTick) / video.timescale))) : null,
    };
  }
  return {
    label,
    status: 'ok',
    encoder,
    duration: round(duration),
    frameRate: round(video.dts.length / duration, 3),
    audioCodec: index.audio?.codec ?? null,
    keyframeCount: keyframes.length,
    keyframeSpacing: spacingStats(intervals),
    intervalsOver4s: { count: intervals.filter((interval) => interval > 4).length, total: intervals.length },
    targets: targetRows,
  };
}

function skippedRow(label, encoder, error) {
  // Only a refusal has a reason; a read that failed is reported as that and not as a container.
  const reason = error instanceof RemuxRefusal ? error.reason : 'read-error';
  const detail = error instanceof RemuxRefusal ? error.message.replace(/[\r\n]/g, ' ') : 'the input could not be read';
  return { label, status: 'skipped', encoder, reason, detail };
}

function inputFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (!stat.isDirectory()) files.push(input);
    else {
      for (const entry of fs.readdirSync(input, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && entry.name !== FIXTURE_TABLE) files.push(path.join(input, entry.name));
      }
    }
  }
  return files;
}

function textRow(row, targets) {
  if (row.status === 'skipped') return `${row.label} | skipped | encoder=${row.encoder} | reason=${row.reason} | ${row.detail}`;
  const spacing = row.keyframeSpacing;
  const targetsText = targets.map((target) => {
    const value = row.targets[String(target)];
    return `${target}s:${value.segmentCount}/${value.overTarget}/${value.longestSeconds ?? '-'}`;
  }).join(' ');
  return `${row.label} | encoder=${row.encoder} | duration=${row.duration} | frameRate=${row.frameRate} | audio=${row.audioCodec ?? '-'} | keyframes=${row.keyframeCount} | spacing=${spacing.min}/${spacing.median}/${spacing.p95}/${spacing.max} | over4s=${row.intervalsOver4s.count}/${row.intervalsOver4s.total} | ${targetsText}`;
}

async function report(inputs, targets, json) {
  const rows = [];
  for (const [i, filename] of inputFiles(inputs).entries()) {
    const label = `file ${i + 1}`;
    const encoder = await encoderTag(filename);
    try {
      const row = await withFileSource(filename, (source) => readSourceIndex(source));
      rows.push(reportRow(label, row, encoder, targets));
    } catch (error) {
      rows.push(skippedRow(label, encoder, error));
    }
  }
  for (const row of rows) console.log(textRow(row, targets));
  if (json) fs.writeFileSync(path.resolve(json), `${JSON.stringify(rows, null, 2)}\n`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'run') await runFile(options.input, options.out, options.targetSeconds);
    else await report(options.inputs, options.targets, options.json);
  } catch (error) {
    console.error(error instanceof RemuxRefusal ? error.message : error.message || String(error));
    process.exitCode = 1;
  }
}

await main();
