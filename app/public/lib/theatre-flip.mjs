// public/lib/theatre-flip.mjs — the player's move into and out of theatre.
// Pure: the caller reads the two boxes; this returns the keyframes that play the new box from
// the old one, or null when there is nothing to animate.

const SAME_PX = 0.5;

const hasArea = (box) => box.width > 0 && box.height > 0;

function sameBox(a, b) {
  return ['left', 'top', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= SAME_PX);
}

export function flipKeyframes(before, after) {
  if (!hasArea(before) || !hasArea(after) || sameBox(before, after)) return null;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = before.width / after.width;
  const sy = before.height / after.height;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: '0 0' },
    { transform: 'none', transformOrigin: '0 0' },
  ];
}
