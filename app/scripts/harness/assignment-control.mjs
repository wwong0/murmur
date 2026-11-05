// The 8b assignment control is declared by the condition,
// supplied to every page before it loads, read back from every page twice, and
// a page that did not run what the condition declared refuses the run.

import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_ARCHIVED, CONTROL_PRODUCT } from '../../public/lib/edge-control.mjs';

export const CONTROL_FILE = 'assignment-control.json';

const declares = (condition) => Object.prototype.hasOwnProperty.call(condition ?? {}, 'assignmentControl');

export function assignmentControlReason(condition = {}) {
  if (!declares(condition)) return null;
  return condition.assignmentControl === CONTROL_ARCHIVED && condition.peerExchange === true
    ? null : 'assignment-control-invalid';
}

/** The pre-load script of a declaring condition, or null. No other value is ever supplied. */
export function controlInjection(condition = {}) {
  return condition?.assignmentControl === CONTROL_ARCHIVED ? `globalThis.__waControl = ${JSON.stringify(CONTROL_ARCHIVED)};` : null;
}

// The probe's shape is asserted before anything is derived from it.
export function assertControlReading(page, reading) {
  const shaped = reading !== null && typeof reading === 'object'
    && (reading.control === CONTROL_ARCHIVED || reading.control === CONTROL_PRODUCT)
    && typeof reading.supplied === 'boolean'
    && (reading.error === null || typeof reading.error === 'string');
  if (!shaped) throw new Error(`assignment-control-reading-malformed: ${page}: ${JSON.stringify(reading ?? null)}`);
  return { control: reading.control, supplied: reading.supplied, error: reading.error };
}

export async function readControls(tabs, { now = Date.now } = {}) {
  const byPage = {};
  for (const [page, tab] of Object.entries(tabs)) {
    byPage[page] = assertControlReading(page, await tab.evaluate('__app.control()'));
  }
  return { byPage, atMs: now() };
}

export const controlTabs = (sessions) => Object.fromEntries(sessions.map((session) => [session.tag, session.tab]));

/** Reads every page once more, and keeps the run's readings in its directory and manifest. */
export async function recordControls({ condition, sessions, record = { declared: condition.assignmentControl ?? null, readings: [] }, runDir, manifestFile, now }) {
  record.readings.push(await readControls(controlTabs(sessions), { now }));
  fs.writeFileSync(path.join(runDir, CONTROL_FILE), `${JSON.stringify(record, null, 2)}\n`);
  manifestFile.merge({ assignmentControl: record });
  return record;
}

/**
 * One refusal per page and fault. `readings` is the run's two, after the joins
 * and at the end boundary; a run that kept none is refused whole, since nothing
 * then says which control its pages ran.
 */
export function controlRefusals(condition = {}, readings = [], { rosterPage = null } = {}) {
  const declared = declares(condition) ? condition.assignmentControl : CONTROL_PRODUCT;
  if (!Array.isArray(readings) || readings.length === 0) return [{ reason: 'assignment-control-unread', declared }];
  const refusals = [];
  for (const reading of readings) {
    for (const [page, raw] of Object.entries(reading.byPage)) {
      const value = assertControlReading(page, raw);
      const at = { page, atMs: reading.atMs };
      if (value.control !== declared) refusals.push({ reason: 'assignment-control-mismatch', ...at, declared, control: value.control });
      if (value.error !== null) refusals.push({ reason: 'assignment-control-error', ...at, error: value.error });
      if (value.supplied && !declares(condition)) refusals.push({ reason: 'assignment-control-supplied', ...at, declared, control: value.control });
    }
  }
  const [first, ...later] = readings;
  for (const reading of later) {
    const pages = new Set([...Object.keys(first.byPage), ...Object.keys(reading.byPage)]);
    for (const page of pages) {
      const before = first.byPage[page] ? assertControlReading(page, first.byPage[page]) : null;
      const after = reading.byPage[page] ? assertControlReading(page, reading.byPage[page]) : null;
      // The page a roster event added or removed is in one reading only.
      if (page === rosterPage && (before === null || after === null)) continue;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        refusals.push({ reason: 'assignment-control-changed', page, before, after });
      }
    }
  }
  return refusals;
}
