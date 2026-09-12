// scripts/check/entry-sampler-spy.mjs
//
// The real frame sampler, with its construction logged to the entry harness so
// a test can order it against the pitch write.

import { createFrameSampler as createRealSampler } from '../../public/lib/frame-sampler.mjs';

export * from '../../public/lib/frame-sampler.mjs';

export function createFrameSampler(config) {
  globalThis.__entryHarness.log('sampler-created');
  return createRealSampler(config);
}
