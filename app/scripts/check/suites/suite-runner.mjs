// The running order survives a suite that throws (14d design.md D7).
import { assertEqual, check } from '../harness.mjs';
import { runSuites } from '../run-suites.mjs';

export default async function suiteRunnerSuite() {
  await check('suite runner: a throw at import or in a body is one failure each, and the rest run', async () => {
    const ran = [];
    const thrown = [];
    const modules = {
      first: { default: async () => { ran.push('first'); } },
      body: { default: async () => { ran.push('body'); throw new Error('body threw'); } },
      last: { default: async () => { ran.push('last'); } },
      notFunction: { default: 42 },
    };
    const load = async (name) => {
      if (name === 'import') throw new Error('import threw');
      return modules[name];
    };
    await runSuites(['first', 'import', 'body', 'notFunction', 'last'], {
      load,
      onThrow: (name, error) => thrown.push(`${name}:${error.message}`),
    });
    assertEqual(ran.join(','), 'first,body,last', 'every loadable suite ran, in order, past the throws');
    assertEqual(thrown.join('|'), 'import:import threw|notFunction:suite notFunction has no default export function|body:body threw',
      'each throw is reported once, named for its suite; import failures before any body runs');
  });

  await check('suite runner: every suite is imported before the first one runs', async () => {
    const events = [];
    await runSuites(['a', 'b'], {
      load: async (name) => { events.push(`load ${name}`); return { default: async () => { events.push(`run ${name}`); } }; },
      onThrow: () => { events.push('threw'); },
    });
    assertEqual(events.join(','), 'load a,load b,run a,run b', 'imports precede runs');
  });
}
