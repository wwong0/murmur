export const END_TOLERANCE_MS = 1;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function endInstant(state, durationMs) {
  if (!state?.current?.playing || !finite(durationMs)) return null;
  const instant = state.current.atSharedMs + durationMs - state.current.mediaMs;
  return Math.max(state.current.atSharedMs, instant);
}

export function isEnded(state, durationMs) {
  return finite(durationMs)
    && state?.current?.playing === false
    && state.current.held !== true
    && state.current.mediaMs >= durationMs - END_TOLERANCE_MS;
}

export function createEndLatch() {
  const taken = new Set();
  return {
    take(identity) {
      if (!identity || typeof identity.lineage !== 'string' || !Number.isInteger(identity.version)) return false;
      const key = `${identity.lineage}:${identity.version}`;
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    },
  };
}
