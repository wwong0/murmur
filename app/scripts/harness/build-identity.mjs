import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSAL_SCOPE } from './arms.mjs';

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const BUNDLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/room.bundle.js');

export function readBundleBuildId(file = BUNDLE_PATH) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return source.match(/\bBUILD_ID\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function readPageBuildId(session) {
  try {
    const value = await session.tab.evaluate('window.__app && typeof window.__app.buildId === "string" ? window.__app.buildId : null');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function recordPageBuildIds(kind, { sessions = [], hostSession = null, runDir }) {
  const host = hostSession ?? sessions.find((session) => session.role === 'host') ?? null;
  const viewers = sessions.filter((session) => session.role === 'viewer');
  const hostBuildId = host ? await readPageBuildId(host) : null;
  const viewerBuildIds = Object.fromEntries(await Promise.all(viewers.map(async (session) => {
    const buildId = await readPageBuildId(session);
    session.pageBuildId = buildId;
    return [session.tag, buildId];
  })));
  if (host) host.pageBuildId = hostBuildId;
  // Read at the boundary: a later recompute must not judge the run by a later build.
  const identity = { host: hostBuildId, viewers: viewerBuildIds, disk: readBundleBuildId() };
  writeJson(path.join(runDir, `build-ids-${kind}.json`), identity);
  return identity;
}

export function buildIdentityFromRun(runDir) {
  const identity = readJson(path.join(runDir, 'build-ids-end.json'))
    ?? readJson(path.join(runDir, 'build-ids-start.json'));
  return identity ?? null;
}

/** A run directory's identities as a reader takes them: the start record, then the latest. */
export function runIdentities(runDir) {
  return [readJson(path.join(runDir, 'build-ids-start.json')), buildIdentityFromRun(runDir)];
}

/** Every distinct build id the identities name — host, disk and each viewer — in first-seen order. */
export function runBuildIds(identities) {
  return [...new Set(identities.filter(Boolean).flatMap((identity) => [identity.host, identity.disk,
    ...Object.values(identity.viewers ?? {})]))];
}

export function buildRefusalDetails(identity) {
  if (!identity) return [];
  const details = [];
  const hostBuildId = identity.host ?? null;
  const diskBuildId = identity.disk ?? null;
  for (const [tag, viewerBuildId] of Object.entries(identity.viewers ?? {})) {
    if (hostBuildId === null || viewerBuildId === null || hostBuildId !== viewerBuildId) {
      details.push({ pair: 'host-viewer', viewer: tag, hostBuildId, viewerBuildId });
    }
    if (viewerBuildId === null || diskBuildId === null || viewerBuildId !== diskBuildId) {
      details.push({ pair: 'viewer-disk', viewer: tag, viewerBuildId, diskBuildId });
    }
  }
  if (hostBuildId === null || diskBuildId === null || hostBuildId !== diskBuildId) {
    details.push({ pair: 'host-disk', hostBuildId, diskBuildId });
  }
  return details;
}

export function buildRefusals(input, addReason) {
  if (!input.buildIdentity) return;
  for (const detail of buildRefusalDetails(input.buildIdentity)) {
    addReason('build-mismatch', REFUSAL_SCOPE.build, detail);
  }
}
