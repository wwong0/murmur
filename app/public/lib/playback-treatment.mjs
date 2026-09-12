// public/lib/playback-treatment.mjs
//
// The adopted pitch treatment (remedy-product-integration-spec.md section 3.2):
// one `preservesPitch = false` write before playback, the controller settings
// that write licenses, and the interlock that stops positive-f correction if the
// flag is later lost.
//
// Rules that survive any edit:
//
//  - Support is established BEFORE the write. Assigning an absent property makes
//    an ordinary expando that reads back false, and that is not support.
//  - This is the only pitch assignment in product source, and it runs once.
//  - Positive f only after a supported, pre-playback write read back false. Any
//    other startup outcome is f = 0 with a named reason, never a retry.
//  - After a successful start, loss or unreadability latches a fault until
//    reload: exact unity, no further polls, no non-unity writes, and no resume
//    on a later false read. The pitch flag is never rewritten.
//  - The kernel snapshot is never mutated. A faulted view replaces it for every
//    consumer and carries it as `historical`, so an old `settled` is not current.
//
// Under public/lib/: no element lookups, no globals, no timers. The element, the
// clock and the notice port are arguments.

import { D8_COMMAND_THRESHOLD } from './drift-controller.mjs';

export const D8_TREATMENT = 'd8-pitch-disabled';
export const FALLBACK_TREATMENT = 'fallback-f0';
export const TREATMENT_FAULT_MODE = 'treatment-fault';
export const UNITY_RESTORE_FAILED = 'unity-restore-failed';
export const STARTUP_FAILURES = Object.freeze([
  'pitch-property-unsupported',
  'pitch-setup-late',
  'pitch-access-exception',
  'pitch-write-exception',
  'pitch-readback-exception',
  'pitch-readback-not-false',
]);
export const FAULT_REASONS = Object.freeze(['pitch-lost', 'pitch-missing', 'pitch-unreadable']);
export const DEFAULT_EVIDENCE_CAPACITY = 16384;

export class TreatmentFaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TreatmentFaultError';
  }
}

const messageOf = (error) => String(error?.message ?? error);

/** One guarded read. A throw and an absence are distinct outcomes, and neither is `false`. */
function read(target, key) {
  try {
    const value = target[key];
    return Object.freeze(value === undefined ? { presence: 'missing' } : { presence: 'value', value });
  } catch (error) {
    return Object.freeze({ presence: 'throw', error: messageOf(error) });
  }
}

const isFalse = (reading) => reading.presence === 'value' && reading.value === false;

/**
 * The verifier's opt-in event history. Bounded; an id is consumed even when its
 * event is dropped, so a reader sees a gap rather than a quiet renumbering.
 */
export function createEvidenceQueue({ now, capacity = DEFAULT_EVIDENCE_CAPACITY }) {
  const queue = [];
  let produced = 0;
  let lost = 0;
  return {
    record(kind, fields) {
      produced += 1;
      if (queue.length >= capacity) {
        lost += 1;
        return;
      }
      queue.push({ id: produced, kind, atMs: now(), ...fields });
    },
    drain(maxEvents = capacity) {
      const events = queue.splice(0, Math.max(0, Math.floor(maxEvents)));
      return { events, produced, lost, pending: queue.length };
    },
  };
}

function establish({ video, opened, atMs, id }) {
  const record = {
    id,
    atMs,
    requested: false,
    supported: null,
    beforePlayback: null,
    attemptedWrites: 0,
    readback: null,
    outcome: 'fallback',
    reason: null,
    error: null,
  };
  const fail = (reason, error = null) => Object.freeze({ ...record, reason, error });
  try {
    record.supported = 'preservesPitch' in video;
  } catch (error) {
    return fail('pitch-access-exception', messageOf(error));
  }
  if (!record.supported) return fail('pitch-property-unsupported');
  const paused = read(video, 'paused');
  if (paused.presence === 'throw') return fail('pitch-access-exception', paused.error);
  record.beforePlayback = opened === false && paused.presence === 'value' && paused.value === true;
  if (!record.beforePlayback) return fail('pitch-setup-late');
  record.attemptedWrites = 1;
  try {
    video.preservesPitch = false;
  } catch (error) {
    return fail('pitch-write-exception', messageOf(error));
  }
  record.readback = read(video, 'preservesPitch');
  if (record.readback.presence === 'throw') return fail('pitch-readback-exception', record.readback.error);
  if (!isFalse(record.readback)) return fail('pitch-readback-not-false');
  return Object.freeze({ ...record, outcome: 'treatment-established' });
}

/**
 * Called once per page and element, after the player exists and before the
 * sampler, the controller and any open. `opened` is whether playback has been
 * opened yet; a paused element alone does not prove that. `evidence` opts in
 * to the verifier's bounded event queue; normal playback keeps no history.
 */
