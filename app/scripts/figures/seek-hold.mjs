const LANDING_FIELDS = new Set(['landingSegment', 'notApplied', 'landedOnHeldMedia', 'viewersNotRestarted']);
const VIEWER_LANDING_FIELDS = ['highestSegmentBeforeE', 'heldSegments', 'kL'];

function pastHeldState(seek) {
  return seek?.host && seek?.before
    && seek.host.held !== true
    && seek.host.lineage === seek.before.lineage
    && seek.host.version > seek.before.version;
}

function sameAppliedState(left, right) {
  return left?.lineage === right?.lineage
    && left?.version === right?.version
    && left?.playing === right?.playing
    && left?.positionMs === right?.positionMs
    && left?.atSharedMs === right?.atSharedMs;
}

function repairedViewers(viewers, host, viewerPolls) {
  return Object.fromEntries(Object.entries(viewers ?? {}).map(([tag, viewer]) => {
    const poll = (Array.isArray(viewerPolls?.[tag]) ? viewerPolls[tag] : [])
      .find((entry) => sameAppliedState(entry?.state, host));
    const next = { ...(viewer ?? {}) };
    if (poll) {
      next.reading = poll.state;
      next.appliedAtMs = poll.harnessBeforeMs;
    }
    for (const field of VIEWER_LANDING_FIELDS) delete next[field];
    return [tag, next];
  }));
}

export function seekWithPolledHold(seek, { hostPoll = [], viewerPolls = {} } = {}) {
  if (!pastHeldState(seek)) return seek;
  const positionMs = Number.isInteger(seek.declaredPositionMs)
    ? seek.declaredPositionMs : seek.declared?.positionMs;
  const poll = (Array.isArray(hostPoll) ? hostPoll : []).find((entry) => {
    const state = entry?.state;
    return state?.lineage === seek.before.lineage
      && state?.version > seek.before.version
      && state?.held === true
      && state?.positionMs === positionMs;
  });
  if (!poll) return seek;
  const hostState = poll.state;
  const host = {
    lineage: hostState.lineage,
    version: hostState.version,
    playing: hostState.playing,
    positionMs: hostState.positionMs,
    atSharedMs: hostState.atSharedMs,
    held: true,
  };
  const repaired = Object.fromEntries(Object.entries(seek).filter(([key]) => !LANDING_FIELDS.has(key)));
  return {
    ...repaired,
    host,
    hostAtMs: poll.harnessBeforeMs,
    viewers: repairedViewers(seek.viewers, host, viewerPolls),
    landingMs: host.positionMs,
    landedPositionMs: host.positionMs,
    effectiveSharedMs: host.atSharedMs,
    holdObservedFrom: 'host-control-poll',
    loopHost: seek.host,
  };
}
