// The seek bar's drag (11b-2 D10): moves only hold the thumb and the release issues one seek.
// After the release the thumb stays where it was dropped until the room's position comes near
// it or the hold runs out, so it does not snap back while the seek lands (12e design.md D7).
export function createSeekScrub({ seek, holdWithinMs = 1000, holdForMs = 1500 }) {
  let dragging = false;
  let committed = null;
  return {
    input() {
      dragging = true;
      committed = null;
    },
    commit(positionMs, nowMs) {
      dragging = false;
      if (!Number.isFinite(positionMs)) {
        committed = null;
        return false;
      }
      const issued = seek(positionMs);
      committed = issued ? { positionMs, atMs: nowMs } : null;
      return issued;
    },
    release() { dragging = false; },
    holds(positionMs, nowMs) {
      if (dragging || !committed) return dragging;
      if (!Number.isFinite(positionMs) || !Number.isFinite(nowMs)) return true;
      const close = Math.abs(positionMs - committed.positionMs) <= holdWithinMs;
      const expired = nowMs - committed.atMs >= holdForMs;
      if (close || expired) {
        committed = null;
        return false;
      }
      return true;
    },
  };
}
