import { REMUX_FORMAT_VERSION, targetMillis } from './remux-settings.mjs';
import { FILE_IDENTITY_PATTERN } from './file-identity.mjs';

export const MANIFEST_NAME = 'content-manifest.json';

export function storeKey({ identity, targetSeconds }) {
  if (typeof identity !== 'string' || !FILE_IDENTITY_PATTERN.test(identity)) {
    throw new TypeError('identity must match v1:<64 lowercase hexadecimal characters>');
  }
  return `${identity.replace(':', '-')}-t${targetMillis(targetSeconds)}-f${REMUX_FORMAT_VERSION}`;
}

export function lockName(key) {
  return `watchalong-prepared:${key}`;
}

export function storageFit({ sourceBytes, estimate }) {
  const freeBytes = Number.isFinite(estimate?.quota)
    && Number.isFinite(estimate?.usage)
    && estimate.quota >= estimate.usage
    ? estimate.quota - estimate.usage
    : null;
  return { fits: freeBytes !== null && sourceBytes <= freeBytes, neededBytes: sourceBytes, freeBytes };
}

export function createPreparedStore({ backend, locks }) {
  async function sweep({ keep = null } = {}) {
    const removed = [];
    const kept = [];
    for (const name of await backend.list()) {
      if (name === keep) {
        kept.push(name);
        continue;
      }
      const release = await locks.hold(lockName(name));
      if (release === null) {
        kept.push(name);
        continue;
      }
      try {
        await backend.remove(name);
        removed.push(name);
      } finally {
        release();
      }
    }
    return { removed, kept };
  }

  async function isComplete(key) {
    return backend.has(key, MANIFEST_NAME);
  }

  async function read(key, name) {
    if (!(await isComplete(key))) return { status: 404, bytes: new Uint8Array() };
    const bytes = await backend.read(key, name);
    return bytes === null ? { status: 404, bytes: new Uint8Array() } : { status: 200, bytes };
  }

  function sink(key) {
    return { write: (name, bytes) => backend.write(key, name, bytes) };
  }

  async function remove(key) {
    try {
      await backend.remove(key);
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
  }

  return { sweep, isComplete, read, sink, remove };
}
