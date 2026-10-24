const WAITING = 'start wait: waiting for first frame';

export const START_WAIT_LINE_WAITING = WAITING;
export const START_WAIT_LINE_RE = /^start wait: \d+ ms$/;

export function startWaitText(waitMs) {
  if (waitMs === null || waitMs === undefined) return WAITING;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('start wait must be a non-negative number');
  return `start wait: ${Math.round(waitMs)} ms`;
}

export function createStartWait() {
  let askedAt = null;
  let frameAt = null;

  return {
    asked(atPageMs) {
      if (askedAt !== null) return false;
      if (!Number.isFinite(atPageMs)) throw new TypeError('start wait asked instant must be finite');
      askedAt = atPageMs;
      return true;
    },
    framePresented(atPageMs) {
      if (askedAt === null || frameAt !== null) return false;
      if (!Number.isFinite(atPageMs)) throw new TypeError('start wait frame instant must be finite');
      const waitMs = atPageMs - askedAt;
      if (waitMs < 0) throw new RangeError('start wait frame precedes asked instant');
      frameAt = atPageMs;
      return true;
    },
    reset() {
      askedAt = null;
      frameAt = null;
    },
    waitMs() {
      return askedAt === null || frameAt === null ? null : Math.round(frameAt - askedAt);
    },
  };
}
