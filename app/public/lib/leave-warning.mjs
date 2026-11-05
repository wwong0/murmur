// A host that leaves while the room plays is asked first; nobody else is.
export function leaveWarns({ role, playing }) {
  return role === 'host' && playing === true;
}
