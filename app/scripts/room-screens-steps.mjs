const FIELDS = ['malformed', 'stale', 'notPermitted', 'notApplicable'];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const failure = (error, deltas = null) => ({ ok: false, class: null, deltas, error });

// Reads the viewer's rejected counters either side of the host's end pause. It accepts a
// notPermitted rejection, a stale one, or none issued, each with no malformed or
// notApplicable rise, and fails everything else (change 12a F21, design.md D18).
export function classifyEndPause(before, after) {
  if (!object(before) || !object(after)) return failure('viewer timeline absent');
  const bad = FIELDS.find((field) => !finite(before[field]) || !finite(after[field]));
  if (bad) return failure(`${bad} is not a number`);
  const deltas = Object.fromEntries(FIELDS.map((field) => [field, after[field] - before[field]]));
  const negative = FIELDS.find((field) => deltas[field] < 0);
  if (negative) return failure(`${negative} delta is negative`, deltas);
  if (deltas.malformed !== 0 || deltas.notApplicable !== 0) return failure('unexpected malformed or notApplicable rejection', deltas);
  if (deltas.notPermitted === 1 && deltas.stale === 0) return { ok: true, class: 'rejected notPermitted', deltas, error: null };
  if (deltas.notPermitted === 0 && deltas.stale === 1) return { ok: true, class: 'rejected stale', deltas, error: null };
  if (deltas.notPermitted === 0 && deltas.stale === 0) return { ok: true, class: 'never issued', deltas, error: null };
  return failure('unexpected deltas', deltas);
}

// The poll's stop condition: a stale or notPermitted rejection has landed since `before`.
export function endPauseSettled(before, after) {
  if (!object(before) || !object(after)) return false;
  if (![before.stale, before.notPermitted, after.stale, after.notPermitted].every(finite)) return false;
  return (after.stale + after.notPermitted) - (before.stale + before.notPermitted) >= 1;
}
