import { assertEqual, check } from '../harness.mjs';
import { classifyEndPause, endPauseSettled } from '../../room-screens-steps.mjs';

const zero = { malformed: 0, stale: 0, notPermitted: 0, notApplicable: 0 };
const bump = (patch) => Object.fromEntries(Object.entries(zero).map(([field, value]) => [field, value + (patch[field] ?? 0)]));

async function row(name, before, after, expected) {
  await check(`room-screens-steps: ${name}`, async () => {
    const got = classifyEndPause(before, after);
    assertEqual(got.ok, expected.ok, `${name} ok`);
    assertEqual(got.class, expected.class, `${name} class`);
    if (expected.error !== undefined) assertEqual(got.error, expected.error, `${name} error`);
  });
}

export default async function roomScreensStepsSuite() {
  await row('notPermitted rise is classed', zero, bump({ notPermitted: 1 }), { ok: true, class: 'rejected notPermitted' });
  await row('stale rise is classed', zero, bump({ stale: 1 }), { ok: true, class: 'rejected stale' });
  await row('no rise is never issued', zero, bump({}), { ok: true, class: 'never issued' });
  await row('deltas are taken from a nonzero base', bump({ stale: 4, notPermitted: 2 }), bump({ stale: 4, notPermitted: 3 }), { ok: true, class: 'rejected notPermitted' });
  await row('both rising fails', zero, bump({ stale: 1, notPermitted: 1 }), { ok: false, class: null, error: 'unexpected deltas' });
  await row('two notPermitted fails', zero, bump({ notPermitted: 2 }), { ok: false, class: null, error: 'unexpected deltas' });
  await row('a malformed rise fails an otherwise never-issued pause', zero, bump({ malformed: 1 }), { ok: false, class: null });
  await row('a notApplicable rise fails an otherwise never-issued pause', zero, bump({ notApplicable: 1 }), { ok: false, class: null });
  await row('a malformed rise fails a notPermitted class', zero, bump({ malformed: 1, notPermitted: 1 }), { ok: false, class: null });
  await row('a negative delta fails and is named', bump({ stale: 2 }), bump({ stale: 1 }), { ok: false, class: null, error: 'stale delta is negative' });
  await row('a string field fails and is named', { ...zero, notPermitted: '3' }, zero, { ok: false, class: null, error: 'notPermitted is not a number' });
  await row('a string field on the after side fails', zero, { ...zero, stale: '1' }, { ok: false, class: null, error: 'stale is not a number' });
  await row('NaN fails and is named', zero, { ...zero, notApplicable: NaN }, { ok: false, class: null, error: 'notApplicable is not a number' });
  await row('a missing field fails and is named', zero, { malformed: 0, stale: 0, notPermitted: 0 }, { ok: false, class: null, error: 'notApplicable is not a number' });
  await row('a null before is an absent timeline', null, zero, { ok: false, class: null, error: 'viewer timeline absent' });
  await row('a null after is an absent timeline', zero, null, { ok: false, class: null, error: 'viewer timeline absent' });
  await row('a non-object before is an absent timeline', 3, zero, { ok: false, class: null, error: 'viewer timeline absent' });

  await check('room-screens-steps: endPauseSettled is true at +1 on either field and false at 0', async () => {
    assertEqual(endPauseSettled(zero, bump({ notPermitted: 1 })), true, 'notPermitted +1');
    assertEqual(endPauseSettled(zero, bump({ stale: 1 })), true, 'stale +1');
    assertEqual(endPauseSettled(zero, bump({})), false, 'no rise');
    assertEqual(endPauseSettled(zero, bump({ malformed: 1, notApplicable: 1 })), false, 'other fields do not settle it');
    assertEqual(endPauseSettled(null, zero), false, 'null before');
    assertEqual(endPauseSettled(zero, null), false, 'null after');
    assertEqual(endPauseSettled(zero, { ...zero, stale: '1' }), false, 'string field');
  });
}
