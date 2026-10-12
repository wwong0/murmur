function missing(error) {
  return error?.name === 'NotFoundError';
}

async function preparedDirectory(root, create = false) {
  return create ? root.getDirectoryHandle('prepared', { create: true }) : root.getDirectoryHandle('prepared');
}

export function createOpfsBackend(getRoot) {
  async function handles(key, name, create = false) {
    const root = await getRoot();
    const prepared = await preparedDirectory(root, create);
    const directory = create
      ? await prepared.getDirectoryHandle(key, { create: true })
      : await prepared.getDirectoryHandle(key);
    const file = create
      ? await directory.getFileHandle(name, { create: true })
      : await directory.getFileHandle(name);
    return { directory, file };
  }

  return {
    async list() {
      const root = await getRoot();
      let prepared;
      try {
        prepared = await preparedDirectory(root);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const names = [];
      for await (const [name, handle] of prepared.entries()) {
        if (handle.kind === 'directory') names.push(name);
      }
      return names;
    },

    async has(dir, name) {
      try {
        const { file } = await handles(dir, name);
        await file.getFile();
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },

    async read(dir, name) {
      try {
        const { file } = await handles(dir, name);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },

    async write(dir, name, bytes) {
      const { file } = await handles(dir, name, true);
      const access = await file.createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(bytes, { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    },

    async remove(dir) {
      const root = await getRoot();
      let prepared;
      try {
        prepared = await preparedDirectory(root);
        await prepared.removeEntry(dir, { recursive: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}

export function createWebLocks(lockManager) {
  return {
    hold(name) {
      return new Promise((resolve, reject) => {
        try {
          const request = lockManager.request(name, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(null);
              return undefined;
            }
            let release;
            const pending = new Promise((done) => { release = done; });
            resolve(() => release());
            return pending;
          });
          Promise.resolve(request).catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    },
  };
}
