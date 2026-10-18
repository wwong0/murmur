import { assertEqual, check } from '../harness.mjs';
import { titleDue } from '../../../public/lib/host-status.mjs';

const TITLE_A = `v1:${'a'.repeat(64)}`;
const TITLE_B = `v1:${'b'.repeat(64)}`;

const readyA = Object.freeze({ state: 'ready', identity: TITLE_A });
const stateA = Object.freeze({ title: TITLE_A });
const stateB = Object.freeze({ title: TITLE_B });

export default async function titleGateSuite() {
  await check('title-gate: same identity is not due', async () => {
    assertEqual(titleDue({ own: readyA, state: stateA }), null, 'same report and state identity returns null');
  });

  await check('title-gate: different identity returns the report identity', async () => {
    assertEqual(titleDue({ own: readyA, state: stateB }), TITLE_A, 'different title returns the ready report identity');
  });

  await check('title-gate: a state without a title is different', async () => {
    assertEqual(titleDue({ own: readyA, state: {} }), TITLE_A, 'missing state title counts as different');
  });

  await check('title-gate: no state cannot issue a title', async () => {
    assertEqual(titleDue({ own: readyA, state: null }), null, 'null state returns null');
    assertEqual(titleDue({ own: readyA }), null, 'omitted state returns null');
  });

  await check('title-gate: a non-ready report cannot issue a title', async () => {
    assertEqual(titleDue({ own: { state: 'preparing', identity: TITLE_A }, state: stateB }), null, 'preparing report returns null');
    assertEqual(titleDue({ own: { state: 'choosing', identity: TITLE_A }, state: stateB }), null, 'choosing report returns null');
  });

  await check('title-gate: dir readiness without an identity leaves title absent', async () => {
    assertEqual(titleDue({ own: { state: 'ready' }, state: stateB }), null, 'ready report without identity returns null');
  });

  await check('title-gate: one-field changes preserve the decision boundary', async () => {
    assertEqual(titleDue({ own: { ...readyA, state: 'preparing' }, state: stateA }), null, 'only own state changed blocks');
    assertEqual(titleDue({ own: readyA, state: { ...stateA, title: TITLE_B } }), TITLE_A, 'only state title changed issues');
    assertEqual(titleDue({ own: { ...readyA, identity: TITLE_B }, state: stateA }), TITLE_B, 'only report identity changed issues');
  });
}
