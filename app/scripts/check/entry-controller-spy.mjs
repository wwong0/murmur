// scripts/check/entry-controller-spy.mjs
//
// The real product controller, with its construction and polls logged to the
// entry harness. Substituted for the entry's own import only, so the treatment
// adapter and everything else still see the one real module.

import { createDriftController as createRealController } from '../../public/lib/drift-controller.mjs';

export * from '../../public/lib/drift-controller.mjs';

export function createDriftController(config) {
  const harness = globalThis.__entryHarness;
  harness.log('controller-created', { f: config.settings?.MIN_COMMAND_DEVIATION });
  const controller = createRealController(config);
  const poll = () => {
    harness.log('controller-poll');
    return controller.poll();
  };
  return new Proxy(controller, {
    get(target, key) {
      if (key === 'poll') return poll;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
