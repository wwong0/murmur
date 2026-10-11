import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { assert, assertEqual, check } from '../harness.mjs';
import { fixtureEntries, loadFixture, memorySink, memorySource } from '../remux-rig.mjs';
import { prepare } from '../../../public/lib/remux.mjs';

const APP_ROOT = path.resolve(import.meta.dirname, '../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const FIXTURES = path.join(APP_ROOT, 'scripts', 'check', 'remux-fixtures');
const SCRATCH = path.join(REPO_ROOT, '.tmp', 'remux-11');

function runNode(args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withScratch(body) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'runner-'));
  try {
    return await body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export default async function remuxRunnerSuite() {
  await check('remux-runner: file output matches the memory runner byte for byte', async () => {
    await withScratch(async (root) => {
      const fixture = loadFixture('varying.mp4');
      const memory = memorySink();
      const manifest = await prepare({ source: memorySource(fixture.bytes), sink: memory, targetSeconds: 2 });
      const output = path.join(root, 'output');
      const result = await runNode(['scripts/remux-file.mjs', path.join(FIXTURES, fixture.name), '--out', output, '--target', '2']);
      assertEqual(result.status, 0, 'the file runner exits successfully');
      assert(result.stdout.includes(`segments ${manifest.segmentCount}`), 'the file runner reports its segment count');
      const names = fs.readdirSync(output).sort();
      assertEqual(JSON.stringify(names), JSON.stringify([...memory.files.keys()].sort()), 'the two runners write the same names');
      for (const name of names) assertEqual(fs.readFileSync(path.join(output, name)).toString('hex'), Buffer.from(memory.files.get(name)).toString('hex'), `${name} is byte-identical`);
    });
  });

  await check('remux-runner: the fixture report is labelled, complete and path-free', async () => {
    await withScratch(async (root) => {
      const reportFile = path.join(root, 'report.json');
      const emptyPath = path.join(root, 'no-ffprobe');
      fs.mkdirSync(emptyPath);
      const env = { ...process.env, PATH: emptyPath, Path: emptyPath };
      const result = await runNode(['scripts/remux-file.mjs', '--report', '--json', reportFile, FIXTURES], env);
      assertEqual(result.status, 0, 'a missing ffprobe is not a report failure');
      const rows = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      const expected = fixtureEntries().length + fixtureEntries({ refusals: true }).length;
      assertEqual(rows.length, expected, 'the report has every fixture media file');
      // The report labels a directory's files in name order; the suite recovers which is which the same way.
      const names = fs.readdirSync(FIXTURES).filter((name) => name !== 'fixtures.json').sort((a, b) => a.localeCompare(b));
      assertEqual(names.length, expected, 'the fixture directory holds the clips and the refusal files');
      const clips = new Map(fixtureEntries().map((fixture) => [fixture.name, fixture.table]));
      const reasons = new Map([
        ['refuse-fragmented.mp4', 'fragmented'], ['refuse-video-codec.mp4', 'video-codec'], ['refuse-audio-codec.mp4', 'audio-codec'],
        ['refuse-no-video.mp4', 'no-video'], ['refuse-encrypted.mp4', 'encrypted'], ['refuse-not-mp4.mkv', 'not-mp4'], ['refuse-mov.mov', 'not-mp4'],
      ]);
      const written = `${result.stdout}\n${result.stderr}\n${JSON.stringify(rows)}`;
      for (const [at, name] of names.entries()) {
        const row = rows[at];
        assertEqual(row.label, `file ${at + 1}`, `row ${at + 1} carries its label`);
        assert(result.stdout.includes(`file ${at + 1} |`), `the text report has a line for file ${at + 1}`);
        assert(!written.includes(name) && !written.includes(name.replace(/\.[^.]+$/, '')), `the report does not carry the name of file ${at + 1}`);
        assertEqual(row.encoder, 'unknown', `${row.label} records unknown when ffprobe is absent`);
        if (clips.has(name)) {
          const video = clips.get(name).streams.video;
          assertEqual(row.status, 'ok', `${row.label} is indexed`);
          assertEqual(row.keyframeCount, video.packets.filter((packet) => packet[3] === 1).length, `${row.label} reports the table's keyframe count`);
          assertEqual(row.frameRate, 24, `${row.label} reports the three-place frame rate`);
          assertEqual(row.duration, (video.packets.length * (video.packets[1][1] - video.packets[0][1])) / video.timescale, `${row.label} reports the table's length`);
          assert(row.targets['4'].segmentCount > 0 && row.targets['1'].segmentCount >= row.targets['4'].segmentCount, `${row.label} reports figures per target`);
        } else {
          assertEqual(row.status, 'skipped', `${row.label} is skipped`);
          assertEqual(row.reason, reasons.get(name), `${row.label} is skipped with its reason`);
        }
      }
      assert(!written.includes(FIXTURES) && !written.includes('remux-fixtures'), 'the report carries no path');
    });
  });
}
