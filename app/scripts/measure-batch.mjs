import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { batchVerdicts } from './measure/batch-verdicts.mjs';
import { secondBatchVerdicts } from './measure/second-batch-verdicts.mjs';
import { memoryLimitVerdicts } from './measure/memory-limit-verdicts.mjs';

function option(argv, name) {
  const equals = argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function readOptional(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function runFiles(resultsRoot, directory) {
  const runRoot = path.resolve(resultsRoot, directory);
  return {
    manifest: readOptional(path.join(runRoot, 'manifest.json')),
    refusalReport: readOptional(path.join(runRoot, 'refusal-report.json')),
    rosterFigure: readOptional(path.join(runRoot, 'published-roster-event.json')),
    schedule: readOptional(path.join(runRoot, 'capacity-schedule.json')),
  };
}

export function runCommand(argv = process.argv) {
  const registryValue = option(argv, 'registry');
  const readingsValue = option(argv, 'readings');
  const outValue = option(argv, 'out');
  const batch = option(argv, 'batch');
  if (!registryValue || !readingsValue || !outValue) throw new Error('usage: node scripts/measure-batch.mjs --registry <file> --readings <readings.json> --out <dir>');
  if (batch !== null && batch !== '13d' && batch !== '13e' && batch !== '13f') {
    console.error(`unknown batch: ${batch}`);
    return 2;
  }
  const outDir = path.resolve(outValue);
  if (fs.existsSync(outDir)) {
    console.error(`output path already exists: ${outDir}`);
    return 2;
  }
  const registry = JSON.parse(fs.readFileSync(path.resolve(registryValue), 'utf8'));
  const readings = JSON.parse(fs.readFileSync(path.resolve(readingsValue), 'utf8'));
  const resultsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'results');
  const entries = registry.runs ?? [];
  const runs = Object.fromEntries(entries.map((entry) => [entry.directory, {
    ...runFiles(resultsRoot, entry.directory),
    readings: readings.runs?.[entry.directory] ?? {},
  }]));
  const baselineValue = option(argv, 'baseline');
  const baseline = batch === '13f' && baselineValue ? JSON.parse(fs.readFileSync(path.resolve(baselineValue), 'utf8')).figures : null;
  const verdicts = batch === '13f' ? memoryLimitVerdicts({ entries, runs, baseline })
    : batch === '13e' ? secondBatchVerdicts({ entries, runs }) : batchVerdicts({ entries, runs });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'verdicts.json'), `${JSON.stringify(verdicts, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = runCommand(process.argv); } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
