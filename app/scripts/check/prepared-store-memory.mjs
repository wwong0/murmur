import { lockName } from '../../public/lib/prepared-store.mjs';

export function createFakeLockManager() {
  const held = new Set();
  const requests = [];
  return {
    held,
    requests,
    isHeld(name) {
      return held.has(name);
    },
    hold(name) {
      requests.push(name);
      if (held.has(name)) return Promise.resolve(null);
      held.add(name);
      return Promise.resolve(() => held.delete(name));
    },
    holdExternally(name) {
      held.add(name);
      return () => held.delete(name);
    },
  };
}

export function createMemoryBackend({ locks = null } = {}) {
  const directories = new Map();
  const writes = [];
  const removals = [];

  return {
    directories,
    writes,
    writeLog: writes,
    removals,
    list: async () => [...directories.keys()],
    has: async (dir, name) => directories.get(dir)?.has(name) ?? false,
    read: async (dir, name) => {
      const bytes = directories.get(dir)?.get(name);
      return bytes === undefined ? null : bytes.slice();
    },
    write: async (dir, name, bytes) => {
      if (!directories.has(dir)) directories.set(dir, new Map());
      directories.get(dir).set(name, new Uint8Array(bytes));
      writes.push({ dir, name });
    },
    remove: async (dir) => {
      removals.push({ dir, held: locks?.isHeld(lockName(dir)) ?? false });
      directories.delete(dir);
    },
  };
}

export const createFakeLocks = createFakeLockManager;
