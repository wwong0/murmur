// A first touch on a faded control bar only reveals it (design.md D7). A mouse or pen moves
// before it clicks, so it never needs this.
export function swallowTouch({ pointerType, faded } = {}) {
  return pointerType === 'touch' && faded === true;
}
