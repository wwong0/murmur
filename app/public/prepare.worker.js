import { createPreparedStore } from './lib/prepared-store.mjs';
import { createOpfsBackend } from './lib/prepared-store-opfs.mjs';
import { createPrepareRunner } from './lib/prepare-runner.mjs';

const store = createPreparedStore({
  backend: createOpfsBackend(() => navigator.storage.getDirectory()),
  locks: { hold: async () => null },
});
const runner = createPrepareRunner({ store, buildId: __BUILD_ID__, post: (message) => self.postMessage(message) });
self.onmessage = (event) => { void runner(event.data); };
