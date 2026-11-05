import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityCounts, parseTerms, pathKind, PROFILE, scanPath, scanText } from './history-check/scan.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const limit = 512 * 1024 * 1024;
const REFUSALS = new Set(['terms file is inside the repository work tree', 'terms file is known to git', 'report already exists', 'JSON already exists', 'report is required', 'invalid arguments', 'report and JSON paths must differ']);
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: limit });
  if (r.status !== 0 || r.error) throw new Error('git command failed');
  return r.stdout;
}
const revList = (repo, args) => git(repo, ['rev-list', ...args]).toString().trim().split('\n').filter(Boolean);
function options(args) {
  const result = { repo: scriptRoot, main: 'main' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!['repo', 'report', 'terms', 'main', 'json'].includes(key) || !args[i].startsWith('--') || !args[i + 1]) throw new Error('invalid arguments');
    result[key] = args[i + 1];
  }
  if (!result.report) throw new Error('report is required');
  return result;
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function readTerms(repo, file) {
  if (!file) return null;
  const root = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']).toString().trim());
  const actual = fs.realpathSync(file);
  if (inside(root, actual) || inside(root, path.resolve(file))) throw new Error('terms file is inside the repository work tree');
  const known = [git(repo, ['ls-files', '-z']), git(repo, ['log', '--all', '--format=', '--name-only', '-z'])];
  if (known.some((list) => list.toString().split('\0').some((name) => name && path.resolve(root, name.trim()) === actual))) throw new Error('terms file is known to git');
  return parseTerms(fs.readFileSync(actual, 'utf8'));
}
function cleanText(value, sensitive) {
  let result = String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[email]').replace(PROFILE, '[profile]');
  for (const secret of [...sensitive].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A short value removed anywhere would erase ordinary letters from the whole report.
    const pattern = secret.length < 4 ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
    result = result.replace(new RegExp(pattern, 'gi'), '[redacted]');
  }
  return result;
}
function shownPath(file) {
  const kind = pathKind(file);
  if (kind.test) return '[test_videos entry]';
  if (kind.ext) return `[media: ${kind.first}/, .${kind.ext}]`;
  return file;
}
function readCommits(repo) {
  const text = git(repo, ['log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00']).toString();
  const fields = text.split('\0');
  const commits = new Map();
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const id = fields[i].trim();
    if (id) commits.set(id, { names: [fields[i + 1], fields[i + 3]], emails: [fields[i + 2], fields[i + 4]], message: fields[i + 5] });
  }
  return commits;
}
async function blobs(repo, ids, consume) {
  if (!ids.length) return;
  const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.on('error', () => {});
  child.stdin.end(ids.join('\n') + '\n');
  let buffer = Buffer.alloc(0), size = null, id, pieces = [], remaining = 0;
  for await (const chunk of child.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (size === null) {
        const nl = buffer.indexOf(10);
        if (nl < 0) break;
        const match = buffer.subarray(0, nl).toString().match(/^([0-9a-f]+) blob (\d+)$/);
        if (!match) throw new Error('invalid blob response');
        id = match[1]; size = Number(match[2]); remaining = size + 1; pieces = []; buffer = buffer.subarray(nl + 1);
      }
      const take = Math.min(buffer.length, remaining);
      if (take) pieces.push(buffer.subarray(0, take));
      buffer = buffer.subarray(take); remaining -= take;
      if (remaining) break;
      consume(id, Buffer.concat(pieces, size + 1).subarray(0, size));
      size = null;
    }
  }
  if (await exit !== 0 || buffer.length || size !== null) throw new Error('blob stream failed');
}
function objectVolume(repo, main, paths) {
  const ids = git(repo, ['rev-list', '--objects', main]).toString().split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
  const data = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(objectsize:disk)'], ids.join('\n') + '\n').toString();
  const groups = { 'app/results/': 0, 'everything else': 0 };
  const largest = [];
  for (const line of data.trim().split('\n')) {
    const [id, type, size, disk] = line.split(' ');
    const file = paths.get(id) || '';
    const group = Object.keys(groups).find((prefix) => prefix !== 'everything else' && file.startsWith(prefix)) || 'everything else';
    groups[group] += Number(disk);
    if (type === 'blob') largest.push({ size: Number(size), path: shownPath(file) });
  }
  const total = Object.values(groups).reduce((a, b) => a + b, 0);
  return { packedBytes: total, groups, largest: largest.sort((a, b) => b.size - a.size).slice(0, 20), sizePack: git(repo, ['count-objects', '-vH']).toString().match(/^size-pack: (.+)$/m)?.[1] || 'unknown' };
}
// Every commit on any ref, then every distinct blob once. Adds each matched value, name and email to `sensitive`.
async function scanHistory(repo, mainRef, terms, sensitive) {
  const list = terms || [];
  const all = revList(repo, ['--all', '--reverse', '--topo-order']), main = new Set(revList(repo, [mainRef]));
  const commits = readCommits(repo), pairs = new Map(), mainPaths = new Map(), identities = { all: [], main: [] };
  const rows = new Map(), hosts = new Map();
  function collect(result, commit, file, onMain) {
    for (const value of result.sensitive) sensitive.add(value);
    for (const host of result.hosts) {
      const entry = hosts.get(host) || { all: 0, main: 0 };
      entry.all++; if (onMain) entry.main++; hosts.set(host, entry);
    }
    for (const item of result.hits) {
      const key = JSON.stringify([item.class, item.sub, commit, item.sub === 'test-videos' ? '[test_videos]' : file]);
      const row = rows.get(key) || { ...item, commit, path: shownPath(file), all: 0, main: 0, samples: new Set() };
      if (item.sample && (item.class === 1 || !row.samples.size)) row.samples.add(item.sample);
      row.all++; if (onMain) row.main++; rows.set(key, row);
    }
  }
  for (const id of all) {
    const meta = commits.get(id);
    if (!meta) throw new Error('commit metadata missing');
    const onMain = main.has(id);
    for (const name of meta.names) sensitive.add(name);
    for (const email of meta.emails) { sensitive.add(email); identities.all.push({ email }); if (onMain) identities.main.push({ email }); }
    for (const input of [meta.message, ...meta.names, ...meta.emails]) collect(scanText(input, list), id, '[commit]', onMain);
    for (const entry of git(repo, ['ls-tree', '-r', '-z', '--full-tree', id]).toString().split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t'), info = entry.slice(0, tab).split(' '), file = entry.slice(tab + 1);
      if (info[1] !== 'blob') continue;
      const kind = pathKind(file);
      if (kind.test || kind.ext) sensitive.add(file.split('/').at(-1));
      const blob = info[2], key = `${blob}\0${file}`;
      const pair = pairs.get(key) || { blob, file, commit: id, main: false };
      if (onMain) { pair.main = true; if (!mainPaths.has(blob)) mainPaths.set(blob, file); }
      pairs.set(key, pair);
    }
  }
  const byBlob = new Map();
  for (const pair of pairs.values()) { if (!byBlob.has(pair.blob)) byBlob.set(pair.blob, []); byBlob.get(pair.blob).push(pair); }
  let binary = 0;
  await blobs(repo, [...byBlob.keys()], (id, bytes) => {
    const isBinary = bytes.subarray(0, 8000).includes(0);
    if (isBinary) binary++;
    const content = isBinary ? null : scanText(bytes.toString('utf8'), list);
    for (const pair of byBlob.get(id)) {
      collect(scanPath(pair.file, bytes.length, list), pair.commit, pair.file, pair.main);
      if (content) collect(content, pair.commit, pair.file, pair.main);
    }
  });
  return { main, rows, hosts, identities, mainPaths, binary };
}
const rowsOf = (rows, n) => [...rows.values()].filter((row) => row.class === n);
const NOT_RUN = 'not run (no terms file)';
function tally(rows, identities, terms) {
  const counts = {};
  for (const n of [1, 3, 4, 5, 6]) {
    const selected = rowsOf(rows, n);
    counts[n] = n === 1 && !terms ? { all: NOT_RUN, main: NOT_RUN } : {
      all: selected.reduce((sum, row) => sum + row.all, 0), main: selected.reduce((sum, row) => sum + row.main, 0),
    };
  }
  counts[2] = { all: identityCounts(identities.all), main: identityCounts(identities.main) };
  const bySub = {};
  for (const row of rows.values()) {
    const key = `${row.class}:${row.sub}`, entry = bySub[key] || { all: 0, main: 0, rows: 0 };
    entry.all += row.all; entry.main += row.main; entry.rows++; bySub[key] = entry;
  }
  counts.bySubclass = bySub;
  return counts;
}
const countLine = (counts, n) => n === 2 ? `${counts[2].all.distinct} distinct / ${counts[2].all.nonNoreply} non-noreply | ${counts[2].main.distinct} distinct / ${counts[2].main.nonNoreply} non-noreply` : `${counts[n].all} | ${counts[n].main}`;
const share = (volume, size) => volume.packedBytes ? (100 * size / volume.packedBytes).toFixed(2) : '0.00';
const subclasses = (counts) => Object.entries(counts.bySubclass).sort();
function reportText({ head, mainHead, cmd, counts, rows, hosts, volume, terms }) {
  const lines = ['# Whole-history check', '', `HEAD: ${head}`, `Main head: ${mainHead}`, `Command: node ${cmd}`, `Date: ${new Date().toISOString()}`, '', '| Class | All refs | From main |', '|---|---:|---:|'];
  for (let n = 1; n <= 6; n++) lines.push(`| ${n} | ${countLine(counts, n)} |`);
  lines.push('', '| Class: sub-class | Occurrences, all refs | From main | Rows (commit, path) |', '|---|---:|---:|---:|');
  for (const [key, entry] of subclasses(counts)) lines.push(`| ${key} | ${entry.all} | ${entry.main} | ${entry.rows} |`);
  for (let n = 1; n <= 6; n++) {
    lines.push('', `## Class ${n}`, '');
    const selected = rowsOf(rows, n);
    if (n === 2) lines.push('Identity counts appear above; addresses and names are omitted.');
    else if (!selected.length) lines.push(n === 1 && !terms ? 'Not run (no terms file).' : 'No findings.');
    // Capped per sub-class, rarest first: a common shape must not crowd a rare one out of the report.
    const subs = [...new Set(selected.map((row) => row.sub))]
      .map((sub) => selected.filter((row) => row.sub === sub)).sort((a, b) => a.length - b.length);
    for (const group of subs) {
      for (const row of group.slice(0, 500)) lines.push(`- ${row.sub}; ${row.commit.slice(0, 12)}; ${row.path}; count ${row.all} (main ${row.main})${row.samples.size ? `; ${[...row.samples].join(', ')}` : ''}${row.size ? `; ${row.size} bytes` : ''}`);
      if (group.length > 500) lines.push(`${group.length - 500} more ${group[0].sub} rows omitted.`);
    }
  }
  lines.push('', '## Hosts', '', '| Host | All refs | From main |', '|---|---:|---:|');
  for (const [host, count] of hosts) lines.push(`| ${host} | ${count.all} | ${count.main} |`);
  lines.push('', '## Volume', '', `Main commits: ${volume.commitsMain}`, `Reachable packed bytes: ${volume.packedBytes}`, `Skipped binary blobs: ${volume.binaryBlobsSkipped}`, `Repository size-pack: ${volume.sizePack}`, '', 'Each object is counted once; blobs use their first observed main path and other objects go in everything else.', '', 'Packed bytes by tree:');
  for (const [group, size] of Object.entries(volume.groups)) lines.push(`- ${group}: ${size} (${share(volume, size)}%)`);
  lines.push('', 'Largest blobs on main:');
  for (const item of volume.largest) lines.push(`- ${item.size} bytes; ${item.path}`);
  return lines.join('\n') + '\n';
}
function summaryText({ head, mainHead, counts, volume }) {
  const output = [`HEAD: ${head}`, `Main head: ${mainHead}`];
  for (let n = 1; n <= 6; n++) output.push(`Class ${n} (all | main): ${countLine(counts, n)}`);
  for (const [key, entry] of subclasses(counts)) output.push(`  ${key}: ${entry.all} | ${entry.main} (${entry.rows} rows)`);
  output.push(`Main commits: ${volume.commitsMain}; packed bytes: ${volume.packedBytes}; skipped binary blobs: ${volume.binaryBlobsSkipped}; size-pack: ${volume.sizePack}`);
  for (const [group, size] of Object.entries(volume.groups)) output.push(`${group}: ${size} bytes (${share(volume, size)}%)`);
  for (const item of volume.largest) output.push(`${item.size} bytes; ${item.path}`);
  return output.join('\n');
}
async function run() {
  const opt = options(process.argv.slice(2));
  if (fs.existsSync(opt.report)) throw new Error('report already exists');
  if (opt.json && fs.existsSync(opt.json)) throw new Error('JSON already exists');
  if (opt.json && path.resolve(opt.json) === path.resolve(opt.report)) throw new Error('report and JSON paths must differ');
  const terms = readTerms(opt.repo, opt.terms);
  const sensitive = new Set((terms || []).map((term) => term.value));
  const mainHead = git(opt.repo, ['rev-parse', '--verify', `${opt.main}^{commit}`]).toString().trim();
  const head = git(opt.repo, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const { main, rows, hosts, identities, mainPaths, binary } = await scanHistory(opt.repo, opt.main, terms, sensitive);
  const counts = tally(rows, identities, terms);
  const volume = { commitsMain: main.size, binaryBlobsSkipped: binary, ...objectVolume(opt.repo, opt.main, mainPaths) };
  const cmd = process.argv.slice(1).map((arg, i, args) => args[i - 1] === '--terms' ? '<terms file>' : arg).join(' ');
  const scrub = (value) => cleanText(value, sensitive);
  fs.writeFileSync(opt.report, scrub(reportText({ head, mainHead, cmd, counts, rows, hosts, volume, terms })), { flag: 'wx' });
  if (opt.json) fs.writeFileSync(opt.json, scrub(JSON.stringify({ counts }, null, 2)) + '\n', { flag: 'wx' });
  console.log(scrub(summaryText({ head, mainHead, counts, volume })));
}
run().catch((error) => {
  const reason = REFUSALS.has(error.message) ? error.message : 'scan could not complete';
  console.error(`history check: ${reason}`);
  process.exitCode = reason.startsWith('terms file') ? 2 : 1;
});
