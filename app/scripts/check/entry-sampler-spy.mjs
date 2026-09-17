// scripts/check/entry-sampler-spy.mjs
//
// The real frame sampler, with its construction, starts and stops logged to the
// entry harness so a test can order them against the pitch write and the
// scheduled start's actions.

import { createFrameSampler as createRealSampler } from '../../public/lib/frame-sampler.mjs';

export * from '../../public/lib/frame-sampler.mjs';

export function createFrameSampler(config) {
  const harness = globalThis.__entryHarness;
  harness.log('sampler-created');
  const sampler = createRealSampler(config);
  return new Proxy(sampler, {
    get(target, key) {
      if (key === 'start' || key === 'stop') {
        return (...args) => {
          harness.log(`sampler-${key}`);
          return target[key](...args);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
