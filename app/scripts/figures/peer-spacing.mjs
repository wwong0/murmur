// Each viewer's declared offset, the lateness of the start in force when the
// window opens, and the spacing they leave.

function startInForce(starts, window) {
  const before = (Array.isArray(starts) ? starts : [])
    .filter((start) => Number.isFinite(start?.playAtSharedMs) && start.playAtSharedMs <= window?.startMs);
  return before.at(-1) ?? null;
}

export function peerSpacing({ clients = {}, tags = [], condition = {}, window } = {}) {
  const declaredOffsetMsByClient = {};
  const startLatenessMsByClient = {};
  const achievedSpacingMsByClient = {};
  for (const tag of tags) {
    const offsetMs = condition.positionOffsetMsByClient?.[tag] ?? 0;
    const lateness = startInForce(clients[tag]?.starts, window)?.latenessMs;
    declaredOffsetMsByClient[tag] = offsetMs;
    startLatenessMsByClient[tag] = Number.isFinite(lateness) ? lateness : null;
    achievedSpacingMsByClient[tag] = Number.isFinite(lateness) ? offsetMs - lateness : null;
  }
  return { declaredOffsetMsByClient, startLatenessMsByClient, achievedSpacingMsByClient };
}
