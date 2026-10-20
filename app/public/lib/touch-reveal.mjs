// A first touch on a faded control bar only reveals it (design.md D7): the bar is still in the
// player's box while faded, so a finger lands on a control it cannot see.

/** True iff this pointer is a finger and the bar is faded. A mouse or pen moves before it clicks, so it never needs this. */
export function swallowTouch({ pointerType, faded } = {}) {
  return pointerType === 'touch' && faded === true;
}
