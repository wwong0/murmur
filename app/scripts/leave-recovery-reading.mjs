// Change 12c-1: read the registered run set once, on one build, and write the reading.

import fs from 'node:fs';
import path from 'node:path';

import { buildIdentityFromRun } from './harness/build-identity.mjs';
import { leaveRecoveryReading } from './figures/leave-recovery-reading.mjs';
import {
  APP_DIR, appPath, argument, isMain, readJson, recomputeRegisteredRun, registryEntries, runMain, runPath, RESULTS_DIR,
} from './registered-runs.mjs';

const REGISTRY = 'results/RUNS-12c-1.json';
const OUTPUT = path.join(APP_DIR, '..', 'openspec', 'changes', 'leave-recovery', 'evidence', 'reading-12c-1.json');
const RUN_DIRECTORY = /^12c1-(drop-comparand|leave-first|shakedown)/;

const startIdentity = (runDir) => {
  const file = path.join(runDir, 'build-ids-start.json');
  return fs.existsSync(file) ? readJson(file) : null;
};

function readRun(entry) {
  const runDir = runPath(entry.directory);
  const identities = fs.existsSync(runDir) ? [startIdentity(runDir), buildIdentityFromRun(runDir)] : [];
  const registered = fs.existsSync(runDir) ? recomputeRegisteredRun(entry) : { recomputeError: 'run-directory-missing' };
  return { entry, identities, riseRecovery: registered.report?.riseRecovery ?? null,
    rosterEvent: registered.report?.rosterEvent ?? null, recomputeError: registered.recomputeError ?? null };
}

function main() {
  const registryPath = appPath(argument('registry', process.argv) ?? REGISTRY);
  const outputPath = appPath(argument('out', process.argv) ?? OUTPUT);
  const entries = registryEntries(registryPath);
  const registered = new Set(entries.map((entry) => entry.directory));
  const unregisteredDirectories = fs.readdirSync(RESULTS_DIR).filter((name) => RUN_DIRECTORY.test(name) && !registered.has(name));
  const reading = leaveRecoveryReading({ runs: entries.map(readRun), unregisteredDirectories,
    generatedFrom: path.relative(APP_DIR, registryPath).split(path.sep).join('/') });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(reading, null, 2)}\n`);
  console.log(`${reading.status}${reading.reason ? `: ${reading.reason}` : ''} → ${outputPath}`);
  if (reading.status !== 'read') process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain(main);
