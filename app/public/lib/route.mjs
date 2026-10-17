export function readRoute(search = '') {
  const params = new URLSearchParams(search);
  const room = params.get('room') || null;
  return {
    room,
    role: room ? (params.get('role') || 'viewer') : null,
    tab: room ? (params.get('tab') || null) : null,
  };
}

export function joinTarget(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value) return null;
  try {
    const room = new URL(value, 'https://watchalong.invalid').searchParams.get('room');
    if (room) return room;
  } catch {
    // A bare room name is checked below.
  }
  return /[/?&#\s]/.test(value) ? null : value;
}
