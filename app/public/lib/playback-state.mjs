export const REJECTION_REASONS = Object.freeze(['malformed', 'stale', 'notPermitted', 'notApplicable']);
export const CONTROL_MODES = Object.freeze(['open', 'host']);

const KINDS = new Set(['create', 'play', 'pause', 'seek', 'control-mode']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value);
}

function validMapping(value) {
  return object(value)
    && typeof value.playing === 'boolean'
    && Number.isFinite(value.atSharedMs)
    && Number.isFinite(value.mediaMs)
    && value.mediaMs >= 0;
}

function validBasis(value) {
  return object(value)
    && typeof value.lineage === 'string'
    && value.lineage.length > 0
    && finiteInteger(value.version);
}

function validMode(value) {
  return CONTROL_MODES.includes(value);
}

function freezeMapping(value) {
  return Object.freeze({
    playing: value.playing,
    atSharedMs: value.atSharedMs,
    mediaMs: value.mediaMs,
  });
}

function freezeState(value) {
  if (!object(value) || typeof value.lineage !== 'string' || value.lineage.length === 0
    || !finiteInteger(value.version) || !validMapping(value.current)
    || !(value.previous === null || validMapping(value.previous))
    || (value.previous && value.previous.atSharedMs > value.current.atSharedMs)
    || !validMode(value.controlMode)) return null;
  return Object.freeze({
    lineage: value.lineage,
    version: value.version,
    current: freezeMapping(value.current),
    previous: value.previous === null ? null : freezeMapping(value.previous),
    controlMode: value.controlMode,
  });
}

export function readPlaybackState(value) {
  return freezeState(value);
}

export function offsetView(state, offsetMs) {
  if (!Number.isFinite(offsetMs) || !Number.isInteger(offsetMs)) {
    throw new TypeError('offsetMs must be a finite integer');
  }
  if (offsetMs === 0) return state;
  if (state === null) return null;
  return Object.freeze({
    ...state,
    current: Object.freeze({ ...state.current, mediaMs: state.current.mediaMs + offsetMs }),
    previous: state.previous === null
      ? null
      : Object.freeze({ ...state.previous, mediaMs: state.previous.mediaMs + offsetMs }),
  });
}

function mappingAt(state, sharedMs) {
  if (!state || !Number.isFinite(sharedMs) || !validMapping(state.current)
    || !(state.previous === null || validMapping(state.previous))) return null;
  if (sharedMs >= state.current.atSharedMs) return state.current;
  if (state.previous && sharedMs >= state.previous.atSharedMs) return state.previous;
  return null;
}

export function mediaMsAt(state, sharedMs) {
  const mapping = mappingAt(state, sharedMs);
  if (!mapping) return null;
  return mapping.playing ? mapping.mediaMs + sharedMs - mapping.atSharedMs : mapping.mediaMs;
}

export function epochMsAt(state, sharedMs) {
  const mapping = mappingAt(state, sharedMs);
  return mapping && mapping.playing ? mapping.atSharedMs - mapping.mediaMs : null;
}

export function stateIdentity(state) {
  const valid = freezeState(state);
  return valid ? Object.freeze({ lineage: valid.lineage, version: valid.version }) : null;
}

function malformedEnvelope(env, maxFutureMs) {
  if (!object(env) || !finiteInteger(env.seq) || typeof env.from !== 'string' || env.from.length === 0
    || !object(env.ts) || !Number.isFinite(env.ts.recv) || !object(env.payload)) return true;

  const payload = env.payload;
  if (typeof payload.kind !== 'string' || !KINDS.has(payload.kind)) return true;

  if (payload.kind === 'create') {
    if (typeof payload.lineage !== 'string' || payload.lineage.length === 0
      || !validMapping(payload.current)
      || !(payload.previous === null || validMapping(payload.previous))
      || (payload.previous && payload.previous.atSharedMs > payload.current.atSharedMs)
      || !validMode(payload.controlMode)) return true;
    const limit = env.ts.recv + maxFutureMs;
    return payload.current.atSharedMs > limit
      || (payload.previous !== null && payload.previous.atSharedMs > limit);
  }

  if (!validBasis(payload.basis)) return true;
  if (payload.kind === 'play' || payload.kind === 'pause' || payload.kind === 'seek') {
    if (!Number.isFinite(payload.atSharedMs)) return true;
    if (payload.kind === 'seek' && !Number.isFinite(payload.positionMs)) return true;
    return payload.atSharedMs > env.ts.recv + maxFutureMs;
  }
  return !validMode(payload.controlMode);
}

