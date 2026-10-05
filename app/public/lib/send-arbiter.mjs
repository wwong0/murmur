// The one turn at the host's shared bucket (design.md D2, D9). Every channel's
// sender registers here, and the arbiter hands out the bucket's chunks: urgent,
// near, then normal, and in turn across channels within a class. A sender polling the
// bucket on its own timer won every refill once it had won one (D2's re-read).
// The clock is injected; the arbiter's one timer wakes it when the bucket refills.

const CLASS_RANK = Object.freeze({ urgent: 3, near: 2, normal: 1 });

export function createSendArbiter({ pace, clock }) {
  if (!pace || typeof pace.available !== 'function' || typeof pace.take !== 'function') {
    throw new TypeError('createSendArbiter: pace is required');
  }
  if (!clock || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function') {
    throw new TypeError('createSendArbiter: clock is required');
  }
  const rotation = [];
  let timer = null;
  let pumping = false;
  let again = false;

  function arm(waitMs) {
    if (timer !== null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      poke();
    }, waitMs);
  }

  // The first handle in rotation order offering the highest class.
  function next(skipped) {
    let best = null;
    let bestRank = 0;
    for (const handle of rotation) {
      if (skipped.has(handle)) continue;
      const rank = CLASS_RANK[handle.offer()] ?? 0;
      if (rank > bestRank) {
        best = handle;
        bestRank = rank;
      }
    }
    return best;
  }

  function pump() {
    const skipped = new Set();
    for (;;) {
      const nowMs = clock.now();
      const availability = pace.available(nowMs);
      if (!availability.ok) {
        arm(availability.waitMs);
        return;
      }
      const handle = next(skipped);
      if (!handle) return;
      const bytes = handle.admitOne();
      if (!(bytes > 0)) {
        skipped.add(handle);
        continue;
      }
      pace.take(bytes, nowMs);
      const index = rotation.indexOf(handle);
      if (index !== -1) rotation.push(...rotation.splice(index, 1));
    }
  }

  // A poke while pumping runs one more pump after this one; it never nests.
  function poke() {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        pump();
      } while (again);
    } finally {
      pumping = false;
    }
  }

  return Object.freeze({
    register({ offer, admitOne }) {
      if (typeof offer !== 'function' || typeof admitOne !== 'function') {
        throw new TypeError('send-arbiter: a handle offers and admits');
      }
      const handle = { offer, admitOne };
      rotation.push(handle);
      return Object.freeze({
        poke,
        unregister() {
          const index = rotation.indexOf(handle);
          if (index !== -1) rotation.splice(index, 1);
        },
      });
    },
    pending() {
      return { handles: rotation.length, timerArmed: timer !== null };
    },
  });
}
