// Read the registered run set once, on one build, and write the reading.

import fs from 'node:fs';
import path from 'node:path';

import { runIdentities } from './harness/build-identity.mjs';
import { healthyRoomReading, placementReading } from './figures/healthy-room-reading.mjs';
import {
  APP_DIR, appPath, argument, isMain, readJson, recomputeRegisteredRun, runMain, runPath, writeRunSetReading,
} from './registered-runs.mjs';

const REGISTRY = 'results/RUNS-12c-2.json';
const OUTPUT = path.join(APP_DIR, 'results', 'reading-12c-2.json');
const RUN_DIRECTORY = /^12c2-(healthy-2s|shakedown)-/;
const POLL_FILE = /^client-(c\d+)\.poll\.ndjson$/;

const readIfPresent = (file) => (fs.existsSync(file) ? readJson(file) : null);
const readNdjson = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function readRun(entry) {
  const runDir = runPath(entry.directory);
  if (!fs.existsSync(runDir)) return { entry, identities: [], recomputeError: 'run-directory-missing' };
  const registered = recomputeRegisteredRun(entry);
  const placement = Object.fromEntries(fs.readdirSync(runDir).map((name) => name.match(POLL_FILE)).filter(Boolean)
    .map(([file, tag]) => [tag, placementReading(readNdjson(path.join(runDir, file)))]));
  const clients = readIfPresent(path.join(runDir, 'manifest.json'))?.clients ?? {};
  const roles = Object.fromEntries(Object.entries(clients).map(([tag, client]) => [tag, client?.role ?? null]));
  return { entry, roles, identities: runIdentities(runDir),
    publishedDrift: readIfPresent(path.join(runDir, 'published-drift.json')),
    settledDrift: readIfPresent(path.join(runDir, 'published-settled-drift.json')),
    aheadForGood: registered.report?.aheadForGood ?? null, placement, recomputeError: registered.recomputeError ?? null };
}

// The run set's build record, given as --build <build.json>.
function requiredBuild() {
  const build = argument('build', process.argv);
  if (!build) throw new Error('--build <build.json> is required');
  return build;
}

const main = () => writeRunSetReading({ registry: REGISTRY, output: OUTPUT, runDirectory: RUN_DIRECTORY, readRun,
  read: (input) => healthyRoomReading({ ...input, build: readJson(appPath(requiredBuild())) }),
  summary: (reading) => ` (${reading.shownAnswer})` });

if (isMain(import.meta.url)) runMain(main);
