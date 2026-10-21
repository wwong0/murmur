// Change 12c-2: read the registered run set once, on one build, and write the reading.

import fs from 'node:fs';
import path from 'node:path';

import { buildIdentityFromRun } from './harness/build-identity.mjs';
import { healthyRoomReading, placementReading } from './figures/healthy-room-reading.mjs';
import {
  APP_DIR, appPath, argument, isMain, readJson, recomputeRegisteredRun, registryEntries, runMain, runPath, RESULTS_DIR,
} from './registered-runs.mjs';

const REGISTRY = 'results/RUNS-12c-2.json';
const EVIDENCE_DIR = path.join(APP_DIR, '..', 'openspec', 'changes', 'timeline-offset', 'evidence');
const OUTPUT = path.join(EVIDENCE_DIR, 'reading-12c-2.json');
const BUILD = path.join(EVIDENCE_DIR, 'build.json');
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
  return { entry, roles, identities: [readIfPresent(path.join(runDir, 'build-ids-start.json')), buildIdentityFromRun(runDir)],
    publishedDrift: readIfPresent(path.join(runDir, 'published-drift.json')),
    settledDrift: readIfPresent(path.join(runDir, 'published-settled-drift.json')),
    aheadForGood: registered.report?.aheadForGood ?? null, placement, recomputeError: registered.recomputeError ?? null };
}

function main() {
  const registryPath = appPath(argument('registry', process.argv) ?? REGISTRY);
  const outputPath = appPath(argument('out', process.argv) ?? OUTPUT);
  const entries = registryEntries(registryPath);
  const registered = new Set(entries.map((entry) => entry.directory));
  const unregisteredDirectories = fs.readdirSync(RESULTS_DIR).filter((name) => RUN_DIRECTORY.test(name) && !registered.has(name));
  const reading = healthyRoomReading({ runs: entries.map(readRun), build: readJson(appPath(argument('build', process.argv) ?? BUILD)),
    unregisteredDirectories, generatedFrom: path.relative(APP_DIR, registryPath).split(path.sep).join('/') });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(reading, null, 2)}\n`);
  console.log(`${reading.status}${reading.reason ? `: ${reading.reason}` : ` (${reading.shownAnswer})`} → ${outputPath}`);
  if (reading.status !== 'read') process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain(main);
