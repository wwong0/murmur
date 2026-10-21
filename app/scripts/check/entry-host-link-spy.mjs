// scripts/check/entry-host-link-spy.mjs
//
// The real host link, with each `reclassify` call counted on the entry harness so
// a test can see the page tick reach it.

import { createHostLink as createRealHostLink } from '../../public/lib/host-link.mjs';

export * from '../../public/lib/host-link.mjs';

export function createHostLink(config) {
  const link = createRealHostLink(config);
  const reclassify = link.reclassify;
  link.reclassify = (...args) => {
    const harness = globalThis.__entryHarness;
    harness.reclassifyCalls = (harness.reclassifyCalls ?? 0) + 1;
    return reclassify.apply(link, args);
  };
  return link;
}
