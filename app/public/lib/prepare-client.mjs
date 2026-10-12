export function createPrepareClient({ worker }) {
  const pending = new Map();
  let nextId = 1;
  let lastBuildId = null;

  worker.addEventListener('message', (event) => {
    const reply = event.data;
    if (typeof reply?.buildId === 'string') lastBuildId = reply.buildId;
    const request = pending.get(reply?.id);
    if (!request) return;
    pending.delete(reply.id);
    request.resolve(reply);
  });

  worker.addEventListener('error', (event) => {
    const error = event.error ?? new Error(event.message ?? 'worker error');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  function call(message) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ ...message, id }); } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    inspect: (file) => call({ t: 'inspect', file }),
    prepare: (file, key, targetSeconds) => call({ t: 'prepare', file, key, targetSeconds }),
    buildId: () => lastBuildId,
  };
}