export function initializePlaybackTreatment({ video, opened, now, notify = () => {}, evidence = false }) {
  const queue = evidence ? createEvidenceQueue({ now }) : null;
  const atMs = now();
  const startup = establish({ video, opened, atMs, id: `pitch-setup-${atMs}-${Math.random().toString(36).slice(2, 8)}` });
  const positive = startup.outcome === 'treatment-established';
  const treatment = positive ? D8_TREATMENT : FALLBACK_TREATMENT;
  const settings = Object.freeze({ MIN_COMMAND_DEVIATION: positive ? D8_COMMAND_THRESHOLD : 0 });
  let fault = null;

  queue?.record('startup', { startup, treatment, f: settings.MIN_COMMAND_DEVIATION });
  if (!positive) {
    notify(`the adopted synchronization treatment is unavailable (${startup.reason}); correcting without the adopted rate floor`, { warn: true });
  }

  function restoreUnity() {
    fault.restoreAttempts += 1;
    let error = null;
    try {
      video.playbackRate = 1;
    } catch (thrown) {
      error = messageOf(thrown);
    }
    const observed = read(video, 'playbackRate');
    fault.unity = Object.freeze({
      ok: error === null && observed.presence === 'value' && observed.value === 1,
      observedRate: observed.presence === 'value' && Number.isFinite(observed.value) ? observed.value : null,
      error: error ?? (observed.presence === 'throw' ? observed.error : null),
    });
    queue?.record('unity-restore', { attempt: fault.restoreAttempts, ...fault.unity });
  }

  function latch(point, observed) {
    const reason = observed.presence === 'throw' ? 'pitch-unreadable' : observed.presence === 'missing' ? 'pitch-missing' : 'pitch-lost';
    fault = { reason, point, atMs: now(), observed, unity: null, restoreAttempts: 0 };
    queue?.record('fault', { reason, point, observed });
    restoreUnity();
    notify(`synchronization stopped: the pitch treatment was lost (${reason} at ${point}); playback continues uncorrected, reload the page to retry`, { warn: true });
  }

  /** True when the controller may act. Enforces only an established treatment. */
  function guard(point) {
    if (!positive) return true;
    if (fault !== null) return false;
    const observed = read(video, 'preservesPitch');
    if (isFalse(observed)) return true;
    latch(point, observed);
    return false;
  }

  /** The controller's `apply`. A refused write throws, so the kernel never records it as applied. */
  function applyRate(rate) {
    if (rate !== 1 && !guard('write')) {
      queue?.record('write', { requested: rate, allowed: false, reason: fault?.reason ?? null });
      throw new TreatmentFaultError(`treatment-fault: non-unity rate ${rate} refused (${fault?.reason})`);
    }
    let error = null;
    try {
      video.playbackRate = rate;
    } catch (thrown) {
      error = thrown;
    }
    queue?.record('write', { requested: rate, allowed: true, readback: read(video, 'playbackRate'), error: error === null ? null : messageOf(error) });
    if (error !== null) throw error;
  }

  let lastControllerNowMs = null;
  /** The controller's clock: `now` unchanged, keeping the instant the kernel
   *  read so a poll event carries the exact value its dwell was decided on. */
  function controllerNow() {
    lastControllerNowMs = now();
    return lastControllerNowMs;
  }

  /** One controller poll, or none after a fault; a failed unity restore is retried alone. */
  function pollController(poll) {
    if (fault !== null) {
      if (!fault.unity.ok) restoreUnity();
      return null;
    }
    if (!guard('poll')) return null;
    lastControllerNowMs = null;
    let snapshot;
    try {
      snapshot = poll();
    } catch (error) {
      queue?.record('poll', { threw: messageOf(error), controllerNowMs: lastControllerNowMs });
      throw error;
    }
    queue?.record('poll', { snapshot, controllerNowMs: lastControllerNowMs });
    return snapshot;
  }

  /** Wraps load or reopen. The after-check runs even when the open throws. */
  function open(action, point) {
    guard(`before-${point}`);
    queue?.record('open', { point });
    try {
      return action();
    } finally {
      guard(`after-${point}`);
    }
  }

  function faultCopy() {
    return fault === null ? null : { reason: fault.reason, point: fault.point, atMs: fault.atMs, observed: fault.observed, unity: fault.unity, restoreAttempts: fault.restoreAttempts };
  }

  /** What consumers read in place of the kernel snapshot once faulted. */
  function view(snapshot) {
    if (fault === null) return snapshot;
    return {
      mode: TREATMENT_FAULT_MODE,
      reason: fault.reason,
      unity: fault.unity.ok ? 'restored' : UNITY_RESTORE_FAILED,
      rate: fault.unity.observedRate,
      thresholdUsable: false,
      stoppingThresholdMs: null,
      fastestCloseMs: null,
      controllerActive: false,
      settings: snapshot.settings,
      polls: snapshot.polls,
      historical: snapshot,
    };
  }

  function pitch() {
    return {
      startup,
      current: read(video, 'preservesPitch'),
      treatment,
      f: settings.MIN_COMMAND_DEVIATION,
      controllerActive: fault === null,
      fault: faultCopy(),
    };
  }

  return {
    settings,
    treatment,
    startup,
    guard,
    applyRate,
    controllerNow,
    pollController,
    open,
    view,
    pitch,
    drainEvidence: (maxEvents) => (queue === null ? null : queue.drain(maxEvents)),
    get faulted() { return fault !== null; },
  };
}
