import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assert, assertEqual, check } from '../harness.mjs';
import { runCommand } from '../../measure-readings.mjs';

function makeRun(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ startedAt: '1970-01-01T00:00:00.000Z', runEndedAt: '1970-01-01T00:01:00.000Z', window: { startMs: 0, endMs: 100 }, declaredClientTags: ['c01'], condition: {}, cadence: {} }));
  fs.writeFileSync(path.join(dir, 'content-manifest.json'), JSON.stringify({ frameRate: 24, segmentSizes: [1], segmentDurations: [1] }));
  fs.writeFileSync(path.join(dir, 'client-c01.drift.ndjson'), '');
  fs.writeFileSync(path.join(dir, 'client-c01.peer-bytes.ndjson'), '');
  return dir;
}

export default async function measureCommandSuite() {
  await check('measurement command: fixed output path refuses before reading', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-command-'));
    try {
      const out = path.join(root, 'existing');
      fs.mkdirSync(out);
      assertEqual(runCommand(['node', 'measure-readings.mjs', '--out', out, path.join(root, 'missing')]), 2, 'existing output returns exit 2');
      assert(fs.existsSync(out), 'existing output remains untouched');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await check('measurement command: writes one combined and one file per reader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-command-'));
    try {
      const first = makeRun(root, 'run-a');
      const second = makeRun(root, 'run-b');
      const out = path.join(root, 'readings');
      assertEqual(runCommand(['node', 'measure-readings.mjs', '--out', out, first, second]), 0, 'reader refusals are not command throws');
      const combined = JSON.parse(fs.readFileSync(path.join(out, 'readings.json'), 'utf8'));
      assertEqual(Object.keys(combined.runs).length, 2, 'both runs are listed');
      assert(fs.existsSync(path.join(out, 'run-a', 'reading-lab-drift.json')), 'lab reading is written');
      assert(fs.existsSync(path.join(out, 'run-b', 'reading-gap-count.json')), 'gap reading is written');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await check('measurement command: --classes pools each run gap-count reading', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-command-'));
    try {
      const run = makeRun(root, 'run-a');
      fs.writeFileSync(path.join(run, 'client-c01.drift.ndjson'), [0, 50].map((at) =>
        JSON.stringify({ displaySharedMs: at, mediaMs: at, driftMs: 50, clock: { offsetMs: 0 } })).join('\n'));
      const classes = path.join(root, 'classes.json');
      fs.writeFileSync(classes, JSON.stringify({ 'run-a': 'healthy' }));
      const out = path.join(root, 'readings');
      runCommand(['node', 'measure-readings.mjs', '--out', out, '--classes', classes, run]);
      const combined = JSON.parse(fs.readFileSync(path.join(out, 'readings.json'), 'utf8'));
      assertEqual(combined.gapCountSet.healthy.playingMs, 50, 'the mapped run is pooled');
      assertEqual(combined.gapCountSet.unmapped.length, 0, 'nothing is unmapped');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
