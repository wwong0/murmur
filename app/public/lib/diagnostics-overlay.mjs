// public/lib/diagnostics-overlay.mjs
//
// The three diagnostics lines the page paints: clock estimate, drift read-out
// and controller state. This module returns those lines as data; room.entry.js
// remains the only code that touches the DOM.
//
// TRAP: `lines()` consumes the stateful drift read-out once per paint. Calling
// it twice can report a healthy client as silent.
//
// Under public/lib/: no DOM, no page access.

import { createDriftReadout, signed } from './drift-readout.mjs';
import { CLOSE_BUDGET_MS, MAX_STOPPING_THRESHOLD_MS } from './drift-controller.mjs';

export const CLOCK_LINE_NO_ESTIMATE = 'clock: no estimate yet';
export const CLOCK_LINE_RE =
  /^clock: [+-]\d+\.\d+ms ± \d+\.\d+ms \(\d+ samples\)$/;

/**
 * TWO SHAPES, ONE PER ARM, AND NOTHING OPTIONAL INSIDE EITHER (design.md D1).
 * One pattern spanning both is satisfied by a page stuck in `waiting · no-clock`,
 * and a `?` around the figures admits a `correcting` line showing nothing it
 * corrected from. Neither is a state the controller can reach.
 */
export const CONTROLLER_LINE_HELD_RE =
  /^controller: rate \d+\.\d{6} · (?:(?:waiting · (?:no-clock|too-few-records))|(?:stale · no-records)) over \d+ frames$/;
const CONTROLLER_NUM = '[+-]?\\d+\\.\\d+';
const CONTROLLER_RATE = '\\d+\\.\\d{6}';
const CONTROLLER_TAIL = 'over \\d+ frames';
const CONTROLLER_SEPARATOR = '\\xB7';

