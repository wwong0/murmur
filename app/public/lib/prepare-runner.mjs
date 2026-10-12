import { fileIdentity } from './file-identity.mjs';
import { RemuxRefusal, readSourceIndex } from './remux-index.mjs';
import { prepare } from './remux.mjs';

export function fileSource(file) {
  return {
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

function errorMessage(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

export function createPrepareRunner({ store, buildId, post }) {
  function reply(data) {
    post({ ...data, buildId });
  }

  async function inspect(data) {
    const source = fileSource(data.file);
    const index = await readSourceIndex(source);
    const identity = await fileIdentity(source);
    return {
      t: 'inspected', id: data.id, identity, sourceBytes: source.size,
      tracks: { video: { codec: index.video.codec }, audio: index.audio ? { codec: index.audio.codec } : null },
    };
  }

  async function prepareFile(data) {
    await store.remove(data.key);
    const manifest = await prepare({
      source: fileSource(data.file),
      sink: store.sink(data.key),
      targetSeconds: data.targetSeconds,
    });
    return { t: 'prepared', id: data.id, manifest };
  }

  return async function onMessage(data) {
    try {
      const result = data.t === 'inspect' ? await inspect(data) : data.t === 'prepare' ? await prepareFile(data) : null;
      if (result) reply(result);
    } catch (error) {
      if (data.t === 'prepare' && !(error instanceof RemuxRefusal)) await store.remove(data.key);
      if (error instanceof RemuxRefusal) reply({ t: 'refused', id: data.id, reason: error.reason, message: error.message });
      else reply({ t: 'failed', id: data.id, message: errorMessage(error) });
    }
  };
}
