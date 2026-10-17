// The seek bar's drag (11b-2 D10; joint D1 F4). A range fires `input` on every pointer move
// and `change` once at release: seek on `input` and a drag issues a seek per move, and let the
// tick write the thumb while it is held and it jumps under the pointer. So a move only marks
// the thumb as held, and a commit issues one seek.
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
