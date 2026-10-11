import { viewerOrder } from './edge-assignment.mjs';

function validVersion(value) {
  return value === null || Number.isInteger(value);
}

function validCandidate(value) {
  return value !== null && typeof value === 'object'
    && typeof value.clientId === 'string' && value.clientId.length > 0
    && validVersion(value.heldVersion);
}

export function electCreator({ selfId, selfHeldVersion, answers } = {}) {
  if (typeof selfId !== 'string' || selfId.length === 0 || !validVersion(selfHeldVersion)
    || !Array.isArray(answers)) return null;
  const candidates = [{ clientId: selfId, heldVersion: selfHeldVersion }, ...answers];
  if (!candidates.every(validCandidate)) return null;
  const highest = candidates.reduce((version, candidate) => {
    if (candidate.heldVersion === null) return version;
    return version === null ? candidate.heldVersion : Math.max(version, candidate.heldVersion);
  }, null);
  const ids = candidates
    .filter((candidate) => candidate.heldVersion === highest)
    .map((candidate) => ({ clientId: candidate.clientId, role: 'viewer' }));
  return viewerOrder(ids)[0] ?? null;
}
