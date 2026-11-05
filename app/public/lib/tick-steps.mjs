// public/lib/tick-steps.mjs
//
// The page tick's step isolation: a throwing step is reported under its own
// name and never skips the steps after it. Pure.

/**
 * @param {Array<[string, () => void]>} steps
 * @param {(name: string, error: unknown) => void} report
 */
export function runTickSteps(steps, report) {
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (error) {
      try {
        report(name, error);
      } catch {
        // Nothing is left to tell.
      }
    }
  }
}
