// scripts/check/fake-verifier.mjs
//
// Stands in for verify-browser.mjs in the supervisor's orchestration checks: a
// real child process that the supervisor must bound, kill and clean up after.
// It launches no browser.
//
//   --run-dir=<dir> --mode=complete --template=<dir>   copy a finished run, print its final line, exit like the verifier
//   --run-dir=<dir> --mode=hang --pid-file=<file>      start a grandchild, then never exit
//   --run-dir=<dir> --mode=hang-detached --pid-file=<file>   the same, but the grandchild is detached, so it
//                                                      outlives the job that ends the rest of the tree
//   --run-dir=<dir> --mode=flood                       write 1 MiB files until killed

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const runDir = arg('run-dir');
const mode = arg('mode');
fs.mkdirSync(runDir, { recursive: true });

if (mode === 'complete') {
  fs.cpSync(arg('template'), runDir, { recursive: true });
  const { failures } = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  console.log(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join('; ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
} else if (mode === 'hang' || mode === 'hang-detached') {
  const detached = mode === 'hang-detached';
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached });
  if (detached) grandchild.unref();
  fs.writeFileSync(arg('pid-file'), String(grandchild.pid));
  console.log('--- T10: flushing ---');
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  const chunk = Buffer.alloc(1024 * 1024);
  let n = 0;
  setInterval(() => fs.writeFileSync(path.join(runDir, `flood-${n++}.bin`), chunk), 10);
} else {
  console.error(`fake-verifier: unknown mode ${mode}`);
  process.exit(2);
}
