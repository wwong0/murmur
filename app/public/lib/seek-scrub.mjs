// The seek bar's drag (11b-2 D10; joint D1 F4). A range fires `input` on every pointer move
// and `change` once at release. Seeking on `input` issued one seek per move: the first landed
// where the drag began and the rest were rejected as stale. And the tick rewrote the thumb
// under the pointer. So a move only marks the thumb as held, and a commit issues one seek.
export function createSeekScrub({ seek }) {
  let held = false;
  return {
    input() { held = true; },
    commit(positionMs) {
      held = false;
      return Number.isFinite(positionMs) ? seek(positionMs) : false;
    },
    release() { held = false; },
    holds: () => held,
  };
}
