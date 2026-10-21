// Change 12c-1: read the registered run set once, on one build, and write the reading.

import fs from 'node:fs';
import path from 'node:path';

import { runIdentities } from './harness/build-identity.mjs';
import { leaveRecoveryReading } from './figures/leave-recovery-reading.mjs';
import { APP_DIR, isMain, recomputeRegisteredRun, runMain, runPath, writeRunSetReading } from './registered-runs.mjs';

const REGISTRY = 'results/RUNS-12c-1.json';
const OUTPUT = path.join(APP_DIR, '..', 'openspec', 'changes', 'archive', '2026-10-21-leave-recovery', 'evidence', 'reading-12c-1.json');
const RUN_DIRECTORY = /^12c1-(drop-comparand|leave-first|shakedown)/;

function readRun(entry) {
  const runDir = runPath(entry.directory);
  if (!fs.existsSync(runDir)) return { entry, identities: [], riseRecovery: null, rosterEvent: null, recomputeError: 'run-directory-missing' };
  const registered = recomputeRegisteredRun(entry);
  return { entry, identities: runIdentities(runDir), riseRecovery: registered.report?.riseRecovery ?? null,
    rosterEvent: registered.report?.rosterEvent ?? null, recomputeError: registered.recomputeError ?? null };
}

const main = () => writeRunSetReading({ registry: REGISTRY, output: OUTPUT, runDirectory: RUN_DIRECTORY, readRun,
  read: leaveRecoveryReading });

if (isMain(import.meta.url)) runMain(main);
