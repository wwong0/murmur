// scripts/check/run-suites.mjs
//
// Imports every suite, then runs each in order. A suite that throws, at import
// or in its body outside a `check()`, is handed to `onThrow` and the run goes
// on: one missing file used to end the whole check with nothing reported after
// it. Importing all of them first keeps what the static
// imports did — every suite's module body has run before the first suite does.

export async function runSuites(names, { load, onThrow }) {
  const loaded = [];
  for (const name of names) {
    try {
      const suite = (await load(name)).default;
      if (typeof suite !== 'function') throw new TypeError(`suite ${name} has no default export function`);
      loaded.push([name, suite]);
    } catch (error) {
      onThrow(name, error);
    }
  }
  for (const [name, suite] of loaded) {
    try {
      await suite();
    } catch (error) {
      onThrow(name, error);
    }
  }
}
