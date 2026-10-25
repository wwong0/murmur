const WAITING = 'start wait: waiting for first frame';

export const START_WAIT_LINE_WAITING = WAITING;
export const START_WAIT_LINE_RE = /^start wait: \d+ ms$/;

export function startWaitText(waitMs) {
  if (waitMs === null || waitMs === undefined) return WAITING;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('start wait must be a non-negative number');
  return `start wait: ${Math.round(waitMs)} ms`;
}

// One start per title (13 design.md D17): asked, then the drift sequence at its play(), then the
// first frame after that sequence. Each step is taken once until `reset`.
export function createStartWait() {
  let askedAt = null;
  let afterSeq = null;
  let frameAt = null;

  return {
    asked(atPageMs) {
      if (askedAt !== null) return false;
      if (!Number.isFinite(atPageMs)) throw new TypeError('start wait asked instant must be finite');
      askedAt = atPageMs;
      return true;
    },
    played(seq) {
      if (askedAt === null || frameAt !== null || afterSeq !== null) return false;
      afterSeq = seq;
      return true;
    },
    // The drift sequence whose next record is the start's first frame, while one is awaited.
    awaitedAfterSeq() {
      return askedAt === null || frameAt !== null ? null : afterSeq;
    },
    framePresented(atPageMs) {
      if (askedAt === null || frameAt !== null) return false;
      if (!Number.isFinite(atPageMs)) throw new TypeError('start wait frame instant must be finite');
      const waitMs = atPageMs - askedAt;
      if (waitMs < 0) throw new RangeError('start wait frame precedes asked instant');
      frameAt = atPageMs;
      afterSeq = null;
      return true;
    },
    reset() {
      askedAt = null;
      afterSeq = null;
      frameAt = null;
    },
    waitMs() {
      return askedAt === null || frameAt === null ? null : Math.round(frameAt - askedAt);
    },
  };
}
