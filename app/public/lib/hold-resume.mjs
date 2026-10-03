// public/lib/hold-resume.mjs
//
// T8 (design.md D3): the resume rule, pure — no timer, no clock read. It takes
// every instant as an argument and keeps only the memory the rule itself needs
// across calls: the viewer set's key, when it last changed, and when the
// viewer count first went from zero to one.

export const READY_HELD_AHEAD_MS = 4_000;
const ROSTER_SETTLE_MS = 2_000;
const BOUND_MS = 10_000;
const REISSUE_SUPPRESS_MS = 3_000;

function identityKey(identity) {
  return `${identity.lineage}:${identity.version}`;
}

export function createHoldResume() {
  let lastViewerKey;
  let rosterChangedAtSharedMs = null;
  let viewerSince = null;
  const suppressedUntil = new Map();

  function evaluate({ nowSharedMs, state, roster, reports }) {
    const viewers = (roster ?? []).filter((member) => member && member.role === 'viewer');
    const viewerKey = viewers.map((member) => member.clientId).sort().join(',');
    if (lastViewerKey === undefined || viewerKey !== lastViewerKey) {
      rosterChangedAtSharedMs = nowSharedMs;
      lastViewerKey = viewerKey;
    }
    if (viewers.length === 0) viewerSince = null;
    else if (viewerSince === null) viewerSince = nowSharedMs;

    if (!state || state.current.held !== true || !Number.isFinite(nowSharedMs)
      || nowSharedMs < state.current.atSharedMs) return null;

    const identity = { lineage: state.lineage, version: state.version };
    const key = identityKey(identity);
    const suppressUntil = suppressedUntil.get(key);
    if (suppressUntil !== undefined && nowSharedMs < suppressUntil) return null;

    const viewersOut = {};
    for (const member of viewers) {
      const report = reports?.[member.clientId];
      const current = report && report.lineage === identity.lineage && report.version === identity.version
        ? report.heldAheadMs
        : null;
      viewersOut[member.clientId] = { tabId: member.tabId, heldAheadMs: current };
    }

    const heldAtSharedMs = state.current.atSharedMs;
    const boundBaseSharedMs = Math.max(heldAtSharedMs, viewerSince ?? heldAtSharedMs);
    const everyViewerReady = viewers.length >= 1
      && viewers.every((member) => viewersOut[member.clientId].heldAheadMs !== null
        && viewersOut[member.clientId].heldAheadMs >= READY_HELD_AHEAD_MS);
    const rosterSettled = nowSharedMs - rosterChangedAtSharedMs >= ROSTER_SETTLE_MS;

    let cause = null;
    if (everyViewerReady && rosterSettled) cause = 'ready';
    else if (viewerSince !== null && nowSharedMs - boundBaseSharedMs >= BOUND_MS) cause = 'bound';
    if (cause === null) return null;

    return { cause, identity, heldAtSharedMs, boundBaseSharedMs, rosterChangedAtSharedMs, viewers: viewersOut };
  }

  function issued(identity, ok, nowSharedMs) {
    const key = identityKey(identity);
    // A successful issue is quiet for the re-issue interval — long enough to
    // clear the transition lead plus a round trip, so it cannot race the
    // play's own application. A failed issue leaves no memory: the very next
    // evaluation may try again.
    if (ok) suppressedUntil.set(key, nowSharedMs + REISSUE_SUPPRESS_MS);
    else suppressedUntil.delete(key);
  }

  return { evaluate, issued };
}

/** A bounded ring for published resume records, evicting the oldest first. */
export function createResumeRing(capacity = 256) {
  const records = [];
  let latestSeq = 0;
  let evicted = 0;
  return {
    push(record) {
      const item = { seq: ++latestSeq, ...record };
      records.push(item);
      if (records.length > capacity) {
        records.shift();
        evicted += 1;
      }
      return item;
    },
    read(afterSeq = 0) {
      return {
        records: records.filter((item) => item.seq > afterSeq).map((item) => ({ ...item })),
        evicted,
      };
    },
  };
}
