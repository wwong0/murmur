// public/lib/drift-readout.mjs
//
// One line of text: where this client is against the room, or — when the log has
// stopped producing records — WHICH INPUT WENT MISSING (change 3b design.md D2).
//
// It reads the log and the load rule and writes to neither, which is what lets
// the line the browser pass asserts be checked WITHOUT a browser — the no-record
// diagnoses in particular, which a healthy page never reaches.
//
// Under public/lib/: no DOM, no page access.

import { REFUSAL_REASONS } from './frame-drift.mjs';
import {
  MISSING_CLOCK,
  MISSING_HOST_LINK,
  MISSING_STATE,
  WAITING_PAUSED,
  WAITING_PREPARING,
  WAITING_REFUSED,
} from './playback-start.mjs';

/** The scheduled start's status as words (change 5 design.md D6): a missing input first. */
function notPlayingReason({ missing, waiting, retargets }) {
  if (missing) return `waiting for ${missing}`;
  if (waiting === WAITING_PAUSED) return 'room paused';
  if (waiting === WAITING_PREPARING) return `preparing start (retargets ${retargets})`;
  if (waiting === WAITING_REFUSED) return 'start refused, click the page to start';
  return 'no reason published';
}

/** The panel's millisecond format, shared with diagnostics-overlay.mjs: two copies drift apart. */
export const signed = (ms) => `${ms >= 0 ? '+' : ''}${ms.toFixed(1)}ms`;

/**
 * THE SHAPE OF THE LINE, WHERE THE LINE IS BUILT — a second copy of it would rot
 * for the ninety seconds and the Chrome the browser pass costs. Group 1 is the
 * frame count, which must be above zero.
 */
export const DRIFT_LINE_RE =
  /^drift: [+-]\d+\.\d+ms · rolling window over the last (\d+) frames: median [+-]\d+\.\d+ms, p99 [+-]\d+\.\d+ms$/;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MISSING_RE = [MISSING_CLOCK, MISSING_STATE, MISSING_HOST_LINK].map(escapeRegex).join('|');
// The text notPlayingReason renders for WAITING_PAUSED, WAITING_PREPARING and
// WAITING_REFUSED; the drift suite renders each one against this.
const WAITING_RE = ['room paused', 'preparing start \\(retargets \\d+\\)', 'start refused, click the page to start'].join('|');
const REFUSAL_RE = REFUSAL_REASONS.map(escapeRegex).join('|');

export const DRIFT_LINE_NOT_PLAYING_RE = new RegExp(
  `^drift: not playing — (?:waiting for (?:${MISSING_RE})|${WAITING_RE}|no reason published)$`,
);
export const DRIFT_LINE_NO_RECORDS_RE = new RegExp(
  `^drift: no new records — (nothing recorded yet|no frames offered — rVFC is silent|(?:${REFUSAL_RE}) rising \\(\\d+ total\\))$`,
);

export function driftLineForm(line) {
  if (typeof line !== 'string') return null;
  if (DRIFT_LINE_RE.test(line)) return 'recording';
  if (DRIFT_LINE_NOT_PLAYING_RE.test(line)) return 'not-playing';
  if (DRIFT_LINE_NO_RECORDS_RE.test(line)) return 'no-new-records';
  return null;
}

/**
 * Which counter is rising, fastest first. The log charges every offered frame
 * either to a record or to exactly one named reason, so "frames arrived and none
 * of them recorded for any reason" is not a state to branch on.
 */
function whyNoRecords(counters, before) {
  if (!before) return 'nothing recorded yet';
  const delta = (reason) => counters[reason] - before[reason];
  const worst = REFUSAL_REASONS.filter((reason) => delta(reason) > 0).sort((a, b) => delta(b) - delta(a))[0];
  return worst ? `${worst} rising (${counters[worst]} total)` : 'no frames offered — rVFC is silent';
}

/**
 * @param {{log: {read: Function, summary: Function}, playback: {state: () => object}}} config
 */
export function createDriftReadout({ log, playback }) {
  let cursor = 0;
  /** The counters as of the previous line, so a rising one can be told from a high one. */
  let seenCounters = null;

  function text() {
    const status = playback.state();
    if (!status.playing) return `drift: not playing — ${notPlayingReason(status)}`;
    const read = log.read({ afterSeq: cursor });
    const before = seenCounters;
    seenCounters = read.counters;
    if (read.records.length === 0) return `drift: no new records — ${whyNoRecords(read.counters, before)}`;

    cursor = read.latestSeq;
    const latest = read.records[read.records.length - 1];
    const s = log.summary();
    // A ROLLING WINDOW, NEVER "median drift": change 6 computes a median over
    // the whole run, and two different numbers under one name guarantee a false
    // conclusion (D2).
    return (
      `drift: ${signed(latest.driftMs)} · rolling window over the last ${s.framesHeld} frames: ` +
      `median ${signed(s.medianDriftMs)}, p99 ${signed(s.p99DriftMs)}`
    );
  }

  return { text };
}
