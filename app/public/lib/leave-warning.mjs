// A host that leaves while the room plays is asked first; nobody else is (12e design.md D13).
export function leaveWarns({ role, playing }) {
  return role === 'host' && playing === true;
}
