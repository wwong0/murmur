import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CLASSES_13F, HOUR, NIGHTS, normaliseVerdicts, RECOVERY } from './graphs/sources.mjs';
import { records } from './graphs/common.mjs';
import * as sharing from './graphs/fig-sharing.mjs';
import * as roomSize from './graphs/fig-room-size.mjs';
import * as sync from './graphs/fig-sync.mjs';
import * as connection from './graphs/fig-connection.mjs';
import * as recovery from './graphs/fig-recovery.mjs';
import * as waits from './graphs/fig-waits.mjs';
import * as weaker from './graphs/fig-weaker.mjs';
import * as hour from './graphs/fig-hour.mjs';
import { alsoTested, limits, notesDocument } from './graphs/notes.mjs';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : argv[i + 1] ?? null;
};
function loader(root) {
  const sources = new Map();
  let current = 'shared';
  const add = (relative) => {
    const key = relative.replaceAll('\\', '/');
    if (!sources.has(key)) {
      sources.set(key, new Set());
    }
    sources.get(key).add(current);
  };
  const resolve = (relative) => {
    return path.join(root, relative);
  };
  const json = (relative, optional = false) => {
    const file = resolve(relative);
    if (optional && !fs.existsSync(file)) {
      return null;
    }
    add(relative);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  async function clients(directory) {
    const names = fs.readdirSync(resolve(directory)).filter((name) =>
      /^client-c\d+\.peer-bytes\.ndjson$/.test(name)
    ).sort();
    return Object.fromEntries(
      await Promise.all(names.map(async (name) => {
        const relative = `${directory}/${name}`, result = [];
        add(relative);
        for await (
          const line of readline.createInterface({
            input: fs.createReadStream(resolve(relative)),
            crlfDelay: Infinity,
          })
        ) {
          if (line.trim()) {
            const r = JSON.parse(line);
            result.push({
              kind: r.kind,
              source: r.source,
              peerId: r.peerId,
              end: r.end,
              bytes: r.bytes,
              endMs: r.endMs,
            });
          }
        }
        return [name.match(/^client-(c\d+)\./)[1], result];
      })),
    );
  }
  return {
    sources,
    json,
    clients,
    figure: (id) => {
      current = id;
    },
  };
}
export async function runCommand(argv = process.argv) {
  const outValue = option(argv, 'out');
  if (!outValue) {
    throw new Error('usage: node scripts/measure-graphs.mjs --out <dir> [--results <dir>]');
  }
  const out = path.resolve(outValue),
    root = path.resolve(option(argv, 'results') ?? path.join(appRoot, 'results'));
  if (fs.existsSync(out)) {
    console.error(`output path already exists: ${out}`);
    return 2;
  }
  const load = loader(root), nights = {};
  for (const [night, files] of Object.entries(NIGHTS)) {
    nights[night] = {
      ledger: load.json(files.ledger),
      verdicts: load.json(files.verdicts),
      readings: load.json(files.readings),
      classes: files.classes ? load.json(files.classes) : CLASSES_13F,
    };
  }
  const reports = {};
  for (const e of nights['13f'].verdicts.runs ?? []) {
    reports[e.directory] = load.json(`${e.directory}/refusal-report.json`, true);
  }
  nights['13f'].verdicts = normaliseVerdicts(nights['13f'].verdicts, reports);
  const runs = {};
  for (const e of Object.values(nights).flatMap((n) => n.verdicts.entries)) {
    const content = load.json(`${e.directory}/content-manifest.json`);
    delete content.segmentSizes;
    runs[e.directory] = {
      manifest: load.json(`${e.directory}/manifest.json`),
      content,
      assignmentControl: load.json(`${e.directory}/assignment-control.json`, true),
    };
  }
  const inputs = { nights, runs, traces: {} };
  load.figure('recovery');
  for (const row of records(inputs).filter((r) => r.entry.condition === RECOVERY.current)) {
    row.run.schedule = load.json(`${row.entry.directory}/capacity-schedule.json`);
  }
  load.figure('hour');
  inputs.traces.hour = await load.clients(HOUR);
  const modules = [sharing, roomSize, sync, connection, recovery, waits, weaker, hour];
  const built = modules.map((m) => {
    const data = m.data(inputs);
    return {
      id: m.ID,
      kind: m.KIND,
      title: m.TITLE,
      takeaway: m.takeaway(data),
      regime: data.regimes,
      data,
      svg: m.svg(data),
      notes: m.notes(data),
    };
  });
  const also = alsoTested(inputs),
    nightFiles = new Set(Object.values(NIGHTS).flatMap((v) => Object.values(v)).filter(Boolean));
  const sourcesOf = (id, data) => {
    const content = JSON.stringify(data);
    return [...load.sources].filter(([file, tags]) =>
      tags.has(id) || (tags.has('shared') && (nightFiles.has(file) || content.includes(file.split('/')[0])))
    ).map(([file]) => file).sort();
  };
  const result = built.map(({ svg: _, notes: __, ...entry }) => ({
    ...entry,
    regime: entry.regime.map((item) => item.regime),
    sources: sourcesOf(entry.id, entry.data),
  }));
  result.push({ id: 'also-tested', sources: sourcesOf('also-tested', also.data), data: also.data });
  const notes = notesDocument(built, also, limits(built.map((b) => b.data)));
  fs.mkdirSync(out, { recursive: true });
  for (const figure of built) {
    fs.writeFileSync(path.join(out, `fig-${figure.id}.svg`), figure.svg);
  }
  fs.writeFileSync(path.join(out, 'notes.md'), notes);
  fs.writeFileSync(path.join(out, 'figures.json'), `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await runCommand();
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
