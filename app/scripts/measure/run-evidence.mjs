import fs from 'node:fs';
import path from 'node:path';

import { timebaseJoin } from '../figures/control-figures.mjs';

const jsonFiles = ['content-manifest.json', 'seek.json', 'disturbance.json', 'roster-event.json',
  'assignment-control.json', 'published-figures.json'];
const ndjsonFiles = ['host-control-poll.ndjson', 'host-resumes.ndjson', 'origin-link.ndjson'];
function parseJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function optionalJson(runDir, fileName) {
  const filePath = path.join(runDir, fileName);
  return fs.existsSync(filePath) ? parseJson(filePath) : null;
}

function parseNdjson(runDir, fileName, truncated) {
  const filePath = path.join(runDir, fileName);
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trim() === '') return [];
  const lines = text.split(/\r?\n/).filter((line, index, all) => !(line === '' && index === all.length - 1));
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    try {
      values.push(JSON.parse(lines[index]));
    } catch (error) {
      if (index === lines.length - 1 || lines.slice(index + 1).every((line) => line.trim() === '')) {
        truncated[fileName] = (truncated[fileName] ?? 0) + 1;
        break;
      }
      throw new Error(`${fileName}: malformed NDJSON at line ${index + 1}: ${error.message}`);
    }
  }
  return values;
}

function readClient(runDir, tag, truncated) {
  const prefix = `client-${tag}`;
  return {
    drift: parseNdjson(runDir, `${prefix}.drift.ndjson`, truncated),
    peerBytes: parseNdjson(runDir, `${prefix}.peer-bytes.ndjson`, truncated),
    polls: parseNdjson(runDir, `${prefix}.poll.ndjson`, truncated),
    receipts: parseNdjson(runDir, `${prefix}.receipts.ndjson`, truncated),
    echo: parseNdjson(runDir, `${prefix}.echo.ndjson`, truncated),
    presence: parseNdjson(runDir, `${prefix}.presence.ndjson`, truncated),
    clockJoin: optionalJson(runDir, `${prefix}.clock-join.json`),
    viewerControl: parseNdjson(runDir, `viewer-control-${tag}.ndjson`, truncated),
  };
}

export function loadRunEvidence(runDir) {
  const resolvedDir = path.resolve(runDir);
  const manifestPath = path.join(resolvedDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest-missing');
  const manifest = parseJson(manifestPath);
  const tags = Array.isArray(manifest.declaredClientTags) ? [...manifest.declaredClientTags] : [];
  const truncated = {};
  const hostPoll = parseNdjson(resolvedDir, 'host-control-poll.ndjson', truncated);
  const clients = Object.fromEntries(tags.map((tag) => [tag, readClient(resolvedDir, tag, truncated)]));
  return {
    runDir: resolvedDir,
    run: path.basename(resolvedDir),
    manifest,
    condition: manifest.condition ?? null,
    tags,
    content: optionalJson(resolvedDir, 'content-manifest.json'),
    hostPoll,
    hostResumes: parseNdjson(resolvedDir, 'host-resumes.ndjson', truncated),
    originLink: parseNdjson(resolvedDir, 'origin-link.ndjson', truncated),
    seek: optionalJson(resolvedDir, 'seek.json'),
    disturbance: optionalJson(resolvedDir, 'disturbance.json'),
    rosterEvent: optionalJson(resolvedDir, 'roster-event.json'),
    assignmentControl: optionalJson(resolvedDir, 'assignment-control.json'),
    publishedFigures: optionalJson(resolvedDir, 'published-figures.json'),
    timebase: hostPoll?.length ? timebaseJoin(hostPoll) : null,
    clients,
    truncated,
  };
}