function senderRole(roster, sender) {
  if (!Array.isArray(roster)) return undefined;
  return roster.find((member) => member && member.clientId === sender)?.role;
}

function rosterHasHost(roster) {
  return Array.isArray(roster) && roster.some((member) => member && member.role === 'host');
}

export function createPlaybackStateHolder({ maxFutureMs }) {
  if (!Number.isFinite(maxFutureMs) || maxFutureMs < 0) {
    throw new TypeError('maxFutureMs must be a finite non-negative number');
  }
  let held = null;
  let awaiting = false;
  let applied = 0;
  const rejected = { malformed: 0, stale: 0, notPermitted: 0, notApplicable: 0 };

  function reject(reason) {
    rejected[reason] += 1;
    return { outcome: reason };
  }

  function apply(env, roster) {
    if (malformedEnvelope(env, maxFutureMs)) return reject('malformed');
    const { payload } = env;

    if (payload.kind !== 'create') {
      if (!held || payload.basis.lineage !== held.lineage || payload.basis.version !== held.version) {
        return reject('stale');
      }
    } else if (held || !awaiting) {
      return reject('stale');
    }

    const role = senderRole(roster, env.from);
    if (payload.kind === 'control-mode' && role !== 'host') return reject('notPermitted');
    if (held?.controlMode === 'host' && (payload.kind === 'play' || payload.kind === 'pause' || payload.kind === 'seek')
      && rosterHasHost(roster) && role !== 'host') return reject('notPermitted');

    if (payload.kind !== 'create' && payload.kind !== 'control-mode') {
      if ((payload.kind === 'play' && held.current.playing)
        || (payload.kind === 'pause' && !held.current.playing)
        || env.ts.recv < held.current.atSharedMs) return reject('notApplicable');
    }

    if (payload.kind === 'create') {
      held = freezeState({
        lineage: payload.lineage,
        version: env.seq,
        current: payload.current,
        previous: payload.previous,
        controlMode: payload.controlMode,
      });
      awaiting = false;
    } else if (payload.kind === 'control-mode') {
      held = freezeState({ ...held, version: env.seq, controlMode: payload.controlMode });
    } else {
      const effective = Math.max(payload.atSharedMs, held.current.atSharedMs);
      let current;
      if (payload.kind === 'pause') {
        current = { playing: false, atSharedMs: effective, mediaMs: mediaMsAt(held, effective) };
      } else if (payload.kind === 'play') {
        current = { playing: true, atSharedMs: effective, mediaMs: held.current.mediaMs };
      } else {
        current = {
          playing: held.current.playing,
          atSharedMs: effective,
          mediaMs: Math.max(0, payload.positionMs),
        };
      }
      held = freezeState({
        lineage: held.lineage,
        version: env.seq,
        current,
        previous: held.current,
        controlMode: held.controlMode,
      });
    }
    applied += 1;
    return { outcome: 'applied' };
  }

  return {
    reset() {
      held = null;
      awaiting = false;
    },
    expectCreation() {
      awaiting = true;
    },
    adopt(state) {
      const copy = readPlaybackState(state);
      if (!copy) throw new TypeError('invalid playback state');
      held = copy;
      awaiting = false;
    },
    apply,
    get state() {
      return held;
    },
    get awaitingCreation() {
      return awaiting;
    },
    get counters() {
      return Object.freeze({
        applied,
        rejected: Object.freeze({ ...rejected }),
      });
    },
  };
}
