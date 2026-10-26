import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRunEvidence } from './measure/run-evidence.mjs';
import { labDrift } from './measure/lab-drift.mjs';
import { byteInventory } from './measure/byte-inventory.mjs';
import { attemptLedger } from './measure/attempt-ledger.mjs';
import { gapCount, gapCountSet } from './measure/gap-count.mjs';
import { landings, landingPairs } from './measure/landings.mjs';
import { catchUp } from './measure/catch-up.mjs';
import { eventClocks } from './measure/event-clocks.mjs';

const readers = [
  ['lab-drift', labDrift],
  ['byte-inventory', byteInventory],
  ['gap-count', gapCount],
];

function option(argv, name) {
  const equals = argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function options(argv, name) {
  const values = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) values.push(argv[index + 1] ?? null);
    else if (argv[index].startsWith(`--${name}=`)) values.push(argv[index].slice(name.length + 3));
  }
  return values.filter(Boolean);
}

function positional(argv) {
  const values = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) { if (!argv[index].includes('=')) index += 1; continue; }
    values.push(argv[index]);
  }
  return values;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestFor(registryPath, directory) {
  const base = path.dirname(registryPath);
  const direct = path.resolve(base, directory, 'manifest.json');
  const underAppResults = path.resolve(base, 'results', directory, 'manifest.json');
  const filePath = fs.existsSync(direct) ? direct : underAppResults;
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function finalizationFor(registryPath, directory) {
  const base = path.dirname(registryPath);
  const candidates = [path.resolve(base, directory, 'refusal-report.json'), path.resolve(base, 'results', directory, 'refusal-report.json')];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  return filePath ? JSON.parse(fs.readFileSync(filePath, 'utf8')).finalization ?? null : null;
}

export function runCommand(argv = process.argv) {
  const outValue = option(argv, 'out');
  if (!outValue) throw new Error('usage: node scripts/measure-readings.mjs --out <dir> <runDir>...');
  const outDir = path.resolve(outValue);
  if (fs.existsSync(outDir)) {
    console.error(`output path already exists: ${outDir}`);
    return 2;
  }
  const pairSpecs = options(argv, 'pair');
  const pairDirs = pairSpecs.flatMap((spec) => spec.split('=', 2));
  const runDirs = [...new Set([...positional(argv), ...pairDirs])];
  if (!runDirs.length) throw new Error('at least one run directory is required');
  const classesPath = option(argv, 'classes');
  const registryPathValue = option(argv, 'registry');
  const classes = classesPath ? JSON.parse(fs.readFileSync(path.resolve(classesPath), 'utf8')) : null;
  const evidenceByRun = {};
  const runs = {};
  let threw = false;
  const pairRunNames = new Set(pairDirs.map((directory) => path.basename(path.resolve(directory))));
  for (const runDir of runDirs) {
    const evidence = loadRunEvidence(runDir);
    evidenceByRun[evidence.run] = evidence;
    const outputDir = path.join(outDir, evidence.run);
    fs.mkdirSync(outputDir, { recursive: true });
    const reading = {};
    const dispatch = [...readers];
    if (evidence.seek || pairRunNames.has(evidence.run)) dispatch.push(['landings', landings]);
    if (evidence.disturbance) dispatch.push(['catch-up', catchUp]);
    if (evidence.rosterEvent) dispatch.push(['event-clocks', eventClocks]);
    for (const [name, reader] of dispatch) {
      let result;
      try {
        result = reader(evidence);
      } catch (error) {
        threw = true;
        result = { refused: true, reason: 'reader-threw', detail: error.message };
      }
      reading[name] = result;
      writeJson(path.join(outputDir, `reading-${name}.json`), result);
    }
    runs[evidence.run] = reading;
  }
  let ledger = null;
  if (registryPathValue) {
    const registryPath = path.resolve(registryPathValue);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const manifests = Object.fromEntries((registry.runs ?? []).map((entry) => [entry.directory, manifestFor(registryPath, entry.directory)]));
    const finalizations = Object.fromEntries((registry.runs ?? []).map((entry) => [entry.directory, finalizationFor(registryPath, entry.directory)]));
    const registryDir = path.dirname(registryPath);
    const resultsDir = path.basename(registryDir).toLowerCase() === 'results' ? registryDir : path.join(registryDir, 'results');
    const resultNames = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir) : [];
    ledger = attemptLedger({ registry, manifests, finalizations, resultNames });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const pairInputs = pairSpecs.map((spec) => {
    const [productDir, controlDir] = spec.split('=', 2);
    const product = runs[path.basename(path.resolve(productDir))]?.landings;
    const control = runs[path.basename(path.resolve(controlDir))]?.landings;
    return [product, control];
  });
  const pairs = landingPairs(pairInputs);
  writeJson(path.join(outDir, 'readings.json'), { runs, ledger, gapCountSet: classes
    ? gapCountSet(Object.fromEntries(Object.entries(runs).map(([run, reading]) => [run, reading['gap-count']])), classes) : null, pairs });
  return threw ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = runCommand(process.argv); } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
