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
  /^controller: rate \d\.\d{6} · [a-z-]+ · [a-z-]+ over \d+ frames$/;
export const CONTROLLER_LINE_ACTING_RE =
  /^controller: rate \d\.\d{6} · [a-z-]+ · estimate [+-]\d+\.\d+ms, deadband \d+\.\d+ms, closes in \d+\.\d+s over \d+ frames$/;

function clockText({ offsetMs, halfWidthMs, sampleCount }) {
  if (offsetMs === null) return CLOCK_LINE_NO_ESTIMATE;
  return `clock: ${signed(offsetMs)} ± ${halfWidthMs.toFixed(1)}ms (${sampleCount} samples)`;
}

/** One guard over all three, for the reason above: a per-figure guard builds part-lines. */
function figuresText({ estimateMs, bandMs, fastestCloseMs }) {
  if (!Number.isFinite(estimateMs) || !Number.isFinite(bandMs) || !Number.isFinite(fastestCloseMs)) return null;
  return `estimate ${signed(estimateMs)}, deadband ${bandMs.toFixed(1)}ms, closes in ${(fastestCloseMs / 1000).toFixed(1)}s`;
}

function controllerText(state) {
  const head = `controller: rate ${state.rate.toFixed(6)} · ${state.mode}`;
  const tail = `over ${state.windowRecords} frames`;
  const detail = state.reason ?? figuresText(state);
  return detail === null ? `${head} ${tail}` : `${head} · ${detail} ${tail}`;
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
