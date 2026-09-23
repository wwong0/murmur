import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRunDirectory, recomputeRunDirectory } from './harness-figures.mjs';
import { viewerHttpLeak, uplinkVersusDelivered, loopbackAnswer } from './figures/host-origin-checks.mjs';
import { judgeHostOrigin } from './figures/host-origin-bars.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(APP_DIR, 'results');
const BASELINE_DIR = path.join(RESULTS_DIR, '6a-repair-final-baseline-nop2p');

function json(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function refusal(runDir, manifest) {
  const reportPath = path.join(runDir, 'refusal-report.json');
  const report = fs.existsSync(reportPath) ? json(reportPath) : {};
  return {
    refused: manifest.status === 'refused' || report.finalization?.status === 'refused' || report.refusal?.runRefused === true,
    reasons: report.refusal?.reasons ?? manifest.refusalReasons ?? [],
  };
}

function roomCounter(value) {
  return value?.counters ?? value ?? {};
}

function hostSourceBytes(start, end) {
  const before = roomCounter(start).byClient?.c00?.mediaBytesDelivered;
  const after = roomCounter(end).byClient?.c00?.mediaBytesDelivered;
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) return null;
  return after - before;
}

function oq1(runDir, retained) {
  const loopStartPath = path.join(runDir, 'origin-loopback-start.json');
  const loopEndPath = path.join(runDir, 'origin-loopback-end.json');
  const roomStartPath = path.join(runDir, 'room-counters-start.json');
  const roomEndPath = path.join(runDir, 'room-counters-end.json');
  if (![loopStartPath, loopEndPath, roomStartPath, roomEndPath].every(fs.existsSync)) return loopbackAnswer({});
  const loopStart = json(loopStartPath);
  const loopEnd = json(loopEndPath);
  const L = Number(loopEnd.txBytes) - Number(loopStart.txBytes);
  const S = hostSourceBytes(json(roomStartPath), json(roomEndPath));
  const uplink = uplinkVersusDelivered({
    linkSamples: retained.input.linkSamples,
    window: retained.input.window,
    originStart: retained.input.originStart,
    originEnd: retained.input.originEnd,
  });
  return loopbackAnswer({ L, S, T: uplink.txBytes, D: uplink.deliveredMediaBytes });
}

function arm(runDir) {
  const retained = readRunDirectory(runDir);
  const recomputed = recomputeRunDirectory(runDir);
  const manifest = retained.manifest;
  const refusalEvidence = refusal(runDir, manifest);
  const leak = viewerHttpLeak({ roomFinal: fs.existsSync(path.join(runDir, 'room-counters-final.json')) ? json(path.join(runDir, 'room-counters-final.json')) : undefined, viewerTags: retained.input.declaredClientTags ?? [] });
  const uplink = uplinkVersusDelivered({ linkSamples: retained.input.linkSamples, window: retained.input.window, originStart: retained.input.originStart, originEnd: retained.input.originEnd });
  return {
    directory: path.basename(runDir),
    figures: recomputed.publishedByte ?? recomputed.figures,
    refusal: refusalEvidence,
    leak,
    uplink,
    oq1: oq1(runDir, retained),
  };
}

function parse(argv) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--(capped|uncapped)=(.+)$/);
    if (!match) throw new Error('usage: node scripts/host-origin-comparison.mjs --capped=<dir> --uncapped=<dir>');
    values[match[1]] = path.resolve(match[2]);
  }
  if (!values.capped || !values.uncapped) throw new Error('usage: node scripts/host-origin-comparison.mjs --capped=<dir> --uncapped=<dir>');
  return values;
}

export function compareHostOrigin({ cappedDir, uncappedDir, baselineDir = BASELINE_DIR, outputDir = null } = {}) {
  const baseline = json(path.join(baselineDir, 'published-figures.json'));
  const capped = arm(cappedDir);
  const uncapped = arm(uncappedDir);
  const verdict = judgeHostOrigin({ baseline, capped: { ...capped.figures, ...capped.refusal }, uncapped: { ...uncapped.figures, ...uncapped.refusal } });
  const destination = outputDir ?? path.join(RESULTS_DIR, `7a2-comparison-${new Date().toISOString().replaceAll(':', '-')}`);
  fs.mkdirSync(destination);
  const result = { baseline: { directory: path.basename(baselineDir), figures: baseline }, capped, uncapped, verdict };
  fs.writeFileSync(path.join(destination, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
  return { destination, result };
}

function main(argv = process.argv.slice(2)) {
  const { capped, uncapped } = parse(argv);
  console.log(JSON.stringify(compareHostOrigin({ cappedDir: capped, uncappedDir: uncapped }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