/** One shape per reachable acting branch; every branch-specific figure is required. */
export const CONTROLLER_LINE_MEASUREMENT_LIMIT_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} · declining · measurement-limit · measurement arm (?:clock|dispersion|clock-and-dispersion) · error ${CONTROLLER_NUM}ms · U ${CONTROLLER_NUM}ms · actuator allowance ${CONTROLLER_NUM}ms · stopping threshold ${CONTROLLER_NUM}ms ${CONTROLLER_TAIL}$`,
);
export const CONTROLLER_LINE_ACTUATOR_LIMIT_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} · declining · actuator-limit · error ${CONTROLLER_NUM}ms · U ${CONTROLLER_NUM}ms · actuator allowance ${CONTROLLER_NUM}ms · stopping threshold ${CONTROLLER_NUM}ms ${CONTROLLER_TAIL}$`,
);
export const CONTROLLER_LINE_BUDGET_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} · resolution-budget-hold · stopping-threshold-over-budget · required S ${CONTROLLER_NUM}ms · ceiling 20\\.0ms refused ${CONTROLLER_TAIL}$`,
);
export const CONTROLLER_LINE_SETTLED_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} · settled · error ${CONTROLLER_NUM}ms · U ${CONTROLLER_NUM}ms · actuator allowance ${CONTROLLER_NUM}ms · stopping threshold ${CONTROLLER_NUM}ms · applied rate ${CONTROLLER_RATE} ${CONTROLLER_TAIL}$`,
);
const CONTROLLER_CLOSING_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} · (?:correcting|beyond-rate-authority) · error ${CONTROLLER_NUM}ms · U ${CONTROLLER_NUM}ms · actuator allowance ${CONTROLLER_NUM}ms · stopping threshold ${CONTROLLER_NUM}ms · close lower bound ${CONTROLLER_NUM}s \\(close budget ${CONTROLLER_NUM}s\\) ${CONTROLLER_TAIL}$`,
);
export const CONTROLLER_LINE_CORRECTING_RE = new RegExp(CONTROLLER_CLOSING_RE.source.replace('(?:correcting|beyond-rate-authority)', 'correcting'));
export const CONTROLLER_LINE_BEYOND_RE = new RegExp(CONTROLLER_CLOSING_RE.source.replace('(?:correcting|beyond-rate-authority)', 'beyond-rate-authority'));
/** The zero-authority arm has no finite close projection; the literal token keeps
 * that absence explicit while requiring every other beyond-authority figure. */
export const CONTROLLER_LINE_BEYOND_UNAVAILABLE_RE = new RegExp(
  `^controller: rate ${CONTROLLER_RATE} ${CONTROLLER_SEPARATOR} beyond-rate-authority ${CONTROLLER_SEPARATOR} error ${CONTROLLER_NUM}ms ${CONTROLLER_SEPARATOR} U ${CONTROLLER_NUM}ms ${CONTROLLER_SEPARATOR} actuator allowance ${CONTROLLER_NUM}ms ${CONTROLLER_SEPARATOR} stopping threshold ${CONTROLLER_NUM}ms ${CONTROLLER_SEPARATOR} close lower bound unavailable \\(close budget ${CONTROLLER_NUM}s\\) ${CONTROLLER_TAIL}$`,
);
/** Compatibility union for consumers that only need to know that a published acting shape matched. */
export const CONTROLLER_LINE_ACTING_RE = new RegExp([
  CONTROLLER_LINE_MEASUREMENT_LIMIT_RE.source.slice(1, -1),
  CONTROLLER_LINE_ACTUATOR_LIMIT_RE.source.slice(1, -1),
  CONTROLLER_LINE_BUDGET_RE.source.slice(1, -1),
  CONTROLLER_LINE_SETTLED_RE.source.slice(1, -1),
  CONTROLLER_LINE_CORRECTING_RE.source.slice(1, -1),
  CONTROLLER_LINE_BEYOND_RE.source.slice(1, -1),
  CONTROLLER_LINE_BEYOND_UNAVAILABLE_RE.source.slice(1, -1),
].join('|'));

function clockText({ offsetMs, halfWidthMs, sampleCount }) {
  if (offsetMs === null) return CLOCK_LINE_NO_ESTIMATE;
  return `clock: ${signed(offsetMs)} ± ${halfWidthMs.toFixed(1)}ms (${sampleCount} samples)`;
}

function finiteFields(state, fields) {
  return fields.every((field) => Number.isFinite(state[field]));
}

function controllerFigures(state) {
  const shared = ['estimateMs', 'bandMs', 'actuatorAllowanceMs', 'stoppingThresholdMs'];
  if (!finiteFields(state, shared) || state.thresholdUsable !== true) return null;
  return `error ${signed(state.estimateMs)} · U ${state.bandMs.toFixed(1)}ms · actuator allowance ${state.actuatorAllowanceMs.toFixed(1)}ms · stopping threshold ${state.stoppingThresholdMs.toFixed(1)}ms`;
}

/**
 * The line branches on accepted-threshold usability and then on the published
 * reason. Holds never display provisional figures; acting branches display all
 * fields their consumers need, so no regex arm can admit a missing figure.
 */
function controllerText(state) {
  const head = `controller: rate ${state.rate.toFixed(6)} · ${state.mode}`;
  const tail = `over ${state.windowRecords} frames`;
  if (state.thresholdUsable !== true) {
    if (state.mode === 'resolution-budget-hold' && state.reason === 'stopping-threshold-over-budget'
      && Number.isFinite(state.requiredStoppingThresholdMs)) {
      const ceiling = Number.isFinite(state.settings?.MAX_STOPPING_THRESHOLD_MS)
        ? state.settings.MAX_STOPPING_THRESHOLD_MS
        : MAX_STOPPING_THRESHOLD_MS;
      return `${head} · stopping-threshold-over-budget · required S ${state.requiredStoppingThresholdMs.toFixed(1)}ms · ceiling ${ceiling.toFixed(1)}ms refused ${tail}`;
    }
    return state.reason ? `${head} · ${state.reason} ${tail}` : `${head} ${tail}`;
  }

  const figures = controllerFigures(state);
  if (figures === null) return `${head} ${tail}`;
  if (state.mode === 'declining' && state.reason === 'measurement-limit' && state.measurementLimit) {
    return `${head} · measurement-limit · measurement arm ${state.measurementLimit} · ${figures} ${tail}`;
  }
  if (state.mode === 'declining' && state.reason === 'actuator-limit') {
    return `${head} · actuator-limit · ${figures} ${tail}`;
  }
  if (state.mode === 'settled') {
    if (!Number.isFinite(state.rate)) return `${head} ${tail}`;
    return `${head} · ${figures} · applied rate ${state.rate.toFixed(6)} ${tail}`;
  }
  if (state.mode === 'correcting' || state.mode === 'beyond-rate-authority') {
    const closeBudgetMs = Number.isFinite(state.settings?.CLOSE_BUDGET_MS)
      ? state.settings.CLOSE_BUDGET_MS
      : CLOSE_BUDGET_MS;
    // A zero rate authority cannot produce a finite close bound. Publish that
    // absence as a required literal rather than zero or a number; the branch's
    // error, U, allowance and accepted threshold remain visible and its shape
    // therefore cannot accept a line with any required figure missing.
    if (!Number.isFinite(state.fastestCloseMs)) {
      return `${head} \u00b7 ${figures} \u00b7 close lower bound unavailable (close budget ${(closeBudgetMs / 1000).toFixed(1)}s) ${tail}`;
    }
    return `${head} · ${figures} · close lower bound ${(state.fastestCloseMs / 1000).toFixed(1)}s (close budget ${(closeBudgetMs / 1000).toFixed(1)}s) ${tail}`;
  }
  return `${head} ${tail}`;
}

export function createDiagnosticsOverlay({ clock, controller, log, playback }) {
  const driftReadout = createDriftReadout({ log, playback });

  function lines() {
    return {
      clock: clockText(clock.read()),
      controller: controllerText(controller.state()),
      // LAST, and once: the only call here that consumes, so a throw above it would spend a window unpainted.
      drift: driftReadout.text(),
    };
  }

  return { lines };
}
